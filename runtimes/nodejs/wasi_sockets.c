/*
 * Host socket bindings for the nodejs runtime, exposed to JavaScript as the
 * os.sock* functions that runtimes/nodejs/main.js builds `net` and `http` on.
 *
 * ── Inbound only, and why ────────────────────────────────────────────────────
 *
 * Everything here uses WASI Preview 1 as it is actually standardised:
 * sock_accept, sock_recv, sock_send and sock_shutdown, plus fd_close and
 * fd_fdstat_set_flags. No extensions, so a binary containing this file imports
 * only what a stock preview1 host already provides and keeps instantiating
 * everywhere it does today.
 *
 * That is enough to be a *server* and not enough to be a *client*. Preview 1
 * has no way to create a socket -- sock_open, sock_bind, sock_connect and
 * sock_listen are WASIX-style extensions -- so a socket can only arrive from
 * outside, already bound and listening. The host binds the port and hands the
 * listening descriptor to the guest; the guest only ever accepts on it.
 *
 * WebAssembly imports are static: declaring an extension would mean every host
 * must supply it or the module fails to instantiate before a line of JS runs,
 * and weak linkage does not help (wasm-ld emits the import or replaces the
 * call with a trapping stub, never both). Outbound connect therefore waits for
 * a separate networking build once the import contract is settled; until then
 * main.js reports it as unsupported with that reason.
 *
 * ── How the listening descriptor arrives ─────────────────────────────────────
 *
 * By convention, through the environment:
 *
 *   WASMHUB_LISTEN_FD    the descriptor number of a bound, listening socket
 *   WASMHUB_LISTEN_ADDR  optional "host:port" it is bound to, so that
 *                        server.address() can answer truthfully
 *
 * This mirrors `wasmtime run --tcplisten`, which binds the port on the host
 * side and passes the socket in as a descriptor after the directory preopens.
 * Nothing here reads the environment: main.js does, and passes the descriptor
 * down. Keeping the convention in one place makes it reusable by the go and
 * rust runtimes if they ever grow program execution.
 */

#include <stdint.h>
#include <string.h>
#include <errno.h>

#include "quickjs.h"

#define WASM_IMPORT(name) \
    __attribute__((__import_module__("wasi_snapshot_preview1"), \
                   __import_name__(name)))

typedef struct {
    const uint8_t *buf;
    uint32_t len;
} wasi_iovec;

/* sock_accept is the three-argument preview1 form. WASIX defines a
   four-argument variant of the same name that also returns the peer address;
   using the standard one keeps the signature compatible with stock hosts, at
   the cost of not knowing who connected. */
WASM_IMPORT("sock_accept")
int32_t wasmhub_sock_accept(int32_t fd, uint32_t fdflags, int32_t *fd_out);

WASM_IMPORT("sock_recv")
int32_t wasmhub_sock_recv(int32_t fd, const wasi_iovec *ri_data,
                          uint32_t ri_data_len, uint32_t ri_flags,
                          uint32_t *ro_datalen, uint32_t *ro_flags);

WASM_IMPORT("sock_send")
int32_t wasmhub_sock_send(int32_t fd, const wasi_iovec *si_data,
                          uint32_t si_data_len, uint32_t si_flags,
                          uint32_t *so_datalen);

WASM_IMPORT("sock_shutdown")
int32_t wasmhub_sock_shutdown(int32_t fd, uint32_t how);

WASM_IMPORT("fd_close")
int32_t wasmhub_fd_close(int32_t fd);

WASM_IMPORT("fd_fdstat_set_flags")
int32_t wasmhub_fd_fdstat_set_flags(int32_t fd, uint32_t flags);

#define WASI_FDFLAG_NONBLOCK 0x0004
#define WASI_SHUT_RD         0x0001
#define WASI_SHUT_WR         0x0002

/* ── errno → Node error code ──────────────────────────────────────────────── */

/* Values come from wasi-libc's errno.h rather than being written out, so the
   mapping stays correct if the WASI numbering is ever revised. Anything not
   listed reaches JavaScript as "UNKNOWN", which main.js reports verbatim. */
