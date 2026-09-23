//! Wires `file-watcher` → `download-detector` → `event-engine` → `storage`
//! → UI together.
//!
//! This is the app's `inbox-service` orchestration (spec section 18) living
//! directly in the Tauri crate for now rather than as its own workspace
//! member — its job is inherently Tauri-coupled (notifying the UI means
//! emitting a Tauri event), and pulling it out only pays off once something
//! other than this app needs to reuse it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use domain::{AppErrorCode, FileRecord, FileStatus};
use download_detector::{wait_until_ready, DetectorError, StabilityConfig};
use event_engine::BatchConfig;
use file_watcher::{FsEvent, FsEventKind, WatcherError, WatcherHandle};
use storage::DbPool;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

use crate::self_writes::SelfWrites;

/// Event name from spec section 26's Rust → UI event list.
const EVENT_FILE_READY: &str = "file-ready";
/// Emitted when a file the Inbox/Temporary panels were still showing
/// disappeared from a watched folder for a reason the app didn't itself
/// cause (see `handle_removed`).
const EVENT_FILE_MISSING: &str = "file-missing";

/// How long to wait before retrying a file that timed out during the
/// stability check (spec section 20.3: "低频重试").
const RETRY_INTERVAL: Duration = Duration::from_secs(10);

/// Starts watching every folder in `watched_dirs`. Keep the returned
/// `WatcherHandle` alive (e.g. via `app.manage`) for as long as watching
/// should continue.
pub fn start(
    app: AppHandle,
    pool: DbPool,
    watched_dirs: Vec<PathBuf>,
    self_writes: Arc<SelfWrites>,
) -> Result<WatcherHandle, WatcherError> {
    let (handle, events) = file_watcher::watch(&watched_dirs)?;

    // event_engine::spawn() calls tokio::spawn() internally, which needs an
    // active Tokio runtime context — `start()` runs synchronously from
    // Tauri's `.setup()`, which has none. Doing it inside this task (already
    // running on Tauri's managed runtime via `async_runtime::spawn`) gives
    // it one; a bare call here panics with "no reactor running".
    tauri::async_runtime::spawn(async move {
        let (batch_tx, batch_rx) = event_engine::spawn(BatchConfig::default());
        tokio::join!(
            run_event_loop(app.clone(), pool, events, batch_tx, self_writes),
            run_batch_consumer(app, batch_rx),
        );
    });
    Ok(handle)
}

/// Turns each closed batch into a Floating Card show — one file gets the
/// normal single-file card, two or more get the batch card (spec section 9).
async fn run_batch_consumer(app: AppHandle, mut batches: UnboundedReceiver<Vec<FileRecord>>) {
    while let Some(batch) = batches.recv().await {
        match batch.as_slice() {
            [] => {}
            [single] => crate::floating_card::show_single(&app, single),
            _ => crate::floating_card::show_batch(&app, &batch),
        }
    }
}

async fn run_event_loop(
    app: AppHandle,
    pool: DbPool,
    mut events: UnboundedReceiver<FsEvent>,
    batch_tx: UnboundedSender<FileRecord>,
    self_writes: Arc<SelfWrites>,
) {
    // Paths currently being tracked, so a burst of Modify/Rename events for
    // one in-progress download doesn't spawn a tracking task per event.
    let in_flight: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));

    while let Some(event) = events.recv().await {
        if event.kind == FsEventKind::Remove {
            let app = app.clone();
            let pool = pool.clone();
            let path = event.path.clone();
            tauri::async_runtime::spawn(async move {
                handle_removed(&app, &pool, &path).await;
            });
            continue;
        }
        if !matches!(event.kind, FsEventKind::Create | FsEventKind::Rename) {
            continue;
        }
        if !should_track(&event.path, &self_writes, &in_flight) {
            continue;
        }

        let app = app.clone();
        let pool = pool.clone();
        let in_flight = in_flight.clone();
        let path = event.path.clone();
        let batch_tx = batch_tx.clone();

        tauri::async_runtime::spawn(async move {
            track_candidate(&app, &pool, &path, &batch_tx).await;
            in_flight.lock().unwrap().remove(&path);
        });
    }
}

/// Decides whether a Create/Rename event at `path` should start tracking a
/// brand-new candidate file. Pulled out of `run_event_loop` so the decision
/// itself — in particular, the self-write suppression that fixes the
/// "drag-to-group creates a phantom duplicate" bug — is unit-testable
/// without needing a real watcher or a Tauri `AppHandle`.
fn should_track(
    path: &Path,
    self_writes: &SelfWrites,
    in_flight: &Mutex<HashSet<PathBuf>>,
) -> bool {
    if download_detector::is_temp_extension(path) {
        return false;
    }
    // The app just wrote this path itself (organized into a group, renamed
    // in place, or restored by Undo) and that destination happens to sit
    // inside a watched folder — not a new download.
    if self_writes.consume(path) {
        return false;
    }
    in_flight.lock().unwrap().insert(path.to_path_buf())
}

