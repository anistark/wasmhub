# Node.js runtime fixtures

Smoke-test fixtures for the QuickJS-based Node.js runtime's CommonJS `require()`
support.

## Layout

```
fixtures/
  app.js              # entry point — exercises require, path, JSON, node_modules
  math.js             # sibling module via relative require
  config.json         # JSON import
  node_modules/
    greet/
      package.json    # main: src/greet.js
      src/greet.js    # nested package main
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
