---
title: Library Guide
description: Use WasmHub as a Rust library
layout: libdoc_page.liquid
permalink: library/index.html
eleventyNavigation:
    key: Library Guide
    order: 3
---

## Add the dependency

```toml
[dependencies]
wasmhub = "0.2"
tokio = { version = "1", features = ["full"] }
```

## Default usage

```rust
use wasmhub::{RuntimeLoader, Language};

#[tokio::main]
async fn main() -> wasmhub::Result<()> {
    let loader = RuntimeLoader::new()?;

    let runtime = loader.get_runtime(Language::Go, "1.23").await?;
    println!("Path:   {}", runtime.path.display());
    println!("SHA256: {}", runtime.sha256);

    let manifest = loader.list_available().await?;
    for (lang, info) in &manifest.languages {
        println!("{}: latest = {}", lang, info.latest);
    }

    let latest = loader.get_latest_version(Language::Go).await?;
    println!("Latest Go: {}", latest);

    loader.clear_cache(Language::Go, "1.23")?;
    loader.clear_all_cache()?;

    Ok(())
}
```

## Builder configuration

Customize cache location, CDN sources, and retry behavior:

```rust
use wasmhub::{RuntimeLoader, CdnSource};
use std::path::PathBuf;

let loader = RuntimeLoader::builder()
    .cache_dir(PathBuf::from("/tmp/my-cache"))
    .cdn_sources(vec![CdnSource::GitHubReleases])
    .max_retries(5)
    .initial_backoff_ms(1000)
    .max_backoff_ms(60_000)
    .build()?;
```

## Feature flags

| Feature   | What it enables                                            | Default |
|-----------|------------------------------------------------------------|---------|
| *(none)*  | Library only                                               | yes     |
| `progress`| Download progress bars (`indicatif`)                       | no      |
| `cli`     | CLI binary + `clap`, `anyhow`, `colored` + `progress`      | no      |

## Error handling

All fallible APIs return `wasmhub::Result<T>`. The `Error` enum (in `wasmhub::error`) covers:

- `RuntimeNotFound` — manifest didn't list that language/version
- `Network` — wrapped reqwest error
- `Io` — wrapped std::io error
- `IntegrityCheckFailed` — downloaded SHA256 didn't match the manifest

Match on these for finer control, or just propagate with `?`.

## Async runtime

The library is async-first and uses `tokio`. If your app uses a different runtime, you'll need to bridge — there's no sync API surface yet.
