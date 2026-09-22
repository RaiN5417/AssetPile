use std::collections::HashMap;

use domain::Tag;
use storage::DbPool;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub async fn list_tags(pool: State<'_, DbPool>) -> Result<Vec<Tag>, String> {
    storage::list_tags(&pool)
        .await
        .map_err(|err| err.to_string())
}

/// Keyed by file id (as a string — Tauri's JSON bridge can't carry a
/// `HashMap<Uuid, _>` key as-is) so the frontend can hydrate a gallery's
/// worth of cards from one call instead of one request per file.
#[tauri::command]
pub async fn list_all_file_tags(
    pool: State<'_, DbPool>,
) -> Result<HashMap<String, Vec<Tag>>, String> {
    let map = storage::list_all_file_tags(&pool)
        .await
        .map_err(|err| err.to_string())?;
    Ok(map
        .into_iter()
        .map(|(id, tags)| (id.to_string(), tags))
        .collect())
}

/// Creates a tag with no file attached yet — the sidebar's "+" button.
#[tauri::command]
pub async fn create_tag(pool: State<'_, DbPool>, tag_name: String) -> Result<Tag, String> {
    let tag_name = tag_name.trim();
    if tag_name.is_empty() {
        return Err("tag name can't be empty".to_string());
    }
    storage::create_tag(&pool, tag_name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn add_tag_to_file(
    pool: State<'_, DbPool>,
    file_id: String,
    tag_name: String,
) -> Result<Tag, String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|err| err.to_string())?;
    let tag_name = tag_name.trim();
    if tag_name.is_empty() {
        return Err("tag name can't be empty".to_string());
    }
    let tag = storage::add_tag_to_file(&pool, file_id, tag_name)
        .await
        .map_err(|err| err.to_string())?;
    sync_mirror_for_file(&pool, file_id).await;
    Ok(tag)
}

/// Deletes a tag entirely (the Tags management panel's delete button) —
/// distinct from `remove_tag_from_file`, which only unlinks one file.
#[tauri::command]
pub async fn delete_tag(pool: State<'_, DbPool>, tag_id: String) -> Result<(), String> {
    let tag_id = Uuid::parse_str(&tag_id).map_err(|err| err.to_string())?;
    storage::delete_tag(&pool, tag_id)
        .await
        .map_err(|err| err.to_string())?;
    // A deleted tag can drop off files across more than one group at once,
    // so resync every group's mirror rather than tracking which ones held it.
    crate::tag_mirror::sync_all(&pool).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_tag_from_file(
    pool: State<'_, DbPool>,
    file_id: String,
    tag_id: String,
) -> Result<(), String> {
    let file_id = Uuid::parse_str(&file_id).map_err(|err| err.to_string())?;
    let tag_id = Uuid::parse_str(&tag_id).map_err(|err| err.to_string())?;
    storage::remove_tag_from_file(&pool, file_id, tag_id)
        .await
        .map_err(|err| err.to_string())?;
    sync_mirror_for_file(&pool, file_id).await;
    Ok(())
}

/// Looks up which group (if any) `file_id` currently belongs to and
/// resyncs that group's tag mirror — a no-op if the file isn't filed under
/// a group yet.
async fn sync_mirror_for_file(pool: &DbPool, file_id: Uuid) {
    if let Ok(Some(file)) = storage::get_file(pool, file_id).await {
        if let Some(group_id) = file.group_id {
            crate::tag_mirror::sync(pool, group_id).await;
        }
    }
}
