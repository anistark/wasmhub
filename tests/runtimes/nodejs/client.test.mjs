// Tests for the nodejs runtime's outbound half: net.connect, the http client
// and fetch, as the -net build has them. Run under plain node via
// ./harness.mjs, with ./fakenet.mjs standing in for sock_open/sock_connect and
// each test playing the remote server through the connection's peer.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';
import { FakeNet, until } from './fakenet.mjs';

/// A runtime on a host that accepts every connect unless `refuse` says
/// otherwise, the way wasmrun applies its egress policy.
async function withOutbound(refuse = () => null) {
    const net = new FakeNet({ outbound: refuse });
    const rt = await loadRuntime({ sockets: net.backend });
    return { rt, net };
}

const headOf = (peer) => until(() => peer.text().includes('\r\n\r\n') && peer.text(), { label: 'request head' });

/// The body after the head as bytes, once `length` of them have arrived.
const bodyBytes = async (peer, length) => {
    const buf = await until(() => {
        const b = peer.received();
        const at = b.indexOf('\r\n\r\n');
        return at >= 0 && b.length - at - 4 >= length && b;
    }, { label: 'request body' });
    return buf.subarray(buf.indexOf('\r\n\r\n') + 4);
};
const bodyOf = async (peer, length) => (await bodyBytes(peer, length)).toString('latin1');

function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
        stream.on('error', reject);
    });
}

test('without sock_connect the client reports why, and the server half still works', async () => {
    const net = new FakeNet();
    const rt = await loadRuntime({ sockets: net.backend });
    assert.equal(rt.HAS_SOCKETS, true);
    assert.equal(rt.HAS_OUTBOUND, false);
    assert.throws(() => rt.netModule.connect(80, '127.0.0.1'), { code: 'ERR_NOT_SUPPORTED' });
    assert.throws(() => rt.httpModule.get('http://127.0.0.1/'), (e) => {
        assert.equal(e.code, 'ERR_NOT_SUPPORTED');
        assert.match(e.message, /nodejs-20-net/);
        return true;
    });
});

test('net.connect connects, exchanges bytes both ways, and closes', async () => {
    const { rt, net } = await withOutbound();
    assert.equal(rt.HAS_OUTBOUND, true);
    const events = [];
    const socket = rt.netModule.connect(7000, '127.0.0.1', () => events.push('connect'));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    // Written before the connection exists: queued, not lost.
    socket.write('ping');
    const peer = await net.dial();
    assert.deepEqual(net.dialed.map(d => [d.host, d.port]), [['127.0.0.1', 7000]]);
    await until(() => peer.text() === 'ping', { label: 'queued write' });
    assert.deepEqual(events, ['connect']);
    assert.equal(socket.remoteAddress, '127.0.0.1');
    assert.equal(socket.remotePort, 7000);

    const received = collect(socket);
    peer.send('pong').end();
    assert.equal(await received, 'pong');
    await until(() => peer.ended, { label: 'the guest closing its side' });
    await closed;
});

test('a refused connect is an error event naming the policy, not a throw', async () => {
    const { rt } = await withOutbound(() => 'EACCES');
    const socket = rt.netModule.createConnection({ host: '10.0.0.1', port: 80 });
    const closed = new Promise((resolve) => socket.on('close', resolve));
    const err = await new Promise((resolve) => socket.on('error', resolve));
    assert.equal(err.code, 'EACCES');
    assert.equal(err.syscall, 'connect');
    assert.equal(err.address, '10.0.0.1');
    assert.equal(err.port, 80);
    assert.match(err.message, /network policy/);
    await closed;
});

test('a bad port throws synchronously, as node does', async () => {
    const { rt } = await withOutbound();
    assert.throws(() => rt.netModule.connect(0, 'localhost'), { code: 'ERR_SOCKET_BAD_PORT' });
    assert.throws(() => rt.netModule.connect({ port: 70000 }), { code: 'ERR_SOCKET_BAD_PORT' });
});

test('an idle socket emits timeout', async () => {
    const { rt, net } = await withOutbound();
    const socket = rt.netModule.connect({ port: 9, timeout: 30 });
    await net.dial();
    await new Promise((resolve) => socket.on('timeout', resolve));
    socket.destroy();
});

test('http.get sends a well-formed request and reads a Content-Length response', async () => {
    const { rt, net } = await withOutbound();
    const responded = new Promise((resolve) => {
        rt.httpModule.get('http://example.test:8080/path?q=1', resolve);
    });
    const peer = await net.dial();
    assert.equal(net.dialed[0].host, 'example.test');
    assert.equal(net.dialed[0].port, 8080);
    const head = await headOf(peer);
    assert.match(head, /^GET \/path\?q=1 HTTP\/1\.1\r\n/);
    assert.match(head, /\r\nHost: example\.test:8080\r\n/);
    assert.match(head, /\r\nConnection: close\r\n/);
    assert.doesNotMatch(head, /Content-Length|Transfer-Encoding/i);

    peer.send('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 5\r\n\r\nhello');
    const res = await responded;
    assert.equal(res.statusCode, 200);
    assert.equal(res.statusMessage, 'OK');
    assert.equal(res.headers['content-type'], 'text/plain');
    assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
    assert.equal(await collect(res), 'hello');
    assert.equal(res.complete, true);
});

