#!/usr/bin/env bash
set -euo pipefail

# Builds the swc TypeScript transpiler as a WASI CLI.
#
# A plain stable wasm32-wasip1 build. Until wasmhub v0.6 this one was
# MVP-lowered (nightly, -Zbuild-std, target-cpu=mvp, then wasm-opt's
# memory.copy/fill lowering), because wasmrun's interpreter rejected the
# post-MVP features rustc enables by default. wasmrun 0.23.0 runs them
# (multi-value, sign-ext, nontrapping-fptoint, bulk-memory), and wasmrun pins
# the wasmhub release it consumes, so an older wasmrun never sees this build.
#
# What is still checked: the result is validated against the feature set
# wasmrun implements (WASMRUN_FEATURES below), so a toolchain that starts
# emitting something newer (SIMD, tail calls, GC) fails here, not in a sandbox.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
RUNTIMES_DIR="${PROJECT_ROOT}/runtimes/swc"

# shellcheck source=scripts/lib/features.sh
source "${SCRIPT_DIR}/lib/features.sh"

BUILD_DIR="${PROJECT_ROOT}/build/swc"

# Version label = swc_core major (mirrors nodejs-20 / rust-1.84 upstream-major naming)
SWC_VERSION="${SWC_VERSION:-73}"
TARGET="${TARGET:-wasm32-wasip1}"
OPTIMIZE="${OPTIMIZE:-true}"

# What wasmrun's interpreter runs. wasm-opt validates against exactly these.
WASMRUN_FEATURES=(
    --mvp-features
    --enable-mutable-globals
    --enable-sign-ext
    --enable-nontrapping-float-to-int
    --enable-bulk-memory
    --enable-multivalue
    --enable-reference-types
)

usage() {
    echo "Usage: $0 [options] <cargo_project_dir>"
    echo ""
    echo "Options:"
    echo "  -v, --version VERSION   swc version label (default: ${SWC_VERSION})"
    echo "  -o, --output NAME       Output filename (default: swc-VERSION.wasm)"
    echo "  -t, --target TARGET     Rust target (default: ${TARGET})"
    echo "  --no-optimize           Skip wasm-opt optimization"
    echo "  -h, --help              Show this help"
    exit 1
}

OUTPUT_NAME=""
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--version) SWC_VERSION="$2"; shift 2 ;;
        -o|--output) OUTPUT_NAME="$2"; shift 2 ;;
        -t|--target) TARGET="$2"; shift 2 ;;
        --no-optimize) OPTIMIZE="false"; shift ;;
        -h|--help) usage ;;
        -*) echo "Unknown option: $1"; usage ;;
        *) PROJECT_DIR="$1"; shift ;;
    esac
done

if [[ -z "${PROJECT_DIR}" ]]; then
    echo "Error: Cargo project directory required"
    usage
fi

if [[ ! -f "${PROJECT_DIR}/Cargo.toml" ]]; then
    echo "Error: Cargo.toml not found in: ${PROJECT_DIR}"
    exit 1
fi

if ! rustup target list --installed | grep -q "${TARGET}"; then
    echo "Adding Rust target: ${TARGET}"
    rustup target add "${TARGET}"
fi

OUTPUT_NAME="${OUTPUT_NAME:-swc-${SWC_VERSION}.wasm}"
OUTPUT_PATH="${BUILD_DIR}/${OUTPUT_NAME}"

mkdir -p "${BUILD_DIR}"

echo "Building swc transpiler..."
echo "  Project: ${PROJECT_DIR}"
echo "  Target: ${TARGET}"
echo "  Output: ${OUTPUT_PATH}"

pushd "${PROJECT_DIR}" > /dev/null
cargo build --target "${TARGET}" --release
BINARY_NAME=$(cargo metadata --format-version 1 --no-deps | jq -r '.packages[0].targets[] | select(.kind[] == "bin") | .name' | head -1)
popd > /dev/null

BUILT_WASM="${PROJECT_DIR}/target/${TARGET}/release/${BINARY_NAME}.wasm"
if [[ ! -f "${BUILT_WASM}" ]]; then
    echo "Error: Built WASM not found at: ${BUILT_WASM}"
    exit 1
fi

cp "${BUILT_WASM}" "${OUTPUT_PATH}"

# Optimize, and validate against what wasmrun runs: --mvp-features plus the
# list above means wasm-opt refuses any instruction outside it, and cannot
# introduce one while optimizing either.
if [[ "${OPTIMIZE}" == "true" ]]; then
    if ! command -v wasm-opt &> /dev/null; then
        echo "Error: wasm-opt not found; it optimizes and validates the swc artifact."
        echo "Install binaryen, or pass --no-optimize for an unchecked dev build."
        exit 1
    fi
    echo "Optimizing with $(command -v wasm-opt) ($(wasm-opt --version)), wasmrun's feature set..."
    wasm-opt "${WASMRUN_FEATURES[@]}" -O3 "${OUTPUT_PATH}" -o "${OUTPUT_PATH}.opt"
    mv "${OUTPUT_PATH}.opt" "${OUTPUT_PATH}"
else
    echo "Warning: skipping wasm-opt (--no-optimize): unoptimized and not validated"
fi

SIZE=$(stat -f%z "${OUTPUT_PATH}" 2>/dev/null || stat -c%s "${OUTPUT_PATH}")
SHA256=$(shasum -a 256 "${OUTPUT_PATH}" | cut -d' ' -f1)

echo ""
echo "Build complete:"
echo "  File: ${OUTPUT_PATH}"
echo "  Size: ${SIZE} bytes"
echo "  SHA256: ${SHA256}"

mkdir -p "${RUNTIMES_DIR}"
cp "${OUTPUT_PATH}" "${RUNTIMES_DIR}/"

FEATURES=$(read_features "${RUNTIMES_DIR}/features.txt")

"${SCRIPT_DIR}/generate-metadata.sh" \
    --language swc \
    --version "${SWC_VERSION}" \
    --file "${RUNTIMES_DIR}/${OUTPUT_NAME}" \
    --features "${FEATURES}"
