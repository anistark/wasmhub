// Tests for the nodejs runtime's `http` server, run under plain node via
// ./harness.mjs with the in-memory socket host in ./fakenet.mjs.
//
// The assertions are made against the bytes on the wire rather than against the
// runtime's own objects, so a framing mistake shows up here rather than in
// somebody's sandbox.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';
import { FakeNet, until } from './fakenet.mjs';

async function withHttp(handler, options = {}) {
    const net = new FakeNet(options);
    const rt = await loadRuntime({
        env: { WASMHUB_LISTEN_FD: String(net.listenFd), WASMHUB_LISTEN_ADDR: '127.0.0.1:8080' },
        sockets: net.backend,
    });
    const server = rt.httpModule.createServer(handler);
    await new Promise((resolve) => server.listen(8080, resolve));
    const stop = () => {
        for (const socket of Array.from(server._connections)) socket.destroy();
        if (server.listening) server.close();
    };
    return { rt, net, server, stop };
}

function decodeChunked(text) {
    let body = '';
    let i = 0;
    for (;;) {
        const eol = text.indexOf('\r\n', i);
        if (eol < 0) return { body, consumed: -1 };
        const size = parseInt(text.slice(i, eol), 16);
        i = eol + 2;
        if (size === 0) return { body, consumed: i + 2 };  // trailing blank line
        body += text.slice(i, i + size);
        i += size + 2;
    }
}

/// Parses one response off the front of `text`, returning it and the rest.
function parseResponse(text) {
    const split = text.indexOf('\r\n\r\n');
    assert.ok(split >= 0, `response head is incomplete: ${JSON.stringify(text)}`);
    const lines = text.slice(0, split).split('\r\n');
    const start = /^HTTP\/1\.1 (\d{3}) (.*)$/.exec(lines[0]);
    assert.ok(start, `bad status line: ${lines[0]}`);

    const headers = Object.create(null);
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }

    const rest = text.slice(split + 4);
    let body = '';
    let consumed = 0;
    if (headers['transfer-encoding'] === 'chunked') {
        const decoded = decodeChunked(rest);
        body = decoded.body;
        consumed = decoded.consumed;
    } else if (headers['content-length'] !== undefined) {
        const len = Number(headers['content-length']);
        body = rest.slice(0, len);
        consumed = len;
    }
    return {
        status: Number(start[1]),
        message: start[2],
        headers,
        body,
        remainder: consumed < 0 ? '' : rest.slice(consumed),
    };
}

/// Waits until the peer has a complete response, then parses it.
async function response(peer, label = 'a response') {
    await until(() => {
        const text = peer.text();
        if (text.indexOf('\r\n\r\n') < 0) return false;
        try { parseResponse(text); return true; } catch { return false; }
    }, { label });
    return parseResponse(peer.text());
}

test('a GET is parsed and answered', async () => {
    let seen = null;
    const { net, stop } = await withHttp((req, res) => {
        seen = req;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
    });

    const peer = net.connect();
    peer.send('GET /things?a=1 HTTP/1.1\r\nHost: example.test\r\nX-Case-Test: Yes\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.status, 200);
    assert.equal(res.message, 'OK');
    assert.equal(res.body, 'hello');
    assert.equal(res.headers['content-type'], 'text/plain');
    assert.ok(res.headers.date, 'a Date header is sent by default');

    assert.equal(seen.method, 'GET');
    assert.equal(seen.url, '/things?a=1');
    assert.equal(seen.httpVersion, '1.1');
    // Header names are lowercased, values are not.
    assert.equal(seen.headers['x-case-test'], 'Yes');
    assert.equal(seen.headers.host, 'example.test');
    assert.deepEqual(seen.rawHeaders.slice(0, 2), ['Host', 'example.test']);
    stop();
});

test('a body of unknown length is framed as chunked', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.write('one ');
        res.write('two ');
        res.end('three');
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.1\r\nHost: x\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.headers['transfer-encoding'], 'chunked');
    assert.equal(res.headers['content-length'], undefined);
    assert.equal(res.body, 'one two three');
    // Each write is its own chunk, and the body ends with the terminator.
    assert.match(peer.text(), /\r\n4\r\none \r\n/);
    assert.ok(peer.text().endsWith('0\r\n\r\n'));
    stop();
});

test('an explicit Content-Length suppresses chunked framing', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.setHeader('Content-Length', '5');
        res.end('fixed');
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.1\r\nHost: x\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.headers['content-length'], '5');
    assert.equal(res.headers['transfer-encoding'], undefined);
    assert.equal(res.body, 'fixed');
    stop();
});

test('a request body arrives by Content-Length', async () => {
    let body = null;
    const { net, stop } = await withHttp(async (req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c.toString()));
        req.on('end', () => {
            body = chunks.join('');
            res.setHeader('Content-Length', String(body.length));
            res.end(body);
        });
    });

    const peer = net.connect();
    peer.send(
        'POST /submit HTTP/1.1\r\nHost: x\r\nContent-Length: 11\r\n\r\n' +
        'hello world',
    );

    const res = await response(peer);
    assert.equal(body, 'hello world');
    assert.equal(res.body, 'hello world');
    stop();
});

test('a request body split across host reads is reassembled', async () => {
    let body = null;
    const { net, stop } = await withHttp((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c.toString()));
        req.on('end', () => { body = chunks.join(''); res.end('ok'); });
    });

    const peer = net.connect();
    peer.send('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc');
    await until(() => body === null);
    peer.send('de');
    peer.send('fghij');

    await response(peer);
    assert.equal(body, 'abcdefghij');
    stop();
});

