#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"

BUILD_GO="${BUILD_GO:-true}"
BUILD_RUST="${BUILD_RUST:-true}"
BUILD_NODEJS="${BUILD_NODEJS:-true}"
BUILD_SWC="${BUILD_SWC:-true}"
VERIFY="${VERIFY:-true}"

echo "WasmHub Runtime Builder"
echo "======================"
echo ""

if [[ "${BUILD_GO}" == "true" ]]; then
    if [[ -f "${PROJECT_ROOT}/runtimes/go/main.go" ]]; then
        echo "Building Go runtime..."
        "${SCRIPT_DIR}/build-go.sh" "${PROJECT_ROOT}/runtimes/go/main.go"
        echo ""
    else
        echo "Skipping Go: runtimes/go/main.go not found"
    fi
fi

if [[ "${BUILD_RUST}" == "true" ]]; then
    if [[ -d "${PROJECT_ROOT}/runtimes/rust" ]]; then
        echo "Building Rust runtime..."
        "${SCRIPT_DIR}/build-rust.sh" "${PROJECT_ROOT}/runtimes/rust"
        echo ""
    else
        echo "Skipping Rust: runtimes/rust not found"
    fi
fi

if [[ "${BUILD_NODEJS}" == "true" ]]; then
    if [[ -f "${PROJECT_ROOT}/runtimes/nodejs/main.js" ]]; then
        echo "Building Node.js runtime..."
        "${SCRIPT_DIR}/build-nodejs.sh"
        echo ""
    else
        echo "Skipping Node.js: runtimes/nodejs/main.js not found"
    fi
fi

if [[ "${BUILD_SWC}" == "true" ]]; then
    if [[ -d "${PROJECT_ROOT}/runtimes/swc" ]]; then
        echo "Building swc transpiler..."
        "${SCRIPT_DIR}/build-swc.sh" "${PROJECT_ROOT}/runtimes/swc"
        echo ""
    else
        echo "Skipping swc: runtimes/swc not found"
    fi
fi

if [[ "${VERIFY}" == "true" ]]; then
    echo ""
    echo "Verifying built runtimes..."
    echo ""

    for wasm in "${PROJECT_ROOT}"/runtimes/*/*.wasm; do
        if [[ -f "${wasm}" ]]; then
            "${SCRIPT_DIR}/verify-binary.sh" "${wasm}"
            echo ""
        fi
    done
fi

echo "Generating global manifest..."
"${SCRIPT_DIR}/generate-global-manifest.sh"
echo ""

echo "Build complete!"
