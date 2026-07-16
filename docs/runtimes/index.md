---
title: Runtimes
description: Available WASM language runtimes
layout: libdoc_page.liquid
permalink: runtimes/index.html
eleventyNavigation:
    key: Runtimes
    order: 7
---

| Language | Version | Size | Status |
|----------|---------|------|--------|
| [Go](/runtimes/go/) | 1.23 | 261 KB | ✅ Available |
| [Rust](/runtimes/rust/) | 1.82 | 76 KB | ✅ Available |
| [Node.js](/runtimes/nodejs/) | 20 | ~1.1 MB | 🚧 Alpha |
| [swc](/runtimes/swc/) | 73 | ~2.4 MB | 🚧 Alpha |
| Python | — | — | Coming soon |
| Ruby | — | — | Coming soon |
| PHP | — | — | Coming soon |

All shipped runtimes target **WASI Preview 1** (`wasip1`). swc is a tool artifact (a TypeScript → JavaScript transpiler) rather than a language runtime.
