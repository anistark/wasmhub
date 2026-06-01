// events + util + assert. Deterministic output for differential testing against
// real Node. Async results (promisify/callbackify) print after the sync block.

const EventEmitter = require("events");
const util = require("util");
const assert = require("assert");

// ── events ──
const ee = new EventEmitter();
const log = [];
ee.on("evt", (a, b) => log.push("on:" + a + b));
ee.once("evt", (a) => log.push("once:" + a));
ee.emit("evt", "X", "Y");
ee.emit("evt", "Z", "W");
console.log("events=" + log.join(","));
console.log("listenerCount=" + ee.listenerCount("evt"));
const fn = () => {};
ee.on("z", fn); ee.off("z", fn);
console.log("afterOff=" + ee.listenerCount("z"));
console.log("prepend=" + (() => {
    const e = new EventEmitter(); const o = [];
    e.on("p", () => o.push("a")); e.prependListener("p", () => o.push("b"));
    e.emit("p"); return o.join("");
})());
try { new EventEmitter().emit("error", new Error("boom")); } catch (e) { console.log("errEvent=" + e.message); }

// ── util ──
console.log("format=" + util.format("%s has %d items (%d%%)", "cart", 3, 50));
console.log("inherits=" + (() => {
    function A() {} A.prototype.hi = function () { return "hi"; };
    function B() {} util.inherits(B, A);
    return new B().hi() + "," + (B.super_ === A);
})());
console.log("deepStrict=" + util.isDeepStrictEqual({ a: [1, 2], b: { c: 3 } }, { a: [1, 2], b: { c: 3 } }) +
    "," + util.isDeepStrictEqual({ a: 1 }, { a: "1" }));
console.log("types=" + util.types.isDate(new Date()) + "," + util.types.isRegExp(/x/) +
    "," + util.types.isMap(new Map()) + "," + util.types.isTypedArray(new Uint8Array(1)));

// ── assert ──
function tryAssert(name, f) {
    try { f(); console.log(name + "=pass"); }
    catch (e) { console.log(name + "=" + (e.code || e.name)); }
}
tryAssert("ok", () => assert.ok(1 === 1));
tryAssert("okFail", () => assert.ok(false));
tryAssert("strictEqual", () => assert.strictEqual(2 + 2, 4));
tryAssert("strictEqualFail", () => assert.strictEqual(1, 2));
tryAssert("deepStrict", () => assert.deepStrictEqual([1, { a: 2 }], [1, { a: 2 }]));
tryAssert("deepStrictFail", () => assert.deepStrictEqual({ a: 1 }, { a: 2 }));
tryAssert("throws", () => assert.throws(() => { throw new Error("x"); }));
tryAssert("throwsRe", () => assert.throws(() => { throw new Error("nope"); }, /nope/));
tryAssert("ifError", () => assert.ifError(null));

// ── async: promisify + callbackify (print after sync block) ──
const cbStyle = (x, cb) => process.nextTick(() => cb(null, x * 2));
util.promisify(cbStyle)(21).then((v) => {
    console.log("promisify=" + v);
    util.callbackify((x) => Promise.resolve(x + 1))(9, (err, val) => console.log("callbackify=" + val));
});
