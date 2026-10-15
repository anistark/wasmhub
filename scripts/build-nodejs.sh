#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
RUNTIMES_DIR="${PROJECT_ROOT}/runtimes/nodejs"

# shellcheck source=scripts/lib/features.sh
source "${SCRIPT_DIR}/lib/features.sh"
BUILD_DIR="${PROJECT_ROOT}/build/nodejs"

NODE_VERSION="${NODE_VERSION:-20}"
QUICKJS_VERSION="${QUICKJS_VERSION:-2024-01-13}"
OPTIMIZE="${OPTIMIZE:-true}"
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-false}"
WASI_SDK_PATH="${WASI_SDK_PATH:-/opt/wasi-sdk}"

usage() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION       Node.js compat version label (default: ${NODE_VERSION})"
    echo "  --quickjs-version VERSION   QuickJS version (default: ${QUICKJS_VERSION})"
    echo "  --no-optimize               Skip wasm-opt optimization"
    echo "  --skip-download             Reuse existing QuickJS source"
    echo "  -h, --help                  Show this help"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--version) NODE_VERSION="$2"; shift 2 ;;
        --quickjs-version) QUICKJS_VERSION="$2"; shift 2 ;;
        --no-optimize) OPTIMIZE="false"; shift ;;
        --skip-download) SKIP_DOWNLOAD="true"; shift ;;
        -h|--help) usage ;;
        -*) echo "Unknown option: $1"; usage ;;
        *) echo "Unknown argument: $1"; usage ;;
    esac
done

if [[ ! -d "${WASI_SDK_PATH}" ]]; then
    echo "Error: WASI SDK not found at ${WASI_SDK_PATH}"
    echo "Run inside the wasmhub-builder Docker container."
    exit 1
fi

CLANG="${WASI_SDK_PATH}/bin/clang"
AR="${WASI_SDK_PATH}/bin/llvm-ar"
RANLIB="${WASI_SDK_PATH}/bin/llvm-ranlib"
SYSROOT="${WASI_SDK_PATH}/share/wasi-sysroot"

QUICKJS_DIR="${BUILD_DIR}/quickjs-${QUICKJS_VERSION}"
OUTPUT_NAME="nodejs-${NODE_VERSION}.wasm"
OUTPUT_PATH="${BUILD_DIR}/${OUTPUT_NAME}"
# The same runtime with outbound sockets (net.connect, http.request, fetch).
# It imports sock_open and sock_connect, wasmrun extensions a stock WASI host
# lacks, so it is a second artifact rather than the default: a host without
# them cannot instantiate it.
NET_VERSION="${NODE_VERSION}-net"
NET_OUTPUT_NAME="nodejs-${NET_VERSION}.wasm"
NET_OUTPUT_PATH="${BUILD_DIR}/${NET_OUTPUT_NAME}"

mkdir -p "${BUILD_DIR}" "${RUNTIMES_DIR}"

# ── Download ──────────────────────────────────────────────────────────────────

if [[ "${SKIP_DOWNLOAD}" != "true" ]] || [[ ! -d "${QUICKJS_DIR}" ]]; then
    TARBALL="quickjs-${QUICKJS_VERSION}.tar.xz"
    DOWNLOAD_URL="https://bellard.org/quickjs/${TARBALL}"

    echo "Downloading QuickJS ${QUICKJS_VERSION}..."
    curl -fsSL -o "${BUILD_DIR}/${TARBALL}" "${DOWNLOAD_URL}"
    tar -xJf "${BUILD_DIR}/${TARBALL}" -C "${BUILD_DIR}"
    rm "${BUILD_DIR}/${TARBALL}"
    echo "Source extracted to ${QUICKJS_DIR}"
fi

if [[ ! -d "${QUICKJS_DIR}" ]]; then
    echo "Error: QuickJS source not found at ${QUICKJS_DIR}"
    exit 1
fi

# ── Native qjsc (for JS bundling) ─────────────────────────────────────────────
# Build qjsc natively BEFORE applying WASI patches so the host compiler can
# link against pthreads and other POSIX libs that patches strip out.

