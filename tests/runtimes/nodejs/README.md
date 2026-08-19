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
  stdin.js            # process.stdin, fs.readFileSync(0), tty, node:process
  testrunner.js       # the node:test runner: TAP output and exit code
  resolver.js         # package.json "exports": conditions, subpaths, encapsulation
  node_modules/
    greet/
      package.json    # main: src/greet.js
      src/greet.js    # nested package main
    exported/
      package.json    # exports map: conditions, a subpath, a pattern, a null
      lib/            # main.cjs / main.mjs / sub.js / feature/one.js / private.js
```

## Running

```sh
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/app.js
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
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/timers.js
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
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/buffer.js
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
wasmrun exec --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- run tests/runtimes/nodejs/fixtures/base.js | diff expected.txt -

# stream — order-independent (sort both)
diff <(node …/stream.js | sort) <(wasmrun … run …/stream.js | sort)
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
wasmrun exec --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- run tests/runtimes/nodejs/fixtures/webglobals.js | diff expected.txt -
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
`node:test` runner (`nodetest.test.mjs`) are covered here too.

What it cannot cover is the real event loop, real WASI, and the runner's own
process exit. That is what `fixtures/builtins.js`, `fixtures/stdin.js` and
`fixtures/testrunner.js` are for, and they need a built runtime:

```sh
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/builtins.js
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
echo -n 'hello from the host' | wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/stdin.js
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
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/testrunner.js
```

Prints TAP 13 for four tests (one skipped, one todo) and exits 0. Run it under
real node for the reference output and diff the two, ignoring `duration_ms`:

```sh
node --test-reporter=tap --test tests/runtimes/nodejs/fixtures/testrunner.js
```

Set `WASMHUB_TEST_FAIL=1` in the sandbox environment to add a failing test:
the run must then exit 1, which is how wasmrun surfaces a failed test run.

### Module resolution (`resolver.js`)

```sh
wasmrun exec \
  --dir tests/runtimes/nodejs/fixtures \
  runtimes/nodejs/nodejs-20.wasm -- \
  run tests/runtimes/nodejs/fixtures/resolver.js
```

Expected output:

```
exports.root=ok
exports.subpath=ok
exports.encapsulation=ok
legacy.main=ok
resolver=pass
```
