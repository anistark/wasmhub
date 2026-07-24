// Tests for the nodejs runtime's built-in modules, run under plain node via
// ./harness.mjs. Expected values are what real node produces, so a divergence
// between this runtime and node shows up as a failure rather than as a
// surprise inside somebody's sandbox.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { loadRuntime } from './harness.mjs';

const rt = await loadRuntime();

// ── querystring ───────────────────────────────────────────────────────

test('querystring round-trips and matches node', () => {
    const { querystring } = rt;

    assert.equal(querystring.stringify({ a: 1, b: 'two' }), 'a=1&b=two');
    assert.equal(querystring.stringify({ tag: ['x', 'y'] }), 'tag=x&tag=y');
    assert.equal(querystring.stringify({ 'a b': 'c d' }), 'a%20b=c%20d');
    assert.equal(querystring.stringify({}), '');
    assert.equal(querystring.stringify(null), '');

    assert.deepEqual({ ...querystring.parse('a=1&b=two') }, { a: '1', b: 'two' });
    assert.deepEqual({ ...querystring.parse('tag=x&tag=y') }, { tag: ['x', 'y'] });
    assert.deepEqual({ ...querystring.parse('flag') }, { flag: '' });
    assert.deepEqual({ ...querystring.parse('') }, {});
    // '+' means space in form-encoded input.
    assert.deepEqual({ ...querystring.parse('q=a+b') }, { q: 'a b' });

    assert.equal(querystring.encode, querystring.stringify);
    assert.equal(querystring.decode, querystring.parse);
});

