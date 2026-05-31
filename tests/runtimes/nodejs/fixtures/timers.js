// Exercises the event loop: microtask ordering (process.nextTick / queueMicrotask
// / Promise / async-await) plus macrotask timers (setTimeout / setInterval).
// The runtime keeps running until the event loop drains, so the deferred output
// below appears even though the top-level body finishes synchronously first.
//
// Delays are spaced (5ms / 10ms steps) so the timer ordering is deterministic
// and does not interleave.

const order = [];
order.push("sync-start");

// Microtasks — drain (FIFO) before any timer fires.
process.nextTick(() => console.log("nextTick"));
queueMicrotask(() => console.log("queueMicrotask"));
Promise.resolve().then(() => console.log("promise.then"));

// Timer with trailing args forwarded to the callback.
setTimeout((a, b) => console.log(`setTimeout=${a},${b}`), 5, "x", "y");

// Self-rearming interval, stopped from inside via clearInterval.
let ticks = 0;
const iv = setInterval(() => {
    ticks += 1;
    console.log(`interval ${ticks}`);
    if (ticks === 3) clearInterval(iv);
}, 10);

// clearTimeout must prevent this from ever firing.
const cancelled = setTimeout(() => console.log("SHOULD NOT PRINT"), 15);
clearTimeout(cancelled);

// async/await resolves on the microtask queue once the body returns.
(async () => {
    const v = await Promise.resolve(42);
    console.log(`async/await=${v}`);
})();

order.push("sync-end");
console.log(order.join(" -> "));