static const char *errno_to_code(int32_t err)
{
    switch (err) {
    case 0:              return NULL;
    case EAGAIN:         return "EAGAIN";
    case EACCES:         return "EACCES";
    case EBADF:          return "EBADF";
    case ECONNABORTED:   return "ECONNABORTED";
    case ECONNRESET:     return "ECONNRESET";
    case EINTR:          return "EINTR";
    case EINVAL:         return "EINVAL";
    case EMFILE:         return "EMFILE";
    case EMSGSIZE:       return "EMSGSIZE";
    case ENOBUFS:        return "ENOBUFS";
    case ENOMEM:         return "ENOMEM";
    case ENOTCONN:       return "ENOTCONN";
    case ENOTSOCK:       return "ENOTSOCK";
    case ENOTSUP:        return "ENOTSUP";
    case ENOSYS:         return "ENOSYS";
    case EPERM:          return "EPERM";
    case EPIPE:          return "EPIPE";
    case ETIMEDOUT:      return "ETIMEDOUT";
    default:             return "UNKNOWN";
    }
}

/* Every binding answers [value, code]: code is null on success and a Node
   error-code string otherwise. That is the shape os.stat and os.readdir
   already use, with a string in place of a raw errno. */
static JSValue result_pair(JSContext *ctx, JSValue value, int32_t err)
{
    JSValue pair = JS_NewArray(ctx);
    const char *code = errno_to_code(err);
    if (JS_IsException(pair)) {
        JS_FreeValue(ctx, value);
        return pair;
    }
    JS_SetPropertyUint32(ctx, pair, 0, value);
    JS_SetPropertyUint32(ctx, pair, 1,
                         code ? JS_NewString(ctx, code) : JS_NULL);
    return pair;
}

static JSValue error_only(JSContext *ctx, int32_t err)
{
    const char *code = errno_to_code(err);
    return code ? JS_NewString(ctx, code) : JS_NULL;
}

/* ── Bindings ─────────────────────────────────────────────────────────────── */

/* os.sockNonblocking(fd) -> code
   Applied to the listener and to every accepted connection. A host that
   refuses the flag still leaves a usable socket; it just means the poll loop's
   calls block, which is survivable for a single connection and is why the
   caller treats a failure here as advisory. */
static JSValue js_wasmhub_sock_nonblocking(JSContext *ctx,
                                           JSValueConst this_val,
                                           int argc, JSValueConst *argv)
{
    int32_t fd;
    (void)this_val; (void)argc;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    return error_only(ctx,
                      wasmhub_fd_fdstat_set_flags(fd, WASI_FDFLAG_NONBLOCK));
}

/* os.sockAccept(fd) -> [clientFd, code]
   EAGAIN, meaning nothing is pending, is the ordinary answer on a poll tick
   and is not an error condition. Accepted descriptors are made non-blocking
   here so no caller can forget to. */
static JSValue js_wasmhub_sock_accept(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    int32_t fd, client = -1, err;

    (void)this_val; (void)argc;

    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;

    err = wasmhub_sock_accept(fd, WASI_FDFLAG_NONBLOCK, &client);
    if (err != 0)
        return result_pair(ctx, JS_NewInt32(ctx, -1), err);

    wasmhub_fd_fdstat_set_flags(client, WASI_FDFLAG_NONBLOCK);
    return result_pair(ctx, JS_NewInt32(ctx, client), 0);
}

/* Shared argument handling for sockRecv/sockSend: (fd, arrayBuffer, offset,
   length). Returns 0 on success, -1 with a pending exception otherwise. */
static int read_buffer_args(JSContext *ctx, JSValueConst *argv,
                            int32_t *fd, uint8_t **base, uint32_t *length)
{
    size_t size;
    uint8_t *buf;
    uint32_t offset, len;

    if (JS_ToInt32(ctx, fd, argv[0]))
        return -1;
    buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf)
        return -1;
    if (JS_ToUint32(ctx, &offset, argv[2]) ||
        JS_ToUint32(ctx, &len, argv[3]))
        return -1;
    if (offset > size || len > size - offset) {
        JS_ThrowRangeError(ctx, "socket buffer range out of bounds");
        return -1;
    }
    *base = buf + offset;
    *length = len;
    return 0;
}

