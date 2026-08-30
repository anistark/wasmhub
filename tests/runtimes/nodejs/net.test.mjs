// Tests for the nodejs runtime's `net` module, run under plain node via
// ./harness.mjs with the in-memory socket host in ./fakenet.mjs standing in
// for the WASI bindings.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';
import { FakeNet, until } from './fakenet.mjs';

/// A runtime wired to a fresh fake host, with the listening descriptor in the
/// environment the way a host passes it.
async function withNet(options = {}) {
    const net = new FakeNet(options);
    const env = { WASMHUB_LISTEN_FD: String(net.listenFd) };
    if (options.addr !== null) env.WASMHUB_LISTEN_ADDR = options.addr || '127.0.0.1:8080';
    const rt = await loadRuntime({ env, sockets: net.backend });
    return { rt, net };
}

/// Closes a server and every connection it accepted. A socket left open keeps
/// the runtime's poll timer armed -- which is the point of the design, and
/// which would otherwise keep this test process alive too.
function stop(server) {
    for (const socket of Array.from(server._connections)) socket.destroy();
    if (server.listening) server.close();
}

test('net degrades to a named error when the host has no socket layer', async () => {
    const rt = await loadRuntime();   // no sockets backend
    assert.equal(rt.HAS_SOCKETS, false);

    // Present, not missing: requiring it must not read as a broken runtime.
    assert.ok(rt.builtins.net, 'net should still be registered');
    assert.ok(rt.builtins['node:net'], 'the node: alias should exist too');

    assert.throws(() => rt.builtins.net.createServer(), (err) => {
        assert.equal(err.code, 'ERR_NOT_SUPPORTED');
        assert.match(err.message, /net\.createServer/);
        assert.match(err.message, /Preview 1 cannot bind a port/);
        return true;
    });
    assert.throws(() => rt.builtins.http.createServer(), /ERR_NOT_SUPPORTED|not supported/);
});

test('net is a working module when the socket bindings are present', async () => {
    const { rt } = await withNet();
    assert.equal(rt.HAS_SOCKETS, true);
    assert.equal(rt.builtins.net, rt.netModule);
    assert.equal(typeof rt.netModule.createServer, 'function');
});

test('outbound connect reports why it cannot work', async () => {
    const { rt } = await withNet();
    for (const api of ['connect', 'createConnection']) {
        assert.throws(() => rt.netModule[api]('127.0.0.1', 80), (err) => {
            assert.equal(err.code, 'ERR_NOT_SUPPORTED');
            assert.match(err.message, /no outbound connect/);
            return true;
        }, `net.${api} should explain itself`);
    }
});

test('listen without a host-provided descriptor emits a usable error', async () => {
    const net = new FakeNet();
    const rt = await loadRuntime({ env: {}, sockets: net.backend });
    const server = rt.netModule.createServer();

    const err = await new Promise((resolve) => {
        server.on('error', resolve);
        server.listen(8080);
    });
    assert.equal(err.code, 'ERR_SOCKET_NO_LISTENER');
    assert.match(err.message, /WASMHUB_LISTEN_FD/);
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
});

test('listen adopts the descriptor and reports the address it was given', async () => {
    const { rt } = await withNet({ addr: '127.0.0.1:8080' });
    const server = rt.netModule.createServer();

    await new Promise((resolve) => server.listen(8080, resolve));
    assert.equal(server.listening, true);
    assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: 8080 });
    stop(server);
});

test('an IPv6 listen address parses into the right family', async () => {
    const { rt } = await withNet({ addr: '[::1]:9000' });
    const server = rt.netModule.createServer();
    await new Promise((resolve) => server.listen(resolve));
    assert.deepEqual(server.address(), { address: '::1', family: 'IPv6', port: 9000 });
    stop(server);
});

