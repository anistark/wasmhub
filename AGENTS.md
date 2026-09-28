# AGENTS.md — AI Coding Agent Instructions for WasmHub

> Instructions for Claude Code, pi, Cursor, Copilot, and other AI coding agents working on this project.

---

## Project Overview

**WasmHub** is a centralized registry and package manager for WebAssembly language runtimes. It provides versioned WASM runtime binaries (Go, Rust, and more coming) that can be downloaded, cached, and verified — usable as a Rust library, CLI tool, or via CDN.

- **Repository:** https://github.com/anistark/wasmhub
- **Crate:** https://crates.io/crates/wasmhub
- **Docs:** https://docs.rs/wasmhub
- **License:** MIT
- **Minimum Rust Version:** 1.85

---

## ⚠️ The Runtime Build Pipeline — Read This First

The most critical part of this project is the pipeline that builds, verifies, and publishes WASM runtime binaries. Getting this wrong means shipping broken runtimes to every downstream consumer.

### How a Runtime Gets Built

```
runtimes/<lang>/source code
        ↓ scripts/build-<lang>.sh (inside Docker)
build/<lang>/<lang>-<version>.wasm
        ↓ wasm-opt optimization
runtimes/<lang>/<lang>-<version>.wasm
        ↓ scripts/verify-binary.sh (magic number, SHA256)
        ↓ tests/runtimes/nodejs/run-fixtures.mjs (nodejs only: real engine, exit codes, under wasmtime and wasmrun)
        ↓ scripts/generate-metadata.sh (updates per-language manifest)
          ← runtimes/<lang>/features.txt (the published feature list)
runtimes/<lang>/manifest.json
        ↓ scripts/generate-global-manifest.sh
manifest.json (root)
```

### How Runtimes Get Released

1. **Local or CI build:** `scripts/build-all.sh` runs inside Docker (`wasmhub-builder` image) to compile all runtimes.
2. **Optimization:** `scripts/optimize-wasm.sh` runs `wasm-opt` with `-O3 --enable-bulk-memory`, generates gzip/brotli compressed variants.
3. **Verification:** `scripts/verify-binary.sh` checks WASM magic number (`0061736d`) and SHA256 checksums. For nodejs, `tests/runtimes/nodejs/run-fixtures.mjs` then runs every fixture against the optimized binary under two hosts, wasmtime 46.0.1 and wasmrun 0.23.0's agent mode, checking exit codes as well as output; `release.yml` fails before staging any asset if one does not pass.
4. **Manifest generation:** `scripts/generate-metadata.sh` updates `runtimes/<lang>/manifest.json` with new size/sha256/date, and with the feature list the build script read from `runtimes/<lang>/features.txt`. `scripts/generate-global-manifest.sh` aggregates all per-language manifests into `manifest.json`.
5. **Release:** `just release <version>` or `scripts/publish.sh` creates a git tag, GitHub Release, and uploads all assets. The `release.yml` CI workflow then:
   - Builds all WASM runtimes in Docker
   - Optimizes and compresses them
   - Runs the nodejs fixtures against the optimized `nodejs-20.wasm`, under wasmtime and under wasmrun
   - Uploads `.wasm`, `.wasm.gz`, `.wasm.br`, per-language manifests, global `manifest.json`, and `SHA256SUMS` as release assets
   - Builds CLI binaries for Linux (x86_64, aarch64), macOS (x86_64, aarch64), and Windows (x86_64)
   - Publishes to crates.io

### Where Binaries Live

| Location | What | Committed? |
|----------|------|------------|
| `runtimes/<lang>/*.wasm` | Built WASM binaries | **No** — gitignored |
| `build/<lang>/` | Intermediate build output | **No** — gitignored |
| `release-assets/` | Staged release files | **No** — created by `publish.sh` |
| GitHub Releases | Published WASM + CLI binaries | Yes — the distribution point |
| `~/.cache/wasmhub/` | User's local cache (via library/CLI) | N/A — runtime |

