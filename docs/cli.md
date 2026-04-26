---
title: CLI Reference
description: All wasmhub commands, flags, and examples
layout: libdoc_page.liquid
permalink: cli/index.html
eleventyNavigation:
    key: CLI Reference
    order: 2
---

## Install

```sh
cargo install wasmhub --features cli
```

## Commands

```sh
wasmhub get <language> [version]          # Download runtime (default: latest)
wasmhub get <language> <version> --force  # Force re-download
wasmhub list [language]                   # List available runtimes
wasmhub info <language> [version]         # Show runtime details
wasmhub cache show                        # Show cache contents
wasmhub cache clear <language> <version>  # Clear specific cached runtime
wasmhub cache clear-all [--yes]           # Clear all cache
```

## Language aliases

| Language | Accepted values |
|----------|----------------|
| Node.js  | `nodejs`, `node`, `node.js` |
| Python   | `python`, `py` |
| Ruby     | `ruby`, `rb` |
| PHP      | `php` |
| Go       | `go`, `golang` |
| Rust     | `rust`, `rs` |

## Examples

Download the latest Go runtime:

```sh
wasmhub get go
```

Pin a specific version:

```sh
wasmhub get rust 1.82
```

Force a re-download even if cached:

```sh
wasmhub get go 1.23 --force
```

Inspect what's cached:

```sh
wasmhub cache show
```

Clear everything (with confirmation):

```sh
wasmhub cache clear-all
```

Skip the prompt:

```sh
wasmhub cache clear-all --yes
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | General error (network, IO, integrity check failed, etc.) |
| `2`  | Bad arguments |
