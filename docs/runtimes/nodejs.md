---
title: Node.js runtime
description: JavaScript runtime for WASM, built with QuickJS targeting WASI
layout: libdoc_page.liquid
permalink: runtimes/nodejs/index.html
eleventyNavigation:
    key: Node.js
    parent: Runtimes
    order: 3
---

## Status

**Available** — `nodejs-20.wasm` is fully working. Built with [QuickJS](https://bellard.org/quickjs/) compiled to WASM via the WASI SDK.

## At a glance

| | |
|--|--|
| **Engine** | QuickJS 2024-01-13 (ES2020) |
| **Node.js compat** | v20.x API surface |
| **Binary size** | ~1.1 MB (optimized) |
| **Target** | `wasm32-wasi` (WASI Preview 1) |
| **License** | MIT |
| **Source** | <https://bellard.org/quickjs/> |

## Capabilities

- `eval` — evaluate JavaScript expressions (including complex ES2020)
- `run` — execute a `.js` file with CommonJS `require()` (requires WASI filesystem pre-open)
- `echo` — print arguments to stdout
- `env` — print environment variables
- `version` — print runtime info
- Environment variables via WASI
- Command-line args
- Standard I/O (stdin/stdout/stderr)
- Filesystem read/write (via WASI pre-open)
- ES2020: async/await, optional chaining, nullish coalescing, BigInt
- **CommonJS `require()`** with relative paths (`./foo`), absolute paths (`/abs`), JSON imports, `package.json` `main` resolution, and `node_modules` lookup walking up the directory tree
- `module.exports`, `exports`, `__filename`, `__dirname`, `require.cache`, `require.resolve`, `require.main`
- **Built-in modules:** `path`, `fs`, `os`, `buffer`, `events`, `util`, `assert`, `stream` (also under the `node:` prefix)
- **`events`** — full `EventEmitter` (`on`/`once`/`off`/`prependListener`/`removeAllListeners`/`emit`/`listeners`/`listenerCount`/`eventNames`, the `error` special-case, `newListener`/`removeListener` meta-events, static `EventEmitter.once`)
- **`util`** — `format`, `inspect`, `inherits`, `promisify`, `callbackify`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `types.*`, `TextEncoder`/`TextDecoder`
- **`assert`** — `ok`/`equal`/`strictEqual`/`deepStrictEqual`/`throws`/`rejects`/`ifError`/`match`/… plus `assert.strict` and `AssertionError`
- **`stream`** — `Readable` (incl. `Readable.from`), `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `.pipe()`
- **`Buffer`** — full `Uint8Array`-subclass implementation: `from`/`alloc`/`allocUnsafe`/`concat`/`isBuffer`/`byteLength`/`compare`, `toString`/`write`/`slice`/`copy`/`fill`/`equals`/`indexOf`/`includes`, and fixed-width int/float accessors (`readUInt32BE`, `writeDoubleLE`, …). Encodings: `utf8`, `hex`, `base64`, `base64url`, `latin1`, `ascii`, `utf16le`
- **`TextEncoder` / `TextDecoder`** (utf-8), plus `atob` / `btoa` globals
- **Binary file I/O:** `fs.readFileSync(path)` returns a `Buffer` (or a string when an encoding is given); `fs.writeFileSync` / `appendFileSync` accept a `Buffer`/`Uint8Array` or string
- **Globals:** `process` (`argv`, `env`, `cwd()`, `exit()`, `platform`, `stdout.write`, `stderr.write`, `nextTick`, `hrtime`), `global`, `console`
- **Timers & event loop:** `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, `queueMicrotask`, and a deferred `process.nextTick` — driven by the QuickJS event loop. `async`/`await`, Promise chains, and timer callbacks resolve after the entry script returns and the loop drains.
- **Web platform globals:** `URL` / `URLSearchParams` (WHATWG parsing, relative resolution against a base, `searchParams` kept in sync with the URL), `crypto.getRandomValues` / `crypto.randomUUID` (entropy from the WASI `random_get` syscall via `os.getentropy`), `structuredClone` (cycles, `Map`/`Set`/`Date`/`RegExp`/`ArrayBuffer`/TypedArrays; functions and symbols throw `DataCloneError`), and `fetch` — defined but always rejecting with a clear network-unsupported error (`code: 'ERR_NETWORK_UNSUPPORTED'`) rather than a bare `ReferenceError`

## Limitations

- No networking (WASI Preview 1 has no socket API); `fetch` exists but rejects with a clear error
- No worker threads
- No native addons (.node files)
- Built-in modules cover common APIs but not everything — `require('crypto')`/`require('url')` are not implemented as modules (the `crypto`/`URL` *globals* are — see above), and `http`/`https`/`net` (no sockets under WASI), `querystring`, `zlib`, `child_process`, `worker_threads` are not implemented; `fs` is synchronous-only (no callback/promise API, no `fs.createReadStream`)
- `Buffer` covers the common API but not everything (e.g. `swap16`/`swap32`, `BigInt64` accessors); `TextDecoder` is utf-8 only
- `stream` is a pragmatic subset (no full backpressure/highWaterMark semantics, no async iterators); `util.inspect` output approximates Node's but is not byte-identical
- Timers return a numeric id (browser-style), not a Node `Timeout` object — `.ref()`/`.unref()` are unavailable. `process.nextTick` is a microtask (no separate higher-priority queue), and the trailing-args forms are supported

## Install

```sh
wasmhub get nodejs 20
```

## Usage examples

```sh
# Print version info
wasmrun exec nodejs-20.wasm -- version

# Evaluate JavaScript
wasmrun exec nodejs-20.wasm -- eval "1 + 1"
# → 2

# Complex expressions
wasmrun exec nodejs-20.wasm -- eval "[1,2,3].map(x => x * x).join(',')"
# → 1,4,9

# Echo arguments
wasmrun exec nodejs-20.wasm -- echo hello world
# → hello world

# Print env
wasmrun exec nodejs-20.wasm -- env

# Run a JS file (requires --dir mount)
wasmrun exec --dir /path/to/scripts nodejs-20.wasm -- run /path/to/scripts/app.js
```

## CommonJS `require()`

A worked example is in `tests/runtimes/nodejs/fixtures/`:

```js
// app.js
const path = require("path");
const { square } = require("./math");
const config = require("./config.json");
const greet = require("greet");          // resolves via node_modules/greet/package.json

console.log(square(4), config.name, greet("world"));
console.log("entry:", path.basename(__filename));
console.log("require.main===module:", require.main === module);
```

Resolution rules (mirroring Node.js for the supported subset):

1. **Built-in** — `path`, `fs`, `os`, `node:path`, `node:fs`, `node:os`.
2. **Relative / absolute** — `./x`, `../x`, `/abs/x`. Tries `x`, `x.js`, `x.json`, `x/package.json` `main` field, `x/index.js`, `x/index.json`.
3. **Bare specifier** — walks up from the requiring file's directory, looking for `node_modules/<name>` and applying the same file/dir rules.

Modules are evaluated inside `new Function('exports','require','module','__filename','__dirname', src)`, the same wrapper Node.js uses. Cached in `require.cache` keyed by resolved filename.

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

let loader = RuntimeLoader::new()?;
let nodejs = loader.get_runtime(Language::NodeJs, "20").await?;
// Pass nodejs.path to your WASM runtime (wasmtime, wasmrun, etc.)
```

## Building from source

```sh
just build-nodejs
```

Requires Docker (runs inside `wasmhub-builder`). The build:
1. Downloads QuickJS 2024-01-13 source
2. Compiles `main.js` to C bytecode via native `qjsc`
3. Cross-compiles all sources with WASI SDK clang (`wasm32-wasi` target)
4. Links with 8 MB C stack (required for QuickJS's parser depth)
5. Optimizes with `wasm-opt -O3`

## Technical notes

The runtime is built from QuickJS rather than full Node.js because Node.js (V8 + libuv) cannot currently compile to WASM/WASI. QuickJS is a complete ES2020 engine in ~210 KB of C, and compiles cleanly with the WASI SDK.

Three non-obvious build issues were debugged and fixed:
- **C stack overflow** — QuickJS's parser uses deep call frames. The default WASM C stack (64 KB) is too small; fixed with `-Wl,-z,stack-size=8388608`.
- **`-fbignum` incompatibility** — `qjsc -fbignum` emits BigNum intrinsics that fail in WASI; removed.
- **Module linking phase** — QuickJS runs the module body during _linking_ before C module `init_func`s run, so `std.out` is `undefined` at that point; guarded with `if (std.out)`.

## Roadmap

- [ ] Node.js v22 and v24 builds
- [x] `node:fs` shim via WASI filesystem APIs (minimal synchronous subset)
- [x] CommonJS `require()` support — implemented in `main.js` (no bundler pre-pass needed)
- [x] `Buffer` and binary `fs` reads — `Uint8Array`-subclass `Buffer`, `TextEncoder`/`TextDecoder`, and `fs.readFileSync`→`Buffer`
- [x] `events`, `util`, `assert`, `stream` built-ins
- [ ] `crypto`, `url`, `querystring`, `zlib` built-ins
- [x] Event-loop driven `setTimeout` / `setInterval` exposed as globals (plus `setImmediate`, `queueMicrotask`, deferred `process.nextTick`)
