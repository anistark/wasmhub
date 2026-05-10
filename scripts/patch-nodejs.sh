#!/usr/bin/env bash
set -euo pipefail

# Applies WASI-compatibility patches to a QuickJS or Node.js source tree.
#
# For Node.js (full build, weeks 11-13): patches configure.py and node.gyp
# to accept wasi/wasm32 targets, stubs out libuv networking, and removes
# features that require OS-level threading or process APIs.
#
# For QuickJS (current): lightweight patches to ensure WASI compatibility
# in the Makefile and config headers.

SOURCE_DIR="${1:-}"

if [[ -z "${SOURCE_DIR}" ]] || [[ ! -d "${SOURCE_DIR}" ]]; then
    echo "Usage: $0 <source-directory>"
    exit 1
fi

echo "Patching source at ${SOURCE_DIR}..."

# ── QuickJS patches ──────────────────────────────────────────────────────────

if [[ -f "${SOURCE_DIR}/Makefile" ]] && grep -q "quickjs" "${SOURCE_DIR}/Makefile" 2>/dev/null; then
    echo "  [quickjs] Detected QuickJS source tree"

    # Ensure CONFIG_WASI path doesn't require unavailable POSIX features
    if grep -q "CONFIG_WASI" "${SOURCE_DIR}/Makefile"; then
        echo "  [quickjs] WASI config already present in Makefile"
    else
        echo "  [quickjs] Adding WASI config guard to Makefile"
        sed -i 's/^CFLAGS=/CONFIG_WASI?=y\nCFLAGS=/' "${SOURCE_DIR}/Makefile"
    fi

    # Patch quickjs.h: disable atomics if not available under WASI
    if [[ -f "${SOURCE_DIR}/quickjs.h" ]]; then
        sed -i 's/#define JS_HAVE_ATOMICS 1/#ifdef __wasi__\n#undef JS_HAVE_ATOMICS\n#else\n#define JS_HAVE_ATOMICS 1\n#endif/' \
            "${SOURCE_DIR}/quickjs.h" 2>/dev/null || true
    fi

    echo "  [quickjs] Patches applied"
    exit 0
fi

# ── Node.js patches (for the full Node.js build, weeks 11-13) ───────────────

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

    # node.gyp: add wasi conditions for build flags
    if [[ -f "${SOURCE_DIR}/node.gyp" ]] && ! grep -q "OS==\"wasi\"" "${SOURCE_DIR}/node.gyp"; then
        echo "  [nodejs] Patching node.gyp: add wasi conditions"
        # Disable V8 JIT under WASI (no mmap for executable pages)
        sed -i "s/'OS==\"linux\"'/'OS==\"linux\"', ['OS==\"wasi\"', {\n          'v8_enable_turbofan%': 0,\n          'v8_enable_maglev%': 0,\n        }],/" \
            "${SOURCE_DIR}/node.gyp" 2>/dev/null || true
    fi

    # libuv: create a minimal WASI event loop stub if not present
    UV_WASI_STUB="${SOURCE_DIR}/deps/uv/src/wasi.c"
    if [[ ! -f "${UV_WASI_STUB}" ]]; then
        echo "  [nodejs] Creating libuv WASI stub"
        mkdir -p "$(dirname "${UV_WASI_STUB}")"
        cat > "${UV_WASI_STUB}" <<'WASI_STUB'
#if defined(__wasi__)
#include "uv.h"
#include <errno.h>

// Minimal WASI event loop — no epoll/kqueue, single-tick only.
// Networking and async I/O are not available under WASI Preview 1.

int uv_loop_init(uv_loop_t* loop) {
    memset(loop, 0, sizeof(*loop));
    return 0;
}

int uv_run(uv_loop_t* loop, uv_run_mode mode) {
    return 0;
}

void uv_stop(uv_loop_t* loop) {}

int uv_loop_close(uv_loop_t* loop) {
    return 0;
}

int uv_tcp_init(uv_loop_t* loop, uv_tcp_t* handle) {
    return UV_ENOSYS;
}

int uv_listen(uv_stream_t* stream, int backlog, uv_connection_cb cb) {
    return UV_ENOSYS;
}

int uv_tcp_connect(uv_connect_t* req, uv_tcp_t* handle,
                   const struct sockaddr* addr, uv_connect_cb cb) {
    return UV_ENOSYS;
}

#endif /* __wasi__ */
WASI_STUB
    fi

    echo "  [nodejs] Patches applied"
    exit 0
fi

echo "Warning: unrecognised source tree at ${SOURCE_DIR} — no patches applied"