test('a connection is accepted, read and answered', async () => {
    const { rt, net } = await withNet();
    const server = rt.netModule.createServer((socket) => {
        socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    peer.send('hello');

    await until(() => peer.text() === 'echo:hello', { label: 'the echoed reply' });
    stop(server);
});

test('the peer half-closing surfaces as end, not as an empty read', async () => {
    const { rt, net } = await withNet();
    const seen = [];
    const server = rt.netModule.createServer((socket) => {
        socket.on('data', (c) => seen.push(c.toString()));
        socket.on('end', () => seen.push('<end>'));
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    peer.send('one');
    peer.end('two');

    await until(() => seen.includes('<end>'), { label: 'the end event' });
    assert.equal(seen.join(''), 'onetwo<end>');
    stop(server);
});

test('a write larger than the host will take in one call still arrives whole', async () => {
    // maxSend forces sockSend to report short writes, which is the ordinary
    // case on a real non-blocking socket.
    const { rt, net } = await withNet({ maxSend: 3 });
    const payload = 'x'.repeat(5000);
    const server = rt.netModule.createServer((socket) => {
        socket.on('data', () => socket.write(payload));
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    peer.send('go');

    await until(() => peer.received().length === payload.length, { label: 'the whole payload' });
    assert.equal(peer.text(), payload);
    stop(server);
});

test('reads spanning several host calls are reassembled in order', async () => {
    const { rt, net } = await withNet();
    let received = '';
    const server = rt.netModule.createServer((socket) => {
        socket.on('data', (c) => { received += c.toString(); });
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    for (let i = 0; i < 50; i++) peer.send(`${i},`);

    await until(() => received.endsWith('49,'), { label: 'every chunk' });
    assert.equal(received, Array.from({ length: 50 }, (_, i) => `${i},`).join(''));
    stop(server);
});

test('ending the server socket shuts down the write side', async () => {
    const { rt, net } = await withNet();
    const server = rt.netModule.createServer((socket) => {
        socket.end('bye');
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    await until(() => peer.ended, { label: 'the shutdown' });
    assert.equal(peer.text(), 'bye');
    stop(server);
});

test('close stops accepting and emits close once connections are done', async () => {
    const { rt, net } = await withNet();
    const sockets = [];
    const server = rt.netModule.createServer((socket) => sockets.push(socket));
    await new Promise((resolve) => server.listen(8080, resolve));

    const peer = net.connect();
    await until(() => sockets.length === 1, { label: 'the connection' });

    const closed = new Promise((resolve) => server.on('close', resolve));
    stop(server);
    assert.equal(server.listening, false);

    // Still open, so the server has not finished closing yet.
    sockets[0].destroy();
    await closed;
    assert.equal(peer.closed, true);
});

test('a second server cannot claim the same listening descriptor', async () => {
    const { rt } = await withNet();
    const first = rt.netModule.createServer();
    await new Promise((resolve) => first.listen(8080, resolve));

    const second = rt.netModule.createServer();
    const err = await new Promise((resolve) => {
        second.on('error', resolve);
        second.listen(8080);
    });
    assert.equal(err.code, 'EADDRINUSE');

    // Closing the first releases it, so a later listen succeeds.
    stop(first);
    const third = rt.netModule.createServer();
    await new Promise((resolve) => third.listen(8080, resolve));
    assert.equal(third.listening, true);
    stop(third);
});

test('a host error on accept reaches the server as an error event', async () => {
    const { rt, net } = await withNet();
    const server = rt.netModule.createServer();
    await new Promise((resolve) => server.listen(8080, resolve));

    // What a host refusing on policy grounds looks like from the guest side.
    net.listenerClosed = true;
    const err = await new Promise((resolve) => server.on('error', resolve));
    assert.equal(err.code, 'EBADF');
    assert.equal(err.syscall, 'accept');
    stop(server);
});

test('isIP recognises the addresses it should and rejects the rest', async () => {
    const { rt } = await withNet();
    const { isIP, isIPv4, isIPv6 } = rt.netModule;

    for (const good of ['0.0.0.0', '127.0.0.1', '255.255.255.255']) {
        assert.equal(isIPv4(good), true, good);
        assert.equal(isIP(good), 4, good);
    }
    for (const bad of ['256.0.0.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', '', 'localhost']) {
        assert.equal(isIPv4(bad), false, bad);
    }
    for (const good of ['::1', '::', '2001:db8::1', '::ffff:127.0.0.1',
                        'fe80:0:0:0:0:0:0:1', '2001:0db8:0000:0000:0000:0000:0000:0001']) {
        assert.equal(isIPv6(good), true, good);
        assert.equal(isIP(good), 6, good);
    }
    for (const bad of ['1:2:3', '::1::2', 'gggg::1', '2001:db8:::1']) {
        assert.equal(isIPv6(bad), false, bad);
    }
    assert.equal(isIP('nope'), 0);
});
