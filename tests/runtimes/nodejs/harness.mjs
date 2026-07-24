// Loads the nodejs runtime's main.js under plain node, so its pure-JS logic
// can be tested without building the wasm binary.
//
// main.js is a QuickJS ES module importing the engine's "std" and "os"
// built-ins. This rewrites those two imports into shims and appends an export
// list, then imports the result. The command dispatch at the bottom of main.js
// is guarded on `std.out` being truthy (it has to be, because QuickJS runs the
// module body during linking), so a shim with no `out` loads the definitions
// without running anything.
//
// This covers the modules that are pure computation: querystring,
// string_decoder, url, and the crypto hashes. Anything touching the
// filesystem or the event loop still needs the fixtures in ./fixtures, run
// against a built runtime.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(HERE, '../../../runtimes/nodejs/main.js');

const SHIMS = `
// Injected by tests/runtimes/nodejs/harness.mjs.
// No \`out\`: that is what keeps main.js from dispatching a command on load.
const std = { getenviron: () => ({}) };
const os = {};
const scriptArgs = [];
`;

const EXPORTS = `
export {
    builtins,
    querystring,
    StringDecoder,
    urlModule,
    nodeCrypto,
    path,
    Buffer,
    URL,
    URLSearchParams,
    sha256,
    sha1,
    md5,
    utf8CompleteLength,
};
`;

/// Load main.js and return its module namespace.
export async function loadRuntime() {
    const source = await readFile(MAIN_JS, 'utf8');
    const patched = source
        .replace('import * as std from "std";', '')
        .replace('import * as os from "os";', SHIMS);

    if (patched.includes('import * as std')) {
        throw new Error('harness could not rewrite the std/os imports; did main.js change its header?');
    }

    const dir = await mkdtemp(join(tmpdir(), 'wasmhub-nodejs-harness-'));
    const file = join(dir, 'main.harness.mjs');
    await writeFile(file, patched + EXPORTS);
    return import(pathToFileURL(file).href);
}
