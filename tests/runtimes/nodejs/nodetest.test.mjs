// Tests for the runtime's own node:test runner, run under plain node via
// ./harness.mjs. Each case loads a fresh runtime (the runner keeps
// module-level registration state), drives it, and reads back the TAP it
// wrote to the fake process.stdout.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './harness.mjs';

/// Load a runtime with a process whose stdout is captured, register tests
/// through `register`, and resolve with the TAP output once the run has
/// printed its summary.
async function runTests(register) {
    const rt = await loadRuntime();
    let output = '';
    let exitCode = 0;

    const previous = globalThis.process;
    globalThis.process = {
        stdout: { write(text) { output += text; return true; } },
        exit(code) { exitCode = code; },
        exitCode: 0,
    };
    try {
        register(rt.nodeTest);
        const deadline = Date.now() + 5000;
        while (!output.includes('# duration_ms') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    } finally {
        globalThis.process = previous;
    }
    return { output, exitCode, lines: output.split('\n') };
}

/// The counts from the trailing summary comments.
function summary(output) {
    const counts = {};
    for (const line of output.split('\n')) {
        const m = /^# (tests|suites|pass|fail|skipped|todo) (\d+)$/.exec(line);
        if (m) counts[m[1]] = Number(m[2]);
    }
    return counts;
}

test('a passing test prints TAP and reports no failures', async () => {
    const { output, exitCode } = await runTests((t) => {
        t.test('adds', () => { assert.equal(1 + 1, 2); });
    });

    assert.match(output, /^TAP version 13\n/);
    assert.ok(output.includes('# Subtest: adds'));
    assert.ok(output.includes('ok 1 - adds'));
    assert.ok(output.includes('\n1..1\n'));
    assert.deepEqual(summary(output), { tests: 1, suites: 0, pass: 1, fail: 0, skipped: 0, todo: 0 });
    assert.equal(exitCode, 0);
});

test('a failing test is reported and exits non-zero', async () => {
    const { output, exitCode } = await runTests((t) => {
        t.test('passes', () => {});
        t.test('fails', () => { assert.equal(1, 2, 'one is not two'); });
    });

    assert.ok(output.includes('ok 1 - passes'));
    assert.ok(output.includes('not ok 2 - fails'));
    assert.ok(output.includes("error: 'one is not two'"));
    assert.ok(output.includes("code: 'ERR_ASSERTION'"));
    assert.equal(summary(output).fail, 1);
    assert.equal(exitCode, 1, 'a failing run must exit non-zero');
});

test('async and promise-returning bodies are awaited', async () => {
    const order = [];
    const { output } = await runTests((t) => {
        t.test('async body', async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push('async');
        });
        t.test('promise body', () => Promise.resolve().then(() => order.push('promise')));
        t.test('rejects', () => Promise.reject(new Error('nope')));
        t.test('callback body', (_t, done) => { order.push('callback'); done(); });
    });

    assert.deepEqual(order, ['async', 'promise', 'callback'], 'tests run in order, one at a time');
    assert.ok(output.includes('not ok 3 - rejects'));
    assert.ok(output.includes("error: 'nope'"));
    assert.equal(summary(output).pass, 3);
});

test('a suite reports its children\'s failures without double counting', async () => {
    const { output } = await runTests((t) => {
        t.describe('math', () => {
            t.test('adds', () => {});
            t.test('fails', () => { throw new Error('one is not two'); });
        });
    });

    assert.ok(output.includes('not ok 1 - math'));
    assert.ok(output.includes("failureType: 'subtestsFailed'"));
    assert.ok(output.includes("error: '1 subtest failed'"));
    // An error with no code of its own is reported the way node reports it.
    assert.ok(output.includes("code: 'ERR_TEST_FAILURE'"));
    assert.equal(summary(output).fail, 1, 'the suite must not be counted as a second failure');
});

test('describe groups nest and report as suites', async () => {
    const { output } = await runTests((t) => {
        t.describe('math', () => {
            t.test('adds', () => {});
            t.describe('deep', () => {
                t.test('nested', () => {});
            });
        });
    });

    // Node indents each level by four spaces, numbering restarting per level.
    assert.ok(output.includes('# Subtest: math'));
    assert.ok(output.includes('    # Subtest: adds'));
    assert.ok(output.includes('    ok 1 - adds'));
    assert.ok(output.includes('        ok 1 - nested'));
    assert.ok(output.includes('    1..2'));
    assert.ok(output.includes('ok 1 - math'));
    assert.ok(output.includes("type: 'suite'"));
    assert.deepEqual(summary(output), { tests: 2, suites: 2, pass: 2, fail: 0, skipped: 0, todo: 0 });
});

