#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"

if [[ -z "${SOURCE_DIR}" ]] || [[ ! -d "${SOURCE_DIR}" ]]; then
    echo "Usage: $0 <source-directory>"
    exit 1
fi

echo "Patching source at ${SOURCE_DIR}..."

# ── QuickJS patches ──────────────────────────────────────────────────────────

if [[ -f "${SOURCE_DIR}/Makefile" ]] && grep -q "quickjs" "${SOURCE_DIR}/Makefile" 2>/dev/null; then
    echo "  [quickjs] Detected QuickJS source tree"

    # Mark CONFIG_WASI in the Makefile so native `make` invocations also get
    # the right defaults (workers disabled, pthreads excluded).
    if grep -q "CONFIG_WASI" "${SOURCE_DIR}/Makefile"; then
        echo "  [quickjs] WASI config already present in Makefile"
    else
        echo "  [quickjs] Adding CONFIG_WASI default to Makefile"
        # GNU sed: insert line before the first CFLAGS= assignment
        sed -i '/^CFLAGS=/i CONFIG_WASI?=y' "${SOURCE_DIR}/Makefile"
    fi

    # Expose entropy to JS as os.getentropy(len) → ArrayBuffer. wasi-libc
    # implements getentropy() via the WASI random_get syscall, which is what
    # backs crypto.getRandomValues in main.js.
    if grep -q "js_os_getentropy" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] getentropy binding already present"
    else
        echo "  [quickjs] Adding os.getentropy binding to quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'PYEOF'
import sys

path = sys.argv[1]
content = open(path).read()

func = '''
/* wasmhub: entropy for crypto.getRandomValues — getentropy() is wasi-libc's
   wrapper over the WASI random_get syscall (max 256 bytes per call). */
extern int getentropy(void *buffer, size_t len);

static JSValue js_os_getentropy(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    uint32_t len;
    uint8_t *buf;
    size_t off, chunk;
    JSValue ab;
    if (JS_ToUint32(ctx, &len, argv[0]))
        return JS_EXCEPTION;
    if (len > 65536)
        return JS_ThrowRangeError(ctx, "getentropy: length must not exceed 65536");
    buf = js_malloc(ctx, len ? len : 1);
    if (!buf)
        return JS_EXCEPTION;
    for (off = 0; off < len; off += chunk) {
        chunk = len - off > 256 ? 256 : len - off;
        if (getentropy(buf + off, chunk)) {
            js_free(ctx, buf);
            return JS_ThrowInternalError(ctx, "getentropy failed");
        }
    }
    ab = JS_NewArrayBufferCopy(ctx, buf, len);
    js_free(ctx, buf);
    return ab;
}

'''

anchor = "static const JSCFunctionListEntry js_os_funcs[] = {"
if anchor not in content:
    sys.exit("quickjs-libc.c: js_os_funcs anchor not found")
entry = '    JS_CFUNC_DEF("getentropy", 1, js_os_getentropy ),'
content = content.replace(anchor, func + anchor + "\n" + entry, 1)
open(path, "w").write(content)
PYEOF
    fi

    # Let std.evalScript() name the script it compiles. Stock QuickJS hardcodes
    # "<evalScript>", so every CommonJS module main.js compiled reported the
    # same placeholder and no stack frame said which file it came from.
    if grep -q "wasmhub_eval_filename" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] evalScript filename option already present"
    else
        echo "  [quickjs] Adding evalScript filename option to quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'PYEOF'
import sys

path = sys.argv[1]
content = open(path).read()

# 1. Declare the filename locals alongside the existing option locals.
decl_anchor = """    JSValueConst options_obj;
    BOOL backtrace_barrier = FALSE;
    BOOL is_async = FALSE;
    int flags;
"""
if decl_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript locals anchor not found")
content = content.replace(decl_anchor, decl_anchor + """    /* wasmhub: optional filename so stack frames name the real script */
    const char *wasmhub_eval_filename = NULL;
    JSValue wasmhub_filename_val = JS_UNDEFINED;
""", 1)

