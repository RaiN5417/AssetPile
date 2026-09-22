use chrono::Utc;
use domain::{FileRecord, Group, Operation, OperationStatus, OperationType};
use storage::DbPool;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

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
    let existing = storage::list_groups(&pool).await.map_err(|err| err.to_string())?;
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
