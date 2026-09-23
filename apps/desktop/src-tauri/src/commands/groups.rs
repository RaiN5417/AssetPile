use std::sync::Arc;

use chrono::Utc;
use domain::{FileRecord, FileStatus, Group, Operation, OperationStatus, OperationType};
use storage::DbPool;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::self_writes::SelfWrites;

/// Emitted after a successful move so the UI can offer Undo without a
/// dedicated "list operations" round trip — see spec section 26's event list.
const EVENT_FILE_ORGANIZED: &str = "file-organized";

#[derive(serde::Serialize, Clone)]
struct OrganizedEvent {
    file: FileRecord,
    operation_id: Uuid,
}

/// Classifies a filesystem error touching a group's `destination_path` into
/// a stable, matchable string the frontend can branch on instead of a raw
/// OS error (e.g. "The system cannot find the path specified. (os error
/// 3)") — mirrors `file-operations::classify_io_error`'s intent, but at the
/// command layer since this crate isn't pulled in here just for that.
fn classify_destination_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => "group_path_not_found".to_string(),
        std::io::ErrorKind::PermissionDenied => "group_path_permission_denied".to_string(),
        _ => err.to_string(),
    }
}

#[tauri::command]
pub async fn create_group(
    pool: State<'_, DbPool>,
    name: String,
    destination_path: String,
) -> Result<Group, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("name can't be empty".to_string());
    }
    let existing = storage::list_groups(&pool)
        .await
        .map_err(|err| err.to_string())?;
    if existing.iter().any(|group| group.name == trimmed_name) {
        return Err("duplicate_name".to_string());
    }

    let now = Utc::now();
    let group = Group {
        id: Uuid::new_v4(),
        name,
        destination_path: Some(destination_path),
        icon: None,
        is_pinned: false,
        sort_order: 0,
        created_at: now,
        updated_at: now,
    };

    storage::insert_group(&pool, &group)
        .await
        .map_err(|err| err.to_string())?;
    Ok(group)
}

#[tauri::command]
pub async fn list_groups(pool: State<'_, DbPool>) -> Result<Vec<Group>, String> {
    storage::list_groups(&pool)
        .await
        .map_err(|err| err.to_string())
}

/// Files currently filed under a group — what the Groups panel shows once
/// the user selects a specific group (spec section 23 has no dedicated
/// listing for this; it's a plain filter on `group_id`).
#[tauri::command]
pub async fn list_group_files(
    pool: State<'_, DbPool>,
    group_id: String,
) -> Result<Vec<FileRecord>, String> {
    let group_id = Uuid::parse_str(&group_id).map_err(|err| err.to_string())?;
    storage::list_files_by_group(&pool, group_id)
        .await
        .map_err(|err| err.to_string())
}

/// Fails with a friendly message if any file is still filed under this
/// group — the DB's own foreign key is what actually enforces that; this
/// just gives the UI something better than a raw SQLite error to show.
#[tauri::command]
pub async fn delete_group(pool: State<'_, DbPool>, group_id: String) -> Result<(), String> {
    let group_id = Uuid::parse_str(&group_id).map_err(|err| err.to_string())?;
    storage::delete_group(&pool, group_id).await.map_err(|err| {
        if err.to_string().contains("FOREIGN KEY") {
            "This group still has files in it — move them first.".to_string()
        } else {
            err.to_string()
        }
    })
}

