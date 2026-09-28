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
import { loadRuntime, withGlobals, exitCodeFrom } from './harness.mjs';

test('process.exit reaches std.exit with its code', async () => {
    await withGlobals((process, state) => {
        assert.equal(exitCodeFrom(() => process.exit(3)), 3);
        assert.equal(state.exitCode, 3);
    });
});

test('process.exit coerces a non-integer code', async () => {
    await withGlobals((process) => {
        assert.equal(exitCodeFrom(() => process.exit('7')), 7);
    });
});

test('process.exit with no code exits 0', async () => {
    await withGlobals((process) => {
        assert.equal(exitCodeFrom(() => process.exit()), 0);
    });
});

test('process.exit with no code uses process.exitCode', async () => {
    await withGlobals((process) => {
        process.exitCode = 4;
        assert.equal(exitCodeFrom(() => process.exit()), 4);
    });
});

test('process.exit emits exit once, and a listener can change the code', async () => {
    await withGlobals((process) => {
        const seen = [];
        process.on('exit', (code) => {
            seen.push(code);
            process.exitCode = 9;
        });
        assert.equal(exitCodeFrom(() => process.exit(2)), 9);
        assert.deepEqual(seen, [2]);
        // Calling exit from inside an exit listener, or again, does not re-emit.
        assert.equal(exitCodeFrom(() => process.exit(5)), 5);
        assert.deepEqual(seen, [2]);
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
