/*
 * Engine-backed helpers for the nodejs runtime, exposed to main.js on the `os`
 * module beside the socket bindings in wasi_sockets.c:
 *
 *   os.hashInit(name)                     -> ArrayBuffer state, or null
 *   os.hashUpdate(state, buf, off, len)   -> undefined
 *   os.hashDigest(state)                  -> ArrayBuffer digest
 *   os.memoryUsage()                      -> { rss, heapTotal, heapUsed, ... }
 *   os.getAsyncContext()                  -> the current async context value
 *   os.setAsyncContext(value)             -> undefined
 *
 * None of these needs a host import, so they are in every build.
 *
 * A hash's state lives in an ArrayBuffer that main.js holds, not in a C
 * allocation behind a handle: it has no pointers in it, so the garbage
 * collector owns it, nothing can leak, and Hash#copy() is a slice.
 *
 * The async context is the value AsyncLocalStorage keeps its stores in. The
 * engine patch in scripts/patch-nodejs.sh captures it when a promise reaction
 * is registered (an `await`, a `.then`) and restores it when the reaction
 * runs, which is what lets a store survive an await.
 */

#include <stdint.h>
#include <string.h>

#include "quickjs.h"
#include "hash.h"

/* Defined by the engine patch in quickjs.c. */
JSValue wasmhub_get_async_context(JSContext *ctx);
void wasmhub_set_async_context(JSContext *ctx, JSValueConst value);

static wasmhub_hash_ctx *hash_state(JSContext *ctx, JSValueConst val)
{
    size_t size;
    uint8_t *buf = JS_GetArrayBuffer(ctx, &size, val);
    wasmhub_hash_ctx *c;

    if (!buf)
        return NULL;
    c = (wasmhub_hash_ctx *)buf;
    if (size != sizeof(*c) || wasmhub_hash_digest_size((int)c->alg) == 0) {
        JS_ThrowTypeError(ctx, "not a hash state");
        return NULL;
    }
    return c;
}

/* os.hashInit(name) -> ArrayBuffer, or null when the name is not one this
   file implements. */
static JSValue js_wasmhub_hash_init(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    wasmhub_hash_ctx c;
    const char *name;
    int alg;

    (void)this_val; (void)argc;
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    alg = wasmhub_hash_lookup(name);
    JS_FreeCString(ctx, name);
    if (!alg)
        return JS_NULL;
    wasmhub_hash_init(&c, alg);
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *)&c, sizeof(c));
}

/* os.hashUpdate(state, arrayBuffer, offset, length) */
static JSValue js_wasmhub_hash_update(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    wasmhub_hash_ctx *c;
    uint8_t *data;
    size_t size;
    uint32_t offset, length;

    (void)this_val; (void)argc;
    c = hash_state(ctx, argv[0]);
    if (!c)
        return JS_EXCEPTION;
    data = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!data)
        return JS_EXCEPTION;
    if (JS_ToUint32(ctx, &offset, argv[2]) || JS_ToUint32(ctx, &length, argv[3]))
        return JS_EXCEPTION;
    if (offset > size || length > size - offset)
        return JS_ThrowRangeError(ctx, "hash input range out of bounds");
    wasmhub_hash_update(c, data + offset, length);
    return JS_UNDEFINED;
}

/* os.hashDigest(state) -> ArrayBuffer. The state is finalized; main.js
   refuses a second digest the way node does. */
static JSValue js_wasmhub_hash_digest(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    uint8_t out[WASMHUB_HASH_MAX_DIGEST];
    wasmhub_hash_ctx *c;
    size_t n;

    (void)this_val; (void)argc;
    c = hash_state(ctx, argv[0]);
    if (!c)
        return JS_EXCEPTION;
    n = wasmhub_hash_final(c, out);
    return JS_NewArrayBufferCopy(ctx, out, n);
}

/* os.memoryUsage() -> the fields of node's process.memoryUsage(). rss is the
   whole linear memory, which is what the host has committed for this
   instance; the heap figures are the engine's own accounting. */
static JSValue js_wasmhub_memory_usage(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    JSMemoryUsage s;
    JSValue obj;
    double rss = 0, heap_total;

    (void)this_val; (void)argc; (void)argv;
#ifdef __wasm__
    rss = (double)__builtin_wasm_memory_size(0) * 65536.0;
#endif
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &s);
    /* malloc_size counts what malloc_usable_size reports, which wasi-libc
       undercounts, so it can come out below what the engine knows it uses. */
    heap_total = (double)(s.malloc_size > s.memory_used_size ? s.malloc_size : s.memory_used_size);
    obj = JS_NewObject(ctx);
    if (JS_IsException(obj))
        return obj;
    JS_SetPropertyStr(ctx, obj, "rss", JS_NewFloat64(ctx, rss));
    JS_SetPropertyStr(ctx, obj, "heapTotal", JS_NewFloat64(ctx, heap_total));
    JS_SetPropertyStr(ctx, obj, "heapUsed", JS_NewFloat64(ctx, (double)s.memory_used_size));
    JS_SetPropertyStr(ctx, obj, "external", JS_NewFloat64(ctx, (double)s.binary_object_size));
    JS_SetPropertyStr(ctx, obj, "arrayBuffers", JS_NewFloat64(ctx, (double)s.binary_object_size));
    return obj;
}

static JSValue js_wasmhub_get_async_context(JSContext *ctx, JSValueConst this_val,
                                            int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return wasmhub_get_async_context(ctx);
}

static JSValue js_wasmhub_set_async_context(JSContext *ctx, JSValueConst this_val,
                                            int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc;
    wasmhub_set_async_context(ctx, argv[0]);
    return JS_UNDEFINED;
}

/* Appended to quickjs-libc's os module by scripts/patch-nodejs.sh, the same
   way wasi_sockets.c's list is. */
const JSCFunctionListEntry wasmhub_host_funcs[] = {
    JS_CFUNC_DEF("hashInit",        1, js_wasmhub_hash_init),
    JS_CFUNC_DEF("hashUpdate",      4, js_wasmhub_hash_update),
    JS_CFUNC_DEF("hashDigest",      1, js_wasmhub_hash_digest),
    JS_CFUNC_DEF("memoryUsage",     0, js_wasmhub_memory_usage),
    JS_CFUNC_DEF("getAsyncContext", 0, js_wasmhub_get_async_context),
    JS_CFUNC_DEF("setAsyncContext", 1, js_wasmhub_set_async_context),
};

const int wasmhub_host_funcs_count =
    (int)(sizeof(wasmhub_host_funcs) / sizeof(wasmhub_host_funcs[0]));
