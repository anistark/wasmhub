# WasmHub Docs Site

Eleventy-powered docs site for WasmHub, deployed to GitHub Pages.

## Local dev

From the repo root, use `just`:

```sh
just docs-install     # first time only
just docs             # serve at http://localhost:8080
just docs-build       # production build → _site/
just docs-clean       # remove _site/
```

Or directly with pnpm in this folder:

```sh
pnpm install
pnpm run serve
pnpm run build
```

## Add a page

Drop a Markdown file at the root (or under `runtimes/`, etc.). Use frontmatter:

```yaml
---
title: My Page
description: Short description for SEO
layout: libdoc_page.liquid
permalink: my-page/index.html
eleventyNavigation:
    key: My Page
    order: 10
---
```

Cross-link with absolute paths (`/cli/`) — the `htmlBasePathPrefix` in `settings.json` handles the GitHub Pages prefix.

## Theming

Wasmhub palette and the pixel wordmark live in `assets/theme.css`. Don't edit anything under `core/` — that's vendored from [eleventy-libdoc](https://github.com/ita-design-system/eleventy-libdoc) and re-pulling upstream gets messy if you patch it.

## Built on

[eleventy-libdoc](https://github.com/ita-design-system/eleventy-libdoc) — ISC licensed (see `LICENSE`).
