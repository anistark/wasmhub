// Tests for the console and the process lifecycle: uncaught errors, unhandled
// rejections and the exit code a drained loop ends with. Run under plain node
// via ./harness.mjs.
//
// All of it was missing from the built runtime, and together it made a failed
// run look like a successful one. quickjs-libc's console has only `log`, so the
// usual `main().catch((e) => { console.error(e); process.exit(1); })` threw
// inside the catch; that throw rejected a promise nobody held; and the engine
// ignores unhandled rejections and exits 0. The engine side of the fix is the
// os.setHostHooks patch in scripts/patch-nodejs.sh, which calls the functions
// tested here directly; fixtures/lifecycle.js covers it against a built wasm.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, withGlobals, exitCodeFrom } from './harness.mjs';

function capture() {
    const chunks = [];
    return { write(s) { chunks.push(String(s)); return true; }, get text() { return chunks.join(''); } };
}

async function consoleWithCapture() {
    const runtime = await loadRuntime();
    const out = capture();
    const err = capture();
    return { c: new runtime.Console({ stdout: out, stderr: err }), out, err, runtime };
}

// ── console ──────────────────────────────────────────────────────────────────

test('console.error and console.warn write to stderr', async () => {
    const { c, out, err } = await consoleWithCapture();
    c.error('bad', 1);
    c.warn('careful');
    assert.equal(err.text, 'bad 1\ncareful\n');
    assert.equal(out.text, '');
});

test('console.log formats like util.format, not toString', async () => {
    const { c, out } = await consoleWithCapture();
    c.log({ a: 1 }, [1, 2], 'plain', 3);
    c.log('%s is %d', 'x', 42);
    c.log();
    assert.equal(out.text, "{ a: 1 } [ 1, 2 ] plain 3\nx is 42\n\n");
});

test('console.info and console.debug go to stdout', async () => {
    const { c, out, err } = await consoleWithCapture();
    c.info('i');
    c.debug('d');
    assert.equal(out.text, 'i\nd\n');
    assert.equal(err.text, '');
});

test('console methods are bound, so they survive destructuring', async () => {
    const { c, err } = await consoleWithCapture();
    const { error } = c;
    error('detached');
    assert.equal(err.text, 'detached\n');
});

test('an Error prints its name and message, not only its frames', async () => {
    const { c, out } = await consoleWithCapture();
    c.log(new TypeError('nope'));
    assert.match(out.text, /^TypeError: nope\n/);
});

test('console.assert reports only a falsy value', async () => {
    const { c, err } = await consoleWithCapture();
    c.assert(true, 'never shown');
    c.assert(false, 'shown %d', 1);
    c.assert(0);
    assert.equal(err.text, 'Assertion failed: shown 1\nAssertion failed\n');
});

test('console.count, countReset and group indentation', async () => {
    const { c, out } = await consoleWithCapture();
    c.count();
    c.count('x');
    c.count();
    c.countReset();
    c.count();
    c.group('outer');
    c.log('a\nb');
    c.groupEnd();
    c.log('flush');
    assert.equal(out.text, 'default: 1\nx: 1\ndefault: 2\ndefault: 1\nouter\n  a\n  b\nflush\n');
});

test('console.timeEnd prints a duration and warns on an unknown label', async () => {
    const { c, out, err } = await consoleWithCapture();
    c.time('t');
    c.timeEnd('t');
    c.timeEnd('t');
    assert.match(out.text, /^t: \d+\.\d{3}ms\n$/);
    assert.match(err.text, /No such label 't'/);
});

test('console.trace writes a Trace: header to stderr', async () => {
    const { c, err } = await consoleWithCapture();
    c.trace('here');
    assert.match(err.text, /^Trace: here\n/);
});

test('console.table draws the table node draws', async () => {
    const { c, out } = await consoleWithCapture();
    c.table([{ a: 1, b: 'x' }, { a: 2 }]);
    assert.equal(out.text, [
        '┌─────────┬───┬─────┐',
        '│ (index) │ a │  b  │',
        '├─────────┼───┼─────┤',
        "│    0    │ 1 │ 'x' │",
        '│    1    │ 2 │     │',
        '└─────────┴───┴─────┘',
        '',
    ].join('\n'));
});

test('console.table puts primitives in a Values column', async () => {
    const { c, out } = await consoleWithCapture();
    c.table(['p', 'q']);
    assert.match(out.text, /│ \(index\) │ Values │/);
    assert.match(out.text, /│    0    │  'p'   │/);
});

test('the global console writes through process.stdout and process.stderr', async () => {
    await withGlobals((process) => {
        const out = capture();
        const err = capture();
        process.stdout = out;
        process.stderr = err;
        globalThis.console.log('to out');
        globalThis.console.error('to err');
        assert.equal(out.text, 'to out\n');
        assert.equal(err.text, 'to err\n');
    });
});

test('require("console") is the global console, with the Console class', async () => {
    const runtime = await loadRuntime();
    assert.equal(runtime.builtins['console'], runtime.nodeConsole);
    assert.equal(runtime.builtins['node:console'], runtime.nodeConsole);
    assert.equal(typeof runtime.nodeConsole.Console, 'function');
});

test('util.inspect.custom is honored without throwing', async () => {
    const runtime = await loadRuntime();
    const obj = { [runtime.inspect.custom]: () => 'custom!' };
    assert.equal(runtime.inspect(obj), 'custom!');
});

