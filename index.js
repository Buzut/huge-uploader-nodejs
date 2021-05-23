const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');

/**
 * Make sure required headers are present & are numbers
 * @param { Object } headers – req.headers object
 * @return { Boolean }
 */
function checkHeaders(headers) {
    if (
        !headers['uploader-chunk-number'] ||
        !headers['uploader-chunks-total'] ||
        !headers['uploader-file-id'] ||
        !headers['uploader-chunks-total'].match(/^[0-9]+$/) ||
        !headers['uploader-chunk-number'].match(/^[0-9]+$/) ||
        !headers['uploader-file-id'].match(/^[0-9]+$/)
    ) return false;

    return true;
}

/**
 * Make sure total file size isn't bigger than limit
 * @param { Number } maxFileSize
 * @param { Number } maxChunkSize
 * @param { Object } headers – req.headers object
 * @return { Boolean }
 */
function checkTotalSize(maxFileSize, maxChunkSize, totalChunks) {
    if (maxChunkSize * totalChunks > maxFileSize) return false;
    return true;
}

/**
 * Delete tmp directory containing chunks
 * @param { String } dirPath
 */
function cleanChunks(dirPath) {
    fs.readdir(dirPath, (err, files) => {
        let filesLength = files.length;

        files.forEach((file) => {
            fs.unlink(path.join(dirPath, file), () => {
                if (--filesLength === 0) fs.rmdir(dirPath, () => {}); // cb does nothing but required
            });
        });
    });
}

/**
 * Take all chunks of a file and reassemble them in a unique file
 * @param { String } tmpDir
 * @param { String } dirPath
 * @param { String } fileId
 * @param { Number } totalChunks
 * @param { Object } postParams – form post fields
 * @return { Function } promised function to start assembling
 */
function assembleChunks(tmpDir, dirPath, fileId, totalChunks, postParams) {
    const asyncReadFile = promisify(fs.readFile);
    const asyncAppendFile = promisify(fs.appendFile);
    const assembledFile = path.join(tmpDir, fileId);
    let chunkCount = 0;

    return () => { // eslint-disable-line
        return new Promise((resolve, reject) => {
            const pipeChunk = () => {
                asyncReadFile(path.join(dirPath, chunkCount.toString()))
                .then(chunk => asyncAppendFile(assembledFile, chunk))
                .then(() => {
                    // 0 indexed files = length - 1, so increment before comparison
                    if (totalChunks > ++chunkCount) pipeChunk(chunkCount);

                    else {
                        cleanChunks(dirPath);
                        resolve({ filePath: assembledFile, postParams });
                    }
                })
                .catch(reject);
            };

            pipeChunk();
        });
    };
}

/**
 * Create directory if it doesn't exist
 * @param { String } dirPath
 * @param { Function } callback
 */
function mkdirIfDoesntExist(dirPath, callback) {
    fs.stat(dirPath, (err) => {
        if (err) fs.mkdir(dirPath, callback);
        else callback();
    });
}

/**
 * write chunk to upload dir, create tmp dir if first chunk
 * return getFileStatus ƒ to query completion status cb(err, [null | assembleChunks ƒ])
 * assembleChunks ƒ is returned only for last chunk
 * @param { String } tmpDir
 * @param { Object } headers
 * @param { Object } fileStream
 * @param { Object } postParams
 * @return { Function } getFileStatus – cb based function to know when file is written. callback(err, assembleChunks ƒ)
 */
function handleFile(tmpDir, headers, fileStream, postParams) {
    const dirPath = path.join(tmpDir, `${headers['uploader-file-id']}_tmp`);
    const chunkPath = path.join(dirPath, headers['uploader-chunk-number']);
    const chunkCount = +headers['uploader-chunk-number'];
    const totalChunks = +headers['uploader-chunks-total'];

    let error;
    let assembleChunksPromise;
    let finished = false;
    let writeStream;

    const writeFile = () => {
        writeStream = fs.createWriteStream(chunkPath);

        writeStream.on('error', (err) => {
            error = err;
            fileStream.resume();
        });

        writeStream.on('close', () => {
            finished = true;

            // if all is uploaded
            if (chunkCount === totalChunks - 1) {
                assembleChunksPromise = assembleChunks(tmpDir, dirPath, headers['uploader-file-id'], totalChunks, postParams);
            }
        });

        fileStream.pipe(writeStream);
    };

    // make sure chunk is in range
    if (chunkCount < 0 || chunkCount >= totalChunks) {
        error = new Error('Chunk is out of range');
        fileStream.resume();
    }

    // create file upload dir if it's first chunk
    else if (chunkCount === 0) {
        mkdirIfDoesntExist(dirPath, (err) => {
            if (err) {
                error = err;
                fileStream.resume();
            }

            else writeFile();
        });
    }

    // make sure dir exists if it's not first chunk
    else {
        fs.stat(dirPath, (err) => {
            if (err) {
                error = new Error('Upload has expired');
                fileStream.resume();
            }

            else writeFile();
        });
    }

    return (callback) => {
        if (finished && !error) callback(null, assembleChunksPromise);
        else if (error) callback(error);

        else {
            writeStream.on('error', callback);
            writeStream.on('close', () => callback(null, assembleChunksPromise));
        }
    };
}

/**
 * Master function. Parse form and call child ƒs for writing and assembling
 * @param { Object } req – nodejs req object
 * @param { String } tmpDir – upload temp dir
 * @param { Number } maxChunkSize
 */
function uploadFile(req, tmpDir, maxFileSize, maxChunkSize) {
    return new Promise((resolve, reject) => {
        if (!checkHeaders(req.headers)) {
            reject(new Error('Missing header(s)'));
            return;
        }

        if (!checkTotalSize(maxFileSize, maxChunkSize, req.headers['uploader-chunks-total'])) {
            reject(new Error('File is above size limit'));
            return;
        }

        try {
            const postParams = {};
            let limitReached = false;
            let getFileStatus;

            const busboy = new Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxChunkSize * 1000 * 1000 } });

            busboy.on('file', (fieldname, fileStream) => {
                fileStream.on('limit', () => {
                    limitReached = true;
                    fileStream.resume();
                });

                getFileStatus = handleFile(tmpDir, req.headers, fileStream, postParams);
            });

            busboy.on('field', (key, val) => {
                postParams[key] = val;
            });

            busboy.on('finish', () => {
                if (limitReached) {
                    reject(new Error('Chunk is above size limit'));
                    return;
                }

                getFileStatus((fileErr, assembleChunksF) => {
                    if (fileErr) reject(fileErr);
                    else resolve(assembleChunksF);
                });
            });

            req.pipe(busboy);
        }

        catch (err) {
            reject(err);
        }
    });
}

module.exports = uploadFile;
