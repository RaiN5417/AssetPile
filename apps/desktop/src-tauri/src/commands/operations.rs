use std::sync::Arc;

use domain::{FileRecord, OperationStatus};
use storage::DbPool;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::self_writes::SelfWrites;

/// Emitted after a successful Undo so any open Inbox/History view can update
/// live, whether the Undo was triggered from the Floating Card's session-only
/// list or from History (which works on operations from any past session).
const EVENT_FILE_RESTORED: &str = "file-restored";

/// Undoes a completed move (spec section 24): moves the file back from its
/// destination to its original path (or a conflict-safe "(restored)" name
/// if something else now occupies that spot), then stamps the operation
/// `undone_at`.
#[tauri::command]
pub async fn undo_operation(
    app: AppHandle,
    pool: State<'_, DbPool>,
    self_writes: State<'_, Arc<SelfWrites>>,
    operation_id: String,
) -> Result<FileRecord, String> {
    let operation_id = Uuid::parse_str(&operation_id).map_err(|err| err.to_string())?;

    let operation = storage::get_operation(&pool, operation_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("operation not found")?;

    if operation.status != OperationStatus::Completed {
        return Err("only a completed operation can be undone".to_string());
    }
    if operation.undone_at.is_some() {
        return Err("operation was already undone".to_string());
    }

    let destination = operation
        .destination_path
        .ok_or("operation has no destination path")?;
    let original_source = operation
        .source_path
        .ok_or("operation has no source path")?;
    let destination_path = std::path::PathBuf::from(&destination);
    let original_path = std::path::PathBuf::from(&original_source);

    // Preflight (spec section 35): the file we're about to move back must
    // still be where the original operation left it.
    if tokio::fs::metadata(&destination_path).await.is_err() {
        return Err("the organized file is no longer at its expected location".to_string());
    }

    let restore_target = file_operations::resolve_restore_path(&original_path).await;

    // Restoring puts the file back inside its original (likely watched)
    // folder — same self-caused-event risk as a group move or rename.
    self_writes.expect(restore_target.clone());

    file_operations::execute_move(&destination_path, &restore_target)
        .await
        .map_err(|err| err.message)?;

    storage::mark_operation_undone(&pool, operation_id)
        .await
        .map_err(|err| err.to_string())?;

    let restore_name = restore_target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let restore_path_str = restore_target.to_string_lossy().into_owned();

    storage::mark_restored(&pool, operation.file_id, &restore_name, &restore_path_str)
        .await
        .map_err(|err| err.to_string())?;

    // The file just left this group (mark_restored just cleared its
    // group_id) — resync so the folder's mirror stops listing it.
    if let Some(group_id) = operation.group_id {
        crate::tag_mirror::sync(&pool, group_id).await;
    }

    let restored = storage::get_file(&pool, operation.file_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "file disappeared after being restored".to_string())?;

    let _ = app.emit(EVENT_FILE_RESTORED, &restored);

    Ok(restored)
}
