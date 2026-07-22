// Smoke test for the built-in modules that need a real runtime: the ones
// touching the filesystem or the event loop. The pure-computation modules
// (querystring, string_decoder, url, crypto hashes) are covered under plain
// node by ../builtins.test.mjs, which cross-checks them against node itself.

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const path = require('node:path');
const timers = require('node:timers/promises');
const crypto = require('node:crypto');

async function main() {
    // ── fs/promises ───────────────────────────────────────────────────
    const file = path.join('/tmp', 'wasmhub-builtins-fixture.txt');
    await fsp.writeFile(file, 'hello');
    assert.strictEqual(await fsp.readFile(file, 'utf8'), 'hello');
    await fsp.appendFile(file, ' world');
    assert.strictEqual(await fsp.readFile(file, 'utf8'), 'hello world');

    const stat = await fsp.stat(file);
    assert.strictEqual(stat.size, 11);

    // access resolves for a file that exists and rejects for one that does not
    await fsp.access(file);
    let missed = false;
    try { await fsp.access('/tmp/definitely-not-here'); } catch (e) { missed = e.code === 'ENOENT'; }
    assert.ok(missed, 'access should reject with ENOENT');

    await fsp.unlink(file);
    console.log('fs/promises=ok');

    // The same object is reachable both ways.
    assert.strictEqual(require('fs').promises.readFile, fsp.readFile);
    console.log('fs.promises=ok');

    // ── timers/promises ───────────────────────────────────────────────
    const started = Date.now();
    await timers.setTimeout(20);
    assert.ok(Date.now() - started >= 15, 'setTimeout should actually wait');
    assert.strictEqual(await timers.setTimeout(1, 'value'), 'value');
    assert.strictEqual(await timers.setImmediate('now'), 'now');
    await timers.scheduler.wait(1);

    let ticks = 0;
    for await (const _ of timers.setInterval(5)) {
        if (++ticks === 3) break;
    }
    assert.strictEqual(ticks, 3);
    console.log('timers/promises=ok');

    // ── crypto entropy through the runtime ────────────────────────────
    // Under WASI this comes from random_get, so it is worth checking in the
    // real runtime rather than only under node.
    const bytes = crypto.randomBytes(16);
    assert.strictEqual(bytes.length, 16);
    assert.ok(bytes.some(b => b !== 0), 'randomBytes should not be all zeros');
    assert.strictEqual(crypto.createHash('sha256').update('abc').digest('hex'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    console.log('crypto=ok');

    // ── stubs are present and honest ──────────────────────────────────
    assert.throws(() => require('zlib').gzipSync('x'), /not supported/);
    assert.throws(() => require('child_process').spawn('ls'), /not supported/);
    assert.strictEqual(require('worker_threads').isMainThread, true);
    console.log('stubs=ok');

    console.log('builtins=pass');
}

main().catch(e => {
    console.log('builtins=FAIL ' + (e && e.message));
    process.exit(1);
});
