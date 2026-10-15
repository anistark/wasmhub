// Tests for async_hooks: AsyncLocalStorage and AsyncResource. Run under plain
// node via ./harness.mjs, where there is no engine patch, so the context is a
// plain variable: these cover the synchronous semantics and the propagation
// the runtime does itself (timers). Propagation across promises and awaits is
// the engine's, and fixtures/asynccontext.js covers it against a built wasm.
//
// Run: node --test tests/runtimes/nodejs/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, withGlobals } from './harness.mjs';

const rt = await loadRuntime();
const { AsyncLocalStorage, AsyncResource } = rt.asyncHooksModule;

test('async_hooks is a builtin, under node: too', () => {
    assert.equal(rt.builtins.async_hooks, rt.asyncHooksModule);
    assert.equal(rt.builtins['node:async_hooks'], rt.asyncHooksModule);
});

test('run() scopes a store to its callback, and stores nest', () => {
    const als = new AsyncLocalStorage();
    const other = new AsyncLocalStorage();
    assert.equal(als.getStore(), undefined);
    const result = als.run({ id: 1 }, (a, b) => {
        assert.deepEqual(als.getStore(), { id: 1 });
        other.run('x', () => {
            assert.deepEqual(als.getStore(), { id: 1 });
            assert.equal(other.getStore(), 'x');
            als.run({ id: 2 }, () => assert.deepEqual(als.getStore(), { id: 2 }));
            assert.deepEqual(als.getStore(), { id: 1 });
        });
        assert.equal(other.getStore(), undefined);
        return a + b;
    }, 2, 3);
    assert.equal(result, 5);
    assert.equal(als.getStore(), undefined);
});

test('a throwing callback still restores the outer store', () => {
    const als = new AsyncLocalStorage();
    als.run('outer', () => {
        assert.throws(() => als.run('inner', () => { throw new Error('boom'); }), /boom/);
        assert.equal(als.getStore(), 'outer');
    });
});

test('exit(), enterWith() and disable()', () => {
    const als = new AsyncLocalStorage();
    als.run('s', () => {
        als.exit(() => assert.equal(als.getStore(), undefined));
        assert.equal(als.getStore(), 's');
    });
    als.run('t', () => {
        als.enterWith('u');
        assert.equal(als.getStore(), 'u');
        als.disable();
        assert.equal(als.getStore(), undefined);
    });
    assert.equal(als.getStore(), undefined);
});

test('bind() and snapshot() capture the context they were made in', () => {
    const als = new AsyncLocalStorage();
    const bound = als.run('captured', () => AsyncLocalStorage.bind(() => als.getStore()));
    const snap = als.run('snap', () => AsyncLocalStorage.snapshot());
    assert.equal(bound(), 'captured');
    assert.equal(als.run('other', () => snap(() => als.getStore())), 'snap');
});

test('AsyncResource runs callbacks in its creation context', () => {
    const als = new AsyncLocalStorage();
    const resource = als.run('r', () => new AsyncResource('TEST'));
    assert.equal(resource.runInAsyncScope(function (x) { return [als.getStore(), this, x]; }, 'self', 7)[0], 'r');
    const fn = als.run('b', () => AsyncResource.bind(function namedFn(a, b) { return als.getStore(); }));
    assert.equal(fn(), 'b');
    assert.equal(fn.length, 2);
    assert.ok(fn.asyncResource instanceof AsyncResource);
    assert.ok(resource.asyncId() > 0);
});

test('timers run under the context they were scheduled in', async () => {
    // withGlobals loads its own runtime, whose timers and context these are.
    await withGlobals(async (proc, state, runtime) => {
        const als = new runtime.asyncHooksModule.AsyncLocalStorage();
        const seen = await new Promise((resolve) => {
            const out = [];
            als.run('t1', () => setTimeout(() => out.push(als.getStore()), 1));
            als.run('t2', () => setTimeout(() => { out.push(als.getStore()); resolve(out); }, 5));
        });
        assert.deepEqual(seen, ['t1', 't2']);
        let ticks = 0;
        const fromInterval = await new Promise((resolve) => {
            als.run('iv', () => {
                const id = setInterval(() => {
                    if (++ticks === 2) { clearInterval(id); resolve(als.getStore()); }
                }, 1);
            });
        });
        assert.equal(fromInterval, 'iv');
    });
});

test('createHook exists and does nothing', () => {
    const hook = rt.asyncHooksModule.createHook({ init() { throw new Error('never'); } });
    assert.equal(hook.enable(), hook);
    assert.equal(hook.disable(), hook);
    assert.equal(typeof rt.asyncHooksModule.executionAsyncId(), 'number');
});