# 2. Read the option next to the ones already parsed.
opt_anchor = """        if (get_bool_option(ctx, &is_async, options_obj,
                            "async"))
            return JS_EXCEPTION;
"""
if opt_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript options anchor not found")
content = content.replace(opt_anchor, opt_anchor + """        /* wasmhub */
        wasmhub_filename_val = JS_GetPropertyStr(ctx, options_obj, "filename");
        if (JS_IsException(wasmhub_filename_val))
            return JS_EXCEPTION;
        if (!JS_IsUndefined(wasmhub_filename_val)) {
            wasmhub_eval_filename = JS_ToCString(ctx, wasmhub_filename_val);
            if (!wasmhub_eval_filename) {
                JS_FreeValue(ctx, wasmhub_filename_val);
                return JS_EXCEPTION;
            }
        }
""", 1)

# 3. Use it, and release both borrowed references.
eval_anchor = """    ret = JS_Eval(ctx, str, len, "<evalScript>", flags);
    JS_FreeCString(ctx, str);
"""
if eval_anchor not in content:
    sys.exit("quickjs-libc.c: js_evalScript JS_Eval anchor not found")
content = content.replace(eval_anchor, """    ret = JS_Eval(ctx, str, len,
                  wasmhub_eval_filename ? wasmhub_eval_filename : "<evalScript>",
                  flags);
    JS_FreeCString(ctx, str);
    if (wasmhub_eval_filename)
        JS_FreeCString(ctx, wasmhub_eval_filename);
    JS_FreeValue(ctx, wasmhub_filename_val);
""", 1)

open(path, "w").write(content)
PYEOF
    fi

    # Expose the WASI Preview 1 socket calls to JS as os.sock*, which is what
    # main.js builds the `net` and `http` server halves on. The bindings
    # themselves live in runtimes/nodejs/wasi_sockets.c; this only registers
    # them on the `os` module, alongside the functions quickjs-libc ships.
    if grep -q "wasmhub_sock_funcs" "${SOURCE_DIR}/quickjs-libc.c"; then
        echo "  [quickjs] socket bindings already registered"
    else
        echo "  [quickjs] Registering os.sock* bindings in quickjs-libc.c"
        python3 - "${SOURCE_DIR}/quickjs-libc.c" <<'SOCKEOF'
import re
import sys

path = sys.argv[1]
content = open(path).read()

# The list is defined in wasi_sockets.c, compiled and linked alongside, so an
# extern declaration is all quickjs-libc needs in order to export it.
decl = """
/* wasmhub: host socket bindings (runtimes/nodejs/wasi_sockets.c) */
extern const JSCFunctionListEntry wasmhub_sock_funcs[];
extern const int wasmhub_sock_funcs_count;

"""

init_anchor = "static int js_os_init(JSContext *ctx, JSModuleDef *m)"
if init_anchor not in content:
    sys.exit("quickjs-libc.c: js_os_init anchor not found")
content = content.replace(init_anchor, decl + init_anchor, 1)

# A module's exports are declared with JS_AddModuleExportList when the module
# is created and filled in with JS_SetModuleExportList when it initialises.
# Both have to know about the extra entries or the names resolve to undefined.
add_pat = re.compile(
    r"JS_AddModuleExportList\(ctx,\s*m,\s*js_os_funcs,\s*countof\(js_os_funcs\)\);"
)
if not add_pat.search(content):
    sys.exit("quickjs-libc.c: JS_AddModuleExportList(js_os_funcs) not found")
content = add_pat.sub(
    lambda m: m.group(0)
    + "\n    JS_AddModuleExportList(ctx, m, wasmhub_sock_funcs, wasmhub_sock_funcs_count);",
    content,
    count=1,
)

set_pat = re.compile(
    r"return\s+JS_SetModuleExportList\(ctx,\s*m,\s*js_os_funcs,\s*countof\(js_os_funcs\)\);"
)
if not set_pat.search(content):
    sys.exit("quickjs-libc.c: JS_SetModuleExportList(js_os_funcs) not found")