test('hooks run around tests in the right order', async () => {
    const order = [];
    await runTests((t) => {
        t.describe('outer', () => {
            t.before(() => order.push('before'));
            t.beforeEach(() => order.push('beforeEach'));
            t.afterEach(() => order.push('afterEach'));
            t.after(() => order.push('after'));
            t.test('one', () => order.push('one'));
            t.test('two', () => order.push('two'));
        });
    });

    assert.deepEqual(order, [
        'before',
        'beforeEach', 'one', 'afterEach',
        'beforeEach', 'two', 'afterEach',
        'after',
    ]);
});

test('nested beforeEach hooks run outermost first', async () => {
    const order = [];
    await runTests((t) => {
        t.describe('outer', () => {
            t.beforeEach(() => order.push('outer-before'));
            t.afterEach(() => order.push('outer-after'));
            t.describe('inner', () => {
                t.beforeEach(() => order.push('inner-before'));
                t.afterEach(() => order.push('inner-after'));
                t.test('body', () => order.push('body'));
            });
        });
    });

    assert.deepEqual(order, [
        'outer-before', 'inner-before', 'body', 'inner-after', 'outer-after',
    ]);
});

test('afterEach runs even when the test fails', async () => {
    const order = [];
    const { output } = await runTests((t) => {
        t.afterEach(() => order.push('cleanup'));
        t.test('fails', () => { throw new Error('boom'); });
    });

    assert.deepEqual(order, ['cleanup']);
    assert.ok(output.includes('not ok 1 - fails'));
});

test('skip and todo are reported as TAP directives', async () => {
    const ran = [];
    const { output, exitCode } = await runTests((t) => {
        t.test.skip('skipped by method', () => ran.push('a'));
        t.test('skipped by option', { skip: true }, () => ran.push('b'));
        t.test('skipped by reason', { skip: 'not on wasi' }, () => ran.push('c'));
        t.test.todo('todo by method', () => ran.push('d'));
        t.test('todo that fails', { todo: true }, () => { throw new Error('later'); });
        t.test('skipped from inside', (ctx) => { ctx.skip('changed my mind'); });
    });

    // A skipped body never runs; a todo body does, which is how a todo that
    // has started working shows up. Node behaves the same way.
    assert.deepEqual(ran, ['d']);
    assert.ok(output.includes('ok 1 - skipped by method # SKIP'));
    assert.ok(output.includes('ok 2 - skipped by option # SKIP'));
    assert.ok(output.includes('ok 3 - skipped by reason # SKIP not on wasi'));
    assert.ok(output.includes('ok 4 - todo by method # TODO'));
    assert.ok(output.includes('not ok 5 - todo that fails # TODO'));
    assert.ok(output.includes('ok 6 - skipped from inside # SKIP changed my mind'));

    const counts = summary(output);
    assert.equal(counts.skipped, 4);
    assert.equal(counts.todo, 2);
    assert.equal(counts.fail, 0, 'a failing todo does not fail the run');
    assert.equal(exitCode, 0);
});

test('describe.skip does not run its body', async () => {
    const ran = [];
    const { output } = await runTests((t) => {
        t.describe.skip('skipped suite', () => { ran.push('registered'); t.test('inner', () => ran.push('inner')); });
    });

    assert.deepEqual(ran, []);
    assert.ok(output.includes('ok 1 - skipped suite # SKIP'));
});

test('it and suite are aliases of test and describe', async () => {
    const { output } = await runTests((t) => {
        t.suite('group', () => {
            t.it('works', () => {});
        });
    });

    assert.ok(output.includes('# Subtest: group'));
    assert.ok(output.includes('    ok 1 - works'));
});

test('the context carries the name and can print diagnostics', async () => {
    let seen;
    const { output } = await runTests((t) => {
        t.test('named', (ctx) => { seen = ctx.name; ctx.diagnostic('halfway'); });
    });

    assert.equal(seen, 'named');
    assert.ok(output.includes('# halfway'));
});

test('the runner is reachable as node:test only', async () => {
    const rt = await loadRuntime();
    assert.equal(typeof rt.builtins['node:test'], 'function');
    assert.equal(rt.builtins['node:test'].test, rt.builtins['node:test']);
    assert.equal(typeof rt.builtins['node:test'].describe, 'function');
    assert.ok(!Object.prototype.hasOwnProperty.call(rt.builtins, 'test'));
});
