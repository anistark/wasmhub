// Appending to a file, sync and promise forms. The runtime opens with "ab",
// which wasi-libc turns into a path_open carrying the append fdflag, so this
// checks the host honours it: a host that drops the flag writes at offset 0
// and the append overwrites the start of the file instead.

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function main() {
    const file = path.join('/tmp', 'wasmhub-append-fixture.txt');

    fs.writeFileSync(file, 'hello');
    fs.appendFileSync(file, ' world');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello world');

    await fsp.appendFile(file, '!');
    assert.strictEqual(await fsp.readFile(file, 'utf8'), 'hello world!');

    fs.unlinkSync(file);
    console.log('append=pass');
}

main().catch((e) => {
    console.log('append=FAIL ' + (e && e.message));
    process.exit(1);
});