/// Moves one file into a group's destination folder (spec section 23).
///
/// Takes a single file rather than the `Vec<file_id>` shape spec section 26
/// eventually wants — the only caller today is the Floating Card acting on
/// the one file it's showing. A multi-select Inbox view can loop this per
/// id when it lands; that's a UI-layer concern, not a reason to build batch
/// plumbing here now.
#[tauri::command]
pub async fn assign_group(
    app: AppHandle,
    pool: State<'_, DbPool>,
    self_writes: State<'_, Arc<SelfWrites>>,
    file_id: String,
    group_id: String,
) -> Result<FileRecord, String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|err| err.to_string())?;
    let group_id = Uuid::parse_str(&group_id).map_err(|err| err.to_string())?;

    let file = storage::get_file(&pool, file_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("file not found")?;
    let group = storage::get_group(&pool, group_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("group not found")?;
    let destination_dir = group
        .destination_path
        .ok_or("group has no destination path set")?;
    let destination_dir = std::path::PathBuf::from(destination_dir);

    tokio::fs::create_dir_all(&destination_dir)
        .await
        .map_err(|err| classify_destination_error(&err))?;

    let source = std::path::PathBuf::from(&file.current_path);
    let destination =
        file_operations::resolve_destination(&destination_dir, &file.current_name).await;

    // Operation log is written *before* the filesystem action executes
    // (spec section 18/39), so a crash mid-move leaves a reconcilable trail.
    let operation = Operation {
        id: Uuid::new_v4(),
        file_id,
        operation_type: OperationType::Move,
        source_path: Some(source.to_string_lossy().into_owned()),
        destination_path: Some(destination.to_string_lossy().into_owned()),
        group_id: Some(group_id),
        status: OperationStatus::Pending,
        created_at: Utc::now(),
        completed_at: None,
        undone_at: None,
        error_code: None,
        error_message: None,
    };
    storage::insert_operation(&pool, &operation)
        .await
        .map_err(|err| err.to_string())?;

    // The destination can sit inside a watched folder (e.g. the group's
    // destination *is* the watched Downloads folder) — flag it before the
    // move so the watcher doesn't mistake the file landing there for a new
    // download and re-track it as an unarchived duplicate.
    self_writes.expect(destination.clone());

    match file_operations::execute_move(&source, &destination).await {
        Ok(_size) => {
            storage::mark_operation_completed(&pool, operation.id)
                .await
                .map_err(|err| err.to_string())?;

            let final_name = destination
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&file.current_name)
                .to_string();
            let destination_str = destination.to_string_lossy().into_owned();

            storage::assign_group(&pool, file_id, group_id, &final_name, &destination_str)
                .await
                .map_err(|err| err.to_string())?;
            crate::tag_mirror::sync(&pool, group_id).await;

            let updated = storage::get_file(&pool, file_id)
                .await
                .map_err(|err| err.to_string())?
                .ok_or_else(|| "file disappeared after being organized".to_string())?;

            let _ = app.emit(
                EVENT_FILE_ORGANIZED,
                OrganizedEvent {
                    file: updated.clone(),
                    operation_id: operation.id,
                },
            );

            Ok(updated)
        }
        Err(err) => {
            let _ =
                storage::mark_operation_failed(&pool, operation.id, err.code, &err.message).await;
            let _ = storage::mark_status(
                &pool,
                file_id,
                domain::FileStatus::Error,
                Some(err.code),
                Some(&err.message),
            )
            .await;
            Err(err.message)
        }
    }
}

/// One file sitting in a group's destination folder that the app has never
/// seen before — e.g. it was already there when the folder was added as a
/// group, or was copied in from outside the app. Surfaced by
/// `scan_group_folder` so the user can bring it under app management.
#[derive(serde::Serialize)]
pub struct ImportableFile {
    name: String,
    path: String,
    size_bytes: Option<u64>,
}

/// Lists files sitting directly in a group's destination folder that aren't
/// already tracked in the DB — non-recursive, matching the watcher's own
/// scope (spec section 15 forbids recursive/polling scans in general; a
/// user-triggered rescan of one folder is a one-off listing, not a loop,
/// but there's no reason for it to walk subfolders the watcher itself never
/// would).
#[tauri::command]
pub async fn scan_group_folder(
    pool: State<'_, DbPool>,
    group_id: String,
) -> Result<Vec<ImportableFile>, String> {
    scan_group_folder_impl(&pool, &group_id).await
}

