use chrono::Utc;
use domain::Group;
use uuid::Uuid;

use crate::{DbPool, StorageError};

pub async fn insert_group(pool: &DbPool, group: &Group) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO groups (id, name, destination_path, icon, is_pinned, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(group.id.to_string())
    .bind(&group.name)
    .bind(&group.destination_path)
    .bind(&group.icon)
    .bind(group.is_pinned)
    .bind(group.sort_order)
    .bind(group.created_at.to_rfc3339())
    .bind(group.updated_at.to_rfc3339())
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_groups(pool: &DbPool) -> Result<Vec<Group>, StorageError> {
    let rows = sqlx::query_as::<_, GroupRow>(
        "SELECT id, name, destination_path, icon, is_pinned, sort_order, created_at, updated_at
         FROM groups ORDER BY sort_order ASC, name ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn get_group(pool: &DbPool, id: Uuid) -> Result<Option<Group>, StorageError> {
    let row = sqlx::query_as::<_, GroupRow>(
        "SELECT id, name, destination_path, icon, is_pinned, sort_order, created_at, updated_at
         FROM groups WHERE id = ?",
    )
    .bind(id.to_string())
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Into::into))
}

/// Repoints a group at a different destination folder — new files filed
/// into the group use this from here on; files already filed keep their
/// recorded path untouched.
pub async fn update_group_destination(
    pool: &DbPool,
    id: Uuid,
    destination_path: &str,
) -> Result<(), StorageError> {
    sqlx::query("UPDATE groups SET destination_path = ?, updated_at = ? WHERE id = ?")
        .bind(destination_path)
        .bind(Utc::now().to_rfc3339())
        .bind(id.to_string())
        .execute(pool)
        .await?;

    Ok(())
}

/// Fails (FK constraint) if any file's `group_id` still points at this
/// group — the caller must move or reassign those files first. Past
/// `operations` rows referencing this group survive with `group_id` cleared
/// (see migrations/0002).
pub async fn delete_group(pool: &DbPool, id: Uuid) -> Result<(), StorageError> {
    sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(id.to_string())
        .execute(pool)
        .await?;

    Ok(())
}

#[derive(sqlx::FromRow)]
struct GroupRow {
    id: String,
    name: String,
    destination_path: Option<String>,
    icon: Option<String>,
    is_pinned: bool,
    sort_order: i64,
    created_at: String,
    updated_at: String,
}

impl From<GroupRow> for Group {
    fn from(row: GroupRow) -> Self {
        Group {
            id: Uuid::parse_str(&row.id).unwrap_or_default(),
            name: row.name,
            destination_path: row.destination_path,
            icon: row.icon,
            is_pinned: row.is_pinned,
            sort_order: row.sort_order,
            created_at: crate::parse_timestamp(&row.created_at),
            updated_at: crate::parse_timestamp(&row.updated_at),
        }
    }
}
