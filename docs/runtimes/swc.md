---
title: swc transpiler
description: TypeScript → JavaScript transpiler for WASM, built from swc_core targeting WASI
layout: libdoc_page.liquid
permalink: runtimes/swc/index.html
eleventyNavigation:
    key: swc
    parent: Runtimes
    order: 4
---

## Status

**Alpha** — `swc-73.wasm` is available. A tool artifact rather than a language runtime: a small WASI CLI over [swc_core](https://swc.rs/) that transpiles TypeScript to JavaScript. It exists to feed the [Node.js runtime](/runtimes/nodejs/), which only speaks CommonJS.

## At a glance

| | |
|--|--|
| **Engine** | `swc_core` 73.x |
| **Binary size** | ~2.4 MB (optimized) |
| **Target** | `wasm32-wasip1` (WASI Preview 1), **MVP-only instructions** |
| **License** | Apache-2.0 |
| **Source** | <https://swc.rs/> |

## Capabilities

- `version` — print transpiler version
- `swc [options] <file.ts|file.tsx>...` — transpile each input, writing a sibling `.js` file (directories preserved)
- Types stripped
- TSX lowered, to `React.createElement` or to the automatic JSX runtime
- ES modules lowered to CommonJS with interop helpers **inlined** into the output (no `@swc/helpers` dependency at runtime)
- Parse errors — including recoverable ones — go to stderr as `error: <file>:<line>:<col>: <message>` referencing the original TypeScript source, and any failure exits non-zero

Inputs must end in `.ts` or `.tsx`, so filenames can never collide with the `version` subcommand.

### Options

| Option | What it does |
|--|--|
| `--target <version>` | Down-level the output: `es3`, `es5`, `es2015` … `es2024`, `esnext`. The default, `esnext`, lowers nothing. Each edition's syntax is lowered by the pass for that edition, so `--target es2020` keeps classes but lowers private fields, and `--target es5` lowers classes, `async`/`await` and private fields alike |
| `--jsx <mode>` | `classic` (the default, `React.createElement`) or `automatic` (the `react/jsx-runtime` import). The tsconfig spellings `react`, `react-jsx` and `react-jsxdev` are accepted too |
| `--jsx-import-source <pkg>` | Package the automatic runtime imports from, for `preact` and friends |
| `--decorators` | Legacy TypeScript decorators (tsconfig `experimentalDecorators`). Without this flag, decorator syntax is parsed but passes through untransformed, which the JavaScript engine cannot execute |
| `--decorator-metadata` | Emit `design:type` metadata (tsconfig `emitDecoratorMetadata`); implies `--decorators` |
| `--source-map` | Write a sibling `.js.map` and link it from the emitted file with a `sourceMappingURL` comment. `sources` holds the path the input was given under, so a stack frame maps back to the original `.ts` line |

Values may be written `--flag value` or `--flag=value`, and `--` ends option parsing.

## Limitations

- Transpile only — no type checking
- Output is CommonJS only (by design, for the Node.js runtime)
- Reads and writes through the WASI filesystem, so the host must pre-open the directory containing the inputs
- Decorators are lowered only when asked for: the transform is `--decorators`, and only the legacy semantics are implemented

## Install

```sh
wasmhub get swc 73
```

## Usage examples

```sh
# Print version info
wasmrun exec swc-73.wasm -- version

# Transpile a file (requires --dir mount); writes app.js next to app.ts
wasmrun exec --dir /path/to/src swc-73.wasm -- /path/to/src/app.ts

# Multiple inputs, TSX included
wasmrun exec --dir /path/to/src swc-73.wasm -- /path/to/src/app.ts /path/to/src/view.tsx

# A tsconfig with experimentalDecorators, target and the automatic JSX runtime
wasmrun exec --dir /path/to/src swc-73.wasm -- \
  --decorators --target es2020 --jsx automatic --source-map \
  /path/to/src/app.tsx

# Then run the output with the Node.js runtime
wasmrun exec --dir /path/to/src nodejs-20.wasm -- run /path/to/src/app.js
```

## Use from Rust

```rust
use wasmhub::{RuntimeLoader, Language};

let loader = RuntimeLoader::new()?;
let swc = loader.get_runtime(Language::Swc, "73").await?;
// Pass swc.path to your WASM runtime (wasmtime, wasmrun, etc.)
```

## Building from source

```sh
./scripts/build-swc.sh runtimes/swc
```

Or inside Docker via the aggregate build: `BUILD_SWC=true ./scripts/build-all.sh`.

## Technical notes

This is the one build that deliberately deviates from `scripts/build-rust.sh`: rustc 1.82+ emits post-MVP WASM instructions by default (multi-value, sign-ext, bulk-memory, nontrapping-fptoint), which downstream interpreters — notably wasmrun's exec mode, the primary consumer — reject at parse time. The build script therefore:

1. Rebuilds `std` with nightly `-Zbuild-std` under `-C target-cpu=mvp`
2. Runs `wasm-opt` with the plain MVP feature set, which doubles as validation that nothing post-MVP slipped through

The version label is `73` — the `swc_core` major — following the upstream-major naming of `nodejs-20` and `rust-1.82`.

## Roadmap

- [x] Source map output
- [x] Automatic JSX runtime and a configurable import source
- [x] Decorators and `--target` down-levelling
- [ ] Configurable JSX pragma for the classic runtime
- [ ] ESM output mode (once the Node.js runtime supports ES modules)
