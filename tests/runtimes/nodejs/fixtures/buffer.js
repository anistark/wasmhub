// Buffer API + binary fs read. Portable: uses __dirname so it produces identical
// output under real Node and under the WASM runtime (with the fixtures dir
// preopened), which makes it a direct differential test.

const fs = require("fs");

const u = Buffer.from("héllo ✓", "utf8");
console.log("len=" + u.length);
console.log("utf8=" + u.toString());
console.log("hex=" + u.toString("hex"));
console.log("base64=" + u.toString("base64"));
console.log("base64url=" + u.toString("base64url"));
console.log("hex.rt=" + Buffer.from(u.toString("hex"), "hex").toString("utf8"));
console.log("b64.rt=" + Buffer.from(u.toString("base64"), "base64").toString("utf8"));

const a = Buffer.alloc(6);
a.write("AB", 1);
console.log("alloc.hex=" + a.toString("hex"));

console.log("concat=" + Buffer.concat([Buffer.from("foo"), Buffer.from("-"), Buffer.from("bar")]).toString());

const n = Buffer.alloc(4);
n.writeUInt32BE(0x01020304, 0);
console.log("u32be.hex=" + n.toString("hex"));
console.log("u32le=" + n.readUInt32LE(0));
console.log("i16be=" + Buffer.from([0xff, 0xfe]).readInt16BE(0));

const d = Buffer.alloc(8);
d.writeDoubleLE(3.5, 0);
console.log("double=" + d.readDoubleLE(0));

console.log("isBuffer=" + Buffer.isBuffer(a) + "," + Buffer.isBuffer("x") + "," + Buffer.isBuffer(new Uint8Array(2)));
console.log("byteLength=" + Buffer.byteLength("héllo ✓", "utf8"));
console.log("equals=" + Buffer.from("ab").equals(Buffer.from("ab")));
console.log("compare=" + Buffer.from("a").compare(Buffer.from("b")));
console.log("indexOf=" + Buffer.from("hello world").indexOf("world"));
console.log("includes=" + Buffer.from("hello").includes("ell"));
console.log("slice=" + Buffer.from("hello").slice(1, 4).toString());

const te = new TextEncoder();
const td = new TextDecoder();
console.log("textcodec=" + td.decode(te.encode("round✓trip")));

// binary fs read: no encoding -> Buffer; with encoding -> string
const raw = fs.readFileSync(__dirname + "/config.json");
console.log("fs.isBuffer=" + Buffer.isBuffer(raw));
console.log("fs.byte0=" + raw[0]);
const txt = fs.readFileSync(__dirname + "/config.json", "utf8");
console.log("fs.utf8.type=" + typeof txt);
console.log("fs.parsed.name=" + JSON.parse(txt).name);

console.log("done");
