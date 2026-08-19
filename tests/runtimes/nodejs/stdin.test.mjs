// Tests for standard input and the process/tty modules, run under plain node
// via ./harness.mjs, whose shims serve fd 0 from a buffer the test supplies.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';

/// Collect a stream's chunks through its 'data' events.
function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

test('stdin reads to end of file', async () => {
    const rt = await loadRuntime({ stdin: 'hello stdin' });
    assert.equal(rt.readStdinBytes().toString(), 'hello stdin');
});

test('stdin is read once and cached for every consumer', async () => {
    const rt = await loadRuntime({ stdin: 'once' });
    assert.equal(rt.readStdinBytes().toString(), 'once');
    // fd 0 cannot be rewound: a second read must see the same bytes rather
    // than an empty buffer.
    assert.equal(rt.readStdinBytes().toString(), 'once');
    assert.equal(rt.fs.readFileSync('/dev/stdin', 'utf8'), 'once');
});

test('stdin spans more than one read chunk', async () => {
    const big = 'x'.repeat(200_000);
    const rt = await loadRuntime({ stdin: big });
    assert.equal(rt.readStdinBytes().length, big.length);
});

test('stdin is binary safe', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a]);
    const rt = await loadRuntime({ stdin: bytes });
    assert.deepEqual(Buffer.from(rt.readStdinBytes()), bytes);
});

test('empty stdin is an immediate end of file', async () => {
    const rt = await loadRuntime({ stdin: '' });
    assert.equal(rt.readStdinBytes().length, 0);

    const stream = rt.makeStdinStream();
    assert.equal((await collect(stream)).length, 0);
});

test('process.stdin is a readable stream', async () => {
    const rt = await loadRuntime({ stdin: 'streamed input' });
    const stream = rt.makeStdinStream();

    assert.equal(stream.fd, 0);
    assert.equal(stream.isTTY, false);
    assert.equal((await collect(stream)).toString(), 'streamed input');
});

test('process.stdin supports read() and async iteration', async () => {
    const direct = await loadRuntime({ stdin: 'sync read' });
    assert.equal(direct.makeStdinStream().read().toString(), 'sync read');

    const iterated = await loadRuntime({ stdin: 'for await' });
    const chunks = [];
    for await (const chunk of iterated.makeStdinStream()) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'for await');
});

test('process.stdin honors setEncoding and pipe', async () => {
    const rt = await loadRuntime({ stdin: 'piped' });
    const stream = rt.makeStdinStream();
    stream.setEncoding('utf8');

    const written = [];
    const sink = { write: (chunk) => { written.push(chunk); return true; }, end: () => {}, emit: () => {} };
    stream.pipe(sink);
    await new Promise((resolve) => stream.on('end', resolve));
    assert.equal(written.join(''), 'piped');
});

test('fs.readFileSync reads stdin by path and by descriptor', async () => {
    const rt = await loadRuntime({ stdin: 'from fd 0' });
    assert.equal(rt.fs.readFileSync(0, 'utf8'), 'from fd 0');

    const byPath = await loadRuntime({ stdin: 'from /dev/stdin' });
    const buf = byPath.fs.readFileSync('/dev/stdin');
    assert.ok(Buffer.isBuffer(Buffer.from(buf)));
    assert.equal(buf.toString(), 'from /dev/stdin');
});

// ── process and tty as modules ────────────────────────────────────────

test('require("process") hands back the global object', async () => {
    const rt = await loadRuntime();
    // The registry entry is an accessor, so it tracks whatever setupGlobals
    // installs rather than a snapshot taken at load time.
    const marker = { argv: ['nodejs'] };
    const previous = globalThis.process;
    try {
        globalThis.process = marker;
        assert.equal(rt.builtins['process'], marker);
        assert.equal(rt.builtins['node:process'], marker);
    } finally {
        globalThis.process = previous;
    }
});

test('tty reports that nothing is a terminal', async () => {
    const rt = await loadRuntime();
    const { tty } = rt;

    assert.equal(tty.isatty(0), false);
    assert.equal(tty.isatty(1), false);
    assert.equal(tty.isatty(2), false);
    assert.throws(() => tty.isatty('1'), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => new tty.ReadStream(0), { code: 'ERR_NOT_SUPPORTED' });
    assert.throws(() => new tty.WriteStream(1), { code: 'ERR_NOT_SUPPORTED' });
    assert.equal(rt.builtins['tty'], tty);
    assert.equal(rt.builtins['node:tty'], tty);
});