content = set_pat.sub(
    "if (JS_SetModuleExportList(ctx, m, js_os_funcs, countof(js_os_funcs)))\n"
    "        return -1;\n"
    "    return JS_SetModuleExportList(ctx, m, wasmhub_sock_funcs,\n"
    "                                  wasmhub_sock_funcs_count);",
    content,
    count=1,
)

open(path, "w").write(content)
SOCKEOF
    fi

    echo "  [quickjs] Patches applied"
    exit 0
fi

# ── Node.js patches (full Node.js build, weeks 11-13) ───────────────────────

if [[ -f "${SOURCE_DIR}/configure.py" ]]; then
    echo "  [nodejs] Detected Node.js source tree"

    # configure.py: add 'wasi' to valid dest_os values
    if ! grep -q "'wasi'" "${SOURCE_DIR}/configure.py"; then
        echo "  [nodejs] Patching configure.py: add wasi dest_os"
        sed -i "s/'android', 'freebsd'/'android', 'freebsd', 'wasi'/" "${SOURCE_DIR}/configure.py" || \
        sed -i "s/valid_os = \[/valid_os = ['wasi',/" "${SOURCE_DIR}/configure.py"
    fi

    # configure.py: add 'wasm32' to valid dest_cpu values
    if ! grep -q "'wasm32'" "${SOURCE_DIR}/configure.py"; then
        echo "  [nodejs] Patching configure.py: add wasm32 dest_cpu"
        sed -i "s/valid_arch = \[/valid_arch = ['wasm32',/" "${SOURCE_DIR}/configure.py" || true
    fi

    # node.gyp: disable V8 JIT tiers that require mmap(PROT_EXEC)
    if [[ -f "${SOURCE_DIR}/node.gyp" ]] && ! grep -q "OS==\"wasi\"" "${SOURCE_DIR}/node.gyp"; then
        echo "  [nodejs] Patching node.gyp: disable V8 JIT for WASI"
        python3 - "${SOURCE_DIR}/node.gyp" <<'PYEOF'
import re, sys
content = open(sys.argv[1]).read()
wasi_condition = """['OS=="wasi"', {
          'v8_enable_turbofan%': 0,
          'v8_enable_maglev%': 0,
        }],"""
content = re.sub(r"('OS==\"linux\"')", r"\1, " + wasi_condition.replace('\n', '\n          '), content, count=1)
open(sys.argv[1], 'w').write(content)
PYEOF
    fi

    # libuv: minimal WASI event loop stub (no epoll/kqueue; networking unsupported)
    UV_WASI_STUB="${SOURCE_DIR}/deps/uv/src/wasi.c"
    if [[ ! -f "${UV_WASI_STUB}" ]]; then
        echo "  [nodejs] Creating libuv WASI stub"
        mkdir -p "$(dirname "${UV_WASI_STUB}")"
        cat > "${UV_WASI_STUB}" <<'WASI_STUB'
#if defined(__wasi__)
#include "uv.h"
#include <errno.h>
#include <string.h>

int uv_loop_init(uv_loop_t* loop) { memset(loop, 0, sizeof(*loop)); return 0; }
int uv_run(uv_loop_t* loop, uv_run_mode mode) { (void)loop; (void)mode; return 0; }
void uv_stop(uv_loop_t* loop) { (void)loop; }
int uv_loop_close(uv_loop_t* loop) { (void)loop; return 0; }
int uv_tcp_init(uv_loop_t* loop, uv_tcp_t* handle) { (void)loop; (void)handle; return UV_ENOSYS; }
int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb) { (void)stream; (void)backlog; (void)cb; return UV_ENOSYS; }
int uv_tcp_connect(uv_connect_t* req, uv_tcp_t* handle, const struct sockaddr* addr, uv_connect_cb cb)
{ (void)req; (void)handle; (void)addr; (void)cb; return UV_ENOSYS; }
#endif /* __wasi__ */
WASI_STUB
    fi

    echo "  [nodejs] Patches applied"
    exit 0
fi

echo "Warning: unrecognised source tree at ${SOURCE_DIR} — no patches applied"
