<p align="right"><a href="README.md">简体中文</a> | English</p>

<div align="center">

# AssetPile｜材栈

**A local-first asset manager — your Downloads folder isn't a filing cabinet.**

[![CI](https://github.com/RaiN5417/AssetPile/actions/workflows/ci.yml/badge.svg)](https://github.com/RaiN5417/AssetPile/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RaiN5417/AssetPile)](https://github.com/RaiN5417/AssetPile/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

A tiny, local-first Windows utility that asks where a download belongs while
you still remember — via a non-focus-stealing floating card, not an AI guess.

- No AI
- No cloud
- No account
- No background directory scanning (event-driven watcher only)
- Every organize is undoable; nothing is ever auto-deleted

Full product/technical spec (the source of truth for this repo):
[docs/assetpile_product_technical_spec_v0.2.md](docs/assetpile_product_technical_spec_v0.2.md).

![AssetPile inbox and floating card](AppScreenshots/e1.png)

## Download

Grab the latest release from the [Releases page](https://github.com/RaiN5417/AssetPile/releases/latest) — no build tools, no manual dependencies:

- **`AssetPile-x64-portable.zip`** — unzip and run `assetpile.exe` directly. No install, no admin rights.
- **`AssetPile｜材栈_x64-setup.exe`** — a normal Windows installer (Start Menu shortcut, uninstaller). Most Windows 10/11 machines already have WebView2 preinstalled; if yours doesn't, the installer downloads it during setup (visibly, with a progress window — not silently).

Windows may show a SmartScreen warning on first run (the binary isn't code-signed yet) — click "More info" → "Run anyway".

## Status

**MVP feature-complete** (milestones M0–M6 of the plan in spec section 49).
Polish pass (M7 — README, docs, benchmarks, first release) is in progress; see
[docs/architecture.md](docs/architecture.md) for what's still open.

## What it does

- Watches your Downloads folder (`notify`, event-driven — never polls) and
  waits for a file to actually finish downloading (size/mtime stability
  check, `.crdownload`/`.part`/`.tmp` ignored) before doing anything.
- Pops a small, non-focus-stealing **Floating Card** at the bottom-right of
  whichever monitor your mouse is on. One click files the download into a
  **Group** (a destination folder), adds **tags** for later search, marks it
  **Temporary** (auto-expires into a cleanup queue, never auto-deleted), or
  **Later** (handle it from the main window instead).
- Several files landing close together collapse into one **batch card**
  instead of popping once per file.
- The main window supports **search and filtering** by filename, tag, or
  group, a gallery/list view toggle, and one-click preview for common image
  formats.
- Every move is **logged and undoable** — same-name collisions never
  overwrite, they get `(1)`, `(2)`, ... suffixes.
- **Temporary** files that expire land in a cleanup queue where you can keep
  them longer, file them into a group, or send them to the Recycle Bin
  (never a permanent delete from inside the app).
- Lives in the system tray; closing the main window just hides it.

<div align="center">
<img src="AppScreenshots/e2.png" width="49%" alt="Downloads auto-captured into the inbox" />
<img src="AppScreenshots/e3.png" width="49%" alt="Search, tags, and groups" />
</div>

## Why?

Files land with no record of why you downloaded them. A few days later the
context is gone, and folder-by-extension auto-sorting just moves the mess
somewhere else. This project moves the organizing moment earlier: ask once,
right when you still remember, instead of sorting later when you don't.

## Architecture

```text
React UI (apps/desktop/src)
        │  Tauri IPC + events
        ▼
Tauri / Rust core (apps/desktop/src-tauri)
        ├── file-watcher      — OS file events, event-driven only
        ├── download-detector — is this path a finished, operable file yet?
        ├── event-engine      — batches ready files so 20 downloads ≠ 20 cards
        ├── file-operations   — the only crate allowed to move/rename/trash files
        ├── storage           — SQLite pool + migrations + repositories
        └── domain            — pure model, no Tauri/SQLite/Windows deps
```

Details: [docs/architecture.md](docs/architecture.md) · [docs/data-model.md](docs/data-model.md) ·
[docs/event-flow.md](docs/event-flow.md) · [docs/performance.md](docs/performance.md) ·
ADRs in [docs/adr/](docs/adr/).

<a id="getting-started"></a>

## Building from source

Prerequisites (none of this is bundled — install once):

1. [Rust](https://rustup.rs/) (stable; `rustfmt` + `clippy` components)
2. [Node.js 22.13+](https://nodejs.org/) (pnpm 11 requires it)
3. `corepack enable` (ships pnpm with Node) or `npm i -g pnpm`
4. [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/) —
   WebView2 (preinstalled on most Windows 10/11) and the MSVC C++ build tools

Then:

```bash
pnpm install --dir apps/desktop
pnpm --dir apps/desktop tauri dev
```

`cargo build` / `cargo test` work from the repo root against the workspace
without touching the frontend. Before opening a PR, run the checklist in
[CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pr) — CI runs the same checks.

## Repository layout

```text
apps/desktop/          Tauri + React UI
crates/                domain, storage, file-watcher, download-detector,
                        event-engine, file-operations
migrations/            SQLite schema
docs/                   architecture, data model, ADRs, performance, full spec
.github/                CI, issue/PR templates
```

## Non-goals

No AI classification, no OCR, no cloud sync, no team accounts, no full-disk
organizing, no auto-delete. Full list: spec section 4.

## Contributing & feedback

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report
security issues privately via [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
