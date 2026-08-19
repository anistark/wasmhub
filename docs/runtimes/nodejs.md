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
- **Built-in modules:** `path`, `fs`, `fs/promises`, `os`, `buffer`, `events`, `util`, `assert`, `stream`, `crypto`, `url`, `querystring`, `string_decoder`, `timers`, `timers/promises`, `process`, `tty` (all also under the `node:` prefix), plus `node:test`, which is prefix-only as it is in Node
- **`events`** — full `EventEmitter` (`on`/`once`/`off`/`prependListener`/`removeAllListeners`/`emit`/`listeners`/`listenerCount`/`eventNames`, the `error` special-case, `newListener`/`removeListener` meta-events, static `EventEmitter.once`)
- **`util`** — `format`, `inspect`, `inherits`, `promisify`, `callbackify`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `types.*`, `TextEncoder`/`TextDecoder`
- **`assert`** — `ok`/`equal`/`strictEqual`/`deepStrictEqual`/`throws`/`rejects`/`ifError`/`match`/… plus `assert.strict` and `AssertionError`
- **`stream`** — `Readable` (incl. `Readable.from`), `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `.pipe()`
- **`crypto`** — `createHash` and `createHmac` (`sha256`, `sha1`, `md5`), `randomBytes`, `randomInt`, `randomUUID`, `randomFillSync`, `timingSafeEqual`, `getHashes`, and `webcrypto`. Digests are implemented in the runtime itself, so no crypto library is linked in
- **`url`** — the WHATWG `URL`/`URLSearchParams` classes plus the legacy `parse`/`format`/`resolve` API, `fileURLToPath`/`pathToFileURL`, and `domainToASCII`/`domainToUnicode`
- **`querystring`** — `parse`/`stringify`/`escape`/`unescape` with the `decode`/`encode` aliases. Parsed objects have a null prototype, so a `__proto__` key in a query string cannot pollute anything
- **`string_decoder`** — `StringDecoder` for `utf8`, `base64`, `hex`, `latin1`, and `utf16le`, holding back partial sequences so a multi-byte character is never split across chunks
- **`fs/promises`** — the promise API over the same synchronous implementations, also reachable as `fs.promises`
- **`node:test`** — the built-in test runner: `test`/`it` with sync, async, promise and callback bodies, `describe`/`suite` nesting, `before`/`after`/`beforeEach`/`afterEach`, `skip`/`todo` as methods, options or context calls, TAP 13 output shaped like Node's, and a non-zero exit code when anything fails
- **`process`** — the same object as the `process` global, so `require('node:process')` and the global cannot diverge
- **`tty`** — `isatty()`, which answers `false`: nothing in the sandbox is a terminal. `ReadStream`/`WriteStream` throw `ERR_NOT_SUPPORTED` rather than pretending to open a device
- **`timers` / `timers/promises`** — the callback forms plus promise `setTimeout`/`setImmediate`, `setInterval` as an async generator, and `scheduler.wait`
- **`Buffer`** — full `Uint8Array`-subclass implementation: `from`/`alloc`/`allocUnsafe`/`concat`/`isBuffer`/`byteLength`/`compare`, `toString`/`write`/`slice`/`copy`/`fill`/`equals`/`indexOf`/`includes`, and fixed-width int/float accessors (`readUInt32BE`, `writeDoubleLE`, …). Encodings: `utf8`, `hex`, `base64`, `base64url`, `latin1`, `ascii`, `utf16le`
- **`TextEncoder` / `TextDecoder`** (utf-8), plus `atob` / `btoa` globals
- **Binary file I/O:** `fs.readFileSync(path)` returns a `Buffer` (or a string when an encoding is given); `fs.writeFileSync` / `appendFileSync` accept a `Buffer`/`Uint8Array` or string
- **Standard input:** `process.stdin` is a readable stream over fd 0 (`data`/`end` events, `read()`, `pipe()`, `setEncoding`, and `for await`), and `fs.readFileSync(0)` / `fs.readFileSync('/dev/stdin')` read the same bytes. fd 0 can only be drained once, so the input is read on first use and shared between them; no input at all is an immediate end of file rather than a hang
- **Globals:** `process` (`argv`, `env`, `cwd()`, `exit()`, `platform`, `stdout.write`, `stderr.write`, `stdin`, `nextTick`, `hrtime`), `global`, `console`
- **Timers & event loop:** `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, `queueMicrotask`, and a deferred `process.nextTick` — driven by the QuickJS event loop. `async`/`await`, Promise chains, and timer callbacks resolve after the entry script returns and the loop drains.
- **Web platform globals:** `URL` / `URLSearchParams` (WHATWG parsing, relative resolution against a base, `searchParams` kept in sync with the URL), `crypto.getRandomValues` / `crypto.randomUUID` (entropy from the WASI `random_get` syscall via `os.getentropy`), `structuredClone` (cycles, `Map`/`Set`/`Date`/`RegExp`/`ArrayBuffer`/TypedArrays; functions and symbols throw `DataCloneError`), and `fetch` — defined but always rejecting with a clear network-unsupported error (`code: 'ERR_NETWORK_UNSUPPORTED'`) rather than a bare `ReferenceError`

