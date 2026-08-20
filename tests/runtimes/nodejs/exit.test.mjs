// Tests for process exit codes and the filenames that reach stack frames, run
// under plain node via ./harness.mjs.
//
// Both were silently broken before: quickjs-libc puts `exit` on std, not os, so
// every `os.exit(...)` in main.js threw "not a function" and was swallowed,
// leaving a failing run reporting success. And the CommonJS wrapper was built
// with `new Function`, which QuickJS names `<input>`, so no frame said which
// file it came from and every line number was shifted by the wrapper preamble.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, loadRuntimeWithState } from './harness.mjs';

/// The `std.exit(N)` marker the harness throws, or null if `fn` did not exit.
function exitCodeFrom(fn) {
    try {
        fn();
    } catch (e) {
        if (typeof e.__wasmhubExit === 'number') return e.__wasmhubExit;
        throw e;
    }
    return null;
}

/// Run `fn` with the runtime's globals installed, then put node's back.
///
/// setupGlobals assigns over `crypto`, which node defines as getter-only, so
/// the property is made writable for the duration and restored afterwards.
async function withGlobals(fn) {
    const { runtime, state } = await loadRuntimeWithState();
    const cryptoDesc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const processDesc = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'crypto', {
        value: cryptoDesc.get ? cryptoDesc.get.call(globalThis) : cryptoDesc.value,
        writable: true,
        configurable: true,
    });
    try {
        runtime.setupGlobals('/main.js', []);
        return fn(globalThis.process, state);
    } finally {
        Object.defineProperty(globalThis, 'crypto', cryptoDesc);
        Object.defineProperty(globalThis, 'process', processDesc);
    }
}

test('process.exit reaches std.exit with its code', async () => {
    await withGlobals((process, state) => {
        assert.equal(exitCodeFrom(() => process.exit(3)), 3);
        assert.equal(state.exitCode, 3);
    });
});

test('process.exit coerces a non-integer code', async () => {
    await withGlobals((process) => {
        assert.equal(exitCodeFrom(() => process.exit('7')), 7);
        assert.equal(exitCodeFrom(() => process.exit()), 0);
    });
});

test('a stack frame names the module it came from', async () => {
    const runtime = await loadRuntime({
        files: {
            '/app/lib/boom.js': [
                'function inner() {',
                '  throw new Error("kaboom");',
                '}',
                'module.exports = inner;',
            ].join('\n'),
        },
    });

    const require = runtime.makeRequire('/app', null);
    const boom = require('./lib/boom.js');

    let stack = '';
    try {
        boom();
    } catch (e) {
        stack = e.stack || '';
    }

    assert.match(stack, /boom\.js/, `frame should name boom.js, got:\n${stack}`);
    assert.doesNotMatch(stack, /<input>/, `frame should not be anonymous:\n${stack}`);
});

test('a frame reports the line the source actually has', async () => {
    // `throw` is on line 4 of the file. The wrapper must not shift it: its
    // opening line sits on the source's first line precisely so this holds.
    const runtime = await loadRuntime({
        files: {
            '/app/thrower.js': [
                '// line 1',
                '// line 2',
                'function go() {',
                '  throw new Error("here");',
                '}',
                'module.exports = go;',
            ].join('\n'),
        },
    });

    const require = runtime.makeRequire('/app', null);
    let stack = '';
    try {
        require('./thrower.js')();
    } catch (e) {
        stack = e.stack || '';
    }

    const frame = stack.split('\n').find((l) => l.includes('thrower.js'));
    assert.ok(frame, `no frame named thrower.js:\n${stack}`);
    assert.match(frame, /thrower\.js:4/, `expected line 4, got: ${frame}`);
});

test('a module keeps its own __filename and __dirname', async () => {
    const runtime = await loadRuntime({
        files: {
            '/app/lib/where.js': 'module.exports = { file: __filename, dir: __dirname };',
        },
    });

    const require = runtime.makeRequire('/app', null);
    assert.deepEqual(require('./lib/where.js'), {
        file: '/app/lib/where.js',
        dir: '/app/lib',
    });
});

test('a syntax error still names the offending module', async () => {
    const runtime = await loadRuntime({
        files: { '/app/broken.js': 'function ( {' },
    });

    const require = runtime.makeRequire('/app', null);
    assert.throws(() => require('./broken.js'), /Syntax error in '\/app\/broken\.js'/);
});