test('end(body) sends Content-Length; write() then end() streams chunks', async () => {
    const { rt, net } = await withOutbound();

    const one = rt.httpModule.request({ host: 'h', port: 80, method: 'POST', path: '/a' });
    one.end('{"x":1}');
    const p1 = await net.dial(0);
    const head1 = await headOf(p1);
    assert.match(head1, /\r\nContent-Length: 7\r\n/);
    assert.match(head1, /\r\nHost: h\r\n/);
    assert.equal(await bodyOf(p1, 7), '{"x":1}');
    p1.send('HTTP/1.1 204 No Content\r\n\r\n').end();

    const two = rt.httpModule.request({ host: 'h', port: 80, method: 'PUT', path: '/b' });
    // The peer hangs up without answering, which node reports as an error.
    const hungUp = new Promise((resolve) => two.on('error', resolve));
    two.write('ab');
    two.end('cde');
    const p2 = await net.dial(1);
    const head2 = await headOf(p2);
    assert.match(head2, /\r\nTransfer-Encoding: chunked\r\n/);
    assert.equal(await bodyOf(p2, 20), '2\r\nab\r\n3\r\ncde\r\n0\r\n\r\n');
    p2.end();
    assert.match((await hungUp).message, /socket hang up/);

    const three = rt.httpModule.request({ host: 'h', port: 80, method: 'POST' });
    three.end();
    const p3 = await net.dial(2);
    const head3 = await headOf(p3);
    assert.match(head3, /\r\nContent-Length: 0\r\n/);
    p3.send('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
});

test('chunked and read-until-close response bodies', async () => {
    const { rt, net } = await withOutbound();

    const chunked = new Promise((resolve) => rt.httpModule.get('http://h/c', resolve));
    const p1 = await net.dial(0);
    await headOf(p1);
    p1.send('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n');
    p1.send('5;ext=1\r\npedia\r\n0\r\nX-Trailer: y\r\n\r\n');
    assert.equal(await collect(await chunked), 'Wikipedia');

    const untilClose = new Promise((resolve) => rt.httpModule.get('http://h/u', resolve));
    const p2 = await net.dial(1);
    await headOf(p2);
    p2.send('HTTP/1.0 200 OK\r\n\r\nall of ');
    p2.send('it').end();
    assert.equal(await collect(await untilClose), 'all of it');
});

test('a 100 Continue is an information event before the real response', async () => {
    const { rt, net } = await withOutbound();
    const req = rt.httpModule.get('http://h/');
    const info = new Promise((resolve) => req.on('information', resolve));
    const response = new Promise((resolve) => req.on('response', resolve));
    const peer = await net.dial();
    await headOf(peer);
    peer.send('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok');
    assert.equal((await info).statusCode, 100);
    const res = await response;
    assert.equal(res.statusCode, 201);
    assert.equal(await collect(res), 'ok');
});

test('a connection dropped mid-body aborts the response', async () => {
    const { rt, net } = await withOutbound();
    const responded = new Promise((resolve) => rt.httpModule.get('http://h/', resolve));
    const peer = await net.dial();
    await headOf(peer);
    peer.send('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc').end();
    const res = await responded;
    const aborted = new Promise((resolve) => res.on('aborted', resolve));
    const failed = new Promise((resolve) => res.on('error', resolve));
    res.resume();
    await aborted;
    assert.equal((await failed).code, 'ECONNRESET');
});

test('the client refuses https rather than sending plaintext', async () => {
    const { rt } = await withOutbound();
    assert.throws(() => rt.httpModule.get('https://example.com/'), { code: 'ERR_INVALID_PROTOCOL' });
});

test('a refused request is an error on the request', async () => {
    const { rt } = await withOutbound(() => 'EACCES');
    const req = rt.httpModule.get('http://blocked.test/');
    const err = await new Promise((resolve) => req.on('error', resolve));
    assert.equal(err.code, 'EACCES');
});

// ── fetch ────────────────────────────────────────────────────────────────────

test('fetch reads status, headers and a JSON body', async () => {
    const { rt, net } = await withOutbound();
    const pending = rt.fetchImpl('http://api.test/items?id=3', { headers: { 'X-Token': 'abc' } });
    const peer = await net.dial();
    const head = await headOf(peer);
    assert.match(head, /^GET \/items\?id=3 HTTP\/1\.1\r\n/);
    assert.match(head, /\r\nx-token: abc\r\n/);
    assert.match(head, /\r\naccept: \*\/\*\r\n/);
    peer.send('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"found":false}');
    peer.end();
    const res = await pending;
    assert.equal(res.status, 404);
    assert.equal(res.ok, false);
    assert.equal(res.statusText, 'Not Found');
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.url, 'http://api.test/items?id=3');
    assert.deepEqual(await res.json(), { found: false });
    assert.equal(res.bodyUsed, true);
    await assert.rejects(res.text(), /already been read/);
});