echo "Building native qjsc for JS bundling..."
pushd "${QUICKJS_DIR}" > /dev/null
make CC=cc CONFIG_BIGNUM=y qjsc 2>&1 | tail -3
popd > /dev/null

NATIVE_QJSC="${QUICKJS_DIR}/qjsc"
BUNDLE_C="${BUILD_DIR}/nodejs_bundle.c"
HAS_BUNDLE=false

if [[ -f "${NATIVE_QJSC}" ]] && [[ -f "${RUNTIMES_DIR}/main.js" ]]; then
    echo "Bundling main.js via qjsc..."
    # -e: emit main() + bytecode to a C file (default is full executable output)
    # -m: treat input as ES module
    # -fbignum: match CONFIG_BIGNUM=y used in the WASM build
    "${NATIVE_QJSC}" -e -o "${BUNDLE_C}" -m "${RUNTIMES_DIR}/main.js"
    HAS_BUNDLE=true
else
    echo "Warning: native qjsc unavailable — building interpreter-only binary"
fi

# ── WASI patches ─────────────────────────────────────────────────────────────

echo "Applying WASI patches..."
"${SCRIPT_DIR}/patch-nodejs.sh" "${QUICKJS_DIR}"

# ── Compile QuickJS to WASM ───────────────────────────────────────────────────
# Compile each source file individually with the WASI clang.
# - CONFIG_WASI=1 : disables worker threads (CONFIG_WORKER) and pthread includes
# - CONFIG_BIGNUM=1: enables BigInt/BigFloat support
# - _WASI_EMULATED_SIGNAL/_WASI_EMULATED_PROCESS_CLOCKS: WASI libc emulation layers
# - -include wasi_shims.h: stubs popen, fork, setenv, exec*, waitpid without
#   modifying QuickJS source

echo "Compiling QuickJS for WASI..."

WASI_SHIMS="${RUNTIMES_DIR}/wasi_shims.h"

WASM_CFLAGS=(
    "--target=wasm32-wasi"
    "--sysroot=${SYSROOT}"
    "-O2"
    "-DCONFIG_BIGNUM=1"
    "-DCONFIG_WASI=1"
    "-D_WASI_EMULATED_SIGNAL"
    "-D_WASI_EMULATED_PROCESS_CLOCKS"
    "-D_WASI_EMULATED_GETPID"
    "-DCONFIG_VERSION=\"${QUICKJS_VERSION}\""
    "-Wno-deprecated-declarations"
    "-I${RUNTIMES_DIR}/wasi_include"
    "-I${QUICKJS_DIR}"
    "-include"
    "${WASI_SHIMS}"
)

QJS_SOURCES=(quickjs.c quickjs-libc.c cutils.c libbf.c libregexp.c libunicode.c)
WASM_OBJS=()

for src in "${QJS_SOURCES[@]}"; do
    obj="${BUILD_DIR}/${src%.c}.o"
    echo "  Compiling ${src}..."
    "${CLANG}" "${WASM_CFLAGS[@]}" -c "${QUICKJS_DIR}/${src}" -o "${obj}"
    WASM_OBJS+=("${obj}")
done

if [[ "${HAS_BUNDLE}" == "true" ]]; then
    echo "  Compiling bundled main.js bytecode..."
    "${CLANG}" "${WASM_CFLAGS[@]}" -c "${BUNDLE_C}" -o "${BUILD_DIR}/nodejs_bundle.o"
    WASM_OBJS+=("${BUILD_DIR}/nodejs_bundle.o")
else
    echo "  Compiling qjs.c (interpreter entry point)..."
    "${CLANG}" "${WASM_CFLAGS[@]}" -c "${QUICKJS_DIR}/qjs.c" -o "${BUILD_DIR}/qjs.o"
    WASM_OBJS+=("${BUILD_DIR}/qjs.o")
fi

