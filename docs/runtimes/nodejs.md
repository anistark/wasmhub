---
title: Node.js runtime
description: JavaScript runtime for WASM, built with QuickJS targeting WASI
layout: libdoc_page.liquid
permalink: runtimes/nodejs/index.html
eleventyNavigation:
    key: Node.js
    parent: Runtimes
    order: 3
---

## Status

**In development** — Phase 2 (see [roadmap](https://github.com/anistark/wasmhub/blob/main/plan/PLAN.md)).

The initial runtime uses [QuickJS](https://bellard.org/quickjs/) compiled to WASM via the WASI SDK. QuickJS is a complete ES2020 engine in ~210 KB. Full Node.js compilation is being worked on in parallel (weeks 11-13).

## At a glance

| | |
|--|--|
| **Engine** | QuickJS (ES2020) |
| **Node.js compat** | v20.x API surface |
| **Target** | `wasm32-wasi` |
| **License** | MIT |
| **Source** | <https://bellard.org/quickjs/> |

## Capabilities

- `eval` — evaluate JavaScript expressions
- `run` — execute a `.js` file
- Environment variables
- Command-line args
- Standard I/O (stdin/stdout/stderr)
- Filesystem read/write (via WASI)
- ES2020: async/await, optional chaining, nullish coalescing, BigInt

## Limitations

- No networking (WASI Preview 1 has no socket API)
- No `require()` / CommonJS (use ES modules)
- No `node:*` built-in modules (`fs`, `path`, etc.) — WASI equivalents only
- No worker threads
- No native addons (.node files)

## Install

```sh
wasmhub get nodejs 20
```

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

let loader = RuntimeLoader::new()?;
let nodejs = loader.get_runtime(Language::NodeJs, "20").await?;
// Pass nodejs.path to your WASM runtime (wasmtime, wasmrun, etc.)
```

## Building from source

```sh
just build-nodejs
```

Requires Docker (runs inside `wasmhub-builder`).

## Roadmap

- [ ] Full Node.js v20 compiled to WASM (weeks 11-13)
- [ ] Node.js v18 LTS + v22 builds
- [ ] `node:fs` shim via WASI filesystem APIs
- [ ] CommonJS `require()` support via bundler pre-pass
