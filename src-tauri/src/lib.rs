mod commands;
mod core;
mod db;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub thumbs_dir: PathBuf,
    pub ffmpeg: crate::core::ffmpeg::FfmpegPaths,
    pub scanning: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let thumbs_dir = data_dir.join("thumbs");
            std::fs::create_dir_all(&thumbs_dir)?;
            let conn = db::init(&data_dir.join("library.db"))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                thumbs_dir,
                ffmpeg: crate::core::ffmpeg::FfmpegPaths::resolve(),
                scanning: AtomicBool::new(false),
            });

            // 起動時に自動スキャン(バックグラウンド)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || crate::core::library::run_scan_all(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::folders::list_watched_folders,
            commands::folders::add_watched_folder,
            commands::folders::remove_watched_folder,
            commands::folders::rescan_all,
            commands::videos::query_videos,
            commands::videos::count_videos,
            commands::videos::register_files,
            commands::videos::open_video,
            commands::tags::list_tags,
            commands::tags::tag_videos,
            commands::tags::untag_videos,
            commands::tags::rename_tag,
            commands::tags::delete_tag,
            commands::tags::tags_for_videos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