## Limitations

- No networking (WASI Preview 1 has no socket API); `fetch` exists but rejects with a clear error
- No worker threads (`worker_threads` reports `isMainThread: true`; constructing a `Worker` throws)
- No native addons (.node files)
- Built-in modules cover common APIs but not everything. `http`/`https`/`net` are absent (no sockets under WASI). `zlib`, `child_process`, and `worker_threads` are *present but throw* `ERR_NOT_SUPPORTED` when used, with a message naming the constraint: a package that merely imports one keeps working, and one that calls it gets a clear error instead of "Cannot find module"
- `fs` is synchronous under the hood. `fs/promises` and `fs.promises` wrap the same calls, so they resolve immediately rather than doing real async I/O, and `fs.createReadStream` is unavailable
- `crypto` offers `sha256`/`sha1`/`md5` only; other digests throw an error naming the ones that exist. There is no `createCipheriv`, no key generation, and no certificate handling
- `Buffer` covers the common API but not everything (e.g. `swap16`/`swap32`, `BigInt64` accessors); `TextDecoder` is utf-8 only
- `stream` is a pragmatic subset (no full backpressure/highWaterMark semantics), though `Readable` does support `for await`; `util.inspect` output approximates Node's but is not byte-identical
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
3. **Bare specifier** — walks up from the requiring file's directory looking for `node_modules/<name>`. A package that declares `exports` is resolved through it; one that does not falls back to the `main`/index rules above.

### `exports` maps

Most packages published since 2021 declare their entry points in `exports` rather than `main`, and a package with `exports` is also sealed: only what it lists is reachable.

- Conditions are matched in the order the package wrote them, which is what the specification says and what resolves `{"import": …, "require": …}` correctly. The set is `require`, `node` and `default`; `import` is not in it, because the module wrapper is CommonJS
- The `"."` root key, subpaths (`require('pkg/sub')`), and subpath patterns (`"./*": "./dist/*.js"`) all resolve, with the longest matching prefix winning
- A `null` target blocks the subpath with `ERR_PACKAGE_PATH_NOT_EXPORTED`, as does a subpath the map does not cover, even when the file exists
- If no condition matches at the package root, resolution falls back to `main`. That is what an ES module package looks like once it has been lowered to CommonJS in place, which is how wasmrun ships them into the sandbox

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
- [x] `crypto`, `url`, `querystring`, `string_decoder` built-ins (plus `fs/promises` and `timers/promises`)
- [ ] `zlib`, `child_process`, `worker_threads` beyond the present-but-throwing stubs
- [x] `node:test` runner, `exports`-map resolution, readable `process.stdin`
- [ ] Native ESM in the module wrapper (`import` is lowered to CommonJS before it reaches the runtime today)
- [x] Event-loop driven `setTimeout` / `setInterval` exposed as globals (plus `setImmediate`, `queueMicrotask`, deferred `process.nextTick`)
