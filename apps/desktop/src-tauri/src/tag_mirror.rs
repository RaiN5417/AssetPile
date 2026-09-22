//! Writes a hidden `.assetpile-tags.json` snapshot into a Group's
//! destination folder whenever a file in it gets tagged — so the tags a
//! file carries are visible (and travel with the folder, e.g. if it's
//! zipped up or moved to another machine) without opening the app.
//!
//! The SQLite `files`/`tags`/`file_tags` tables remain the single source of
//! truth (undo, history, and reconciliation all read from there); this file
//! is a best-effort *mirror*, regenerated wholesale from the DB on every
//! sync rather than incrementally edited, so it can never drift into its
//! own inconsistent state. A write failure here (folder deleted out from
//! under the app, permissions, etc.) is logged and swallowed — it must
//! never fail the tagging action that triggered it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use storage::DbPool;
use uuid::Uuid;

pub const MIRROR_FILENAME: &str = ".assetpile-tags.json";

#[derive(Serialize)]
struct TagMirror {
    /// Bumped if the on-disk shape ever needs to change.
    version: u32,
    generated_at: String,
    /// current file name -> tag names, alphabetical on both axes so the
    /// file diffs cleanly if someone puts the folder under version control.
    files: BTreeMap<String, Vec<String>>,
}

/// Regenerates the mirror for `group_id`'s destination folder. No-op if the
/// group has no destination path (nothing to write into) or no longer
/// exists.
pub async fn sync(pool: &DbPool, group_id: Uuid) {
    let group = match storage::get_group(pool, group_id).await {
        Ok(Some(group)) => group,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!(?err, %group_id, "tag mirror: failed to load group");
            return;
        }
    };
    let Some(destination) = group.destination_path else {
        return;
    };

    let files = match storage::list_files_by_group(pool, group_id).await {
        Ok(files) => files,
        Err(err) => {
            tracing::warn!(?err, %group_id, "tag mirror: failed to list group files");
            return;
        }
    };
    let all_tags = match storage::list_all_file_tags(pool).await {
        Ok(tags) => tags,
        Err(err) => {
            tracing::warn!(?err, "tag mirror: failed to load tags");
            return;
        }
    };

    let mut mirrored = BTreeMap::new();
    for file in &files {
        let mut names: Vec<String> = all_tags
            .get(&file.id)
            .map(|tags| tags.iter().map(|t| t.name.clone()).collect())
            .unwrap_or_default();
        if names.is_empty() {
            continue;
        }
        names.sort();
        mirrored.insert(file.current_name.clone(), names);
    }

    let mirror = TagMirror {
        version: 1,
        generated_at: chrono::Utc::now().to_rfc3339(),
        files: mirrored,
    };

    if let Err(err) = write_mirror(Path::new(&destination), &mirror).await {
        tracing::warn!(?err, %group_id, dir = %destination, "tag mirror: failed to write");
    }
}

/// Same as `sync`, but for every group that has a destination folder —
/// used after an operation (like deleting a tag) that can touch files
/// across more than one group at once. The group count is small enough
/// (user-created "projects", not per-file rows) that resyncing all of them
/// is cheap.
pub async fn sync_all(pool: &DbPool) {
    let groups = match storage::list_groups(pool).await {
        Ok(groups) => groups,
        Err(err) => {
            tracing::warn!(?err, "tag mirror: failed to list groups");
            return;
        }
    };
    for group in groups {
        sync(pool, group.id).await;
    }
}

async fn write_mirror(dir: &Path, mirror: &TagMirror) -> std::io::Result<()> {
    if mirror.files.is_empty() {
        // Nothing tagged in this group (yet, or anymore) — don't leave a
        // stale or empty dotfile sitting in the user's folder.
        let path = dir.join(MIRROR_FILENAME);
        if tokio::fs::metadata(&path).await.is_ok() {
            tokio::fs::remove_file(&path).await?;
        }
        return Ok(());
    }

    let json = serde_json::to_string_pretty(mirror).unwrap_or_default();
    let path = dir.join(MIRROR_FILENAME);
    let is_new = tokio::fs::metadata(&path).await.is_err();
    tokio::fs::write(&path, json).await?;

    if is_new {
        hide_on_windows(&path).await;
    }
    Ok(())
}

/// Best-effort: marks the file hidden via the `attrib` shell command rather
/// than pulling in a Windows API binding for one attribute flip (spec
/// section 48 on dependency control). A dotfile is invisible on macOS/Linux
/// file managers by convention already, so this is a Windows-only step.
/// Run through `spawn_blocking` since `std::process::Command` blocks the
/// thread it runs on and this crate doesn't otherwise need tokio's
/// `process` feature for anything else.
#[cfg(windows)]
async fn hide_on_windows(path: &Path) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW — this is a GUI app with no console to inherit, and
    // without this flag a `cmd.exe` window would flash open for the split
    // second `attrib` runs.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path = path.to_owned();
    let _ = tokio::task::spawn_blocking(move || {
        std::process::Command::new("attrib")
            .arg("+h")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await;
}

#[cfg(not(windows))]
async fn hide_on_windows(_path: &Path) {}