/// Records `path` as `Detected`, then drives it through the stability check
/// until it's `Pending` (ready for the user) or terminally `Error`/`Missing`.
/// Runs as its own task per spec section 20.2 — one slow download must never
/// block others.
async fn track_candidate(
    app: &AppHandle,
    pool: &DbPool,
    path: &Path,
    batch_tx: &UnboundedSender<FileRecord>,
) {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let path_str = path.to_string_lossy().into_owned();
    let extension = path.extension().and_then(|e| e.to_str()).map(str::to_owned);

    let record = FileRecord {
        id: Uuid::new_v4(),
        original_name: file_name.to_string(),
        current_name: file_name.to_string(),
        original_path: path_str.clone(),
        current_path: path_str.clone(),
        extension,
        mime_type: None,
        size_bytes: None,
        status: FileStatus::Detected,
        detected_at: Utc::now(),
        ready_at: None,
        organized_at: None,
        last_seen_at: Utc::now(),
        expires_at: None,
        group_id: None,
        source_context_id: None,
        error_code: None,
        error_message: None,
    };

    if let Err(err) = storage::insert_file(pool, &record).await {
        tracing::error!(?err, path = %path.display(), "failed to record detected file");
        return;
    }

    let config = StabilityConfig::default();

    loop {
        match wait_until_ready(path, &config).await {
            Ok(ready) => {
                let size_bytes = ready.size_bytes as i64;
                if let Err(err) = storage::mark_ready_pending(
                    pool,
                    record.id,
                    file_name,
                    &path_str,
                    size_bytes,
                    ready.modified_at,
                )
                .await
                {
                    tracing::error!(?err, path = %path.display(), "failed to persist ready file");
                    return;
                }

                let mut ready_record = record;
                ready_record.status = FileStatus::Pending;
                ready_record.ready_at = Some(ready.modified_at);
                ready_record.size_bytes = Some(size_bytes);

                if let Err(err) = app.emit(EVENT_FILE_READY, &ready_record) {
                    tracing::error!(?err, "failed to emit file-ready event");
                }
                // The batch engine decides single-card vs batch-card timing
                // (spec section 9/22) — this task's job ends here.
                let _ = batch_tx.send(ready_record);
                return;
            }
            Err(DetectorError::Timeout) => {
                let _ = storage::mark_status(pool, record.id, FileStatus::PendingRetry, None, None)
                    .await;
                tokio::time::sleep(RETRY_INTERVAL).await;
                // loop for another (low-frequency) attempt
            }
            Err(DetectorError::SourceMissing) => {
                let _ =
                    storage::mark_status(pool, record.id, FileStatus::Missing, None, None).await;
                return;
            }
            Err(DetectorError::PermissionDenied) => {
                let _ = storage::mark_status(
                    pool,
                    record.id,
                    FileStatus::Error,
                    Some(AppErrorCode::PermissionDenied),
                    Some("permission denied while checking download stability"),
                )
                .await;
                return;
            }
        }
    }
}

/// A file the Inbox/Temporary panels were still tracking disappeared from a
/// watched folder. Files the app itself just moved/renamed/trashed also
/// produce a Remove event at their old path — those already updated their
/// own row's `current_path` (rename/organize) or `status` (recycle bin)
/// before this async handler runs, so this only actually marks `Missing`
/// when neither happened: a real external deletion the app didn't cause.
async fn handle_removed(app: &AppHandle, pool: &DbPool, path: &Path) {
    let path_str = path.to_string_lossy();
    let Ok(Some(file)) = storage::find_file_by_path(pool, &path_str).await else {
        return;
    };
    if matches!(
        file.status,
        FileStatus::Organized | FileStatus::Trashed | FileStatus::Missing
    ) {
        return;
    }

    if storage::mark_status(pool, file.id, FileStatus::Missing, None, None)
        .await
        .is_err()
    {
        return;
    }

    let mut missing = file;
    missing.status = FileStatus::Missing;
    let _ = app.emit(EVENT_FILE_MISSING, &missing);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reproduces the "drag file into a Group whose destination is a
    // watched folder" bug directly against the exact decision function
    // `run_event_loop` calls, without needing a real OS watcher or a
    // Tauri `AppHandle`.
    #[test]
    fn self_write_is_swallowed_but_only_once() {
        let self_writes = SelfWrites::new();
        let in_flight: Mutex<HashSet<PathBuf>> = Mutex::new(HashSet::new());
        let path = PathBuf::from(r"C:\watched\group\photo (1).png");

        // Nobody registered this path — a genuine new file (or, before the
        // fix, the app's own move landing back in a watched folder) is
        // tracked normally.
        assert!(
            should_track(&path, &self_writes, &in_flight),
            "an unregistered path must still be tracked as a new candidate"
        );

        // A fresh in_flight set (a new burst), now with the write
        // registered right before it happens — exactly what assign_group /
        // rename_file / undo_operation now do via `self_writes.expect`.
        let in_flight: Mutex<HashSet<PathBuf>> = Mutex::new(HashSet::new());
        self_writes.expect(path.clone());
        assert!(
            !should_track(&path, &self_writes, &in_flight),
            "a self-caused write must not be re-tracked as a phantom duplicate"
        );

        // The expectation is one-shot: a later, unrelated event at the same
        // path (a real external rewrite of that file) is tracked again.
        assert!(
            should_track(&path, &self_writes, &in_flight),
            "an expectation must not suppress events forever"
        );
    }

    #[test]
    fn in_flight_dedup_still_collapses_a_burst() {
        let self_writes = SelfWrites::new();
        let in_flight: Mutex<HashSet<PathBuf>> = Mutex::new(HashSet::new());
        let path = PathBuf::from(r"C:\watched\downloads\report.pdf");

        assert!(should_track(&path, &self_writes, &in_flight));
        // A burst of Create+Rename events for one in-progress download must
        // not spawn a second tracking task while the first is still live.
        assert!(!should_track(&path, &self_writes, &in_flight));
    }

    #[test]
    fn temp_extension_is_never_tracked() {
        let self_writes = SelfWrites::new();
        let in_flight: Mutex<HashSet<PathBuf>> = Mutex::new(HashSet::new());
        let path = PathBuf::from(r"C:\watched\downloads\movie.mp4.crdownload");

        assert!(!should_track(&path, &self_writes, &in_flight));
    }
}
