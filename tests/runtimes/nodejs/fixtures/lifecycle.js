// Smoke test for the process lifecycle, which needs a real runtime: the exit
// code comes from the engine's loop, and the rejection tracker is an engine
// hook (os.setHostHooks, added by scripts/patch-nodejs.sh). One scenario per
// run, named by the first argument or, for a host that passes no arguments to
// a script (wasmrun's agent mode), by LIFECYCLE_SCENARIO:
//
//   wasmtime run --dir . nodejs-20.wasm run ./lifecycle.js <scenario>
//
// The expected exit code and output of each are checked by
// ../run-fixtures.mjs.

const scenarios = {
    // console.error exists and goes to stderr; objects are inspected.
    console() {
        console.log({ a: 1 }, [1, 2]);
        console.error('to stderr');
        console.log('lifecycle=pass');
    },
    // The shape that used to exit 0 silently: a catch that logs and exits.
    'catch-exit'() {
        async function main() { await null; throw new Error('boom'); }
        main().catch((e) => {
            console.error('caught', e.message);
            process.exit(1);
        });
    },
    // Nobody handles the rejection: node prints it and exits 1.
    unhandled() {
        (async () => { await null; throw new TypeError('nobody caught me'); })();
    },
    // A handler attached later in the same tick is not a false positive.
    'late-catch'() {
        const p = Promise.reject(new Error('late'));
        Promise.resolve().then(() => p.catch(() => console.log('lifecycle=pass')));
    },
    // A timer that throws ends the run; the later timer never fires.
    'timer-throw'() {
        setTimeout(() => { throw new Error('in timer'); }, 1);
        setTimeout(() => console.log('should not print'), 50);
    },
    // process.exitCode is the code a drained loop exits with, after 'exit'.
    'exit-code'() {
        process.on('exit', (code) => console.log('exit event', code));
        process.exitCode = 3;
    },
    // Listeners take over: the run carries on and exits 0.
    listeners() {
        process.on('uncaughtException', (e, origin) => console.log('uncaught', e.message, origin));
        process.on('unhandledRejection', (r) => console.log('unhandled', r));
        Promise.reject('why');
        setTimeout(() => { throw new Error('t'); }, 1);
        setTimeout(() => console.log('lifecycle=pass'), 20);
    },
};

const name = process.argv[2] || process.env.LIFECYCLE_SCENARIO;
if (!scenarios[name]) {
    console.error(`usage: lifecycle.js <${Object.keys(scenarios).join('|')}>`);
    process.exit(2);
}
scenarios[name]();
