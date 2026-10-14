/*
 * Message digests behind the nodejs runtime's crypto.createHash and
 * createHmac. Plain C with no QuickJS dependency, so it can be compiled and
 * checked natively; host_bindings.c is the JavaScript side.
 */

#ifndef WASMHUB_HASH_H
#define WASMHUB_HASH_H

#include <stddef.h>
#include <stdint.h>

enum {
    WASMHUB_MD5 = 1,
    WASMHUB_SHA1,
    WASMHUB_SHA224,
    WASMHUB_SHA256,
    WASMHUB_SHA384,
    WASMHUB_SHA512,
};

#define WASMHUB_HASH_MAX_DIGEST 64

/* The whole state is plain bytes with no pointers, so a JavaScript
   ArrayBuffer can hold it and Hash#copy() is a byte copy. */
typedef struct {
    uint32_t alg;
    uint32_t used;   /* bytes waiting in buf */
    uint64_t count;  /* bytes hashed so far */
    union {
        uint32_t w[8];
        uint64_t d[8];
    } h;
    uint8_t buf[128];
} wasmhub_hash_ctx;

/* The algorithm's id for a name node accepts ("sha256", "SHA-256", "md5"),
   or 0 when there is none. */
int wasmhub_hash_lookup(const char *name);

/* 0 on success, -1 for an unknown algorithm. */
int wasmhub_hash_init(wasmhub_hash_ctx *c, int alg);
void wasmhub_hash_update(wasmhub_hash_ctx *c, const uint8_t *p, size_t n);
/* Writes the digest and returns its length. Leaves c finalized. */
size_t wasmhub_hash_final(wasmhub_hash_ctx *c, uint8_t *out);

size_t wasmhub_hash_block_size(int alg);
size_t wasmhub_hash_digest_size(int alg);

#endif
