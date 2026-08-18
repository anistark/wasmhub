// Smoke test for package.json "exports" resolution, which needs a real
// runtime: the resolver reads node_modules through WASI.
//
//   wasmrun exec --dir . nodejs-20.wasm -- run resolver.js

const assert = require('node:assert');

// The "require" condition wins over "import": the wrapper is CommonJS.
assert.deepStrictEqual(require('exported'), { entry: 'require condition' });
console.log('exports.root=ok');

assert.deepStrictEqual(require('exported/sub'), { name: 'subpath' });
assert.deepStrictEqual(require('exported/feature/one'), { name: 'pattern' });
console.log('exports.subpath=ok');

function refuses(request) {
    try {
        require(request);
        return null;
    } catch (e) {
        return e.code;
    }
}

// A null target blocks its subpath, and so does anything the map does not
// cover, even though the file is right there on disk.
assert.strictEqual(refuses('exported/blocked'), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
assert.strictEqual(refuses('exported/lib/private.js'), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
console.log('exports.encapsulation=ok');

// A package without exports still resolves through main.
assert.strictEqual(require('greet')('wasmhub'), 'Hello, wasmhub!');
console.log('legacy.main=ok');

console.log('resolver=pass');
