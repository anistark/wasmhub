---
title: Architecture
description: How WasmHub runtimes flow from source to your cache
layout: libdoc_page.liquid
permalink: architecture/index.html
eleventyNavigation:
    key: Architecture
    order: 4
---

## High-level flow

```
runtimes/<lang>/source code
        ↓ scripts/build-<lang>.sh (inside Docker)
build/<lang>/<lang>-<version>.wasm
        ↓ wasm-opt optimization (--enable-bulk-memory)
runtimes/<lang>/<lang>-<version>.wasm
        ↓ scripts/verify-binary.sh (magic number, SHA256)
        ↓ scripts/generate-metadata.sh (per-language manifest)
runtimes/<lang>/manifest.json
        ↓ scripts/generate-global-manifest.sh
manifest.json (root, aggregated)
        ↓ release.yml CI workflow
GitHub Releases (.wasm + .wasm.gz + .wasm.br + manifests + SHA256SUMS)
        ↓ RuntimeLoader (with retry + multi-CDN fallback)
~/.cache/wasmhub/<lang>/<version>/
```

## Source layout

```
src/
├── lib.rs              Library entry point, public exports
├── loader.rs           RuntimeLoader — download, cache lookup, manifest fetching
├── cache.rs            CacheManager — local filesystem cache
├── runtime.rs          Language enum, Runtime struct
├── manifest.rs         GlobalManifest, RuntimeManifest, RuntimeVersion types
├── error.rs            Error enum, Result type alias
└── bin/
    └── wasmhub.rs      CLI binary (feature-gated behind "cli")
```

## CDN fallback

The loader tries CDN sources in order. On any failure (network error, 5xx, integrity mismatch), it moves to the next source. Default order:

1. **GitHub Releases** — primary, no rate limits
2. **jsDelivr** — CDN cache layer (12-24h sync delay after a release)

Configure via `RuntimeLoader::builder().cdn_sources(...)`.

## Retry strategy

Each download attempt uses exponential backoff:

- `initial_backoff_ms` — first delay (default: 500ms)
- `max_backoff_ms` — cap on the delay (default: 30s)
- `max_retries` — total attempts (default: 3)

Retries fire on transient failures (network, 5xx). Permanent failures (404, integrity check) fail fast.

## Cache layout

```
~/.cache/wasmhub/
├── go/
│   ├── 1.23/
│   │   ├── go-1.23.wasm
│   │   └── manifest.json
│   └── ...
└── rust/
    └── 1.82/
        ├── rust-1.82.wasm
        └── manifest.json
```

The cache is content-addressed by language + version. Integrity checks happen on every read against the cached manifest entry.

## Why WASI Preview 1?

Both shipped runtimes target `wasm32-wasip1`. WASI Preview 2 (component model) is still stabilizing across runtimes — `wasip1` gives the broadest compatibility today. We'll add `wasip2` outputs once tooling matures across the runtime ecosystem.
