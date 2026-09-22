//! SQLite connection pool, migrations, and repository functions.
//!
//! Repository functions are added alongside the features that need them
//! (see docs/architecture.md milestones) rather than pre-built speculatively.

mod files;
mod groups;
mod operations;
mod settings;
mod tags;

pub use files::{
    assign_group, find_file_by_path, get_file, insert_file, list_files_by_group, list_inbox,
    list_temporary, mark_ready_pending, mark_restored, mark_status, mark_temporary, mark_trashed,
    rename_file, sweep_expired,
};
pub use groups::{delete_group, get_group, insert_group, list_groups, update_group_destination};
pub use operations::{
    get_operation, insert_operation, list_operations, list_pending_operations,
    mark_operation_completed, mark_operation_failed, mark_operation_undone,
};
pub use settings::{get_setting, set_setting};
pub use tags::{
    add_tag_to_file, create_tag, delete_tag, list_all_file_tags, list_tags, remove_tag_from_file,
};

use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

pub type DbPool = SqlitePool;

/// Columns are written with `to_rfc3339()`, so this should never actually
/// fail — falling back to "now" keeps a read from panicking over a
/// hand-edited or otherwise malformed timestamp.
fn parse_timestamp(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|err| {
            tracing::warn!(
                ?err,
                value = s,
                "malformed timestamp in database, using now()"
            );
            Utc::now()
        })
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

/// Opens the SQLite database at `db_path` (creating it if missing) and runs
/// all pending migrations. WAL mode + foreign keys per spec section 38.
pub async fn init_db(db_path: &Path) -> Result<DbPool, StorageError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("../../migrations").run(&pool).await?;

    Ok(pool)
}
