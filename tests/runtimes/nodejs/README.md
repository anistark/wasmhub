# Node.js runtime fixtures

Smoke-test fixtures for the QuickJS-based Node.js runtime's CommonJS `require()`
support and event loop (timers / microtasks / async-await).

## Layout

```
fixtures/
  app.js              # entry point — exercises require, path, JSON, node_modules
  math.js             # sibling module via relative require
  config.json         # JSON import
  timers.js           # event loop — setTimeout/setInterval/nextTick/queueMicrotask/async
  buffer.js           # Buffer + TextEncoder/Decoder + binary fs.readFileSync
  base.js             # events (EventEmitter) + util + assert
  stream.js           # stream — Readable.from/Transform/Writable/PassThrough/pipe
  webglobals.js       # URL/URLSearchParams, structuredClone, crypto, fetch stub
  builtins.js         # fs/promises, timers/promises, crypto entropy, module stubs
  append.js           # appendFile, sync and promise (needs the host to honour O_APPEND)
  stdin.js            # process.stdin, fs.readFileSync(0), tty, node:process
  testrunner.js       # the node:test runner: TAP output and exit code
  resolver.js         # package.json "exports": conditions, subpaths, encapsulation
  httpserver.js       # inbound networking: a real listening socket from the host
  lifecycle.js        # console, uncaught errors, unhandled rejections, exit codes
  node_modules/
    greet/
      package.json    # main: src/greet.js
      src/greet.js    # nested package main
    exported/
      package.json    # exports map: conditions, a subpath, a pattern, a null
      lib/            # main.cjs / main.mjs / sub.js / feature/one.js / private.js
```

## Running all of them

```sh
just test-nodejs-wasm                            # under wasmtime
just test-nodejs-wasmrun                         # under wasmrun's agent mode
just test-nodejs-wasm path/to/nodejs-20.wasm     # any other build

# One fixture, or a few, by name or name prefix
node tests/runtimes/nodejs/run-fixtures.mjs --host wasmrun --only lifecycle,timers
```

`run-fixtures.mjs` runs every fixture below, including the failing cases (a
mismatched stdin, a failing `node:test` run, each `lifecycle.js` scenario that
should exit non-zero), and drives `httpserver.js` over HTTP. It checks each
one's exit code as well as its output, because the exit code is the part the
node harness cannot see: the v0.5.0 runtime had no `console.error`, and its
failed runs exited 0.

The checks are one table run under either of two hosts:

- **wasmtime**, a stock WASI host, run once per fixture with the fixtures
  directory preopened.
- **wasmrun**, the runtime's real consumer. It is not built on wasmtime: it
  has its own interpreter and its own WASI. The runner starts `wasmrun agent`,
  serves it the build under test as a wasmhub release (via
  `WASMRUN_WASMHUB_BASE_URL`, with a manifest generated from the build's own
  sha256, and a private `HOME` so no cached runtime stands in for it), and
  runs each fixture in its own session through the exec API, `httpserver.js`
  through the serve API. Any other runtime a session needs, in practice swc,
  comes from this checkout when it holds a build its manifest describes, and
  from the latest published release otherwise. `WASMRUN_BIN` picks the binary.