// ── eval ─────────────────────────────────────────────────────────────────────

test('eval prints a result with no toString instead of throwing', async () => {
    const runtime = await loadRuntime();
    // The shape of the handle QuickJS's os.setTimeout returns.
    assert.equal(runtime.formatEvalResult(Object.create(null)), '{}');
    assert.equal(runtime.formatEvalResult('raw'), 'raw');
    assert.equal(runtime.formatEvalResult(3), '3');
    assert.equal(runtime.formatEvalResult({ a: [1] }), '{ a: [ 1 ] }');
});

// ── uncaught exceptions ──────────────────────────────────────────────────────

test('process is an EventEmitter', async () => {
    await withGlobals((process) => {
        assert.equal(typeof process.on, 'function');
        assert.equal(typeof process.once, 'function');
        assert.equal(typeof process.emit, 'function');
        assert.equal(typeof process.listenerCount, 'function');
    });
});

test('an uncaught error prints its name, message and frames, and exits 1', async () => {
    await withGlobals((process, state, runtime) => {
        const code = exitCodeFrom(() => runtime._fatalException(new RangeError('too far'), 'uncaughtException'));
        assert.equal(code, 1);
        assert.match(state.stderr, /^RangeError: too far\n/);
        assert.match(state.stderr, /\n\s+at /, 'the frames follow the header');
    });
});

test('a thrown non-Error prints as node shows it', async () => {
    await withGlobals((process, state, runtime) => {
        assert.equal(exitCodeFrom(() => runtime._fatalException('just a string', 'uncaughtException')), 1);
        assert.equal(state.stderr, "Uncaught 'just a string'\n");
    });
});

test('an uncaughtException listener takes the error and the run carries on', async () => {
    await withGlobals((process, state, runtime) => {
        const seen = [];
        process.on('uncaughtException', (err, origin) => seen.push([err.message, origin]));
        assert.equal(exitCodeFrom(() => runtime._fatalException(new Error('kept'), 'uncaughtException')), null);
        assert.deepEqual(seen, [['kept', 'uncaughtException']]);
        assert.equal(state.stderr, '');
    });
});

test('a throwing uncaughtException listener is fatal', async () => {
    await withGlobals((process, state, runtime) => {
        process.on('uncaughtException', () => { throw new Error('handler broke'); });
        assert.equal(exitCodeFrom(() => runtime._fatalException(new Error('first'), 'uncaughtException')), 1);
        assert.match(state.stderr, /^Error: handler broke/);
    });
});

test('an uncaught error emits exit with code 1', async () => {
    await withGlobals((process, state, runtime) => {
        const seen = [];
        process.on('exit', (code) => seen.push(code));
        exitCodeFrom(() => runtime._fatalException(new Error('x'), 'uncaughtException'));
        assert.deepEqual(seen, [1]);
    });
});

// ── unhandled rejections ─────────────────────────────────────────────────────

test('an unhandled rejection prints the reason and exits 1', async () => {
    await withGlobals((process, state, runtime) => {
        const p = {};
        runtime._onRejection(p, new Error('nobody caught me'), false);
        assert.equal(exitCodeFrom(() => runtime._processRejections()), 1);
        assert.match(state.stderr, /^Error: nobody caught me\n/);
    });
});

test('a rejection handled before the check is not reported', async () => {
    await withGlobals((process, state, runtime) => {
        const p = {};
        runtime._onRejection(p, new Error('late catch'), false);
        runtime._onRejection(p, undefined, true);
        assert.equal(exitCodeFrom(() => runtime._processRejections()), null);
        assert.equal(state.stderr, '');
    });
});

test('a non-Error rejection reason raises ERR_UNHANDLED_REJECTION', async () => {
    await withGlobals((process, state, runtime) => {
        let caught;
        process.on('uncaughtException', (err, origin) => { caught = [err, origin]; });
        runtime._onRejection({}, 'plain reason', false);
        runtime._processRejections();
        assert.equal(caught[0].code, 'ERR_UNHANDLED_REJECTION');
        assert.match(caught[0].message, /The promise rejected with the reason "'plain reason'"/);
        assert.equal(caught[1], 'unhandledRejection');
    });
});

test('an unhandledRejection listener takes the rejection instead', async () => {
    await withGlobals((process, state, runtime) => {
        const seen = [];
        const p = {};
        process.on('unhandledRejection', (reason, promise) => seen.push([reason, promise]));
        runtime._onRejection(p, 'why', false);
        assert.equal(exitCodeFrom(() => runtime._processRejections()), null);
        assert.deepEqual(seen, [['why', p]]);
        assert.equal(state.stderr, '');
    });
});

// ── a drained event loop ─────────────────────────────────────────────────────

test('a drained loop emits exit and ends with process.exitCode', async () => {
    await withGlobals((process, state, runtime) => {
        const seen = [];
        process.on('exit', (code) => seen.push(code));
        process.exitCode = 3;
        assert.equal(runtime._onLoopDrained(), 3);
        assert.deepEqual(seen, [3]);
    });
});

test('a drained loop with no exitCode ends with 0', async () => {
    await withGlobals((process, state, runtime) => {
        assert.equal(runtime._onLoopDrained(), 0);
    });
});
