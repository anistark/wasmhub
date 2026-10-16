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

It ships in two builds from the same source:

| Build | Manifest key | Networking | Runs on |
|---|---|---|---|
| `nodejs-20.wasm` | `20` (`latest`) | Serves connections a host hands in | Any WASI Preview 1 host |
| `nodejs-20-net.wasm` | `20-net` | Also opens them: `net.connect`, `http.request`, `fetch` | Hosts with wasmrun's `sock_open`/`sock_connect` extensions |

The `-net` build imports two calls Preview 1 does not have, so a host without them (plain wasmtime, say) cannot instantiate it. `latest` stays the portable build. See [Networking](#networking).

## At a glance

| | |
|--|--|
| **Engine** | QuickJS 2024-01-13 (ES2020) |
| **Node.js compat** | v20.x API surface |
| **Binary size** | ~1.3 MB (optimized), either build |
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
- **Built-in modules:** `path`, `fs`, `fs/promises`, `os`, `buffer`, `events`, `util`, `assert`, `stream`, `crypto`, `url`, `querystring`, `string_decoder`, `timers`, `timers/promises`, `console`, `process`, `tty`, `net`, `http`, `async_hooks` (all also under the `node:` prefix), plus `node:test`, which is prefix-only as it is in Node
- **`events`** — full `EventEmitter` (`on`/`once`/`off`/`prependListener`/`removeAllListeners`/`emit`/`listeners`/`listenerCount`/`eventNames`, the `error` special-case, `newListener`/`removeListener` meta-events, static `EventEmitter.once`)
- **`util`** — `format`, `inspect`, `inherits`, `promisify`, `callbackify`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `types.*`, `TextEncoder`/`TextDecoder`
- **`assert`** — `ok`/`equal`/`strictEqual`/`deepStrictEqual`/`throws`/`rejects`/`ifError`/`match`/… plus `assert.strict` and `AssertionError`
- **`stream`** — `Readable` (incl. `Readable.from`), `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `.pipe()`
- **`crypto`** — `createHash` and `createHmac` over `md5`, `sha1`, `sha224`, `sha256`, `sha384` and `sha512` (also spelled `SHA-256`, `RSA-SHA256`), `Hash#copy`, `pbkdf2`/`pbkdf2Sync`, `createSecretKey`, `hash()`, `randomBytes`, `randomInt`, `randomUUID`, `randomFillSync`, `timingSafeEqual`, `getHashes`, and `webcrypto` with `subtle.digest`. The digests are compiled C (`runtimes/nodejs/hash.c`), not JavaScript: under an interpreting host such as wasmrun, hashing 64 KiB takes about a fifth of a second where the old pure-JS digests took minutes. No crypto library is linked in
- **`async_hooks`** — `AsyncLocalStorage` (`run`, `getStore`, `exit`, `enterWith`, `disable`, `bind`, `snapshot`) and `AsyncResource` (`runInAsyncScope`, `bind`). A store set with `run()` survives `await`, promise chains, timers and socket events started inside it, including an await on a promise some other code settles; a wasmhub engine patch carries the context through every promise reaction. `createHook` is present, and its callbacks never fire
- **`url`** — the WHATWG `URL`/`URLSearchParams` classes plus the legacy `parse`/`format`/`resolve` API, `fileURLToPath`/`pathToFileURL`, and `domainToASCII`/`domainToUnicode`
- **`querystring`** — `parse`/`stringify`/`escape`/`unescape` with the `decode`/`encode` aliases. Parsed objects have a null prototype, so a `__proto__` key in a query string cannot pollute anything
- **`string_decoder`** — `StringDecoder` for `utf8`, `base64`, `hex`, `latin1`, and `utf16le`, holding back partial sequences so a multi-byte character is never split across chunks
- **`fs/promises`** — the promise API over the same synchronous implementations, also reachable as `fs.promises`
- **`node:test`** — the built-in test runner: `test`/`it` with sync, async, promise and callback bodies, `describe`/`suite` nesting, `before`/`after`/`beforeEach`/`afterEach`, `skip`/`todo` as methods, options or context calls, TAP 13 output shaped like Node's, and a non-zero exit code when anything fails
- **`process`** — the same object as the `process` global, so `require('node:process')` and the global cannot diverge
- **`console`** — the global console, formatted with `util.format` the way Node's is: `log`/`info`/`debug` to stdout, `error`/`warn`/`trace` to stderr, plus `dir`, `assert`, `count`/`countReset`, `time`/`timeLog`/`timeEnd`, `group`/`groupEnd` indentation, `table`, and the `Console` class. Methods are bound, so `const { log } = console` works, and output goes through `process.stdout`/`process.stderr`, so replacing their `write` captures it
- **`net`** — `createServer`, `Server` (`listen`/`close`/`address`/`getConnections`, `connection`/`listening`/`close`/`error` events), `Socket` as a duplex stream (`data`/`end`/`error`/`close`, `write`, `end`, `destroy`, `pipe`, `for await`, an idle `setTimeout`), and `isIP`/`isIPv4`/`isIPv6`. `connect`/`createConnection`/`Socket#connect` work in the `-net` build; elsewhere they throw `ERR_NOT_SUPPORTED`. See [Networking](#networking)
- **`http`** — the server half over `net`: `createServer`, `IncomingMessage` (method, url, lowercased `headers`, `rawHeaders`, body as a readable stream), `ServerResponse` (`writeHead`, `setHeader`/`getHeader`/`removeHeader`, `write`, `end`), `STATUS_CODES` and `METHODS`. Request bodies are decoded by `Content-Length` or `Transfer-Encoding: chunked`; responses are chunked automatically when their length is not known in advance, and HTTP/1.1 keep-alive is honoured when the response can delimit itself. In the `-net` build, the client half too: `request`/`get`, `ClientRequest` (headers, `write`/`end`, `setTimeout`, `abort`/`destroy`, `signal`), with a body of known length sent with `Content-Length` and a streamed one chunked, as Node does; responses delimited by length, by chunks, or by the connection closing, and interim `1xx` responses as `'information'` events. One connection per request (`Connection: close`); `Agent` is accepted and does not pool. Elsewhere `request`/`get` throw `ERR_NOT_SUPPORTED`
- **`tty`** — `isatty()`, which answers `false`: nothing in the sandbox is a terminal. `ReadStream`/`WriteStream` throw `ERR_NOT_SUPPORTED` rather than pretending to open a device
- **`timers` / `timers/promises`** — the callback forms plus promise `setTimeout`/`setImmediate`, `setInterval` as an async generator, and `scheduler.wait`
- **`Buffer`** — full `Uint8Array`-subclass implementation: `from`/`alloc`/`allocUnsafe`/`concat`/`isBuffer`/`byteLength`/`compare`, `toString`/`write`/`slice`/`copy`/`fill`/`equals`/`indexOf`/`includes`, and fixed-width int/float accessors (`readUInt32BE`, `writeDoubleLE`, …). Encodings: `utf8`, `hex`, `base64`, `base64url`, `latin1`, `ascii`, `utf16le`
- **`TextEncoder` / `TextDecoder`** (utf-8), plus `atob` / `btoa` globals
- **Binary file I/O:** `fs.readFileSync(path)` returns a `Buffer` (or a string when an encoding is given); `fs.writeFileSync` / `appendFileSync` accept a `Buffer`/`Uint8Array` or string
- **Standard input:** `process.stdin` is a readable stream over fd 0 (`data`/`end` events, `read()`, `pipe()`, `setEncoding`, and `for await`), and `fs.readFileSync(0)` / `fs.readFileSync('/dev/stdin')` read the same bytes. fd 0 can only be drained once, so the input is read on first use and shared between them; no input at all is an immediate end of file rather than a hang
- **Globals:** `process` (an `EventEmitter` with `argv`, `env`, `cwd()`, `exit()`, `exitCode`, `platform`, `stdout.write`, `stderr.write`, `stdin`, `nextTick`, `hrtime` and `hrtime.bigint`, `uptime()`, `memoryUsage()`), `global`, `console`
- **Exit codes:** the run fails the way Node's does, which is how a caller tells a failed run from a successful one. An uncaught error, thrown synchronously or from a timer, `nextTick` or I/O callback, prints `Name: message` and its frames and exits 1. So does an unhandled promise rejection, once the job queue drains without a handler attaching. `process.exit(code)` ends the run with that code, flushing stdout and stderr first, and a run that simply finishes exits with `process.exitCode`. An unreadable entry file and a failing `node:test` run exit non-zero too
- **Process events:** `'beforeExit'` (each time the loop runs dry; a listener that schedules more work keeps the run going, as in Node), `'exit'` (with the exit code; a listener can change `process.exitCode`), `'uncaughtException'` and `'unhandledRejection'`, whose listeners take the error over and let the run carry on, and `'rejectionHandled'`. The engine side is a wasmhub patch to quickjs-libc (`os.setHostHooks`), because stock QuickJS prints a timer's exception and carries on, ignores unhandled rejections, and exits 0 whatever happened
- **Stack traces:** frames name the module they came from and report that file's own line numbers, so `at inner (/app/lib/boom.js:4)` points at real source. Modules are compiled through `std.evalScript` with a `filename` (a wasmhub patch adds the option) rather than `new Function`, which QuickJS would name `<input>`
- **Timers & event loop:** `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, `queueMicrotask`, and a deferred `process.nextTick` — driven by the QuickJS event loop. `async`/`await`, Promise chains, and timer callbacks resolve after the entry script returns and the loop drains.
- **Web platform globals:** `URL` / `URLSearchParams` (WHATWG parsing, relative resolution against a base, `searchParams` kept in sync with the URL), `crypto.getRandomValues` / `crypto.randomUUID` (entropy from the WASI `random_get` syscall via `os.getentropy`), `structuredClone` (cycles, `Map`/`Set`/`Date`/`RegExp`/`ArrayBuffer`/TypedArrays; functions and symbols throw `DataCloneError`), `Headers`, `Request`, `Response` (with `json()`, `redirect()`, `clone()`), `AbortController`/`AbortSignal` (`abort`, `timeout`, `any`), `Event` and `EventTarget`, and `fetch`. In the `-net` build `fetch` works over `http:`, follows redirects, honours `signal`, and fails as `TypeError('fetch failed')` with the reason as `cause`; elsewhere it rejects with `ERR_NETWORK_UNSUPPORTED` rather than a bare `ReferenceError`

## Limitations

- **Outbound connections need the `-net` build** and a host that provides its two extensions; the portable build fails `net.connect`, `http.request` and `fetch` with a clear error rather than hanging. Either way there is no TLS: `https` and `tls` throw, and `fetch` refuses `https:` URLs
- `fetch` buffers the whole response before it resolves, so a response that never ends (server-sent events) never resolves either. `Response#body` is a one-chunk stream over that buffer, and there is no `Blob` or `FormData`
- No worker threads (`worker_threads` reports `isMainThread: true`; constructing a `Worker` throws)
- No native addons (.node files)
- Built-in modules cover common APIs but not everything. `zlib`, `child_process`, `worker_threads`, `https`, `dgram` and `tls` are *present but throw* `ERR_NOT_SUPPORTED` when used, with a message naming the constraint: a package that merely imports one keeps working, and one that calls it gets a clear error instead of "Cannot find module"
- `fs` is synchronous under the hood. `fs/promises` and `fs.promises` wrap the same calls, so they resolve immediately rather than doing real async I/O, and `fs.createReadStream` is unavailable
- `crypto` has digests, HMAC and PBKDF2 only. There is no `createCipheriv`, no key generation, no `scrypt`, and no certificate handling
- `Buffer` covers the common API but not everything (e.g. `swap16`/`swap32`, `BigInt64` accessors); `TextDecoder` is utf-8 only
- `stream` is a pragmatic subset (no full backpressure/highWaterMark semantics), though `Readable` does support `for await`; `util.inspect` output approximates Node's but is not byte-identical
- Timers return a numeric id (browser-style), not a Node `Timeout` object — `.ref()`/`.unref()` are unavailable. `process.nextTick` is a microtask (no separate higher-priority queue), and the trailing-args forms are supported

## Networking

Both builds can **serve** connections. Only `nodejs-20-net.wasm` can **open** them.

WASI Preview 1 standardises `sock_accept`, `sock_recv`, `sock_send` and
`sock_shutdown`, but nothing that creates a socket: `sock_open`, `sock_bind`,
`sock_connect` and `sock_listen` are WASIX-style extensions. A WebAssembly
import is not optional -- declaring one obliges every host to supply it or the
module fails to instantiate -- so this runtime imports only the standard four
and keeps running on any host it ran on before.

That means the listening socket has to come from outside, already bound. The
host binds the port and passes the descriptor in through the environment:

| Variable | Meaning |
|---|---|
| `WASMHUB_LISTEN_FD` | descriptor of a bound, listening socket |
| `WASMHUB_LISTEN_ADDR` | optional `host:port` it is bound to, so `server.address()` can answer truthfully |

wasmtime's listen-socket option already works this way, up to wasmtime 46:
releases 14 to 46 spell it `-S tcplisten` and offer it only on the legacy
Preview 1 implementation (`-S preview2=n`), older ones spell it `--tcplisten`.
wasmtime 47 removed the legacy implementation, and with it any way to hand a
listening socket to a Preview 1 module, so a newer wasmtime cannot run the
server half at all:

```sh
wasmtime run -S preview2=n -S tcplisten=127.0.0.1:8080 \
  --env WASMHUB_LISTEN_FD=3 --env WASMHUB_LISTEN_ADDR=127.0.0.1:8080 \
  nodejs-20.wasm eval "$(cat app/server.js)"
```

The server goes in through `eval` rather than `run ./app/server.js` because
wasmtime puts the socket on fd 3, ahead of any `--dir`, and wasi-libc stops
looking for preopened directories at the first descriptor that is not one. A
`--dir` given alongside `tcplisten` is invisible to the runtime, so `run`
cannot open the file. A host that hands the socket in after its preopens, and
sets `WASMHUB_LISTEN_FD` to match, has no such limit.

```js
// app/server.js
const http = require('node:http');

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url }));
}).listen(8080, () => console.log('serving'));
```

`server.listen(port)` does not bind anything: the port is advertised for
`address()`, and the server serves the socket it was given. A second concurrent
`listen()` fails with `EADDRINUSE`, since one process is handed one socket.

Sockets are non-blocking, and a self-scheduling timer drains them. It backs off
while idle and stops arming once the last socket closes, so a script that
served a request still exits on its own rather than hanging the run.

When the host passes no descriptor, `listen()` emits an `ERR_SOCKET_NO_LISTENER`
error naming the variable to set. When a build has no socket bindings at all,
`net` and `http` take the same shape as `zlib`: present, and throwing a clear
`ERR_NOT_SUPPORTED` when called, so a package that merely requires one keeps
loading.

### Outbound: the `-net` build

`nodejs-20-net.wasm` is the same runtime with two more imports, both wasmrun
extensions under the `wasi_snapshot_preview1` module:

| Call | Signature | Meaning |
|---|---|---|
| `sock_open` | `(family, socktype, protocol, *fd_out) -> errno` | a stream socket (`family` 0 = unspecified, `socktype` 1 = stream) |
| `sock_connect` | `(fd, host_ptr, host_len, port) -> errno` | connect it to `host:port`, blocking until the host answers |

The destination is a host *string*, not a packed address, so the host's egress
policy sees the name the program asked for and resolves it itself. A destination
the policy refuses comes back as `EACCES`, which `net` reports as an `'error'`
event saying the host's network policy refused it; the host keeps the detailed
reason (wasmrun prints it).

```sh
# wasmrun exec, allowing one destination
wasmrun exec --allow-net "api.example.com:80" nodejs-20-net.wasm eval \
  "fetch('http://api.example.com/').then(r => r.text()).then(console.log)"
```

Under wasmrun's agent mode the policy comes from `--allow-net` or a tenant's
`[tenants.network]` table, and in OS mode from `[os.network]` in the project's
`wasmrun.toml`. With no policy at all, nothing is allowed.

The connect runs from a timer, never inside the `connect()` call, so listeners
attached after it returns see the outcome, and writes made before it lands are
queued. After that the socket is non-blocking and the same poll loop drives it.

## Install

```sh
wasmhub get nodejs 20
```

## Usage examples

The runtime is a plain WASI module, so any WASI host runs it. The commands
that need no files work the same everywhere:

```sh
# Print version info
wasmrun exec nodejs-20.wasm version

# Evaluate JavaScript
wasmrun exec nodejs-20.wasm eval "1 + 1"
# → 2

# Complex expressions
wasmrun exec nodejs-20.wasm eval "[1,2,3].map(x => x * x).join(',')"
# → 1,4,9

# Echo arguments
wasmrun exec nodejs-20.wasm echo hello world
# → hello world

# Print the environment the host passed
wasmrun exec --env GREETING=hi nodejs-20.wasm env
# → GREETING=hi

# Run a file from a preopened directory
wasmrun exec --dir ./scripts:/app nodejs-20.wasm run /app/app.js
```

`run <file>` needs the host to give the program a directory to read the file
from, which `--dir` does (wasmrun 1.0 and later). `wasmrun exec` exits with the
program's exit code. wasmrun's [agent mode](https://wasmrun.readthedocs.io/)
fetches this runtime itself and runs each program in a session with its own
filesystem:

```sh
wasmrun agent &
SID=$(curl -s -X POST localhost:8430/api/v1/sessions | jq -r .session_id)
curl -s -X POST localhost:8430/api/v1/sessions/$SID/exec \
  -H 'Content-Type: application/json' \
  -d '{"files": {"app.js": "console.log(require(\"path\").basename(__filename))"}, "entry": "app.js"}'
# → {"stdout":"app.js\n","stderr":"","exit_code":0,...}
```

Agent mode reports the program's exit code as `exit_code`.

Or with any host that preopens a directory, such as wasmtime:

```sh
wasmtime run --dir . nodejs-20.wasm run ./scripts/app.js
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
4. **`#` specifier** — resolved through the `imports` map of the nearest `package.json` above the requiring file, with the same conditions and patterns as `exports`. A target may also be a bare specifier, which is how a package maps `#async_hooks` to the builtin on Node and to a stub elsewhere (p-limit does exactly this).

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
3. Applies the engine patches in `scripts/patch-nodejs.sh` (entropy, script filenames, the socket and host bindings, the process lifecycle hooks, and the async context)
4. Cross-compiles all sources with WASI SDK clang (`wasm32-wasi` target), `wasi_sockets.c` twice: once as is and once with `-DWASMHUB_OUTBOUND`
5. Links both builds with an 8 MB C stack (required for QuickJS's parser depth)
6. Optimizes each with `wasm-opt -O3`, and writes both manifest entries, `20` staying `latest`

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
- [x] Outbound `net`, the `http` client and `fetch` (the `-net` build)
- [x] Native digests, `async_hooks`, `process.memoryUsage`/`uptime`/`'beforeExit'`, package `imports`
- [ ] TLS, so `https` and `fetch` to `https:` work
- [x] Event-loop driven `setTimeout` / `setInterval` exposed as globals (plus `setImmediate`, `queueMicrotask`, deferred `process.nextTick`)
