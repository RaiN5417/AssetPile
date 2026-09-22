mod app;
mod commands;
mod floating_card;
mod inbox;
mod reconciliation;
mod self_writes;
mod tag_mirror;
mod temporary;

pub fn run() {
    app::build()
        .run(tauri::generate_context!())
        .expect("error while running AssetPile");
}
