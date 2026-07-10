FROM debian:bookworm-slim

LABEL maintainer="Ani <github.com/anistark>"
LABEL description="WasmHub build environment with WASI SDK, TinyGo, and Rust"

ARG WASI_SDK_VERSION=24
ARG TINYGO_VERSION=0.34.0
ARG GO_VERSION=1.23.4
ARG RUST_VERSION=stable
ARG WASMRUN_VERSION=0.13.0
ARG QUICKJS_VERSION=2024-01-13

ENV DEBIAN_FRONTEND=noninteractive
ENV WASI_SDK_PATH=/opt/wasi-sdk
ENV TINYGO_ROOT=/opt/tinygo
ENV PATH="${TINYGO_ROOT}/bin:${WASI_SDK_PATH}/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    binaryen \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    git \
    jq \
    nasm \
    ninja-build \
    pkg-config \
    python3 \
    python3-pip \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# WASI SDK — pick the right arch for the container (amd64 or arm64)
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
        x86_64)  WASI_ARCH="x86_64" ;; \
        aarch64) WASI_ARCH="arm64"  ;; \
        *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_ARCH}-linux.tar.gz" \
    | tar -xzf - -C /opt \
    && mv "/opt/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_ARCH}-linux" "${WASI_SDK_PATH}"

# Go — pick the right arch
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
        x86_64)  GO_ARCH="amd64" ;; \
        aarch64) GO_ARCH="arm64" ;; \
        *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    | tar -xzf - -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# TinyGo — pick the right arch
RUN set -eux; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
        x86_64)  TG_ARCH="amd64" ;; \
        aarch64) TG_ARCH="arm64" ;; \
        *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tinygo-org/tinygo/releases/download/v${TINYGO_VERSION}/tinygo${TINYGO_VERSION}.linux-${TG_ARCH}.tar.gz" \
    | tar -xzf - -C /opt

# Rust (rustup selects the correct target triple automatically)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${RUST_VERSION}
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add wasm32-wasip1

# Nightly + rust-src: required by build-swc.sh, which rebuilds std with
# `-Zbuild-std` to produce an MVP-lowered WASM (no post-MVP instructions)
RUN rustup toolchain install nightly && \
    rustup component add rust-src --toolchain nightly && \
    rustup target add wasm32-wasip1 --toolchain nightly

# wasmrun: https://github.com/anistark/wasmrun
RUN cargo install wasmrun --version ${WASMRUN_VERSION}

WORKDIR /workspace

RUN echo "WASI SDK: ${WASI_SDK_VERSION}" && \
    echo "Go: $(go version)" && \
    echo "TinyGo: $(tinygo version)" && \
    echo "Rust: $(rustc --version)" && \
    echo "Cargo: $(cargo --version)" && \
    echo "Python: $(python3 --version)" && \
    echo "Wasmrun: $(wasmrun --version 2>/dev/null || echo 'installed')" && \
    echo "wasm32-wasip1 target: $(rustup target list --installed | grep wasm)"

CMD ["/bin/bash"]
