// Runs the MSIX build with an *absolute* CARGO_TARGET_DIR, and pre-builds +
// renames the exe tauri-windows-bundle expects but Cargo can't produce
// directly (see below).
//
// This is a Cargo workspace, so `cargo build` always writes to the
// workspace-root `target/`, not `src-tauri/target/`. tauri-windows-bundle
// assumes the latter unless CARGO_TARGET_DIR says otherwise, so we point it
// there explicitly. It has to be absolute: tauri-cli invokes cargo from
// `src-tauri`, one directory deeper than this script's own cwd
// (`apps/desktop`), so a relative value resolves to two different
// directories depending on which process reads it.
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcTauriDir = path.join(desktopDir, "src-tauri");
const targetDir = path.resolve(desktopDir, "../../target");
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const args = process.argv.slice(2);
const debug = args.includes("--debug");

// Only x64 is built today — matches bundle.config.json's default and the
// `--arch` flag's own default; update both together if arm64 is ever added.
const rustTarget = "x86_64-pc-windows-msvc";
const releaseDir = path.join(targetDir, rustTarget, debug ? "debug" : "release");

// tauri-windows-bundle looks for the compiled exe named after `displayName`
// (spaces stripped) with no way to point it elsewhere — see
// `executableName()`/`prepareAppxContent()` in
// @choochmeque/tauri-windows-bundle's dist/index.js. `displayName` there is
// `bundle.config.json`'s own `displayName` if set (falling back to
// `tauri.conf.json`'s `productName`), which for this app is set explicitly
// to the exact string reserved in Partner Center — "AssetPile 材栈" — since
// Partner Center rejects a package whose manifest DisplayName doesn't
// character-for-character match the reservation, and that reserved string
// differs from the app's actual `productName`
// ("AssetPile｜材栈", with a fullwidth pipe instead of a space).
//
// Cargo can't produce a `[[bin]]` target with either of those exact
// filenames (CJK/space/pipe characters aren't valid there), so this builds
// the real `assetpile.exe` itself first and copies it under whichever name
// the tool will actually look for — computed the same way the tool
// computes it, so this stays correct if `displayName`/`productName` ever
// changes again. The tool's own `build` command always re-runs
// `tauri build --no-bundle` too, but that's incremental and won't touch or
// remove this extra file.
const bundleConfig = JSON.parse(
  readFileSync(path.join(srcTauriDir, "gen", "windows", "bundle.config.json"), "utf-8"),
);
const tauriConfig = JSON.parse(readFileSync(path.join(srcTauriDir, "tauri.conf.json"), "utf-8"));
const displayName = bundleConfig.displayName || tauriConfig.productName || "App";
const exeName = `${displayName.replace(/\s+/g, "")}.exe`;

console.log(`Pre-building assetpile.exe for ${rustTarget} (${debug ? "debug" : "release"})...`);
execFileSync(
  "pnpm",
  ["tauri", "build", "--target", rustTarget, "--no-bundle", ...(debug ? ["--debug"] : [])],
  { cwd: desktopDir, stdio: "inherit", shell: true, env },
);

const srcExe = path.join(releaseDir, "assetpile.exe");
const destExe = path.join(releaseDir, exeName);
if (!existsSync(srcExe)) {
  throw new Error(`Expected ${srcExe} to exist after 'tauri build' — check the output above.`);
}
copyFileSync(srcExe, destExe);
console.log(`Copied ${srcExe}\n     -> ${destExe}`);

// shell: true is required on Windows to resolve the pnpm.cmd shim.
execFileSync("pnpm", ["exec", "tauri-windows-bundle", "build", "--runner", "pnpm", ...args], {
  cwd: desktopDir,
  stdio: "inherit",
  shell: true,
  env,
});