echo "  Compiling WASI link-time stubs..."
"${CLANG}" "${WASM_CFLAGS[@]}" -c "${RUNTIMES_DIR}/wasi_stubs.c" -o "${BUILD_DIR}/wasi_stubs.o"
WASM_OBJS+=("${BUILD_DIR}/wasi_stubs.o")

# Native hashing, memoryUsage and the async context (os.hash*, ...). No host
# imports, so these are in both builds.
echo "  Compiling host bindings..."
"${CLANG}" "${WASM_CFLAGS[@]}" -c "${RUNTIMES_DIR}/hash.c" -o "${BUILD_DIR}/hash.o"
"${CLANG}" "${WASM_CFLAGS[@]}" -c "${RUNTIMES_DIR}/host_bindings.c" -o "${BUILD_DIR}/host_bindings.o"
WASM_OBJS+=("${BUILD_DIR}/hash.o" "${BUILD_DIR}/host_bindings.o")

# The socket bindings behind os.sock*, which main.js turns into `net` and
# `http`. The default object uses Preview 1 standard calls only
# (sock_accept/recv/send/shutdown), so it adds no import a stock WASI host does
# not already provide; the -net object adds sock_open and sock_connect.
echo "  Compiling WASI socket bindings..."
"${CLANG}" "${WASM_CFLAGS[@]}" -c "${RUNTIMES_DIR}/wasi_sockets.c" -o "${BUILD_DIR}/wasi_sockets.o"
"${CLANG}" "${WASM_CFLAGS[@]}" -DWASMHUB_OUTBOUND -c "${RUNTIMES_DIR}/wasi_sockets.c" -o "${BUILD_DIR}/wasi_sockets_net.o"

# ── Link, optimize, publish ───────────────────────────────────────────────────

# link_runtime <socket object> <output path>
link_runtime() {
    echo "Linking $(basename "$2")..."
    "${CLANG}" \
        --target=wasm32-wasi \
        --sysroot="${SYSROOT}" \
        "${WASM_OBJS[@]}" "$1" \
        -lwasi-emulated-signal \
        -lwasi-emulated-process-clocks \
        -ldl \
        -lwasi-emulated-getpid \
        -lm \
        -Wl,-z,stack-size=8388608 \
        -o "$2"

    if [[ "${OPTIMIZE}" == "true" ]] && command -v wasm-opt &> /dev/null; then
        echo "Optimizing $(basename "$2") with wasm-opt..."
        wasm-opt -O3 --enable-bulk-memory "$2" -o "$2.opt"
        mv "$2.opt" "$2"
    fi

    local size sha
    size=$(stat -f%z "$2" 2>/dev/null || stat -c%s "$2")
    sha=$(shasum -a 256 "$2" | cut -d' ' -f1)
    echo "  File: $2"
    echo "  Size: ${size} bytes"
    echo "  SHA256: ${sha}"
    cp "$2" "${RUNTIMES_DIR}/"
}

link_runtime "${BUILD_DIR}/wasi_sockets.o" "${OUTPUT_PATH}"
link_runtime "${BUILD_DIR}/wasi_sockets_net.o" "${NET_OUTPUT_PATH}"

# The feature list lives beside the runtime source, not in this script and not
# in the generated manifest, so adding a feature and publishing it are the same
# change. A hardcoded list here silently overwrote the manifest at release time.
FEATURES=$(read_features "${RUNTIMES_DIR}/features.txt")
NET_FEATURES="${FEATURES},$(read_features "${RUNTIMES_DIR}/features-net.txt")"

# The -net entry first and --no-latest, so `latest` stays the portable build:
# a consumer asking for the latest runtime gets one every host can load.
"${SCRIPT_DIR}/generate-metadata.sh" \
    --language nodejs \
    --version "${NET_VERSION}" \
    --file "${RUNTIMES_DIR}/${NET_OUTPUT_NAME}" \
    --features "${NET_FEATURES}" \
    --no-latest

"${SCRIPT_DIR}/generate-metadata.sh" \
    --language nodejs \
    --version "${NODE_VERSION}" \
    --file "${RUNTIMES_DIR}/${OUTPUT_NAME}" \
    --features "${FEATURES}"
