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
// The shims are backed by an in-memory filesystem and stdin buffer that a test
// supplies through `loadRuntime({ files, stdin })`, which is what lets the
// module resolver and the stdin path be tested here rather than only against a
// built runtime. Anything touching the real event loop still needs the
// fixtures in ./fixtures.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vm from 'node:vm';

// Reachable from the injected shims, which are plain source text with no
// imports of their own.
globalThis.__wasmhubVm = vm;

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(HERE, '../../../runtimes/nodejs/main.js');

// The shims read their state from a per-load object on globalThis, keyed by
// the module's own temp path, so two runtimes loaded in one test file cannot
// see each other's files.
const SHIMS = `
// Injected by tests/runtimes/nodejs/harness.mjs.
// No \`out\`: that is what keeps main.js from dispatching a command on load.
const __h = globalThis.__wasmhubHarness[__HARNESS_KEY__];

const S_IFREG = 0o100000;
const S_IFDIR = 0o40000;

function __entry(p) {
    if (Object.prototype.hasOwnProperty.call(__h.files, p)) return __h.files[p];
    // A path with children is a directory.
    const prefix = p.endsWith('/') ? p : p + '/';
    for (const k of Object.keys(__h.files)) {
        if (k.startsWith(prefix)) return null;
    }
    return undefined;
}

function __fileHandle(content) {
    const bytes = new TextEncoder().encode(content);
    let pos = 0;
    return {
        read(buffer, offset, length) {
            const n = Math.min(length, bytes.length - pos);
            if (n <= 0) return 0;
            new Uint8Array(buffer).set(bytes.subarray(pos, pos + n), offset);
            pos += n;
            return n;
        },
        readAsString() { const s = content.slice(pos); pos = bytes.length; return s; },
        eof() { return pos >= bytes.length; },
        close() {},
    };
}

const std = {
    getenviron: () => __h.env,
    loadFile: (p) => (typeof __entry(p) === 'string' ? __entry(p) : null),
    open: (p) => (typeof __entry(p) === 'string' ? __fileHandle(__entry(p)) : null),
    // Real std.exit ends the process. Recording the code and throwing a marker
    // is the closest a test can get: execution stops at the same point, and the
    // code is still there to assert on afterwards.
    exit(code) {
        __h.exitCode = code | 0;
        const e = new Error(\`std.exit(\${__h.exitCode})\`);
        e.__wasmhubExit = __h.exitCode;
        throw e;
    },
    // Backed by node's vm so the "filename" option behaves as it does under the
    // patched QuickJS: frames name the script and line numbers are its own.
    evalScript(src, options) {
        return globalThis.__wasmhubVm.runInThisContext(src, { filename: (options && options.filename) || '<evalScript>' });
    },
    in: {
        read(buffer, offset, length) {
            const n = Math.min(length, __h.stdin.length - __h.stdinPos);
            if (n <= 0) return 0;
            new Uint8Array(buffer).set(__h.stdin.subarray(__h.stdinPos, __h.stdinPos + n), offset);
            __h.stdinPos += n;
            return n;
        },
    },
};

const os = {
    // The runtime's timers and its socket poll loop both need a real timer;
    // node's is close enough to QuickJS's os.setTimeout for both.
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    getcwd: () => [__h.cwd, 0],
    stat: (p) => {
        const e = __entry(p);
        if (e === undefined) return [null, 2 /* ENOENT */];
        return [{
            mode: e === null ? S_IFDIR : S_IFREG,
            size: e === null ? 0 : new TextEncoder().encode(e).length,
        }, 0];
    },
};

// Defined only when a test supplies a backend, so that HAS_SOCKETS is false
// otherwise and the degraded net/http path is exercised as it would be on a
// host with no socket layer at all.
if (__h.sockets) {
    os.sockAccept = (fd) => __h.sockets.accept(fd);
    os.sockRecv = (fd, ab, off, len) => __h.sockets.recv(fd, ab, off, len);
    os.sockSend = (fd, ab, off, len) => __h.sockets.send(fd, ab, off, len);
    os.sockShutdown = (fd, how) => __h.sockets.shutdown(fd, how);
    os.sockClose = (fd) => __h.sockets.close(fd);
    os.sockNonblocking = (fd) => __h.sockets.nonblocking(fd);
}

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
    tty,
    fs,
    Readable,
    resolveModule,
    makeRequire,
    readStdinBytes,
    makeStdinStream,
    nodeTest,
    setupGlobals,
    netModule,
    httpModule,
    HAS_SOCKETS,
    STATUS_CODES,
};
`;

let seq = 0;

/// Load main.js and return its module namespace.
///
/// `files` maps absolute paths to file contents; any path with children is
/// treated as a directory. `stdin` is a string or Buffer served on fd 0.
/// `sockets` is a backend for the os.sock* bindings (see ./fakenet.mjs);
/// leaving it out is what a host with no socket layer looks like.
export async function loadRuntime(options = {}) {
    return (await loadRuntimeWithState(options)).runtime;
}

/// Load main.js and return both its namespace and the harness state backing
/// the shims, for tests that need to read what the runtime did to it —
/// `state.exitCode` is what std.exit recorded.
export async function loadRuntimeWithState(options = {}) {
    const key = `run${seq++}`;
    globalThis.__wasmhubHarness = globalThis.__wasmhubHarness || {};
    globalThis.__wasmhubHarness[key] = {
        files: options.files || {},
        env: options.env || {},
        cwd: options.cwd || '/',
        stdin: Buffer.from(options.stdin || ''),
        stdinPos: 0,
        sockets: options.sockets || null,
        exitCode: null,
    };

    const source = await readFile(MAIN_JS, 'utf8');
    const patched = source
        .replace('import * as std from "std";', '')
        .replace('import * as os from "os";', SHIMS.replace('__HARNESS_KEY__', JSON.stringify(key)));

    if (patched.includes('import * as std')) {
        throw new Error('harness could not rewrite the std/os imports; did main.js change its header?');
    }

    const dir = await mkdtemp(join(tmpdir(), 'wasmhub-nodejs-harness-'));
    const file = join(dir, 'main.harness.mjs');
    await writeFile(file, patched + EXPORTS);
    return {
        runtime: await import(pathToFileURL(file).href),
        state: globalThis.__wasmhubHarness[key],
    };
}