### Critical Rules

1. **WASM binaries are never committed.** They're gitignored and published via GitHub Releases only.
2. **SHA256 checksums must match.** Every manifest entry has a `sha256` field. If you rebuild a runtime, the checksum changes and the manifest **must** be regenerated.
3. **Manifests must stay in sync.** If you update a runtime version, update both `runtimes/<lang>/manifest.json` and regenerate `manifest.json` with `just manifest`.
4. **Never hand-edit `features` in a manifest.** The list lives in `runtimes/<lang>/features.txt` and is written into the manifest at build time, so a hand-added entry is silently lost at the next release. Add a feature to `features.txt` in the same change that implements it. (This is not hypothetical: the published v0.4.0 nodejs manifest advertises the v0.3.2 feature set, because the build script used to pass a hardcoded list.)
5. **Builds must be reproducible.** All runtime builds happen inside the Docker image (`Dockerfile`). Don't add build steps that depend on host-specific tooling.
6. **Optimization flags matter.** `--enable-bulk-memory` is required for both Go and Rust WASM outputs. Missing it breaks compatibility.
7. **The nodejs runtime is verified against a built wasm, not only the node harness.** `just test-nodejs-builtins` loads `main.js` under node, with node's own console, event loop and process, so it cannot see what the QuickJS engine actually does. v0.5.0 shipped with no `console.error` and with every failed run exiting 0, and the harness passed throughout. Run `just test-nodejs-wasm` and `just test-nodejs-wasmrun` on a rebuilt runtime for any change to `runtimes/nodejs/` or `scripts/patch-nodejs.sh`, and add a fixture (with its expected exit code in the `CHECKS` table of `run-fixtures.mjs`) for behavior only the engine can show.
9. **wasmrun is the runtime's real consumer, and it is not built on wasmtime.** It has its own interpreter (`src/runtime/core/`) and its own WASI (`src/runtime/wasi/`), and runs the nodejs runtime through its agent mode. Test against it, not only against wasmtime, and never reason about wasmrun from wasmtime's behavior: wasmtime's limits (no listen sockets from 47 on, the fd 3 preopen problem) do not apply to it, and its own bugs do not show up under wasmtime. A fixture that fails on one host for a reason outside this runtime gets a `knownFailure` entry for that host rather than being dropped.
8. **QuickJS engine changes go in `scripts/patch-nodejs.sh`.** It patches the pristine QuickJS tarball at build time (`os.getentropy`, `std.evalScript`'s `filename`, the `os.sock*` bindings, and `os.setHostHooks` for uncaught errors, rejections and exit codes). Each patch is an idempotent Python edit that fails loudly when its anchor is missing. Never edit a checked-out QuickJS tree by hand.

---

## Adding a New Language Runtime

This is the most common non-trivial task. Follow every step.

### 1. Create the runtime source

```
runtimes/<lang>/
├── <source files>       # The actual program to compile to WASM
├── features.txt         # Published feature list, one per line (# comments ok)
└── manifest.json        # Will be generated by build script
```

The runtime source should implement a standard set of commands: `version`, `eval`, `env`, `echo`, `cat`, `ls`, `write`. See `runtimes/go/main.go` and `runtimes/rust/src/main.rs` for the expected interface.

### 2. Create the build script

Create `scripts/build-<lang>.sh`. Follow the pattern in `scripts/build-go.sh` or `scripts/build-rust.sh`:
- Accept source path as argument
- Support `--version`, `--output`, `--no-optimize` flags
- Compile to WASM targeting WASI Preview 1 (`wasip1`)
- Run `wasm-opt` optimization if available
- Copy output to `runtimes/<lang>/`
- Source `scripts/lib/features.sh` and pass `--features "$(read_features "${RUNTIMES_DIR}/features.txt")"` when the runtime publishes a feature list (see `build-nodejs.sh`)
- Call `scripts/generate-metadata.sh` to create/update the manifest

### 3. Register in build-all.sh

Add a build block to `scripts/build-all.sh` with an env flag (`BUILD_<LANG>`) for selective builds.

### 4. Update the Dockerfile

Add the language's compiler/toolchain to `Dockerfile`. Keep it in the same pattern as existing tools (Go, TinyGo, Rust).

### 5. Update the Rust library

- Add variant to `Language` enum in `src/runtime.rs`
- Add `as_str()`, `FromStr`, and `Display` implementations
- Add to `Language::all()` array

### 6. Update CI

- Add matrix entry in `.github/workflows/build-runtimes.yml`
- The release workflow (`release.yml`) picks up all runtimes automatically via `scripts/build-all.sh`

### 7. Update global manifest

Add source URL and license to the `SOURCES` and `LICENSES` arrays in `scripts/generate-global-manifest.sh`.

### 8. Regenerate and verify

```sh
just docker-build              # Rebuild Docker image with new toolchain
just docker-build-runtimes     # Build all runtimes
just manifest                  # Regenerate global manifest
```

---

## Updating an Existing Runtime for a New Version

1. Update the source code in `runtimes/<lang>/` if needed (e.g., new language features), and add any new capability to `runtimes/<lang>/features.txt` in the same change.
2. Update the version default in `scripts/build-<lang>.sh` (e.g., `GO_VERSION` or `RUST_VERSION`).
3. Update toolchain versions in `Dockerfile` if the compiler version changes.
4. Rebuild: `just docker-build && just docker-build-runtimes`
5. The build script calls `generate-metadata.sh` which updates `runtimes/<lang>/manifest.json` — it adds the new version entry and sets it as `latest`.
6. Regenerate global manifest: `just manifest`
7. Verify: the build script runs `verify-binary.sh` automatically, but you can re-run manually. For nodejs, also run `just test-nodejs-wasm`.

**Important:** A new version creates a new entry in the manifest's `versions` map. Old versions remain listed. The `latest` field is updated automatically.

---

## After Every Set of Changes

1. **`just format`** — Format all Rust code.
2. **`just lint`** — Run clippy (zero warnings enforced).
3. **`just test`** — Run the full test suite.

For a full CI-equivalent check:

4. **`just ci`** — Runs format-check → lint → test.

Do not consider a change complete until all of the above pass cleanly.

For changes to the nodejs runtime (`runtimes/nodejs/`, `scripts/patch-nodejs.sh`), also:

5. **`just test-nodejs-wasm`** — rebuild the runtime and run the fixtures against it under wasmtime (see Critical Rule 7). `just ci` does not build wasm, so it cannot catch an engine-level regression.

### Additional Housekeeping

- **Prefer `just` commands** over raw `cargo` commands. The justfile handles feature flags correctly.
- **Prompt the user if `AGENTS.md` needs updating.** If your changes alter the build pipeline, add a language, change manifest format, or modify release process, tell the user.

### Documentation

- **README.md** — GitHub front page. Tagline, quick install, feature highlights, link out to the docs site. Keep it lean; long-form lives on the docs site.
- **Docs site** (`docs/`) — Eleventy 3.x + [eleventy-libdoc](https://github.com/ita-design-system/eleventy-libdoc) starter, deployed to GitHub Pages at https://anistark.github.io/wasmhub/. Owns the deep content: getting-started, CLI reference, library guide, architecture, manifest format, contributor guides, per-runtime catalog.
- **API reference** is auto-generated at [docs.rs/wasmhub](https://docs.rs/wasmhub) from inline doc comments.

### Working in `docs/`

- Content is plain Markdown with YAML frontmatter. To add a page: drop a `.md` file under `docs/content/`, follow libdoc's frontmatter conventions for navigation/title, cross-link with the Eleventy `url` filter (required for the `/wasmhub/` path prefix).
- Local preview: `cd docs && pnpm install && pnpm run serve` → http://localhost:8080/
- Build: `pnpm run build` → output in `docs/_site/` (gitignored).
- **Use pnpm, not npm** — lockfile is `pnpm-lock.yaml`, CI uses `pnpm/action-setup@v4`.
- Theming lives in `docs/assets/theme.css` (CSS custom-property overrides). **Do not edit libdoc's vendored CSS directly** — it makes future upstream pulls painful.
- Deployment is automatic: any push to `main` touching `docs/**` triggers `.github/workflows/docs.yml`.

### Planning Documents

- **`plan/` directory** is for all planning and design docs. It's gitignored — never commit it.
- **Check `plan/` for existing plans** before starting related work. Files like `plan/PLAN.md` and any `plan/*_IMPLEMENTATION.md` contain context, checklists, and phase tracking.
- **Create new planning docs here** when scoping features or multi-step work (e.g., `plan/NEW_LANG_PYTHON.md`, `plan/MANIFEST_V2.md`). Keep them focused — one doc per initiative.

### Git Discipline

- **Do not run `git add` or `git commit` unless the user explicitly asks.**
- **When the user asks to commit**, prepare:
  - A **brief title** following conventional commits (`feat:`, `fix:`, `chore:`, etc.)
  - A **detailed description** summarizing what changed and why

---

## Architecture

### Source Layout

```
src/
├── lib.rs              # Library entry point, public exports
├── loader.rs           # RuntimeLoader — download, cache lookup, manifest fetching
├── cache.rs            # CacheManager — local filesystem cache
├── runtime.rs          # Language enum, Runtime struct
├── manifest.rs         # GlobalManifest, RuntimeManifest, RuntimeVersion types
├── error.rs            # Error enum (thiserror), Result type alias
└── bin/
    └── wasmhub.rs      # CLI binary (feature-gated behind "cli")

runtimes/
├── go/
│   ├── main.go             # Go runtime source (compiled with TinyGo)
│   └── manifest.json       # Per-language manifest
├── rust/
│   ├── src/main.rs          # Rust runtime source (compiled with wasm32-wasip1)
│   ├── Cargo.toml
│   └── manifest.json        # Per-language manifest
├── nodejs/
│   ├── main.js              # Node.js API surface on QuickJS (bundled with qjsc)
│   ├── wasi_sockets.c       # os.sock* bindings over WASI Preview 1 sockets
│   ├── wasi_stubs.c, wasi_shims.h, wasi_include/  # WASI link/compile shims
│   ├── features.txt
│   └── manifest.json
└── swc/
    ├── src/main.rs          # TypeScript → JavaScript transpiler CLI (MVP-only wasm)
    ├── features.txt
    └── manifest.json

scripts/
├── build-all.sh             # Orchestrates all runtime builds
├── build-go.sh              # Go → WASM via TinyGo
├── build-rust.sh            # Rust → WASM via wasm32-wasip1
├── build-nodejs.sh          # QuickJS + main.js → WASM via WASI SDK
├── patch-nodejs.sh          # Idempotent QuickJS engine patches applied at build time
├── build-swc.sh             # swc CLI → MVP-only WASM
├── optimize-wasm.sh         # wasm-opt optimization + compression
├── verify-binary.sh         # WASM magic number + SHA256 verification
├── generate-metadata.sh     # Creates/updates per-language manifest.json
├── generate-global-manifest.sh  # Aggregates into root manifest.json
├── publish.sh               # Full release workflow
├── install-wasi-sdk.sh      # WASI SDK installer
└── lib/
    └── features.sh          # read_features(): features.txt → comma-separated list

tests/runtimes/nodejs/       # nodejs runtime tests
├── harness.mjs              # Loads main.js under plain node with std/os shimmed
├── *.test.mjs               # Harness tests (`just test-nodejs-builtins`, in `just ci`)
├── fixtures/                # Programs run against a built wasm
└── run-fixtures.mjs         # Runs them under wasmtime or wasmrun (`just test-nodejs-wasm`, `just test-nodejs-wasmrun`)

docs/                        # Eleventy + libdoc docs site (deployed to GitHub Pages)
├── .eleventy.js
├── package.json
├── settings.json
├── content/                 # Markdown pages with frontmatter
├── assets/theme.css         # Wasmhub-branded overrides on libdoc CSS variables
└── _site/                   # Build output — gitignored

manifest.json               # Global manifest (all languages, aggregated)
Dockerfile                   # Reproducible build environment
justfile                     # Task runner
```

### Cargo Feature Flags

| Feature | What it enables | Default |
|---------|----------------|---------|
| *(none)* | Library only — no CLI deps | ✅ |
| `progress` | Download progress bars (`indicatif`) | No |
| `cli` | CLI binary + `clap`, `anyhow`, `colored` + `progress` | No |

The library must always compile with zero features. CLI-only dependencies (`clap`, `anyhow`, `colored`) must never appear in library modules.

### Manifest Format

The `features` array is generated from `runtimes/<lang>/features.txt`, never edited in place.

**Per-language** (`runtimes/<lang>/manifest.json`):
```json
{
    "language": "go",
    "latest": "1.23",
    "versions": {
        "1.23": {
            "file": "go-1.23.wasm",
            "size": 266712,
            "sha256": "efa1e...",
            "released": "2026-02-03T13:23:13Z",
            "wasi": "wasip1",
            "features": []
        }
    }
}
```

**Global** (`manifest.json`):
```json
{
    "version": "0.1.4",
    "build_date": "...",
    "languages": {
        "go": { "latest": "1.23", "versions": ["1.23"], "source": "https://go.dev/", "license": "BSD-3-Clause" },
        "rust": { "latest": "1.82", "versions": ["1.82"], "source": "https://www.rust-lang.org/", "license": "MIT/Apache-2.0" }
    }
}
```

---

## Tech Stack & Tooling

| Tool | Purpose |
|------|---------|
| **Rust** (Edition 2021, MSRV 1.85) | Core library + CLI |
| **Just** | Task runner (`just` for available commands) |
| **Docker** | Reproducible runtime build environment |
| **TinyGo** | Go → WASM compilation |
| **wasm-opt** (Binaryen) | WASM binary optimization |
| **WASI SDK** | C/C++ WASM compilation (future runtimes) |
| **tokio** / **reqwest** | Async runtime + HTTP client |
| **serde** / **serde_json** | Manifest serialization |
| **sha2** | Integrity verification |
| **clap** | CLI argument parsing (feature-gated) |
| **jq** | Manifest JSON manipulation in build scripts |
| **gh** (GitHub CLI) | Release creation |

---

## Build & Development

```sh
just build              # Library only
just build-all          # Library + CLI
just build-release      # Release binary
just test               # All tests (--all-features)
just test-nodejs-builtins  # nodejs runtime harness tests under plain node (in `just ci`)
just test-nodejs-wasm [wasm]  # nodejs fixtures against a built wasm under wasmtime
just test-nodejs-wasmrun [wasm]  # the same fixtures under wasmrun's agent mode (needs wasmrun)
just format             # rustfmt
just lint               # clippy -D warnings
just ci                 # format-check → lint → test
just install            # Install CLI locally
just manifest           # Regenerate global manifest.json
just docker-build       # Build Docker image
just docker-build-runtimes  # Build all runtimes in Docker
just build-nodejs       # Build the nodejs runtime in Docker
just optimize           # Run wasm-opt on all runtimes
just publish            # Full release (tag + GitHub + crates.io)
just publish-check      # Dry-run crates.io publish
just publish-github     # GitHub release only (no crates.io)
just docs               # Serve docs site locally (Eleventy)
just docs-install       # Install docs site deps (pnpm)
just docs-build         # Build docs site for production
just docs-clean         # Remove docs site _site/ output
just api-docs           # Open Rust API docs (cargo doc)
```

---

## CI Workflows

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `ci.yml` | Push to main, PRs | Format check + clippy + tests (Linux/macOS/Windows) |
| `build-runtimes.yml` | Changes to `runtimes/`, `scripts/` or `tests/runtimes/`, manual | Builds runtimes in Docker, runs the nodejs fixtures against the built runtime under wasmtime and wasmrun, uploads as artifacts |
| `release.yml` | GitHub Release created, manual | Builds runtimes, runs the nodejs fixtures against the optimized binary under wasmtime and wasmrun, then builds CLI binaries for all platforms and uploads to release |
| `docs.yml` | Push to main with `docs/**` changes, manual | Builds Eleventy site in `docs/`, deploys to GitHub Pages |

---

## Code Conventions

- Standard Rust naming: `snake_case` for functions/variables, `PascalCase` for types.
- Use `thiserror` for library errors (`src/error.rs`). CLI uses `anyhow` on top.
- Keep the public API surface minimal. Only `pub use` what consumers need in `src/lib.rs`.
- All network operations go through `reqwest`. All async uses `tokio`.
- Build scripts must work inside the Docker container. Use portable shell constructs.

### Commit Messages

```
feat: description          # New feature
fix: description           # Bug fix
chore: description         # Maintenance, deps, CI
docs: description          # Documentation only
refactor: description      # Code restructuring
test: description          # Adding/fixing tests
```

### Branching

- `main` — stable release branch
- `feat/*`, `fix/*`, `chore/*`, `docs/*` — topic branches

---

## Versioning

- Version source of truth: `Cargo.toml`
- Follow [Semantic Versioning](https://semver.org/)
- `just publish` handles: version check → CI → tag → GitHub Release → crates.io

---

## CLI Commands Reference

```sh
wasmhub get <language> [version]          # Download runtime (default: latest)
wasmhub get <language> <version> --force  # Force re-download
wasmhub list [language]                   # List available runtimes
wasmhub info <language> [version]         # Show runtime details
wasmhub cache show                        # Show cache contents
wasmhub cache clear <language> <version>  # Clear specific cached runtime
wasmhub cache clear-all [--yes]           # Clear all cache
```

**Languages:** `nodejs`/`node`, `python`/`py`, `ruby`/`rb`, `php`, `go`/`golang`, `rust`/`rs`

---

## Important Files

| File | Why It Matters |
|------|----------------|
| `Cargo.toml` | Version, dependencies, feature flags |
| `src/lib.rs` | Public API surface |
| `src/loader.rs` | Core download/cache/manifest logic |
| `src/runtime.rs` | `Language` enum — add new languages here |
| `src/manifest.rs` | Manifest types — update when format changes |
| `src/error.rs` | All error types |
| `src/bin/wasmhub.rs` | CLI commands and output |
| `manifest.json` | Global manifest — aggregated from per-language manifests |
| `runtimes/*/manifest.json` | Per-language manifests (versions, URLs, checksums) |
| `scripts/build-all.sh` | Runtime build orchestration |
| `scripts/build-go.sh` | Go build script (reference for new languages) |
| `scripts/build-rust.sh` | Rust build script (reference for new languages) |
| `scripts/patch-nodejs.sh` | QuickJS engine patches for the nodejs runtime |
| `runtimes/nodejs/main.js` | The nodejs runtime's entire Node.js API surface |
| `tests/runtimes/nodejs/run-fixtures.mjs` | nodejs fixtures against a built wasm under wasmtime and wasmrun; the release gate |
| `scripts/generate-metadata.sh` | Creates/updates per-language manifest entries |
| `scripts/lib/features.sh` | Reads a runtime's `features.txt` for the manifest generator |
| `runtimes/*/features.txt` | Published feature list per runtime — the source of truth for the manifest's `features` |
| `scripts/generate-global-manifest.sh` | Aggregates manifests + adds source/license info |
| `scripts/publish.sh` | Full release workflow |
| `Dockerfile` | Build environment — update when adding new language toolchains |
| `justfile` | All dev commands |

---

## Gotchas & Pitfalls

- **Feature flags:** `cargo build` alone won't build the CLI. Use `--features cli` or `--all-features`.
- **WASM binaries are gitignored.** `runtimes/**/*.wasm` is in `.gitignore`. They're built in CI and published via GitHub Releases.
- **Docker is required for runtime builds.** Build scripts expect TinyGo, wasm32-wasip1 target, wasm-opt, jq, etc. — all in the Docker image.
- **`jq` is required by manifest scripts.** The metadata and global manifest generators use `jq` for JSON manipulation.
- **`gh` CLI is required for releases.** `just release` and `scripts/publish.sh` use `gh release create`.
- **SHA256 verification is mandatory.** Every downloaded runtime must pass integrity checks. The library enforces this — don't bypass it.
- **`--enable-bulk-memory` is required** for `wasm-opt` optimization of both Go and Rust runtimes. Without it, optimized binaries may be broken.
- **Manifest `latest` is updated automatically** by `generate-metadata.sh`. Don't manually set it unless you know what you're doing.
- **Manifest `features` comes from `features.txt`.** `generate-metadata.sh` keeps a version's existing list when `--features` is omitted, so a caller that forgets the flag no longer strips the runtime's published capabilities — but a caller that passes a *stale* list still overwrites them.
- **`stat` syntax differs between macOS and Linux.** Build scripts handle both (`stat -f%z` vs `stat -c%s`). Keep this pattern when adding new scripts.
- **clippy must pass with zero warnings** — CI enforces `-D warnings`.
- **The nodejs harness runs under node's console, loop and process.** Anything QuickJS does differently (its bare `console`, its event loop, its exit code) is invisible there; only `just test-nodejs-wasm` sees it.
- **wasmtime 47+ cannot run the nodejs server half.** Handing a listening socket to a Preview 1 module needs wasmtime's legacy implementation (`-S preview2=n -S tcplisten=…`), which wasmtime 47 removed. CI pins wasmtime 46.0.1, and `run-fixtures.mjs` skips the wasmtime `httpserver.js` check on a newer one unless `WASMHUB_REQUIRE_HTTP=1`. wasmrun is unaffected.
- **A listen socket on fd 3 hides every `--dir`.** wasmtime puts `tcplisten` sockets ahead of preopens, and wasi-libc stops scanning for preopens at the first non-directory descriptor, so `run ./server.js` cannot open its file. Pass the server through `eval "$(cat server.js)"` instead. wasmrun's agent mode preopens the session directory first, so it has no such limit.
- **`wasmrun exec` has no `--dir` and exits 0.** It takes only `--call`, `--tcplisten`, `--allow-net` and program args (no `--` needed), preopens no directory, so `exec nodejs-20.wasm run file.js` cannot open the file, and as of 0.23.0 the wasmrun process exits 0 whatever the program's exit code. Files and exit codes go through agent mode (`POST /api/v1/sessions/:id/exec`, which reports `exit_code`). Docs should show `wasmrun exec` only for `version`/`eval`/`echo`.
- **wasmrun drops `O_APPEND`.** Its `path_open` ignores fdflags, so `fs.appendFile` overwrites from offset 0 there. `append.js` carries a `knownFailure` for wasmrun until that is fixed ([anistark/wasmrun#123](https://github.com/anistark/wasmrun/issues/123)); remove it when the runner reports it passing.
- **Testing a build under wasmrun** needs no wasmrun change: `WASMRUN_WASMHUB_BASE_URL` points its runtime fetches at any wasmhub-shaped host, and `run-fixtures.mjs --host wasmrun` serves the build that way with a private `HOME`, so wasmrun's cache (`~/.wasmrun/runtimes`) cannot substitute an older runtime.
- **Building nodejs outside Docker** needs a WASI SDK (`WASI_SDK_PATH`), a native `cc` for `qjsc`, and GNU `sed` first on `PATH` on macOS: `patch-nodejs.sh` uses `sed -i` without a suffix. `build-nodejs.sh` also rewrites `runtimes/nodejs/manifest.json`, which is committed.
- **`plan/` is gitignored.** Local planning only — never commit anything in it.
