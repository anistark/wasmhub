---
title: Getting Started
description: Install WasmHub and download your first runtime
layout: libdoc_page.liquid
permalink: getting-started/index.html
eleventyNavigation:
    key: Getting Started
    order: 1
---

## Install

### CLI

```sh
cargo install wasmhub --features cli
```

This installs the `wasmhub` binary. Run `wasmhub --help` to verify.

### Library

```toml
[dependencies]
wasmhub = "0.2"
tokio = { version = "1", features = ["full"] }
```

For download progress bars, enable the `progress` feature:

```toml
wasmhub = { version = "0.1", features = ["progress"] }
```

## Your first runtime

```sh
wasmhub get go 1.23
# or try Node.js (alpha)
wasmhub get nodejs 20
```

What happens:

1. WasmHub fetches `go-manifest.json` from GitHub Releases
2. Resolves the entry for version `1.23`
3. Downloads the WASM binary (with retries, backoff, multi-CDN fallback)
4. Verifies the SHA256 against the manifest
5. Caches it under `~/.cache/wasmhub/go/1.23/`

Subsequent calls return the cached binary instantly.

## Inspect the cache

```sh
wasmhub cache show
```

```sh
wasmhub info go 1.23
```

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

#[tokio::main]
async fn main() -> wasmhub::Result<()> {
    let loader = RuntimeLoader::new()?;
    let go = loader.get_runtime(Language::Go, "1.23").await?;

    println!("Path:   {}", go.path.display());
    println!("Size:   {} bytes", go.size);
    println!("SHA256: {}", go.sha256);
    Ok(())
}
```

The returned `Runtime` is a small struct — `path`, `size`, `sha256`, `language`, `version`. Pass `path` to your WASM runtime of choice (wasmtime, wasmer, etc.).

## Next steps

- [CLI Reference](/cli/) — full command list
- [Library Guide](/library/) — builder config, custom CDN sources, retry tuning