test('fetch sends a string body with its content type and length', async () => {
    const { rt, net } = await withOutbound();
    const pending = rt.fetchImpl('http://api.test/echo', { method: 'post', body: 'héllo' });
    const peer = await net.dial();
    const head = await headOf(peer);
    assert.match(head, /^POST \/echo HTTP\/1\.1\r\n/);
    assert.match(head, /\r\ncontent-type: text\/plain;charset=UTF-8\r\n/);
    assert.match(head, /\r\ncontent-length: 6\r\n/);
    assert.equal((await bodyBytes(peer, 6)).toString('utf8'), 'héllo');
    peer.send('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok').end();
    assert.equal(await (await pending).text(), 'ok');
});

test('fetch follows a 303 as a GET and reports the final url', async () => {
    const { rt, net } = await withOutbound();
    const pending = rt.fetchImpl('http://a.test/form', { method: 'POST', body: 'x=1' });
    const first = await net.dial(0);
    await headOf(first);
    first.send('HTTP/1.1 303 See Other\r\nLocation: /done\r\nContent-Length: 0\r\n\r\n').end();
    const second = await net.dial(1);
    const head = await headOf(second);
    assert.match(head, /^GET \/done HTTP\/1\.1\r\n/);
    assert.doesNotMatch(head, /content-type/i);
    second.send('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndone').end();
    const res = await pending;
    assert.equal(res.redirected, true);
    assert.equal(res.url, 'http://a.test/done');
    assert.equal(await res.text(), 'done');
});

test('fetch with redirect: manual hands back the 3xx', async () => {
    const { rt, net } = await withOutbound();
    const pending = rt.fetchImpl('http://a.test/', { redirect: 'manual' });
    const peer = await net.dial();
    await headOf(peer);
    peer.send('HTTP/1.1 302 Found\r\nLocation: http://b.test/\r\nContent-Length: 0\r\n\r\n').end();
    const res = await pending;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://b.test/');
});

test('fetch failures are TypeError("fetch failed") with the reason as cause', async () => {
    const { rt } = await withOutbound(() => 'EACCES');
    await assert.rejects(rt.fetchImpl('http://blocked.test/'), (e) => {
        assert.ok(e instanceof TypeError);
        assert.equal(e.message, 'fetch failed');
        assert.equal(e.cause.code, 'EACCES');
        return true;
    });
    await assert.rejects(rt.fetchImpl('https://secure.test/'), (e) => {
        assert.equal(e.message, 'fetch failed');
        assert.equal(e.cause.code, 'ERR_NOT_SUPPORTED');
        assert.match(e.cause.message, /TLS/);
        return true;
    });
});

test('fetch honours an AbortSignal', async () => {
    const { rt, net } = await withOutbound();
    const controller = new rt.AbortController();
    const pending = rt.fetchImpl('http://slow.test/', { signal: controller.signal });
    const peer = await net.dial();
    await headOf(peer);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await until(() => peer.closed, { label: 'the aborted connection closing' });

    await assert.rejects(rt.fetchImpl('http://x.test/', { signal: rt.AbortSignal.abort('why') }), (e) => e === 'why');
});

// ── Headers / Response / Request ─────────────────────────────────────────────

test('Headers behaves like node\'s', async () => {
    const { rt } = await withOutbound();
    const init = [['B', '1'], ['a', '2'], ['b', '3'], ['Set-Cookie', 'x=1'], ['set-cookie', 'y=2']];
    const ours = new rt.Headers(init);
    const theirs = new Headers(init);
    assert.deepEqual([...ours], [...theirs]);
    assert.equal(ours.get('b'), theirs.get('b'));
    assert.deepEqual(ours.getSetCookie(), theirs.getSetCookie());
    ours.delete('A');
    assert.equal(ours.has('a'), false);
    assert.throws(() => ours.set('bad name', 'v'), TypeError);
});

test('Response statics, clone and the body stream', async () => {
    const { rt } = await withOutbound();
    const r = rt.Response.json({ a: 1 }, { status: 201 });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('content-type'), 'application/json');
    const copy = r.clone();
    assert.deepEqual(await r.json(), { a: 1 });
    const reader = copy.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), '{"a":1}');
    assert.equal((await reader.read()).done, true);
    assert.equal(rt.Response.redirect('http://x.test/', 301).headers.get('location'), 'http://x.test/');
    assert.throws(() => new rt.Response('x', { status: 100 }), RangeError);
    assert.throws(() => new rt.Request('http://x.test/', { body: 'x' }), /GET\/HEAD/);
});

test('AbortSignal.any and EventTarget once listeners', async () => {
    const { rt } = await withOutbound();
    const a = new rt.AbortController();
    const b = new rt.AbortController();
    const any = rt.AbortSignal.any([a.signal, b.signal]);
    let fired = 0;
    any.addEventListener('abort', () => fired++, { once: true });
    b.abort('second');
    a.abort('first');
    assert.equal(any.aborted, true);
    assert.equal(any.reason, 'second');
    assert.equal(fired, 1);
    assert.throws(() => any.throwIfAborted(), (e) => e === 'second');
});
