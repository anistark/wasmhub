// Web platform globals: URL / URLSearchParams / structuredClone /
// crypto.getRandomValues / fetch. Output is deterministic — run under real
// Node and the WASM runtime and diff.

// ── URL parsing ──
const u = new URL('https://user:pass@example.com:8443/a/b/../c?x=1&y=2#frag');
console.log('href=' + u.href);
console.log('origin=' + u.origin);
console.log('protocol=' + u.protocol);
console.log('host=' + u.host);
console.log('hostname=' + u.hostname);
console.log('port=' + u.port);
console.log('pathname=' + u.pathname);
console.log('search=' + u.search);
console.log('hash=' + u.hash);
console.log('userinfo=' + u.username + ',' + u.password);

// ── relative resolution + default-port elision ──
console.log('rel=' + new URL('../z?q=3', 'https://example.com/a/b/c').href);
console.log('abs=' + new URL('/root', 'https://example.com/a/b').href);
console.log('defport=' + new URL('http://example.com:80/p').href);
console.log('canParse=' + URL.canParse('https://ok.com') + ',' + URL.canParse('not a url'));

// ── URLSearchParams ──
const p = new URLSearchParams('a=1&b=two&a=3');
console.log('get=' + p.get('a') + ',' + p.getAll('a').join('|'));
p.append('c', 'x y');
p.set('b', 'B');
p.delete('a');
console.log('qs=' + p.toString());
console.log('entries=' + [...p].map(e => e.join(':')).join(','));

// ── URL <-> searchParams sync ──
const u2 = new URL('https://example.com/p');
u2.searchParams.set('q', 'hello world');
console.log('sync=' + u2.href);
u2.search = '?fresh=1';
console.log('resync=' + u2.searchParams.get('fresh'));

// ── structuredClone ──
const obj = {
    n: 1,
    d: new Date(1700000000000),
    arr: [1, [2, 3]],
    m: new Map([['k', 'v']]),
    s: new Set([1, 2]),
    u8: new Uint8Array([9, 8, 7]),
};
obj.self = obj;
const c = structuredClone(obj);
console.log('clone.n=' + c.n);
console.log('clone.date=' + c.d.getTime());
console.log('clone.arr=' + JSON.stringify(c.arr));
console.log('clone.map=' + c.m.get('k'));
console.log('clone.set=' + [...c.s].join(','));
console.log('clone.u8=' + Array.from(c.u8).join(','));
console.log('clone.cycle=' + (c.self === c));
console.log('clone.distinct=' + (c.arr !== obj.arr && c.m !== obj.m));
let cloneErr = 'none';
try { structuredClone({ fn: () => {} }); } catch (e) { cloneErr = e.name; }
console.log('clone.fnErr=' + cloneErr);

// ── crypto ──
const r1 = crypto.getRandomValues(new Uint8Array(32));
const r2 = crypto.getRandomValues(new Uint8Array(32));
console.log('rand.len=' + r1.length);
console.log('rand.differs=' + (Array.from(r1).join() !== Array.from(r2).join()));
console.log('rand.nonzero=' + (r1.some(x => x !== 0) || r2.some(x => x !== 0)));
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
console.log('uuid.ok=' + (uuidRe.test(crypto.randomUUID()) && crypto.randomUUID() !== crypto.randomUUID()));

// ── fetch: defined, and on WASI it rejects with a clear message ──
console.log('fetch.type=' + typeof fetch);
if (process.platform === 'wasi') {
    fetch('http://example.com').catch(e =>
        console.log('fetch.err=' + (/network/.test(e.message) ? 'clear' : 'BAD:' + e.message)));
} else {
    console.log('fetch.err=clear');
}
