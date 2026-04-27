---
title: Go runtime
description: Go WASM runtime built with TinyGo
layout: libdoc_page.liquid
permalink: runtimes/go/index.html
eleventyNavigation:
    key: Go
    parent: Runtimes
    order: 1
---

## At a glance

| | |
|--|--|
| **Compiler** | TinyGo 0.34.0 |
| **Target** | `wasm32-wasip1` |
| **Available versions** | 1.23 |
| **Binary size** | ~261 KB (post `wasm-opt -O3`) |
| **License** | BSD-3-Clause (Go), BSD-3-Clause (TinyGo) |
| **Source** | <https://go.dev/> |

## Capabilities

- Filesystem (read/write)
- Environment variables
- Command-line args
- Standard I/O (stdin/stdout/stderr)

## Limitations

- No cgo (TinyGo restriction)
- Reduced standard library (TinyGo subset — see [TinyGo's compatibility matrix](https://tinygo.org/docs/reference/lang-support/stdlib/))
- No runtime reflection beyond what TinyGo supports
- Single-threaded — goroutines cooperatively schedule via the scheduler, but no OS threads

## Install

```sh
wasmhub get go 1.23
```

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

let loader = RuntimeLoader::new()?;
let go = loader.get_runtime(Language::Go, "1.23").await?;
// Pass go.path to your WASM runtime
```
