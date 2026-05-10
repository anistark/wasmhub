#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
RUNTIMES_DIR="${PROJECT_ROOT}/runtimes/nodejs"
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

mkdir -p "${BUILD_DIR}" "${RUNTIMES_DIR}"

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

echo "Applying WASI patches to QuickJS..."
"${SCRIPT_DIR}/patch-nodejs.sh" "${QUICKJS_DIR}"

echo "Building QuickJS for WASI (Node.js ${NODE_VERSION} compat)..."
pushd "${QUICKJS_DIR}" > /dev/null

WASM_CFLAGS="--target=wasm32-wasi --sysroot=${SYSROOT} -O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS"

make \
    CC="${CLANG}" \
    AR="${AR}" \
    RANLIB="${RANLIB}" \
    CFLAGS="${WASM_CFLAGS}" \
    CONFIG_WASI=y \
    CONFIG_BIGNUM=y \
    qjs

popd > /dev/null

QJS_BINARY="${QUICKJS_DIR}/qjs"
if [[ ! -f "${QJS_BINARY}" ]]; then
    echo "Error: QuickJS binary not found after build"
    exit 1
fi

# Bundle main.js into the binary via qjsc (compile to bytecode)
if [[ -f "${QUICKJS_DIR}/qjsc" ]] && [[ -f "${RUNTIMES_DIR}/main.js" ]]; then
    echo "Bundling runtime entrypoint with qjsc..."
    "${QUICKJS_DIR}/qjsc" \
        -o "${BUILD_DIR}/nodejs-main.c" \
        -m "${RUNTIMES_DIR}/main.js"

    "${CLANG}" \
        --target=wasm32-wasi \
        --sysroot="${SYSROOT}" \
        -O2 \
        -I "${QUICKJS_DIR}" \
        "${BUILD_DIR}/nodejs-main.c" \
        "${QUICKJS_DIR}/libquickjs.a" \
        -o "${OUTPUT_PATH}" \
        -lm
else
    cp "${QJS_BINARY}" "${OUTPUT_PATH}"
fi

if [[ "${OPTIMIZE}" == "true" ]] && command -v wasm-opt &> /dev/null; then
    echo "Optimizing with wasm-opt..."
    wasm-opt -O3 --enable-bulk-memory "${OUTPUT_PATH}" -o "${OUTPUT_PATH}.opt"
    mv "${OUTPUT_PATH}.opt" "${OUTPUT_PATH}"
fi

SIZE=$(stat -f%z "${OUTPUT_PATH}" 2>/dev/null || stat -c%s "${OUTPUT_PATH}")
SHA256=$(shasum -a 256 "${OUTPUT_PATH}" | cut -d' ' -f1)

echo ""
echo "Build complete:"
echo "  File: ${OUTPUT_PATH}"
echo "  Size: ${SIZE} bytes"
echo "  SHA256: ${SHA256}"

cp "${OUTPUT_PATH}" "${RUNTIMES_DIR}/"

"${SCRIPT_DIR}/generate-metadata.sh" \
    --language nodejs \
    --version "${NODE_VERSION}" \
    --file "${RUNTIMES_DIR}/${OUTPUT_NAME}" \
    --features "eval,esm,filesystem,stdio,env"
