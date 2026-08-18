// Smoke test for standard input, which needs a real runtime: the host has to
// put bytes on fd 0. Feed it through the runner, e.g.
//   echo -n 'hello from the host' | wasmrun exec --dir . nodejs-20.wasm -- run stdin.js
//
// Expects exactly 'hello from the host' on stdin.

const assert = require('node:assert');
const fs = require('node:fs');

const EXPECTED = 'hello from the host';

async function main() {
    // The stream: data/end events, which is what most code reaches for.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const streamed = Buffer.concat(chunks).toString('utf8');
    assert.strictEqual(streamed, EXPECTED);
    console.log('stdin.stream=ok');

    // fd 0 is drained once and shared, so these see the same bytes rather
    // than an empty read.
    assert.strictEqual(fs.readFileSync(0, 'utf8'), EXPECTED);
    assert.strictEqual(fs.readFileSync('/dev/stdin', 'utf8'), EXPECTED);
    console.log('stdin.fs=ok');

    assert.strictEqual(process.stdin.isTTY, false);
    assert.strictEqual(require('node:tty').isatty(0), false);
    console.log('stdin.tty=ok');

    // require('node:process') is the global, not a copy of it.
    assert.strictEqual(require('node:process'), process);
    console.log('stdin.process=ok');

    console.log('stdin=pass');
}

main().catch((e) => {
    console.error('stdin=FAIL', e && e.message);
    process.exit(1);
});
