---
title: WasmHub
description: Open-source WASM Hub of language runtimes
layout: libdoc_page.liquid
permalink: index.html
---

**Open-source WASM Hub of language runtimes.** Download and manage versioned WebAssembly runtimes for Go, Rust, Node.js, and more — usable as a Rust library, a CLI tool, or via CDN.

## Why WasmHub?

- **Multi-language** — Go, Rust, and Node.js (alpha) today; Python, Ruby, PHP planned
- **Smart caching** — download once, use forever
- **Type-safe library** — Rust API with compile-time guarantees
- **Multi-CDN fallback** — GitHub Releases + jsDelivr with automatic failover
- **SHA256 verification** — every download is integrity-checked
- **Cross-platform** — Linux, macOS, Windows

## Quick install

As a CLI:

```sh
cargo install wasmhub --features cli
wasmhub get go 1.23
```

As a library:

```toml
[dependencies]
wasmhub = "0.3"
tokio = { version = "1", features = ["full"] }
```

```rust
use wasmhub::{RuntimeLoader, Language};

#[tokio::main]
async fn main() -> wasmhub::Result<()> {
    let loader = RuntimeLoader::new()?;
    let go = loader.get_runtime(Language::Go, "1.23").await?;
    println!("Runtime at: {}", go.path.display());
    Ok(())
}
```

## Where next

- [Getting Started](/getting-started/) — install, first runtime, basic usage
- [CLI Reference](/cli/) — every command and flag
- [Library Guide](/library/) — Rust API, builder config, feature flags
- [Architecture](/architecture/) — how runtimes flow from source to your cache
- [Manifest Format](/manifest-format/) — the JSON schema
- [Adding a Runtime](/adding-a-runtime/) — contributor guide
