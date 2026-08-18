// Tests for the nodejs runtime's CommonJS module resolver, in particular
// package.json "exports". Run under plain node via ./harness.mjs, whose
// in-memory filesystem stands in for the sandbox's.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';

/// A node_modules tree: `pkg` is a package.json object, `files` are extra
/// files under the package directory.
function pkgFiles(name, manifest, files = {}) {
    const dir = `/app/node_modules/${name}`;
    const out = { [`${dir}/package.json`]: JSON.stringify(manifest) };
    for (const [rel, content] of Object.entries(files)) out[`${dir}/${rel}`] = content;
    return out;
}

async function resolverFor(files) {
    const rt = await loadRuntime({ files: { '/app/index.js': '', ...files } });
    return (request) => rt.resolveModule(request, '/app');
}

test('exports resolves the package root', async () => {
    const resolve = await resolverFor(pkgFiles('nanoid', {
        name: 'nanoid',
        main: 'index.cjs',
        exports: { '.': { require: './index.cjs', import: './index.js' } },
    }, { 'index.cjs': '', 'index.js': '' }));

    assert.deepEqual(resolve('nanoid'), {
        builtin: false,
        id: '/app/node_modules/nanoid/index.cjs',
    });
});

test('conditions are matched in the order the package wrote them', async () => {
    // "import" is not in the condition set, so a package listing it first
    // still resolves through "require".
    const resolve = await resolverFor(pkgFiles('dual', {
        name: 'dual',
        exports: { import: './esm.js', require: './cjs.js' },
    }, { 'esm.js': '', 'cjs.js': '' }));

    assert.equal(resolve('dual').id, '/app/node_modules/dual/cjs.js');
});

test('a nested condition object resolves through node, then default', async () => {
    const resolve = await resolverFor(pkgFiles('nested', {
        name: 'nested',
        exports: { '.': { node: { require: './node.js' }, default: './browser.js' } },
    }, { 'node.js': '', 'browser.js': '' }));

    assert.equal(resolve('nested').id, '/app/node_modules/nested/node.js');
});

test('a string shorthand is the root export', async () => {
    const resolve = await resolverFor(pkgFiles('short', {
        name: 'short',
        exports: './lib/main.js',
    }, { 'lib/main.js': '' }));

    assert.equal(resolve('short').id, '/app/node_modules/short/lib/main.js');
    // …and it exports nothing else.
    assert.throws(() => resolve('short/lib/main.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('subpath exports resolve, including patterns', async () => {
    const resolve = await resolverFor(pkgFiles('multi', {
        name: 'multi',
        exports: {
            '.': './index.js',
            './helper': './lib/helper.js',
            './feature/*': './src/feature/*.js',
        },
    }, { 'index.js': '', 'lib/helper.js': '', 'src/feature/one.js': '' }));

    assert.equal(resolve('multi').id, '/app/node_modules/multi/index.js');
    assert.equal(resolve('multi/helper').id, '/app/node_modules/multi/lib/helper.js');
    assert.equal(resolve('multi/feature/one').id, '/app/node_modules/multi/src/feature/one.js');
});

test('the longest matching pattern wins', async () => {
    const resolve = await resolverFor(pkgFiles('deep', {
        name: 'deep',
        exports: {
            './*': './generic/*.js',
            './special/*': './specific/*.js',
        },
    }, { 'generic/special/x.js': '', 'specific/x.js': '' }));

    assert.equal(resolve('deep/special/x').id, '/app/node_modules/deep/specific/x.js');
});

test('a null target blocks the subpath', async () => {
    const resolve = await resolverFor(pkgFiles('sealed', {
        name: 'sealed',
        exports: { '.': './index.js', './internal': null },
    }, { 'index.js': '', 'internal.js': '' }));

    assert.throws(() => resolve('sealed/internal'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('exports encapsulates the package', async () => {
    // The file exists, but the package does not export it.
    const resolve = await resolverFor(pkgFiles('walled', {
        name: 'walled',
        exports: { '.': './index.js' },
    }, { 'index.js': '', 'lib/private.js': '' }));

    assert.throws(() => resolve('walled/lib/private.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('a package with no matching condition falls back to main at the root', async () => {
    // What an ES-module-only package looks like after being lowered to
    // CommonJS in place: exports names conditions we do not have, main points
    // at the lowered file.
    const resolve = await resolverFor(pkgFiles('esmonly', {
        name: 'esmonly',
        main: 'index.js',
        exports: { '.': { import: './index.js' } },
    }, { 'index.js': '' }));

    assert.equal(resolve('esmonly').id, '/app/node_modules/esmonly/index.js');
});

test('a package without exports still resolves through main and index', async () => {
    const withMain = await resolverFor(pkgFiles('legacy', {
        name: 'legacy',
        main: 'lib/entry.js',
    }, { 'lib/entry.js': '', 'lib/other.js': '' }));
    assert.equal(withMain('legacy').id, '/app/node_modules/legacy/lib/entry.js');
    // No exports means no encapsulation, as in Node.
    assert.equal(withMain('legacy/lib/other.js').id, '/app/node_modules/legacy/lib/other.js');
    assert.equal(withMain('legacy/lib/other').id, '/app/node_modules/legacy/lib/other.js');

    const indexOnly = await resolverFor(pkgFiles('plain', { name: 'plain' }, { 'index.js': '' }));
    assert.equal(indexOnly('plain').id, '/app/node_modules/plain/index.js');
});

test('scoped packages split on the scope, not the first slash', async () => {
    const resolve = await resolverFor(pkgFiles('@scope/pkg', {
        name: '@scope/pkg',
        exports: { '.': './index.js', './sub': './sub.js' },
    }, { 'index.js': '', 'sub.js': '' }));

    assert.equal(resolve('@scope/pkg').id, '/app/node_modules/@scope/pkg/index.js');
    assert.equal(resolve('@scope/pkg/sub').id, '/app/node_modules/@scope/pkg/sub.js');
});

test('a missing package is still a MODULE_NOT_FOUND', async () => {
    const resolve = await resolverFor({});
    assert.throws(() => resolve('absent'), { code: 'MODULE_NOT_FOUND' });
});

test('an exports target that does not exist names the file', async () => {
    const resolve = await resolverFor(pkgFiles('broken', {
        name: 'broken',
        exports: { '.': './missing.js' },
    }));

    assert.throws(() => resolve('broken'), { code: 'MODULE_NOT_FOUND' });
});

test('builtins resolve by name and by node: prefix', async () => {
    const resolve = await resolverFor({});
    assert.deepEqual(resolve('path'), { builtin: true, id: 'path' });
    assert.deepEqual(resolve('node:fs/promises'), { builtin: true, id: 'node:fs/promises' });
    // node:test is prefix-only, as in Node.
    assert.deepEqual(resolve('node:test'), { builtin: true, id: 'node:test' });
    assert.throws(() => resolve('test'), { code: 'MODULE_NOT_FOUND' });
});

test('relative requires resolve files, extensions and directories', async () => {
    const rt = await loadRuntime({
        files: {
            '/app/index.js': '',
            '/app/lib/util.js': '',
            '/app/lib/index.js': '',
            '/app/data.json': '',
        },
    });
    const resolve = (r) => rt.resolveModule(r, '/app');

    assert.equal(resolve('./lib/util').id, '/app/lib/util.js');
    assert.equal(resolve('./lib/util.js').id, '/app/lib/util.js');
    assert.equal(resolve('./lib').id, '/app/lib/index.js');
    assert.equal(resolve('./data.json').id, '/app/data.json');
    assert.throws(() => resolve('./nope'), { code: 'MODULE_NOT_FOUND' });
});
