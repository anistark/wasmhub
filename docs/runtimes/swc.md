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
| **Binary size** | ~3.6 MB (optimized) |
| **Target** | `wasm32-wasip1` (WASI Preview 1), held to the features wasmrun's interpreter runs |
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
wasmrun exec swc-73.wasm version
```

Transpiling reads and writes files, so it needs a host that gives the program
a directory. `wasmrun exec` gives it none; wasmtime's `--dir` does. Preopen the
project root and name inputs under it:

```sh
# Transpile a file; writes app.js next to app.ts
wasmtime run --dir . swc-73.wasm ./src/app.ts

# Multiple inputs, TSX included
wasmtime run --dir . swc-73.wasm ./src/app.ts ./src/view.tsx

# A tsconfig with experimentalDecorators, target and the automatic JSX runtime
# (which imports react/jsx-runtime unless --jsx-import-source says otherwise)
wasmtime run --dir . swc-73.wasm \
  --decorators --target es2020 --jsx automatic --source-map \
  ./src/app.tsx

# Then run the output with the Node.js runtime
wasmtime run --dir . nodejs-20.wasm run ./src/app.js
```

Preopening the directory itself (`--dir ./src`) and naming `./src/app.ts` does
not work: the transpiler cannot resolve a path through a preopen named after a
subdirectory, so it reports the file as missing.

wasmrun's agent mode runs this transpiler for you: an exec with
`"language": "typescript"` transpiles every `.ts`/`.tsx` file in the session
with it, maps the project's `tsconfig.json` onto these flags, and runs the
result with the Node.js runtime.

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

It is a plain stable `wasm32-wasip1` build. Through v0.5 it was MVP-lowered (nightly `-Zbuild-std` under `-C target-cpu=mvp`, then `wasm-opt`'s `memory.copy`/`memory.fill` lowering), because wasmrun's interpreter rejected the post-MVP instructions rustc emits by default. wasmrun 0.23.0 runs them (multi-value, sign-ext, nontrapping float-to-int, bulk memory, reference types), and wasmrun pins the wasmhub release it uses, so an older wasmrun never fetches this build.

`wasm-opt` still runs with exactly that feature set enabled and nothing else, which validates the output: a toolchain that starts emitting something wasmrun does not run yet (SIMD, tail calls, GC) fails the build rather than a sandbox.

The version label is `73` — the `swc_core` major — following the upstream-major naming of `nodejs-20` and `rust-1.82`.

## Roadmap

- [x] Source map output
- [x] Automatic JSX runtime and a configurable import source
- [x] Decorators and `--target` down-levelling
- [ ] Configurable JSX pragma for the classic runtime
- [ ] ESM output mode (once the Node.js runtime supports ES modules)
