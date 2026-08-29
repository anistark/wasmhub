// Inbound networking against a built runtime, which the node harness cannot
// cover: a real listening socket handed in by the host, real WASI sock_accept,
// and the runtime's own poll loop.
//
// The host must bind the port and pass the descriptor in:
//
//   WASMHUB_LISTEN_FD=3 WASMHUB_LISTEN_ADDR=127.0.0.1:8080 \
//   wasmtime run --tcplisten 127.0.0.1:8080 \
//     --env WASMHUB_LISTEN_FD=3 --env WASMHUB_LISTEN_ADDR=127.0.0.1:8080 \
//     --dir tests/runtimes/nodejs/fixtures \
//     runtimes/nodejs/nodejs-20.wasm -- \
//     run tests/runtimes/nodejs/fixtures/httpserver.js
//
// Then, from another shell:
//   curl -s localhost:8080/hello        -> {"method":"GET","url":"/hello","body":""}
//   curl -s -d 'ping' localhost:8080/x  -> {"method":"POST","url":"/x","body":"ping"}
//   curl -s localhost:8080/stop         -> stops the server, run exits 0

const http = require('node:http');
const net = require('node:net');

console.log(`net.isIP=${net.isIP('127.0.0.1')},${net.isIP('::1')},${net.isIP('nope')}`);

// The client half cannot work on Preview 1; it must say so rather than hang.
try {
    net.connect(80, 'example.test');
    console.log('connect=UNEXPECTEDLY-OK');
} catch (err) {
    console.log(`connect=${err.code}`);
}

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        if (req.url === '/stop') {
            res.setHeader('Content-Type', 'text/plain');
            res.end('stopping\n');
            server.close();
            return;
        }

        const payload = JSON.stringify({ method: req.method, url: req.url, body });
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
        });
        res.end(payload);
    });
});

server.on('error', (err) => {
    console.log(`server.error=${err.code}`);
    process.exit(1);
});

server.on('close', () => {
    console.log('server=closed');
});

server.listen(8080, () => {
    const addr = server.address();
    console.log(`listening=${addr.address}:${addr.port}`);
});