test('querystring escapes the characters encodeURIComponent leaves alone', () => {
    // node's querystring.escape covers !'()* ; encodeURIComponent does not.
    assert.equal(rt.querystring.escape("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
});

test('querystring.parse resists prototype pollution', () => {
    const parsed = rt.querystring.parse('__proto__=polluted');
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal({}.polluted, undefined);
});

test('querystring.unescape survives malformed escapes', () => {
    // A bare '%' is not a valid escape; node returns the input rather than throwing.
    assert.equal(rt.querystring.unescape('100%'), '100%');
});

// ── string_decoder ────────────────────────────────────────────────────

test('StringDecoder never splits a multi-byte character', () => {
    const { StringDecoder } = rt;
    const decoder = new StringDecoder('utf8');
    const bytes = Buffer.from('héllo wörld');

    // Feed one byte at a time: the whole string must come out, in order, with
    // no replacement characters.
    let out = '';
    for (const b of bytes) out += decoder.write(Buffer.from([b]));
    out += decoder.end();
    assert.equal(out, 'héllo wörld');
    assert.ok(!out.includes('�'));
});

test('StringDecoder holds back a partial character across chunks', () => {
    const decoder = new rt.StringDecoder('utf8');
    const euro = Buffer.from('€'); // 3 bytes

    assert.equal(decoder.write(euro.subarray(0, 2)), '', 'incomplete char yields nothing');
    assert.equal(decoder.write(euro.subarray(2)), '€');
});

test('StringDecoder emits an unterminated sequence on end()', () => {
    const decoder = new rt.StringDecoder('utf8');
    assert.equal(decoder.write(Buffer.from('€').subarray(0, 2)), '');
    // No input is silently dropped, matching node.
    assert.notEqual(decoder.end(), '');
});

test('StringDecoder passes through a 4-byte emoji split anywhere', () => {
    const emoji = Buffer.from('🎉');
    for (let split = 1; split < emoji.length; split++) {
        const decoder = new rt.StringDecoder('utf8');
        const out = decoder.write(emoji.subarray(0, split)) + decoder.write(emoji.subarray(split));
        assert.equal(out, '🎉', `split at ${split}`);
    }
});

test('utf8CompleteLength stops before a partial sequence', () => {
    const { utf8CompleteLength } = rt;
    assert.equal(utf8CompleteLength(new Uint8Array([0x61, 0x62])), 2, 'plain ascii');
    // 0xE2 starts a 3-byte sequence; one byte of it alone is incomplete.
    assert.equal(utf8CompleteLength(new Uint8Array([0x61, 0xe2])), 1);
    assert.equal(utf8CompleteLength(new Uint8Array([0x61, 0xe2, 0x82])), 1);
    assert.equal(utf8CompleteLength(new Uint8Array([0x61, 0xe2, 0x82, 0xac])), 4);
});

// ── url ───────────────────────────────────────────────────────────────

test('url module re-exports the WHATWG classes', () => {
    const url = rt.builtins.url;
    assert.equal(typeof url.URL, 'function');
    assert.equal(typeof url.URLSearchParams, 'function');
    assert.equal(new url.URL('https://example.com/a?b=1').pathname, '/a');
});

test('url.parse produces the legacy shape', () => {
    const parsed = rt.builtins.url.parse('https://user:pw@example.com:8443/a/b?x=1#frag');
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.hostname, 'example.com');
    assert.equal(parsed.port, '8443');
    assert.equal(parsed.pathname, '/a/b');
    assert.equal(parsed.search, '?x=1');
    assert.equal(parsed.query, 'x=1');
    assert.equal(parsed.hash, '#frag');
    assert.equal(parsed.path, '/a/b?x=1');
    assert.equal(parsed.auth, 'user:pw');
    assert.equal(parsed.slashes, true);
});

test('url.parse can parse the query string into an object', () => {
    const parsed = rt.builtins.url.parse('https://example.com/?a=1&b=2', true);
    assert.deepEqual({ ...parsed.query }, { a: '1', b: '2' });
});

test('url.format round-trips a parsed url', () => {
    const url = rt.builtins.url;
    const input = 'https://example.com:8443/a/b?x=1#frag';
    assert.equal(url.format(url.parse(input)), input);
    assert.equal(url.format({ protocol: 'http', host: 'x.dev', pathname: '/p' }), 'http://x.dev/p');
});

test('url.resolve joins against a base', () => {
    assert.equal(rt.builtins.url.resolve('https://example.com/a/b', '../c'), 'https://example.com/c');
});

test('fileURLToPath and pathToFileURL round-trip', () => {
    const url = rt.builtins.url;
    assert.equal(url.fileURLToPath('file:///tmp/a%20b.txt'), '/tmp/a b.txt');
    assert.equal(url.pathToFileURL('/tmp/a b.txt').href, 'file:///tmp/a%20b.txt');
    assert.throws(() => url.fileURLToPath('https://example.com/x'), /scheme file/);
});

// ── crypto ────────────────────────────────────────────────────────────

const HASH_VECTORS = ['', 'abc', 'The quick brown fox jumps over the lazy dog'];

for (const algorithm of ['sha256', 'sha1', 'md5']) {
    test(`crypto.createHash('${algorithm}') matches node`, () => {
        for (const input of HASH_VECTORS) {
            assert.equal(
                rt.nodeCrypto.createHash(algorithm).update(input).digest('hex'),
                createHash(algorithm).update(input).digest('hex'),
                `${algorithm} of ${JSON.stringify(input)}`
            );
        }
    });
}

test('hashes match node across a block boundary', () => {
    // 64 bytes is the block size, so these exercise the padding edge cases:
    // one block exactly, and a length that forces an extra padding block.
    for (const size of [55, 56, 63, 64, 65, 119, 120, 200]) {
        const input = 'x'.repeat(size);
        assert.equal(
            rt.nodeCrypto.createHash('sha256').update(input).digest('hex'),
            createHash('sha256').update(input).digest('hex'),
            `length ${size}`
        );
    }
});

test('hash update() is chainable and incremental', () => {
    assert.equal(
        rt.nodeCrypto.createHash('sha256').update('foo').update('bar').digest('hex'),
        createHash('sha256').update('foobar').digest('hex')
    );
});

test('hash digest supports hex, base64, and Buffer', () => {
    const expected = createHash('sha256').update('abc').digest();
    assert.equal(rt.nodeCrypto.createHash('sha256').update('abc').digest('hex'), expected.toString('hex'));
    assert.equal(rt.nodeCrypto.createHash('sha256').update('abc').digest('base64'), expected.toString('base64'));
    const raw = rt.nodeCrypto.createHash('sha256').update('abc').digest();
    assert.equal(Buffer.from(raw).toString('hex'), expected.toString('hex'));
});

test('crypto.createHmac matches node', () => {
    for (const algorithm of ['sha256', 'sha1', 'md5']) {
        assert.equal(
            rt.nodeCrypto.createHmac(algorithm, 'secret').update('message').digest('hex'),
            createHmac(algorithm, 'secret').update('message').digest('hex'),
            algorithm
        );
    }
});

test('crypto.createHmac handles a key longer than the block size', () => {
    const key = 'k'.repeat(100); // longer than 64, so it gets hashed down first
    assert.equal(
        rt.nodeCrypto.createHmac('sha256', key).update('m').digest('hex'),
        createHmac('sha256', key).update('m').digest('hex')
    );
});

test('an unknown digest names the ones that exist', () => {
    assert.throws(() => rt.nodeCrypto.createHash('sha512'), /not supported.*sha256/s);
});

test('crypto.timingSafeEqual compares contents', () => {
    const { timingSafeEqual } = rt.nodeCrypto;
    assert.equal(timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
    assert.equal(timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
    assert.throws(() => timingSafeEqual(Buffer.from('ab'), Buffer.from('abc')), /same byte length/);
});

test('crypto.randomBytes and randomInt stay in range', () => {
    const bytes = rt.nodeCrypto.randomBytes(32);
    assert.equal(bytes.length, 32);
    for (let i = 0; i < 200; i++) {
        const n = rt.nodeCrypto.randomInt(10, 20);
        assert.ok(n >= 10 && n < 20, `randomInt returned ${n}`);
    }
    assert.match(rt.nodeCrypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ── registry ──────────────────────────────────────────────────────────

test('every built-in is reachable under its node: alias', () => {
    const { builtins } = rt;
    const plain = Object.keys(builtins).filter(k => !k.startsWith('node:'));
    assert.ok(plain.length >= 18, `expected the full registry, got ${plain.length}`);
    for (const name of plain) {
        assert.equal(builtins[`node:${name}`], builtins[name], `node:${name} should alias ${name}`);
    }
});

test('the registry carries the v0.4.0 additions', () => {
    for (const name of ['crypto', 'url', 'querystring', 'string_decoder', 'zlib',
                        'worker_threads', 'child_process', 'fs/promises', 'timers/promises']) {
        assert.ok(rt.builtins[name], `${name} should be registered`);
    }
});

test('fs.promises is exposed as a property too', () => {
    assert.equal(rt.builtins.fs.promises, rt.builtins['fs/promises']);
    assert.equal(typeof rt.builtins.fs.promises.readFile, 'function');
});

// ── modules the sandbox cannot provide ────────────────────────────────

test('unsupported modules load but throw when used', () => {
    // Loading has to work: a package that merely imports zlib should not fail.
    assert.equal(typeof rt.builtins.zlib.gzipSync, 'function');
    assert.throws(() => rt.builtins.zlib.gzipSync('x'), /not supported.*compression/);
    assert.throws(() => rt.builtins.child_process.spawn('ls'), /not supported.*no process table/);

    const err = (() => { try { rt.builtins.zlib.gzipSync('x'); } catch (e) { return e; } })();
    assert.equal(err.code, 'ERR_NOT_SUPPORTED');
});

test('worker_threads reports a single main thread', () => {
    const wt = rt.builtins.worker_threads;
    assert.equal(wt.isMainThread, true);
    assert.equal(wt.threadId, 0);
    assert.equal(wt.parentPort, null);
    assert.throws(() => new wt.Worker('x.js'), /single-threaded/);
});
