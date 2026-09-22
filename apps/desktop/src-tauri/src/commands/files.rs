use std::sync::Arc;

use chrono::Utc;
use domain::{FileRecord, Operation, OperationStatus, OperationType};
use storage::DbPool;
use tauri::State;
use uuid::Uuid;

use crate::self_writes::SelfWrites;

/// Renames a file in place — a same-directory move, so this reuses
/// `file-operations`' collision-free-destination + safe-move logic rather
/// than duplicating it, and gets its own `Rename` operation log entry
/// (spec section 18/35).
#[tauri::command]
pub async fn rename_file(
    pool: State<'_, DbPool>,
    self_writes: State<'_, Arc<SelfWrites>>,
    file_id: String,
    new_name: String,
) -> Result<FileRecord, String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|err| err.to_string())?;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("name can't be empty".to_string());
    }

    let file = storage::get_file(&pool, file_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("file not found")?;
    let source = std::path::PathBuf::from(&file.current_path);
    let dir = source.parent().ok_or("file has no parent directory")?;
    let destination = file_operations::resolve_destination(dir, new_name).await;

    let operation = Operation {
        id: Uuid::new_v4(),
        file_id,
        operation_type: OperationType::Rename,
        source_path: Some(source.to_string_lossy().into_owned()),
        destination_path: Some(destination.to_string_lossy().into_owned()),
        group_id: file.group_id,
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

    // A rename is a same-directory move within a watched folder, so it
    // always needs this: without it, the watcher's own Create/Rename event
    // for the new name would be tracked as a second, unarchived file.
    self_writes.expect(destination.clone());

    match file_operations::execute_move(&source, &destination).await {
        Ok(_size) => {
            storage::mark_operation_completed(&pool, operation.id)
                .await
                .map_err(|err| err.to_string())?;

            let final_name = destination
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(new_name)
                .to_string();
            let destination_str = destination.to_string_lossy().into_owned();

            storage::rename_file(&pool, file_id, &final_name, &destination_str)
                .await
                .map_err(|err| err.to_string())?;
            // The mirror keys tags by filename, so a rename needs a resync
            // even though group membership itself didn't change.
            if let Some(group_id) = file.group_id {
                crate::tag_mirror::sync(&pool, group_id).await;
            }

            storage::get_file(&pool, file_id)
                .await
                .map_err(|err| err.to_string())?
                .ok_or_else(|| "file disappeared after rename".to_string())
        }
        Err(err) => {
            let _ =
                storage::mark_operation_failed(&pool, operation.id, err.code, &err.message).await;
            Err(err.message)
        }
    }
}
