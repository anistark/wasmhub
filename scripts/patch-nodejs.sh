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
