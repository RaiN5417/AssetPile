use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::commands;

/// Whether the close button hides the main window (spec section 28's
/// default) instead of quitting. Toggled from the Settings page.
const SETTING_MINIMIZE_ON_CLOSE: &str = "minimizeOnClose";
/// Whether the main window starts hidden (tray-only) instead of shown.
const SETTING_SILENT_START: &str = "silentStart";

/// Reads a boolean setting, falling back to `default` if it's unset,
/// unreadable, or not valid JSON — Settings is best-effort, never a reason
/// to fail startup or a window-close.
fn setting_bool(pool: &storage::DbPool, key: &str, default: bool) -> bool {
    tauri::async_runtime::block_on(storage::get_setting(pool, key))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
        .unwrap_or(default)
}

/// Builds the Tauri app: DB init, crash reconciliation, downloads watcher
/// startup, Floating Card window, system tray, and hide-to-tray on close.
pub fn build() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::mark_later,
            commands::inbox::list_inbox,
            commands::inbox::list_operations,
            commands::groups::create_group,
            commands::groups::list_groups,
            commands::groups::list_group_files,
            commands::groups::delete_group,
            commands::groups::assign_group,
            commands::groups::scan_group_folder,
            commands::groups::import_group_files,
            commands::groups::check_group_destination,
            commands::groups::update_group_destination,
            commands::operations::undo_operation,
            commands::temporary::mark_temporary,
            commands::temporary::list_temporary,
            commands::temporary::move_to_recycle_bin,
            commands::files::rename_file,
            commands::tags::list_tags,
            commands::tags::list_all_file_tags,
            commands::tags::create_tag,
            commands::tags::add_tag_to_file,
            commands::tags::remove_tag_from_file,
            commands::tags::delete_tag,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::thumbnails::get_thumbnail,
            commands::folders::list_watched_folders,
            commands::folders::add_watched_folder,
            commands::folders::remove_watched_folder,
        ])
        .setup(|app| {
            tracing_subscriber::fmt::init();

            let data_dir = match portable_data_dir()? {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("assetpile.sqlite");

            let pool = match tauri::async_runtime::block_on(storage::init_db(&db_path)) {
                Ok(pool) => pool,
                Err(err) => {
                    tracing::error!(?err, "failed to open database");
                    let detail = if matches!(err, storage::StorageError::Migrate(_)) {
                        "本地数据库是由更新版本的 AssetPile｜材栈 创建的,与当前安装的版本不兼容。\n请安装最新版本后重试。"
                    } else {
                        "无法打开本地数据库,请重启程序;如果问题持续出现,请重新安装。"
                    };
                    app.dialog()
                        .message(format!("{detail}\n\n{err}"))
                        .title("AssetPile｜材栈 无法启动")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
            };

            // Spec section 40's startup order: migrations, then reconcile
            // any operation a previous crash left half-finished, *then*
            // start watching for new ones.
            tauri::async_runtime::block_on(crate::reconciliation::run(&pool));

            let watcher_pool = pool.clone();
            let sweep_pool = pool.clone();
            let settings_pool = pool.clone();
            app.manage(pool);

            tauri::async_runtime::spawn(crate::temporary::run(app.handle().clone(), sweep_pool));

            // Watcher failure must not take the rest of the app down with it
            // (spec section 40) — the user can still use groups/history/undo
            // even if e.g. the configured folder is missing or unwatchable.
            let watched_dirs = tauri::async_runtime::block_on(
                commands::folders::load_watched_folders(&watcher_pool),
            )
            .unwrap_or_default();
            let watched_dirs = if watched_dirs.is_empty() {
                // First run (or the user cleared the list): fall back to the
                // OS Downloads folder, same as before this was configurable,
                // and persist that as the starting point for the Settings page.
                let downloads_dir = app.path().download_dir()?;
                let seeded = vec![downloads_dir];
                if let Err(err) = tauri::async_runtime::block_on(
                    commands::folders::save_watched_folders(&watcher_pool, &seeded),
                ) {
                    tracing::warn!(?err, "failed to persist default watched folder");
                }
                seeded
            } else {
                watched_dirs
            };
            for dir in &watched_dirs {
                if let Err(err) = std::fs::create_dir_all(dir) {
                    tracing::warn!(?err, dir = %dir.display(), "could not ensure watched directory exists");
                }
            }
            let self_writes = crate::self_writes::SelfWrites::new();
            app.manage(self_writes.clone());
            match crate::inbox::start(app.handle().clone(), watcher_pool, watched_dirs, self_writes) {
                Ok(watcher_handle) => {
                    app.manage(Mutex::new(watcher_handle));
                }
                Err(err) => {
                    tracing::error!(?err, "failed to start folder watcher; continuing without it");
                }
            }

            crate::floating_card::init(app.handle())?;

            let open_item =
                MenuItem::with_id(app, "open", "Open AssetPile", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            // The returned TrayIcon must be kept alive for as long as the app runs —
            // dropping it (e.g. not binding `.build(app)?`) tears down its menu/click
            // wiring immediately, so it's stashed in managed state rather than discarded.
            let tray_icon = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.manage(tray_icon);

            if let Some(window) = app.get_webview_window("main") {
                // The window is created hidden (tauri.conf.json) so "silent start"
                // can skip showing it at all rather than flashing it open and
                // immediately hiding it.
                if !setting_bool(&settings_pool, SETTING_SILENT_START, false) {
                    let _ = window.show();
                }

                let window_handle = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // Spec section 28's default: closing the main window hides it
                        // and keeps the core running, only the tray's Quit really exits.
                        // With the setting off, the close button quits like a normal app.
                        if setting_bool(&settings_pool, SETTING_MINIMIZE_ON_CLOSE, true) {
                            api.prevent_close();
                            let _ = window_handle.hide();
                        } else {
                            app_handle.exit(0);
                        }
                    }
                });
            }

            Ok(())
        })
}

/// The portable build's release step stages a sibling `data/` folder next to
/// the executable (see `.github/workflows/release.yml`). Its presence means
/// this is the portable build, so state is kept next to the exe instead of
/// the OS-wide app data directory — the whole thing can then be moved or
/// deleted without leaving traces on the system, unlike the installed build.
fn portable_data_dir() -> std::io::Result<Option<std::path::PathBuf>> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().map(|parent| parent.join("data"));
    Ok(dir.filter(|dir| dir.is_dir()))
}
