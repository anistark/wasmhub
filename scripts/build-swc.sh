#!/usr/bin/env bash
set -euo pipefail

# Builds the swc TypeScript transpiler as a WASI CLI.
#
# ⚠️ Unlike the other Rust builds, this one MUST be MVP-lowered: rustc ≥1.82
# enables post-MVP WASM features by default (multi-value, sign-ext,
# bulk-memory, nontrapping-fptoint) that downstream interpreters — notably
# wasmrun's exec mode, the primary consumer of this artifact — do not support.
# `-C target-cpu=mvp` needs std rebuilt with the same features, hence
# nightly + `-Zbuild-std`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
RUNTIMES_DIR="${PROJECT_ROOT}/runtimes/swc"
BUILD_DIR="${PROJECT_ROOT}/build/swc"

# Version label = swc_core major (mirrors nodejs-20 / rust-1.84 upstream-major naming)
SWC_VERSION="${SWC_VERSION:-73}"
TARGET="${TARGET:-wasm32-wasip1}"
OPTIMIZE="${OPTIMIZE:-true}"
NIGHTLY_TOOLCHAIN="${NIGHTLY_TOOLCHAIN:-nightly}"

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

if ! rustup toolchain list | grep -q "nightly"; then
    echo "Installing nightly toolchain (required for -Zbuild-std)..."
    rustup toolchain install "${NIGHTLY_TOOLCHAIN}"
fi
if ! rustup component list --toolchain "${NIGHTLY_TOOLCHAIN}" --installed | grep -q rust-src; then
    echo "Adding rust-src component (required for -Zbuild-std)..."
    rustup component add rust-src --toolchain "${NIGHTLY_TOOLCHAIN}"
fi
if ! rustup target list --toolchain "${NIGHTLY_TOOLCHAIN}" --installed | grep -q "${TARGET}"; then
    echo "Adding Rust target: ${TARGET}"
    rustup target add "${TARGET}" --toolchain "${NIGHTLY_TOOLCHAIN}"
fi

OUTPUT_NAME="${OUTPUT_NAME:-swc-${SWC_VERSION}.wasm}"
OUTPUT_PATH="${BUILD_DIR}/${OUTPUT_NAME}"

mkdir -p "${BUILD_DIR}"

echo "Building swc transpiler (MVP-lowered)..."
echo "  Project: ${PROJECT_DIR}"
echo "  Target: ${TARGET}"
echo "  Output: ${OUTPUT_PATH}"

pushd "${PROJECT_DIR}" > /dev/null
RUSTFLAGS="-C target-cpu=mvp -C target-feature=+mutable-globals" \
    cargo "+${NIGHTLY_TOOLCHAIN}" build -Zbuild-std=std,panic_abort \
    --target "${TARGET}" --release
BINARY_NAME=$(cargo metadata --format-version 1 --no-deps | jq -r '.packages[0].targets[] | select(.kind[] == "bin") | .name' | head -1)
popd > /dev/null

BUILT_WASM="${PROJECT_DIR}/target/${TARGET}/release/${BINARY_NAME}.wasm"
if [[ ! -f "${BUILT_WASM}" ]]; then
    echo "Error: Built WASM not found at: ${BUILT_WASM}"
    exit 1
fi

cp "${BUILT_WASM}" "${OUTPUT_PATH}"

# MVP lowering + validation. Even with -C target-cpu=mvp, the binary picks up
# memory.copy/memory.fill from rustup's PREBUILT wasi-libc (memcpy, memmove,
# strdup, ...), which recent toolchains ship compiled with bulk-memory enabled;
# no RUSTFLAGS can fix precompiled objects. So first lower those ops back to
# MVP loops (needs binaryen >= 120), then optimize under --mvp-features, which
# doubles as a validation step: it hard-fails if any post-MVP instruction
# remains. wasm-opt is mandatory here — without the lowering pass the artifact
# is NOT MVP-clean and wasmrun's exec mode rejects it at parse time.
if [[ "${OPTIMIZE}" == "true" ]]; then
    if ! command -v wasm-opt &> /dev/null; then
        echo "Error: wasm-opt not found — required to MVP-lower the swc artifact."
        echo "Install binaryen >= 120, or pass --no-optimize for an unlowered dev build."
        exit 1
    fi
    echo "Using $(command -v wasm-opt) ($(wasm-opt --version))"
    echo "Lowering bulk-memory ops from wasi-libc to MVP loops..."
    wasm-opt --enable-bulk-memory-opt --llvm-memory-copy-fill-lowering \
        "${OUTPUT_PATH}" -o "${OUTPUT_PATH}.lowered"
    echo "Optimizing with wasm-opt (strict MVP feature set)..."
    wasm-opt --mvp-features -O3 "${OUTPUT_PATH}.lowered" -o "${OUTPUT_PATH}.opt"
    rm "${OUTPUT_PATH}.lowered"
    mv "${OUTPUT_PATH}.opt" "${OUTPUT_PATH}"
else
    echo "Warning: skipping MVP lowering (--no-optimize) — artifact will contain bulk-memory ops"
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

"${SCRIPT_DIR}/generate-metadata.sh" \
    --language swc \
    --version "${SWC_VERSION}" \
    --file "${RUNTIMES_DIR}/${OUTPUT_NAME}" \
    --features "typescript,tsx,commonjs-output,inline-helpers"