/// The actual scan logic, split out from the `#[tauri::command]` wrapper so
/// it's callable directly (with a plain `&DbPool`) from tests — `State`
/// can't be constructed without a running Tauri app, but this needs nothing
/// Tauri-specific at all.
async fn scan_group_folder_impl(
    pool: &DbPool,
    group_id: &str,
) -> Result<Vec<ImportableFile>, String> {
    let group_id = Uuid::parse_str(group_id).map_err(|err| err.to_string())?;
    let group = storage::get_group(pool, group_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("group not found")?;
    let destination = group
        .destination_path
        .ok_or("group has no destination path set")?;

    let mut entries = tokio::fs::read_dir(&destination)
        .await
        .map_err(|err| err.to_string())?;

    let mut out = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == crate::tag_mirror::MIRROR_FILENAME {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy().into_owned();
        if storage::find_file_by_path(pool, &path_str)
            .await
            .map_err(|err| err.to_string())?
            .is_some()
        {
            continue;
        }
        let size_bytes = entry.metadata().await.ok().map(|m| m.len());
        out.push(ImportableFile {
            name,
            path: path_str,
            size_bytes,
        });
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Brings files already sitting in a group's folder under app management —
/// the counterpart to `scan_group_folder`'s listing. Unlike `assign_group`,
/// nothing moves on disk (the files are already where they belong); this
/// only creates their DB rows, already `Organized`, and applies whichever
/// tags the user chose while reviewing the scan results.
#[tauri::command]
pub async fn import_group_files(
    pool: State<'_, DbPool>,
    group_id: String,
    paths: Vec<String>,
    tag_names: Vec<String>,
) -> Result<Vec<FileRecord>, String> {
    import_group_files_impl(&pool, &group_id, paths, tag_names).await
}

async fn import_group_files_impl(
    pool: &DbPool,
    group_id: &str,
    paths: Vec<String>,
    tag_names: Vec<String>,
) -> Result<Vec<FileRecord>, String> {
    let group_id = Uuid::parse_str(group_id).map_err(|err| err.to_string())?;
    storage::get_group(pool, group_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("group not found")?;

    let mut imported = Vec::new();
    for path_str in paths {
        let path = std::path::PathBuf::from(&path_str);
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Skip anything the app started tracking in the moment between the
        // scan and this call (e.g. two scans confirmed concurrently).
        if storage::find_file_by_path(pool, &path_str)
            .await
            .map_err(|err| err.to_string())?
            .is_some()
        {
            continue;
        }
        let metadata = tokio::fs::metadata(&path).await.ok();
        let now = Utc::now();
        let record = FileRecord {
            id: Uuid::new_v4(),
            original_name: file_name.to_string(),
            current_name: file_name.to_string(),
            original_path: path_str.clone(),
            current_path: path_str.clone(),
            extension: path.extension().and_then(|e| e.to_str()).map(str::to_owned),
            mime_type: None,
            size_bytes: metadata.map(|m| m.len() as i64),
            status: FileStatus::Organized,
            detected_at: now,
            ready_at: Some(now),
            organized_at: Some(now),
            last_seen_at: now,
            expires_at: None,
            group_id: Some(group_id),
            source_context_id: None,
            error_code: None,
            error_message: None,
        };
        storage::insert_file(pool, &record)
            .await
            .map_err(|err| err.to_string())?;

        for tag_name in &tag_names {
            let tag_name = tag_name.trim();
            if tag_name.is_empty() {
                continue;
            }
            storage::add_tag_to_file(pool, record.id, tag_name)
                .await
                .map_err(|err| err.to_string())?;
        }

        imported.push(record);
    }

    crate::tag_mirror::sync(pool, group_id).await;
    Ok(imported)
}

/// Probes whether a group's destination folder is still reachable, without
/// mutating anything — `list_group_files` only reads the DB, so this is the
/// GroupFilesPanel's way to know whether the on-disk folder itself is
/// missing or unreadable before it lets the user file more into it.
/// `read_dir` (not just `metadata`) so a folder that exists but denies
/// listing still comes back as `group_path_permission_denied`.
#[tauri::command]
pub async fn check_group_destination(
    pool: State<'_, DbPool>,
    group_id: String,
) -> Result<(), String> {
    let group_id = Uuid::parse_str(&group_id).map_err(|err| err.to_string())?;
    let group = storage::get_group(&pool, group_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("group not found")?;

    let Some(destination) = group.destination_path else {
        return Ok(());
    };

    tokio::fs::read_dir(&destination)
        .await
        .map(|_| ())
        .map_err(|err| classify_destination_error(&err))
}

/// Repoints a group at a different destination folder — the "Choose a
/// Different Folder" recovery action for a broken/permission-denied path
/// (spec's Groups panel; see `check_group_destination`). Existing files
/// already filed under the group keep their recorded `current_path`;
/// this only changes where *new* files land.
#[tauri::command]
pub async fn update_group_destination(
    pool: State<'_, DbPool>,
    group_id: String,
    destination_path: String,
) -> Result<Group, String> {
    let group_id = Uuid::parse_str(&group_id).map_err(|err| err.to_string())?;
    let destination_path = destination_path.trim();
    if destination_path.is_empty() {
        return Err("destination path can't be empty".to_string());
    }

    storage::update_group_destination(&pool, group_id, destination_path)
        .await
        .map_err(|err| err.to_string())?;

    storage::get_group(&pool, group_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "group not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A throwaway sqlite DB (in its own directory — like the real app's
    /// app-data dir, never inside a Group's destination folder) plus a
    /// separate empty folder to use as a group destination, both under the
    /// OS temp dir and migrated the same way the real app's DB is. Callers
    /// are responsible for cleaning up `dir` (`std::fs::remove_dir_all`)
    /// when done; the DB directory is a sibling and gets swept up with it.
    async fn temp_pool_and_dir() -> (DbPool, PathBuf) {
        let root = std::env::temp_dir().join(format!("assetpile-test-{}", Uuid::new_v4()));
        let dir = root.join("group-folder");
        let db_dir = root.join("db");
        std::fs::create_dir_all(&dir).expect("create temp test dir");
        std::fs::create_dir_all(&db_dir).expect("create temp db dir");
        let pool = storage::init_db(&db_dir.join("test.sqlite"))
            .await
            .expect("init temp test db");
        (pool, dir)
    }

    /// Cleans up everything `temp_pool_and_dir` created — `dir` plus its
    /// sibling DB directory — rather than leaving temp-dir litter behind.
    fn cleanup(dir: &std::path::Path) {
        if let Some(root) = dir.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    async fn insert_test_group(pool: &DbPool, destination: &std::path::Path) -> Group {
        let group = Group {
            id: Uuid::new_v4(),
            name: "Test group".to_string(),
            destination_path: Some(destination.to_string_lossy().into_owned()),
            icon: None,
            is_pinned: false,
            sort_order: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        storage::insert_group(pool, &group)
            .await
            .expect("insert test group");
        group
    }

    // Reproduces the "folder already had files in it before it became a
    // Group" scenario from the feature request: a file already tracked in
    // the DB, the hidden tag mirror, and a nested subfolder must all be
    // excluded from the scan, leaving only the genuinely new top-level file.
    #[tokio::test]
    async fn scan_lists_only_untracked_top_level_files() {
        let (pool, dir) = temp_pool_and_dir().await;
        let group = insert_test_group(&pool, &dir).await;

        std::fs::write(dir.join("photo.png"), b"fake").unwrap();

        let tracked_path = dir.join("already-in.png");
        std::fs::write(&tracked_path, b"fake").unwrap();
        let tracked = FileRecord {
            id: Uuid::new_v4(),
            original_name: "already-in.png".to_string(),
            current_name: "already-in.png".to_string(),
            original_path: tracked_path.to_string_lossy().into_owned(),
            current_path: tracked_path.to_string_lossy().into_owned(),
            extension: Some("png".to_string()),
            mime_type: None,
            size_bytes: Some(4),
            status: FileStatus::Organized,
            detected_at: Utc::now(),
            ready_at: None,
            organized_at: None,
            last_seen_at: Utc::now(),
            expires_at: None,
            group_id: Some(group.id),
            source_context_id: None,
            error_code: None,
            error_message: None,
        };
        storage::insert_file(&pool, &tracked).await.unwrap();

        std::fs::write(dir.join(crate::tag_mirror::MIRROR_FILENAME), b"{}").unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested").join("inner.png"), b"fake").unwrap();

        let found = scan_group_folder_impl(&pool, &group.id.to_string())
            .await
            .expect("scan should succeed");
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();

        assert_eq!(
            names,
            vec!["photo.png"],
            "should surface only the untracked top-level file, excluding the already-tracked \
             file, the tag mirror, and anything in a subfolder"
        );

        cleanup(&dir);
    }

    // Covers the other half of the feature: importing brings the file under
    // management as already-Organized (nothing moves on disk), applies the
    // requested tags, and updates the hidden per-folder mirror — without
    // ever making the mirror the source of truth (the DB tags are what
    // `list_all_file_tags` reports back).
    #[tokio::test]
    async fn import_creates_organized_rows_tags_them_and_updates_the_mirror() {
        let (pool, dir) = temp_pool_and_dir().await;
        let group = insert_test_group(&pool, &dir).await;

        let file_path = dir.join("art.png");
        std::fs::write(&file_path, b"fake-bytes").unwrap();

        let imported = import_group_files_impl(
            &pool,
            &group.id.to_string(),
            vec![file_path.to_string_lossy().into_owned()],
            vec!["ai生成".to_string(), "  ".to_string()],
        )
        .await
        .expect("import should succeed");

        assert_eq!(imported.len(), 1);
        let record = &imported[0];
        assert_eq!(record.status, FileStatus::Organized);
        assert_eq!(record.group_id, Some(group.id));

        let all_tags = storage::list_all_file_tags(&pool).await.unwrap();
        let file_tags = all_tags.get(&record.id).cloned().unwrap_or_default();
        assert_eq!(
            file_tags
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            vec!["ai生成"],
            "the blank tag entry must be ignored, and the real one applied"
        );

        let mirror_json = std::fs::read_to_string(dir.join(crate::tag_mirror::MIRROR_FILENAME))
            .expect("import should have written the tag mirror");
        assert!(mirror_json.contains("art.png"));
        assert!(mirror_json.contains("ai生成"));

        // Importing the same path again must not create a second row.
        let second = import_group_files_impl(
            &pool,
            &group.id.to_string(),
            vec![file_path.to_string_lossy().into_owned()],
            vec![],
        )
        .await
        .expect("re-import should succeed, not error");
        assert!(
            second.is_empty(),
            "an already-tracked path must be skipped, not duplicated"
        );

        cleanup(&dir);
    }
}
