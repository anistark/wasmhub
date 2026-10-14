// Native hashing (runtimes/nodejs/hash.c through host_bindings.c): every
// algorithm against node's own digests, a 64 KiB input, HMAC-SHA512, PBKDF2
// and subtle.digest. Expected values were computed with node's crypto.
// Prints `hashes=pass`, or the first mismatch and exits 1.

const crypto = require('crypto');

const want = {
    md5: ['900150983cd24fb0d6963f7d28e17f72', 'd7b3e9daa5def26b4d7fb33ee7d2842f'],
    sha1: ['a9993e364706816aba3e25717850c26c9cd0d89d', '9c9cdbf320d401e185bccf04fbe7cd176f74a749'],
    sha224: ['23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7', '8dcc7a80ac1056dbb7b3cb30e41b3d259b7ba5d10f06cc1c4351ef23'],
    sha256: ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '1958d30cbb7f560558fe760742a47c5e27585493531035759e522fbd9c6ca90a'],
    sha384: [
        'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
        '21c7ea7bd191b18e6aace1b18b4185cb9ef2e756234e0f2249ffd7ed4a5c9c9d827d88b8552f0c627a7b6738c533fd7d',
    ],
    sha512: [
        'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
        '7c2183d2b615a34d86b65edd913b4f0f52761219ca6e14211565eb02ca29ed2a6cb9934fc354bc73f4bc19dcc45a627e50375170ff675599e900d99987e25b1c',
    ],
};

function check(label, got, expected) {
    if (got !== expected) {
        console.log(`hashes=FAIL ${label}: got ${got}, want ${expected}`);
        process.exit(1);
    }
}

// 64 KiB read from a file rather than built in a loop: a JS loop costs about
// a millisecond an iteration under wasmrun's interpreter, the hashing itself
// a fraction of that per block.
const big = require('fs').readFileSync(require('path').join(__dirname, 'hash-input.txt'));
if (big.length !== 65536) {
    console.log(`hashes=FAIL hash-input.txt is ${big.length} bytes`);
    process.exit(1);
}

const started = Date.now();
for (const [alg, [abc, large]] of Object.entries(want)) {
    check(`${alg}(abc)`, crypto.createHash(alg).update('abc').digest('hex'), abc);
    // Fed in uneven pieces, so the block buffering is exercised too.
    const h = crypto.createHash(alg);
    for (let at = 0; at < big.length; at += 10007) h.update(big.subarray(at, at + 10007));
    check(`${alg}(64 KiB)`, h.digest('hex'), large);
}
console.log(`hashed 6 x 64 KiB in ${Date.now() - started} ms`);

check('hmac-sha512',
    crypto.createHmac('sha512', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'),
    'b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a');
check('pbkdf2-sha256',
    crypto.pbkdf2Sync('password', 'salt', 2, 32, 'sha256').toString('hex'),
    'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');
check('getHashes', crypto.getHashes().join(','), 'md5,sha1,sha224,sha256,sha384,sha512');

const fork = crypto.createHash('sha256').update('ab');
const copy = fork.copy();
check('copy', copy.update('c').digest('hex'), want.sha256[0]);

crypto.webcrypto.subtle.digest('SHA-512', new TextEncoder().encode('abc')).then((buf) => {
    check('subtle.digest', Buffer.from(buf).toString('hex'), want.sha512[0]);
    console.log('hashes=pass');
});
