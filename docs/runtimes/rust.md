---
title: Rust runtime
description: Rust WASM runtime built with the wasm32-wasip1 target
layout: libdoc_page.liquid
permalink: runtimes/rust/index.html
eleventyNavigation:
    key: Rust
    parent: Runtimes
    order: 2
---

## At a glance

| | |
|--|--|
| **Compiler** | rustc 1.82.0 |
| **Target** | `wasm32-wasip1` |
| **Available versions** | 1.82 |
| **Binary size** | ~76 KB (post `wasm-opt -O3`) |
| **License** | MIT/Apache-2.0 |
| **Source** | <https://www.rust-lang.org/> |

## Capabilities

- Full `std` library
- Filesystem
- Environment + args
- Standard I/O

## Limitations

- No threading on `wasip1` (single-threaded only)
- No `std::net` socket support yet (waiting on WASI networking)
- Async works with single-threaded executors (`futures::executor::block_on`, custom runtimes)

## Install

```sh
wasmhub get rust 1.82
```

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

let loader = RuntimeLoader::new()?;
let rust = loader.get_runtime(Language::Rust, "1.82").await?;
```