/* os.sockRecv(fd, arrayBuffer, offset, length) -> [bytesRead, code]
   A clean end of stream is [0, null]; nothing available yet is EAGAIN. The
   two are entirely different events to a stream, so the caller must not
   collapse them. */
static JSValue js_wasmhub_sock_recv(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    wasi_iovec iov;
    uint32_t got = 0, roflags = 0, length;
    uint8_t *base;
    int32_t fd, err;

    (void)this_val; (void)argc;

    if (read_buffer_args(ctx, argv, &fd, &base, &length))
        return JS_EXCEPTION;

    iov.buf = base;
    iov.len = length;
    err = wasmhub_sock_recv(fd, &iov, 1, 0, &got, &roflags);
    if (err != 0)
        return result_pair(ctx, JS_NewInt32(ctx, -1), err);
    return result_pair(ctx, JS_NewUint32(ctx, got), 0);
}

/* os.sockSend(fd, arrayBuffer, offset, length) -> [bytesWritten, code]
   A short write is normal on a non-blocking socket, so the caller re-queues
   the remainder rather than treating it as an error. */
static JSValue js_wasmhub_sock_send(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    wasi_iovec iov;
    uint32_t sent = 0, length;
    uint8_t *base;
    int32_t fd, err;

    (void)this_val; (void)argc;

    if (read_buffer_args(ctx, argv, &fd, &base, &length))
        return JS_EXCEPTION;

    iov.buf = base;
    iov.len = length;
    err = wasmhub_sock_send(fd, &iov, 1, 0, &sent);
    if (err != 0)
        return result_pair(ctx, JS_NewInt32(ctx, -1), err);
    return result_pair(ctx, JS_NewUint32(ctx, sent), 0);
}

/* os.sockShutdown(fd, how) -> code, where how is 'r', 'w' or 'rw' */
static JSValue js_wasmhub_sock_shutdown(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    const char *how;
    uint32_t flags = 0;
    int32_t fd, err;

    (void)this_val; (void)argc;

    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    how = JS_ToCString(ctx, argv[1]);
    if (!how)
        return JS_EXCEPTION;
    if (strchr(how, 'r')) flags |= WASI_SHUT_RD;
    if (strchr(how, 'w')) flags |= WASI_SHUT_WR;
    JS_FreeCString(ctx, how);

    err = wasmhub_sock_shutdown(fd, flags);
    return error_only(ctx, err);
}

/* os.sockClose(fd) -> code */
static JSValue js_wasmhub_sock_close(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    int32_t fd;
    (void)this_val; (void)argc;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    return error_only(ctx, wasmhub_fd_close(fd));
}

/* ── Registration ─────────────────────────────────────────────────────────── */

/* Appended to quickjs-libc's js_os_funcs[] by scripts/patch-nodejs.sh, which
   is why these are the only non-static symbols in the file. */
const JSCFunctionListEntry wasmhub_sock_funcs[] = {
    JS_CFUNC_DEF("sockAccept",      1, js_wasmhub_sock_accept),
    JS_CFUNC_DEF("sockRecv",        4, js_wasmhub_sock_recv),
    JS_CFUNC_DEF("sockSend",        4, js_wasmhub_sock_send),
    JS_CFUNC_DEF("sockShutdown",    2, js_wasmhub_sock_shutdown),
    JS_CFUNC_DEF("sockClose",       1, js_wasmhub_sock_close),
    JS_CFUNC_DEF("sockNonblocking", 1, js_wasmhub_sock_nonblocking),
};

const int wasmhub_sock_funcs_count =
    (int)(sizeof(wasmhub_sock_funcs) / sizeof(wasmhub_sock_funcs[0]));
