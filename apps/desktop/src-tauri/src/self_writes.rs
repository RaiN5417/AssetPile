//! Suppresses false "new download" detections caused by the app's own file
//! moves landing back inside a watched folder — e.g. a Group's destination
//! is the watched Downloads folder itself (or a path under it), or Undo
//! restores a file to its original spot there. Without this, the watcher's
//! Create/Rename event on the destination path reaches
//! `inbox::run_event_loop` and gets tracked as a brand-new, unarchived file
//! — the "phantom duplicate after drag-to-group" bug.
//!
//! `inbox::handle_removed` already avoids the equivalent problem on the
//! *source* side by checking the file's DB status before marking it
//! Missing; there's no DB row to check on the destination side (the row's
//! `current_path` *is* the new path by the time the event arrives), so this
//! tracks expected destination paths directly instead.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long an expectation stays alive before it's cleared automatically.
/// Generous relative to how quickly `notify` normally delivers events, but
/// short enough that a leaked entry (destination wasn't actually inside a
/// watched folder) can't shadow a genuine future download at that same path.
const EXPECTATION_TTL: Duration = Duration::from_secs(5);

pub struct SelfWrites(Mutex<HashSet<PathBuf>>);

impl SelfWrites {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(HashSet::new())))
    }

    /// Registers `path` as an app-initiated write, right before performing
    /// it. Call this on every move/rename destination that could plausibly
    /// land inside a watched folder — it's a harmless no-op otherwise.
    pub fn expect(self: &Arc<Self>, path: PathBuf) {
        self.0.lock().unwrap().insert(path.clone());
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(EXPECTATION_TTL).await;
            this.0.lock().unwrap().remove(&path);
        });
    }

    /// Consumes a pending expectation for `path`, if any — true means the
    /// caller should swallow the watcher event instead of tracking it.
    pub fn consume(&self, path: &Path) -> bool {
        self.0.lock().unwrap().remove(path)
    }
}
