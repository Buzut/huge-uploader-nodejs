# huge uploader nodejs

`huge-uploader-nodejs` is a Node.js promise-based module made to receive chunked & resumable file uploads. It's made to work with its frontend counterpart [`huge-uploader`](https://github.com/Buzut/huge-uploader).

From `huge-uploader`:
> HTTP and especially HTTP servers have limits and were not designed to transfer large files. In addition, network connexion can be unreliable. No one wants an upload to fail after hours… Sometimes we even need to pause the upload, and HTTP doesn't allow that.
>
> The best way to circumvent these issues is to chunk the file and send it in small pieces. If a chunk fails, no worries, it's small and fast to re-send it. Wanna pause? Ok, just start where you left off when ready.

The frontend module chunks and sends, this backend module receives and assembles all the pieces back together at the end of the process.

## Installation & usage

```javascript
npm install huge-uploader-nodejs --save
```

As an exemple, I'll give something in pure Node.js, without any framework. But it is obviously compatible with any framework out there.

```javascript
const http = require('http');
const uploader = require('huge-uploader-nodejs');

// you must specify a temp upload dir and a max filesize for the chunks
const tmpDir = './tmp';
const maxFileSize = 10;

http.createServer((req, res) => {
    if (req.url === '/upload' && req.method === 'POST') {
        // we feed the function with node's request object (here req),
        // the temp directory path and the max size for the chunks
        uploader(req, tmpDir, maxFileSize, maxChunkSize)
        .then((assembleChunks) => {
            // chunk written to disk
            res.writeHead(204, 'No Content');
            res.end();

            // on last chunk, assembleChunks function is returned
            // the response is already sent to the browser because it can take some time if the file is huge
            if (assembleChunks) {
                // so you call the promise, it assembles all the pieces together and cleans the temporary files
                assembleChunks()
                // when it's done, it returns an object with the path to the file and additional post parameters if any
                .then(data => console.log(data)) // { filePath: 'tmp/1528932277257', postParams: { email: 'upload@corp.com', name: 'Mr Smith' } }
                // errors if any are triggered by the file system (disk is full…)
                .catch(err => console.log(err));
            }
        })
        .catch((err) => {
            if (err.message === 'Missing header(s)') {
                res.writeHead(400, 'Bad Request', { 'Content-Type': 'text/plain' });
                res.end('Missing uploader-* header');
                return;
            }

            if (err.message === 'Missing Content-Type') {
                res.writeHead(400, 'Bad Request', { 'Content-Type': 'text/plain' });
                res.end('Missing Content-Type');
                return;
            }

            if (err.message.includes('Unsupported content type')) {
                res.writeHead(400, 'Bad Request', { 'Content-Type': 'text/plain' });
                res.end('Unsupported content type');
                return;
            }

            if (err.message === 'Chunk is out of range') {
                res.writeHead(400, 'Bad Request', { 'Content-Type': 'text/plain' });
                res.end('Chunk number must be between 0 and total chunks - 1 (0 indexed)');
                return;
            }

            if (err.message === 'File is above size limit') {
                res.writeHead(413, 'Payload Too Large', { 'Content-Type': 'text/plain' });
                res.end(`File is too large. Max fileSize is: ${maxFileSize}MB`);
                return;
            }

            if (err.message === 'Chunk is above size limit') {
                res.writeHead(413, 'Payload Too Large', { 'Content-Type': 'text/plain' });
                res.end(`File is too large. Max fileSize is: ${maxFileSize}MB`);
                return;
            }

			// this error is triggered if a chunk with uploader-chunk-number header != 0
            // is sent and there is no corresponding temp dir.
            // It means that the upload dir has been deleted in the meantime.
            // Although uploads should be resumable, you can't keep partial uploads for days on your server
            if (err && err.message === 'Upload has expired') {
                res.writeHead(410, 'Gone', { 'Content-Type': 'text/plain' });
                res.end(err.message);
                return;
            }

            // other FS errors
            res.writeHead(500, 'Internal Server Error'); // potentially saturated disk
            res.end();
        });
    }

    // unknown route
    else {
        res.writeHead(404, 'Resource Not Found', { 'Content-Type': 'text/plain' });
        res.end('Resource Not Found');
    }
})
.listen(8888, () => {
    console.log('Listening for requests');
});
```

Also, if the uploader is not on the same domain, don't forget to set a CORS policy. Either directly on node or on the reverse proxy. Here's an exemple for Node:

```javascript
res.setHeader('Access-Control-Allow-Origin', 'https://my-super-domain.com');

if (req.url === '/upload' && req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'uploader-chunk-number,uploader-chunks-total,uploader-file-id');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24hrs
    res.writeHead(204, 'No Content');
    res.end();
    return;
 }

```

### Options

They aren't many options (all are required). As shown in the example, you pass the function:
* the request object,
* a directory to write to `{ String }`,
* the maximum total file size for the upload `{ Number }`,
* the maximum chunk size `{ Number }`.

Be warned that total file size is computed by multiplying `maxChunkSize` by `uploader-chunks-total` header. So if the client is splitting files in chunks smaller than  `maxChunkSize`, leading to a situation where `uploader-chunks-total` > `maxFileSize / maxChunkSize`, the upload will be refused although it might be smaller than `maxFileSize`.

### Garbage collection

As said in the exemple, the module takes care of cleaning the successful uploads. But if an upload is paused and never resumed, its files are going to stay forever. So you should create a script called via a crontab that will erased directory older than the time you're willing to keep them.

Example bash script:
```shell
#!/bin/bash

find /var/www/tmp -type d -mtime +24h -delete
```

## How to setup with the frontend
This module is made to work with [`huge-uploader`](https://github.com/Buzut/huge-uploader) frontend module. In case you would like to develop your own frontend, this module needs three specific headers to work:

* `uploader-file-id` a unique file id that's used to create temp upload directory for this upload,
* `uploader-chunks-total` the total numbers of chunk that will be sent,
* `uploader-chunk-number` the current chunk number (0 based index, so last chunk is `uploader-chunks-total - 1`).

Any other header will be ignored. Also, you can send `POST` parameters. Parameters send with the last chunk only will be processed.

## Contributing

There's sure room for improvement, so feel free to hack around and submit PRs!
Please just follow the style of the existing code, which is [Airbnb's style](http://airbnb.io/javascript/) with [minor modifications](.eslintrc).