A check that fails on one host for a reason outside this runtime carries a
`knownFailure` for that host and is reported as `xfail`; if it starts passing,
the run fails, so the marker goes when the bug does. Today that is `append` on
wasmrun, whose `path_open` ignores the append flag
([anistark/wasmrun#123](https://github.com/anistark/wasmrun/issues/123)).

CI runs both hosts on every runtime build (`build-runtimes.yml`) and on the
release binary before any asset is staged (`release.yml`), with wasmtime pinned
to 46.0.1 and `WASMHUB_REQUIRE_HTTP=1`, so the wasmtime `httpserver.js` check
cannot quietly turn into a skip, and wasmrun pinned to 0.23.0.

## Running one by hand

`--only` above runs one under either host. By hand, with wasmtime, map the
fixtures directory to `/` (`wasmrun exec` preopens no directory, so it cannot
open a fixture file):

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /app.js
```

Expected output:

```
name=wasmhub-nodejs-test
maxItems=100
square(4)=16
cube(3)=27
greet=Hello, wasmhub!
__filename basename=app.js
require.main===module: true
```

### Event loop (`timers.js`)

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /timers.js
```

Expected output (synchronous line first, then microtasks drain, then timers
fire in delay order):

```
sync-start -> sync-end
nextTick
queueMicrotask
promise.then
async/await=42
setTimeout=x,y
interval 1
interval 2
interval 3
```

### Buffer + binary fs (`buffer.js`)

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /buffer.js
```

`buffer.js` uses `__dirname`, so its output is identical under real Node and the
WASM runtime — run it under both and diff to confirm. Expected output:

```
len=10
utf8=héllo ✓
hex=68c3a96c6c6f20e29c93
base64=aMOpbGxvIOKckw==
base64url=aMOpbGxvIOKckw
hex.rt=héllo ✓
b64.rt=héllo ✓
alloc.hex=004142000000
concat=foo-bar
u32be.hex=01020304
u32le=67305985
i16be=-2
double=3.5
isBuffer=true,false,false
byteLength=10
equals=true
compare=-1
indexOf=6
includes=true
slice=ell
textcodec=round✓trip
fs.isBuffer=true
fs.byte0=123
fs.utf8.type=string
fs.parsed.name=wasmhub-nodejs-test
done
```

### Base modules (`base.js`, `stream.js`)

`base.js` exercises `events`/`util`/`assert` with fully deterministic output;
`stream.js` exercises the `stream` classes (its two lines may print in either
order, so diff with `sort`). Both use only standard Node APIs, so run them under
real Node and the WASM runtime and diff:

```sh
# events / util / assert — exact match
node tests/runtimes/nodejs/fixtures/base.js > expected.txt
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /base.js | diff expected.txt -

# stream — order-independent (sort both)
diff <(node …/stream.js | sort) <(wasmtime … run /stream.js | sort)
```

`base.js` expected output:

```
events=on:XY,once:X,on:ZW
listenerCount=1
afterOff=0
prepend=ba
errEvent=boom
format=cart has 3 items (50%)
inherits=hi,true
deepStrict=true,false
types=true,true,true,true
ok=pass
okFail=ERR_ASSERTION
strictEqual=pass
strictEqualFail=ERR_ASSERTION
deepStrict=pass
deepStrictFail=ERR_ASSERTION
throws=pass
throwsRe=pass
ifError=pass
promisify=42
callbackify=10
```

`stream.js` expected output (order may vary between the two lines):

```
passthrough=hello world
pipe=FOO|BAR|BAZ|!
```

### Web globals (`webglobals.js`)

Exercises `URL`/`URLSearchParams` (parsing, relative resolution, searchParams
sync), `structuredClone` (cycles, Map/Set/Date/TypedArray, DataCloneError),
`crypto.getRandomValues`/`randomUUID`, and the `fetch` stub (rejects with a
clear network-unsupported message on WASI). Output is deterministic and
identical under real Node — diff the two:

```sh
node tests/runtimes/nodejs/fixtures/webglobals.js > expected.txt
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /webglobals.js | diff expected.txt -
```

---

## Testing built-ins without a wasm build

Most of the built-in modules added in v0.4.0 are pure computation, so they can
be tested under plain node instead of a built runtime:

```sh
just test-nodejs-builtins        # node --test "tests/runtimes/nodejs/*.test.mjs"
```

`harness.mjs` loads `runtimes/nodejs/main.js` with the QuickJS `std`/`os`
imports shimmed out, and `builtins.test.mjs` checks the results against node's
own implementations, so a divergence shows up as a test failure rather than as
a surprise inside somebody's sandbox. This runs in `just ci`.

The harness serves an in-memory filesystem and a stdin buffer, so the module
resolver (`resolver.test.mjs`), standard input (`stdin.test.mjs`) and the
`node:test` runner (`nodetest.test.mjs`) are covered here too. It records what
the runtime writes to `std.err`, so `lifecycle.test.mjs` can assert on the
console and on what an uncaught error or an unhandled rejection reports; the
engine hooks that call into that code are covered by `fixtures/lifecycle.js`.

`fakenet.mjs` adds an in-memory stand-in for the host's socket layer, which is
what lets `net.test.mjs` and `http.test.mjs` cover the server path here rather
than only against a built runtime. It answers with the same `[value, code]`
pairs the real bindings do and keeps the two easy-to-conflate cases apart:
nothing to read yet is `EAGAIN`, an orderly peer shutdown is zero bytes. Its
`maxSend` option forces short writes, so the runtime's re-queueing path is
exercised rather than assumed.

What it cannot cover is the real event loop, real WASI, and the runner's own
process exit. That is what the fixtures are for, and they need a built runtime
(`just test-nodejs-wasm` runs them all):

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ --dir "$(mktemp -d)::/tmp" \
  runtimes/nodejs/nodejs-20.wasm run /builtins.js
```

Expected output:

```
fs/promises=ok
fs.promises=ok
timers/promises=ok
crypto=ok
stubs=ok
builtins=pass
```

### Standard input (`stdin.js`)

Needs bytes on fd 0, so it is the one fixture whose input comes from the host:

```sh
echo -n 'hello from the host' | wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /stdin.js
```

Expected output:

```
stdin.stream=ok
stdin.fs=ok
stdin.tty=ok
stdin.process=ok
stdin=pass
```

### Test runner (`testrunner.js`)

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /testrunner.js
```

Prints TAP 13 for four tests (one skipped, one todo) and exits 0. Run it under
real node for the reference output and diff the two, ignoring `duration_ms`:

```sh
node --test-reporter=tap --test tests/runtimes/nodejs/fixtures/testrunner.js
```

Set `WASMHUB_TEST_FAIL=1` in the sandbox environment (`--env
WASMHUB_TEST_FAIL=1` under wasmtime, `"env"` in a wasmrun exec) to add a
failing test: the run must then exit 1, which is how wasmrun surfaces a failed
test run as `exit_code`.

### Inbound networking (`httpserver.js`)

WASI Preview 1 cannot bind a port from inside the sandbox, so the host binds it
and passes the descriptor in. wasmtime's listen-socket option does exactly that
up to wasmtime 46 (`-S tcplisten` on the legacy Preview 1 implementation, or
`--tcplisten` before 14). wasmtime 47 removed the legacy implementation, so
`run-fixtures.mjs` skips this check on a newer one, and CI pins 46.0.1:

```sh
wasmtime run -S preview2=n -S tcplisten=127.0.0.1:8080 \
  --env WASMHUB_LISTEN_FD=3 --env WASMHUB_LISTEN_ADDR=127.0.0.1:8080 \
  runtimes/nodejs/nodejs-20.wasm \
  eval "$(cat tests/runtimes/nodejs/fixtures/httpserver.js)"
```

`eval`, not `run`: wasmtime puts the socket on fd 3, ahead of any `--dir`, and
wasi-libc stops looking for preopened directories at the first descriptor that
is not one, so a `--dir` alongside it is invisible and `run` cannot open the
file.

wasmrun has no such limit, since it preopens the session directory first and
puts the socket after it. Its agent mode serves the fixture through
`POST /api/v1/sessions/:id/serve`, which is what `--host wasmrun` does.

Expected output on startup:

```
net.isIP=4,6,0
connect=ERR_NOT_SUPPORTED
listening=127.0.0.1:8080
```

Then, from another shell:

```sh
curl -s localhost:8080/hello        # {"method":"GET","url":"/hello","body":""}
curl -s -d 'ping' localhost:8080/x  # {"method":"POST","url":"/x","body":"ping"}
curl -s localhost:8080/stop         # stopping
```

`/stop` closes the server, after which the fixture prints `server=closed` and
the run exits 0 on its own, which is also the check that the poll loop stops
arming its timer once the last socket is gone.

### Module resolution (`resolver.js`)

```sh
wasmtime run --dir tests/runtimes/nodejs/fixtures::/ \
  runtimes/nodejs/nodejs-20.wasm run /resolver.js
```

Expected output:

```
exports.root=ok
exports.subpath=ok
exports.encapsulation=ok
legacy.main=ok
resolver=pass
```
