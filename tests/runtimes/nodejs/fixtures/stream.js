// stream: Readable.from -> Transform (uppercase) -> Writable (collect).
// Output is a single line printed on 'finish', so it's order-deterministic and
// matches real Node regardless of internal event-loop timing.

const { Readable, Writable, Transform, PassThrough } = require("stream");

const src = Readable.from(["foo", "bar", "baz"]);

const upper = new Transform({
    transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); },
    flush(cb) { cb(null, "!"); },
});

const chunks = [];
const sink = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk.toString()); cb(); },
});
sink.on("finish", () => console.log("pipe=" + chunks.join("|")));

src.pipe(upper).pipe(sink);

// Independent PassThrough round-trip, also collected on finish.
const pt = new PassThrough();
const ptOut = [];
pt.on("data", (c) => ptOut.push(c.toString()));
pt.on("end", () => console.log("passthrough=" + ptOut.join("")));
pt.write("hello ");
pt.end("world");
