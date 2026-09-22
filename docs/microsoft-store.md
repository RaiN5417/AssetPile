# MSIX packaging & Microsoft Store submission

Status: local MSIX build pipeline works end-to-end with the real reserved
identity baked in, verified 2026-09-15 (`AssetPile｜材栈_0.2.3.0.msixbundle`
built and copied to `G:\workspace-rain\05-private\assetpile-microsoftstore`
for submission). Nothing has actually been submitted to Partner Center yet
— that's the next step, on the user's side.

## How it's built

Tauri's own bundler doesn't produce MSIX (only NSIS/MSI/portable). This repo
uses the third-party [`@choochmeque/tauri-windows-bundle`](https://github.com/Choochmeque/tauri-windows-bundle)
CLI (`apps/desktop/devDependencies`) for that, driven by:

- [`apps/desktop/src-tauri/gen/windows/bundle.config.json`](../apps/desktop/src-tauri/gen/windows/bundle.config.json) — publisher, capabilities, extensions, signing. Tracked in git (unlike the rest of `gen/`, which is regenerated Tauri/mobile scaffolding).
- [`apps/desktop/src-tauri/gen/windows/AppxManifest.xml.template`](../apps/desktop/src-tauri/gen/windows/AppxManifest.xml.template) — the manifest template; also tracked.
- `apps/desktop/src-tauri/gen/windows/Assets/` — MSIX tile logos, copied from `src-tauri/icons/` (placeholder branding — see `icons/README.md`).
- [`apps/desktop/scripts/build-msix.mjs`](../apps/desktop/scripts/build-msix.mjs) — thin wrapper invoked by the `tauri:windows:build` npm script.

Build it with:

```bash
cd apps/desktop
pnpm run tauri:windows:build
```

Output: `target/msix/AssetPile｜材栈_<version>.0.msixbundle` (workspace-root
`target/`, same as every other Cargo output in this repo).

### Why the wrapper script exists

Two things this repo's setup runs into that the packaging tool doesn't
handle on its own:

1. **Workspace target dir.** This is a Cargo workspace, so `cargo build`
   always writes to the workspace-root `target/`, not
   `apps/desktop/src-tauri/target/`. The tool needs `CARGO_TARGET_DIR` set to
   know that — but as a *relative* value it resolves inconsistently, because
   Tauri's own cargo invocation runs one directory deeper
   (`src-tauri/`) than the packaging tool's own process (`apps/desktop/`).
   `build-msix.mjs` computes an absolute path instead, which both processes
   resolve identically regardless of cwd.

2. **Executable name.** The tool assumes the compiled binary is named after
   `productName` with spaces stripped, with no config override. This
   project's `productName` is `"AssetPile｜材栈"` (no ASCII spaces, so the
   stripped name is unchanged) — but Cargo bin/crate names reject the
   CJK/pipe characters in that string (`invalid character '｜' in crate
   name`), so there's no way to give a `[[bin]]` target that exact name.
   The project's actual Cargo binary is `assetpile.exe` (from `[package]
   name` in `Cargo.toml`), which the NSIS/MSI/portable pipeline already
   depends on (`.github/workflows/release.yml`, autostart registration,
   etc.) — renaming it project-wide would ripple through all of that.

   Confirmed (2026-09-15) the tool does need a literal `AssetPile｜材栈.exe`
   — `prepareAppxContent()`/`executableName()` in
   `@choochmeque/tauri-windows-bundle`'s `dist/index.js` copy exactly that
   filename out of the build dir, erroring (`Executable not found: ...`) if
   it's missing. An earlier attempt worked around this with a second
   `[[bin]]` target as an ASCII approximation that never actually matched
   what the tool looks for (and once case-collided with `assetpile` on
   Windows, breaking a release build with `LNK1104: cannot open file`) —
   removed. Fixed for real in `build-msix.mjs`: it now runs
   `tauri build --no-bundle` itself first (the same build the tool's own
   `build` command would trigger) and copies the resulting `assetpile.exe`
   to `AssetPile｜材栈.exe` in the same directory *before* invoking
   `tauri-windows-bundle build` — whose own internal `tauri build` re-run is
   incremental and doesn't touch or remove that extra file.

## Signing

`bundle.config.json`'s `signing.pfx`/`pfxPassword` (or `MSIX_PFX_PASSWORD`
env var) are for **local sideload testing only** — Microsoft re-signs the
package itself when a Store submission is ingested, so no certificate needs
to be purchased for the submission to go through. To test-install a local
build, you'd sign with a self-signed cert whose Subject exactly matches
`bundle.config.json`'s `publisher` field, then trust it and enable Developer
Mode — that's a local machine-trust change, so it's left as a manual step
rather than something automated here.

## Real identity, set 2026-09-15

App name reserved in Partner Center as "AssetPile 材栈". The MSIX package's
identity now comes entirely from `gen/windows/bundle.config.json`'s own
`identifier`, `displayName`, and `publisher` fields — **not**
`tauri.conf.json`'s `identifier`/`productName` (still `dev.assetpile.app` /
`"AssetPile｜材栈"`, and that's correct, see below):

```json
{
  "identifier": "RainWong.26914958E2086",
  "displayName": "AssetPile 材栈",
  "publisher": "CN=24C2653D-5663-4BE5-A584-7A96F6D59BFA",
  "publisherDisplayName": "Rain Wong"
}
```

`identifier` and `publisher` are copy-pasted verbatim from Partner Center's
**Product management → Product identity** page (Package/Identity/Name and
Package/Identity/Publisher) — the Publisher CN especially must match
character-for-character or `MakeAppx` rejects the package.

`displayName` exists because Partner Center separately validates the
package's `Package/Properties/DisplayName` against the *exact* string you
reserved the app name as — first submission attempt (2026-09-15) was
rejected with "此软件包的清单(Package/Properties/DisplayName)使用了你未保留的显示名称:
AssetPile｜材栈" because the reservation is "AssetPile 材栈" (ASCII space), not
the app's real `productName` "AssetPile｜材栈" (fullwidth pipe — same
branding, different literal string). `build-msix.mjs` reads
`bundle.config.json`'s `displayName` (falling back to `productName`) to
compute the exe filename it pre-builds and copies
(`executableName()`/`prepareAppxContent()` in tauri-windows-bundle's
`dist/index.js` derive it the same way, spaces stripped) — so this one
field, not a hardcoded filename, is the thing to change if the reserved
name ever changes again.

**Why not a `tauri.windows.conf.json` identifier override (tried and
reverted 2026-09-15):** Tauri's own CLI merges `tauri.<platform>.conf.json`
based on the *host OS the build runs on*, not which bundle target is being
produced — confirmed empirically: adding a checked-in
`tauri.windows.conf.json` with an identifier override changed the compiled
identifier in a *plain* `tauri build --no-bundle` run with no MSIX
involvement at all. Since the NSIS/MSI/portable release build also always
runs on Windows (local dev, and the `windows-latest` CI runner), a
checked-in file like that would have silently changed the real installer's
identifier too — different `app_data_dir()`, different autostart
registration — breaking existing installed users' data on their next
regular update. `bundle.config.json` has no such leak: it's read only by
`tauri-windows-bundle`'s own manifest-generation code
(`prepareAppxContent()`/`generateManifest()` in its `dist/index.js`), never
by the Rust `tauri` CLI, so its `identifier`/`publisher` fields affect only
the MSIX `AppxManifest.xml` and nothing else. Confirmed working: the exe's
own compiled-in identifier (`dev.assetpile.app`, used for `app_data_dir()`
etc. inside the running app) stays correct for every build type; only the
*package's declared identity* — what Partner Center actually validates at
ingestion — uses the reserved values.

- **WebView2 runtime**: the NSIS installer bootstraps WebView2 at install
  time; an MSIX package can't run arbitrary install-time logic like that.
  This build currently assumes the Evergreen WebView2 Runtime is already on
  the machine (true by default on Windows 11, and on Windows 10 once it's
  had the runtime pushed via Windows Update — which is the common case but
  not guaranteed). If that turns out to be a real problem during
  certification, the fix is bundling the Fixed Version runtime as an app
  dependency; not done here.

## Capabilities already set

- `internetClient` — the update-check calls the GitHub Releases API from the
  frontend (`apps/desktop/src/lib/update.ts`).
- `runFullTrust` (added automatically by the packaging tool) — this package
  runs as a Desktop Bridge full-trust app, not in an AppContainer, so normal
  Win32 file access (watching/moving files anywhere in the user's Downloads
  folder) works without the restricted `broadFileSystemAccess` capability
  that sandboxed UWP apps would need.

## Before submitting

- Enroll as a developer in Partner Center (individual or company).
- Reserve the app name, then fill in the real identity (see above).
- Prepare Store listing assets (screenshots, description) and answer the age
  rating questionnaire.
- Since the app calls out to the internet (GitHub API for update checks),
  expect Partner Center to ask for a privacy policy URL even though no user
  data leaves the device otherwise.