test('a chunked request body is decoded', async () => {
    let body = null;
    const { net, stop } = await withHttp((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c.toString()));
        req.on('end', () => { body = chunks.join(''); res.end('ok'); });
    });

    const peer = net.connect();
    peer.send(
        'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '5\r\nhello\r\n' +
        '6\r\n world\r\n' +
        '0\r\n\r\n',
    );

    await response(peer);
    assert.equal(body, 'hello world');
    stop();
});

test('a HEAD request gets headers and no body', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.setHeader('Content-Length', '5');
        res.end('never');
    });

    const peer = net.connect();
    peer.send('HEAD / HTTP/1.1\r\nHost: x\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.status, 200);
    // Content-Length describes the body a GET would have returned; the body
    // itself must not be on the wire.
    assert.equal(res.headers['content-length'], '5');
    assert.equal(res.headers['transfer-encoding'], undefined);
    assert.ok(peer.text().endsWith('\r\n\r\n'), `HEAD sent a body: ${JSON.stringify(peer.text())}`);
    stop();
});

test('a keep-alive connection serves more than one request', async () => {
    let count = 0;
    const { net, stop } = await withHttp((req, res) => {
        count++;
        res.setHeader('Content-Length', '1');
        res.end(String(count));
    });

    const peer = net.connect();
    peer.send('GET /one HTTP/1.1\r\nHost: x\r\n\r\n');
    const first = await response(peer);
    assert.equal(first.headers.connection, 'keep-alive');
    assert.equal(first.body, '1');
    assert.equal(peer.ended, false, 'the socket stays open for reuse');

    peer.send('GET /two HTTP/1.1\r\nHost: x\r\n\r\n');
    await until(() => first.remainder !== parseResponse(peer.text()).remainder ||
        parseResponse(peer.text()).remainder.length > 0, { label: 'the second response' });
    const second = parseResponse(parseResponse(peer.text()).remainder);
    assert.equal(second.body, '2');
    assert.equal(count, 2);
    stop();
});

test('pipelined requests are answered one at a time and in order', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.setHeader('Content-Length', String(req.url.length));
        res.end(req.url);
    });

    const peer = net.connect();
    // Both arrive in a single read, so the parser has to hold the second back
    // until the first exchange is finished.
    peer.send(
        'GET /aaa HTTP/1.1\r\nHost: x\r\n\r\n' +
        'GET /bb HTTP/1.1\r\nHost: x\r\n\r\n',
    );

    await until(() => {
        try {
            const first = parseResponse(peer.text());
            return first.remainder.includes('\r\n\r\n');
        } catch { return false; }
    }, { label: 'both responses' });

    const first = parseResponse(peer.text());
    const second = parseResponse(first.remainder);
    assert.equal(first.body, '/aaa');
    assert.equal(second.body, '/bb');
    stop();
});

test('Connection: close is honoured and ends the socket', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.setHeader('Content-Length', '2');
        res.end('ok');
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.headers.connection, 'close');
    await until(() => peer.ended, { label: 'the socket to close' });
    stop();
});

test('an HTTP/1.0 request is answered without chunked framing', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.end('legacy');
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.0\r\nHost: x\r\n\r\n');

    await until(() => peer.ended, { label: 'the response and close' });
    const text = peer.text();
    assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
    assert.doesNotMatch(text, /Transfer-Encoding/i);
    assert.match(text, /Connection: close/);
    assert.ok(text.endsWith('legacy'));
    stop();
});

test('a malformed request line is answered with 400 rather than a hang', async () => {
    const { net, stop } = await withHttp((req, res) => res.end('never'));

    const peer = net.connect();
    peer.send('NOT-A-REQUEST\r\nHost: x\r\n\r\n');

    const res = await response(peer);
    assert.equal(res.status, 400);
    assert.equal(res.headers.connection, 'close');
    assert.match(res.body, /malformed request line/);
    stop();
});

test('setting a header after the response has begun is refused', async () => {
    let error = null;
    const { net, stop } = await withHttp((req, res) => {
        res.write('started');
        try { res.setHeader('X-Late', '1'); } catch (e) { error = e; }
        res.end();
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.1\r\nHost: x\r\n\r\n');

    await response(peer);
    assert.ok(error, 'setHeader should throw once headers are sent');
    assert.equal(error.code, 'ERR_HTTP_HEADERS_SENT');
    stop();
});

test('a 204 carries no body either', async () => {
    const { net, stop } = await withHttp((req, res) => {
        res.writeHead(204);
        res.end('ignored');
    });

    const peer = net.connect();
    peer.send('GET / HTTP/1.1\r\nHost: x\r\n\r\n');

    await until(() => peer.text().includes('\r\n\r\n'), { label: 'the response' });
    const text = peer.text();
    assert.match(text, /^HTTP\/1\.1 204 No Content\r\n/);
    assert.doesNotMatch(text, /Transfer-Encoding/i);
    assert.ok(text.endsWith('\r\n\r\n'), `204 sent a body: ${JSON.stringify(text)}`);
    stop();
});

test('the client half reports why it cannot work', async () => {
    const { rt, stop } = await withHttp(() => {});
    for (const api of ['request', 'get']) {
        assert.throws(() => rt.httpModule[api]('http://example.test/'), (err) => {
            assert.equal(err.code, 'ERR_NOT_SUPPORTED');
            assert.match(err.message, /no outbound connect/);
            return true;
        }, `http.${api} should explain itself`);
    }
    stop();
});

test('STATUS_CODES and METHODS are exposed', async () => {
    const { rt, stop } = await withHttp(() => {});
    assert.equal(rt.httpModule.STATUS_CODES[404], 'Not Found');
    assert.equal(rt.httpModule.STATUS_CODES[500], 'Internal Server Error');
    assert.ok(rt.httpModule.METHODS.includes('GET'));
    assert.ok(rt.httpModule.METHODS.includes('PATCH'));
    stop();
});
