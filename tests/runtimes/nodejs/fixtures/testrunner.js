// Smoke test for the node:test runner, which needs a real runtime: it prints
// TAP through process.stdout and sets the process exit code.
//
//   wasmrun exec --dir . nodejs-20.wasm -- run testrunner.js
//
// Expected: TAP for four tests, one of them skipped and one todo, and exit 0.
// Flip SHOULD_FAIL to see a failing run exit 1.

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const SHOULD_FAIL = process.env.WASMHUB_TEST_FAIL === '1';
const order = [];

describe('arithmetic', () => {
    before(() => order.push('before'));
    beforeEach(() => order.push('beforeEach'));

    test('adds', () => {
        order.push('adds');
        assert.strictEqual(1 + 1, 2);
    });

    test('awaits', async () => {
        order.push('awaits');
        const value = await Promise.resolve(41);
        assert.strictEqual(value + 1, 42);
    });
});

test('skipped', { skip: 'nothing to do here' }, () => {
    throw new Error('a skipped body never runs');
});

test.todo('todo', () => {
    throw new Error('a todo body never runs either');
});

test('hooks ran in order', () => {
    assert.deepStrictEqual(order, ['before', 'beforeEach', 'adds', 'beforeEach', 'awaits']);
});

if (SHOULD_FAIL) {
    test('deliberate failure', () => {
        assert.strictEqual('actual', 'expected');
    });
}
