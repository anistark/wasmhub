// What only the engine patch can show: an AsyncLocalStorage store surviving
// awaits, including on a promise settled from another context, plus
// 'beforeExit', memoryUsage and uptime on the real event loop. Prints
// `asynccontext=pass`, or the first failure and exits 1.

const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const als = new AsyncLocalStorage();
const failures = [];
const expect = (label, got, want) => {
    if (got !== want) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Settled outside any store, from a timer scheduled before either request.
let release;
const shared = new Promise((resolve) => { release = resolve; });
setTimeout(() => release('go'), 15);

async function request(id, delay) {
    return als.run({ id }, async () => {
        expect(`${id} sync`, als.getStore().id, id);
        await sleep(delay);
        expect(`${id} after sleep`, als.getStore().id, id);
        await shared;
        expect(`${id} after a promise someone else settled`, als.getStore().id, id);
        const [a, b] = await Promise.all([sleep(1).then(() => als.getStore().id), Promise.resolve().then(() => als.getStore().id)]);
        expect(`${id} in Promise.all`, a + b, id + id);
        for await (const v of (async function* () { yield als.getStore().id; })()) expect(`${id} in async generator`, v, id);
        await new Promise((resolve) => process.nextTick(resolve));
        expect(`${id} after nextTick`, als.getStore().id, id);
        await new Promise((resolve) => queueMicrotask(resolve));
        expect(`${id} after queueMicrotask`, als.getStore().id, id);
        return als.getStore().id;
    });
}

// A package resolving #async_hooks through its "imports" map, as p-limit does.
const limit = require('limiter');

let beforeExitCount = 0;
process.on('beforeExit', (code) => {
    beforeExitCount++;
    if (beforeExitCount === 1) {
        // More work from beforeExit keeps the loop going, as in node.
        setTimeout(() => expect('store outside any run', als.getStore(), undefined), 1);
        return;
    }
    const m = process.memoryUsage();
    if (!(m.rss > 0 && m.heapUsed > 0 && m.heapTotal >= m.heapUsed)) failures.push(`memoryUsage ${JSON.stringify(m)}`);
    if (!(process.uptime() > 0)) failures.push(`uptime ${process.uptime()}`);
    expect('beforeExit code', code, 0);
    console.log(failures.length ? `asynccontext=FAIL\n${failures.join('\n')}` : 'asynccontext=pass');
    if (failures.length) process.exitCode = 1;
});

Promise.all([request('a', 10), request('b', 2), limit.run(() => limit.als.getStore())]).then(([a, b, fromLimiter]) => {
    expect('results', a + b, 'ab');
    expect('outside after all', als.getStore(), undefined);
    expect('AsyncResource.bind via #async_hooks', fromLimiter, 'limited');
});
