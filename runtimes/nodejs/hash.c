/*
 * MD5 (RFC 1321), SHA-1 and the SHA-2 family (FIPS 180-4), for the nodejs
 * runtime's crypto module.
 *
 * main.js has pure-JS versions of md5, sha1 and sha256, and under wasmrun's
 * interpreter they cost about 1.5 s per 64-byte block, so anything beyond a
 * short digest was impractical. These run as compiled wasm instead, and add
 * sha224, sha384 and sha512, which the JS side never had because it has no
 * cheap 64-bit arithmetic.
 *
 * Every algorithm shares one buffering loop: MD5, SHA-1 and SHA-224/256 work
 * on 64-byte blocks, SHA-384/512 on 128-byte blocks, and they differ only in
 * the compression function, the length encoding and the output words.
 */

#include <string.h>
#include <strings.h>

#include "hash.h"

static uint32_t rotl32(uint32_t x, unsigned n) { return (x << n) | (x >> (32 - n)); }
static uint32_t rotr32(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }
static uint64_t rotr64(uint64_t x, unsigned n) { return (x >> n) | (x << (64 - n)); }

static uint32_t load32le(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static uint32_t load32be(const uint8_t *p)
{
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}

static uint64_t load64be(const uint8_t *p)
{
    return (uint64_t)load32be(p) << 32 | load32be(p + 4);
}

static void store32le(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static void store32be(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v;
}

static void store64be(uint8_t *p, uint64_t v)
{
    store32be(p, (uint32_t)(v >> 32));
    store32be(p + 4, (uint32_t)v);
}

/* ── MD5 ──────────────────────────────────────────────────────────────────── */

static const uint32_t MD5_K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};

static const uint8_t MD5_S[64] = {
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static void md5_compress(uint32_t *h, const uint8_t *p)
{
    uint32_t m[16], a = h[0], b = h[1], c = h[2], d = h[3], f, t;
    unsigned i, g;

    for (i = 0; i < 16; i++)
        m[i] = load32le(p + 4 * i);
    for (i = 0; i < 64; i++) {
        if (i < 16)      { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (b & d) | (c & ~d); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d;          g = (3 * i + 5) & 15; }
        else             { f = c ^ (b | ~d);       g = (7 * i) & 15; }
        t = d;
        d = c;
        c = b;
        b = b + rotl32(a + f + MD5_K[i] + m[g], MD5_S[i]);
        a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
}

/* ── SHA-1 ────────────────────────────────────────────────────────────────── */

static void sha1_compress(uint32_t *h, const uint8_t *p)
{
    uint32_t w[80], a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f, k, t;
    unsigned i;

    for (i = 0; i < 16; i++)
        w[i] = load32be(p + 4 * i);
    for (i = 16; i < 80; i++)
        w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    for (i = 0; i < 80; i++) {
        if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d;                    k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8f1bbcdc; }
        else             { f = b ^ c ^ d;                    k = 0xca62c1d6; }
        t = rotl32(a, 5) + f + e + k + w[i];
        e = d; d = c; c = rotl32(b, 30); b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
}

/* ── SHA-224 / SHA-256 ────────────────────────────────────────────────────── */

static const uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static const uint32_t SHA224_IV[8] = {
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
    0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
};

static const uint32_t SHA256_IV[8] = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
};

static void sha256_compress(uint32_t *h, const uint8_t *p)
{
    uint32_t w[64], v[8], s0, s1, t1, t2;
    unsigned i;

    for (i = 0; i < 16; i++)
        w[i] = load32be(p + 4 * i);
    for (i = 16; i < 64; i++) {
        s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    memcpy(v, h, sizeof(v));
    for (i = 0; i < 64; i++) {
        s1 = rotr32(v[4], 6) ^ rotr32(v[4], 11) ^ rotr32(v[4], 25);
        t1 = v[7] + s1 + ((v[4] & v[5]) ^ (~v[4] & v[6])) + SHA256_K[i] + w[i];
        s0 = rotr32(v[0], 2) ^ rotr32(v[0], 13) ^ rotr32(v[0], 22);
        t2 = s0 + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
        v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1;
        v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
    }
    for (i = 0; i < 8; i++)
        h[i] += v[i];
}

/* ── SHA-384 / SHA-512 ────────────────────────────────────────────────────── */

static const uint64_t SHA512_K[80] = {
    0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
    0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
    0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
    0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
    0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
    0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
    0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
    0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
    0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
    0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
    0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
    0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
    0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
    0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
    0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
    0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
    0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
    0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
    0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
    0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL,
};

static const uint64_t SHA384_IV[8] = {
    0xcbbb9d5dc1059ed8ULL, 0x629a292a367cd507ULL, 0x9159015a3070dd17ULL, 0x152fecd8f70e5939ULL,
    0x67332667ffc00b31ULL, 0x8eb44a8768581511ULL, 0xdb0c2e0d64f98fa7ULL, 0x47b5481dbefa4fa4ULL,
};

static const uint64_t SHA512_IV[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL,
};

static void sha512_compress(uint64_t *h, const uint8_t *p)
{
    uint64_t w[80], v[8], s0, s1, t1, t2;
    unsigned i;

    for (i = 0; i < 16; i++)
        w[i] = load64be(p + 8 * i);
    for (i = 16; i < 80; i++) {
        s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7);
        s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    memcpy(v, h, sizeof(v));
    for (i = 0; i < 80; i++) {
        s1 = rotr64(v[4], 14) ^ rotr64(v[4], 18) ^ rotr64(v[4], 41);
        t1 = v[7] + s1 + ((v[4] & v[5]) ^ (~v[4] & v[6])) + SHA512_K[i] + w[i];
        s0 = rotr64(v[0], 28) ^ rotr64(v[0], 34) ^ rotr64(v[0], 39);
        t2 = s0 + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
        v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1;
        v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
    }
    for (i = 0; i < 8; i++)
        h[i] += v[i];
}

/* ── Shared buffering ─────────────────────────────────────────────────────── */

static const struct {
    const char *name;
    int alg;
} HASH_NAMES[] = {
    { "md5", WASMHUB_MD5 },
    { "sha1", WASMHUB_SHA1 },
    { "sha224", WASMHUB_SHA224 },
    { "sha256", WASMHUB_SHA256 },
    { "sha384", WASMHUB_SHA384 },
    { "sha512", WASMHUB_SHA512 },
};

int wasmhub_hash_lookup(const char *name)
{
    char key[16];
    size_t i, n = 0;

    /* Node takes "SHA-256" and "RSA-SHA256" style names as well. */
    if (strncasecmp(name, "rsa-", 4) == 0)
        name += 4;
    for (i = 0; name[i] && n + 1 < sizeof(key); i++) {
        char ch = name[i];
        if (ch == '-')
            continue;
        key[n++] = (ch >= 'A' && ch <= 'Z') ? (char)(ch - 'A' + 'a') : ch;
    }
    if (name[i])
        return 0;
    key[n] = '\0';
    for (i = 0; i < sizeof(HASH_NAMES) / sizeof(HASH_NAMES[0]); i++) {
        if (strcmp(key, HASH_NAMES[i].name) == 0)
            return HASH_NAMES[i].alg;
    }
    return 0;
}

size_t wasmhub_hash_block_size(int alg)
{
    return (alg == WASMHUB_SHA384 || alg == WASMHUB_SHA512) ? 128 : 64;
}

size_t wasmhub_hash_digest_size(int alg)
{
    switch (alg) {
    case WASMHUB_MD5:    return 16;
    case WASMHUB_SHA1:   return 20;
    case WASMHUB_SHA224: return 28;
    case WASMHUB_SHA256: return 32;
    case WASMHUB_SHA384: return 48;
    case WASMHUB_SHA512: return 64;
    default:             return 0;
    }
}

int wasmhub_hash_init(wasmhub_hash_ctx *c, int alg)
{
    memset(c, 0, sizeof(*c));
    switch (alg) {
    case WASMHUB_MD5:
        c->h.w[0] = 0x67452301; c->h.w[1] = 0xefcdab89;
        c->h.w[2] = 0x98badcfe; c->h.w[3] = 0x10325476;
        break;
    case WASMHUB_SHA1:
        c->h.w[0] = 0x67452301; c->h.w[1] = 0xefcdab89; c->h.w[2] = 0x98badcfe;
        c->h.w[3] = 0x10325476; c->h.w[4] = 0xc3d2e1f0;
        break;
    case WASMHUB_SHA224: memcpy(c->h.w, SHA224_IV, sizeof(SHA224_IV)); break;
    case WASMHUB_SHA256: memcpy(c->h.w, SHA256_IV, sizeof(SHA256_IV)); break;
    case WASMHUB_SHA384: memcpy(c->h.d, SHA384_IV, sizeof(SHA384_IV)); break;
    case WASMHUB_SHA512: memcpy(c->h.d, SHA512_IV, sizeof(SHA512_IV)); break;
    default:
        return -1;
    }
    c->alg = (uint32_t)alg;
    return 0;
}

static void compress(wasmhub_hash_ctx *c, const uint8_t *block)
{
    switch (c->alg) {
    case WASMHUB_MD5:  md5_compress(c->h.w, block); break;
    case WASMHUB_SHA1: sha1_compress(c->h.w, block); break;
    case WASMHUB_SHA224:
    case WASMHUB_SHA256: sha256_compress(c->h.w, block); break;
    default:             sha512_compress(c->h.d, block); break;
    }
}

void wasmhub_hash_update(wasmhub_hash_ctx *c, const uint8_t *p, size_t n)
{
    size_t bs = wasmhub_hash_block_size((int)c->alg), take;

    c->count += n;
    if (c->used) {
        take = bs - c->used;
        if (take > n)
            take = n;
        memcpy(c->buf + c->used, p, take);
        c->used += (uint32_t)take;
        p += take;
        n -= take;
        if (c->used < bs)
            return;
        compress(c, c->buf);
        c->used = 0;
    }
    for (; n >= bs; p += bs, n -= bs)
        compress(c, p);
    if (n) {
        memcpy(c->buf, p, n);
        c->used = (uint32_t)n;
    }
}

size_t wasmhub_hash_final(wasmhub_hash_ctx *c, uint8_t *out)
{
    size_t bs = wasmhub_hash_block_size((int)c->alg);
    size_t len_bytes = bs == 128 ? 16 : 8;
    size_t size = wasmhub_hash_digest_size((int)c->alg), i;
    uint64_t bits = c->count << 3;

    c->buf[c->used++] = 0x80;
    if (c->used > bs - len_bytes) {
        memset(c->buf + c->used, 0, bs - c->used);
        compress(c, c->buf);
        c->used = 0;
    }
    memset(c->buf + c->used, 0, bs - c->used);
    if (c->alg == WASMHUB_MD5) {
        store32le(c->buf + bs - 8, (uint32_t)bits);
        store32le(c->buf + bs - 4, (uint32_t)(bits >> 32));
    } else {
        /* A 128-bit length for the 128-byte block hashes; its high half is
           whatever count lost to the shift. */
        if (len_bytes == 16)
            store64be(c->buf + bs - 16, c->count >> 61);
        store64be(c->buf + bs - 8, bits);
    }
    compress(c, c->buf);
    c->used = 0;

    if (c->alg == WASMHUB_MD5) {
        for (i = 0; i < 4; i++)
            store32le(out + 4 * i, c->h.w[i]);
    } else if (bs == 64) {
        for (i = 0; i < size / 4; i++)
            store32be(out + 4 * i, c->h.w[i]);
    } else {
        for (i = 0; i < size / 8; i++)
            store64be(out + 8 * i, c->h.d[i]);
    }
    return size;
}
