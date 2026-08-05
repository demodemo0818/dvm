mod commands;
pub mod core;
pub mod db;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// 一覧・サイドバーなど読み取りだけのコマンド用。書き込みロックと競合させないため
    /// 別コネクションにしている(db.rs の open_read 参照)
    pub db_read: Mutex<rusqlite::Connection>,
    /// アプリ全体のもの(ライブラリの一覧と、切り替えても変わらない設定)を置く DB(v1.27)。
    /// **読み書きを分けない** —— 取り込みワーカーが触らないので書き込みは設定変更時の単発だけ
    pub app_db: Mutex<rusqlite::Connection>,
    /// アプリのデータフォルダ(%APPDATA%\jp.demo2.dvm)。ライブラリを切り替えても変わらない
    pub data_dir: PathBuf,
    /// いま開いているライブラリのフォルダ。この直下に library.db / thumbs / backups がある
    pub library_root: PathBuf,
    pub library_id: String,
    /// 開けなかったとき(未接続・消失・破損)の理由。フロントが復旧画面を出すのに使う
    pub library_status: crate::core::libraries::LibraryStatus,
    pub library_message: String,
    pub thumbs_dir: PathBuf,
    pub backups_dir: PathBuf,
    /// 再生用変換(remux/transcode)のキャッシュ置き場
    pub transcode_dir: PathBuf,
    /// コマの画像保存(v1.26)の**既定の**置き場所(ピクチャ\DVM)。
    /// 設定 `frame_save_dir` が空のときだけ使う。
    /// **他の 3 つと違い起動時に create_dir_all しない** —— 一度も撮っていない人の
    /// ピクチャに空フォルダを作らないため。作るのは保存の直前(`frames::prepare_dir`)
    pub frames_dir: PathBuf,
    pub ffmpeg: crate::core::ffmpeg::FfmpegPaths,
    pub scanning: AtomicBool,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub watch_tx: Mutex<Option<Sender<i64>>>,
    /// 進行中の再生用変換(同時 1 本)。アプリ終了時に必ず kill する
    pub transcode_job: Mutex<Option<crate::core::playback::TranscodeJob>>,
    /// prepare() 全体の直列化。同じ動画への同時変換(React StrictMode の
    /// 二重実行など)が同じ tmp ファイルに重ね書きして壊すのを防ぐ
    pub prepare_lock: Mutex<()>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .setup(|app| {
            use crate::core::libraries::{self, LibraryStatus};

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // ライブラリの一覧とアプリ全体設定。初回は v1.26 までのデータをここで引き継ぐ
            let app_db = libraries::open_app_db(&data_dir)?;
            let resolved = libraries::resolve_current(&app_db, &data_dir);
            let healthy = resolved.status == LibraryStatus::Ok;
            // 開けないときも AppState は必ず有効な Connection を持たせる(空の placeholder)。
            // Option にすると 60 以上ある既存コマンドが全部 unwrap 地獄になる
            let library_root = if healthy {
                resolved.root.clone()
            } else {
                eprintln!("ライブラリを開けません: {}", resolved.message);
                libraries::reset_placeholder(&data_dir)?
            };
            let library_id = resolved
                .entry
                .as_ref()
                .map(|e| e.id.clone())
                .unwrap_or_default();

            let thumbs_dir = library_root.join("thumbs");
            std::fs::create_dir_all(&thumbs_dir)?;
            let backups_dir = library_root.join("backups");
            std::fs::create_dir_all(&backups_dir)?;
            // 変換キャッシュだけはアプリのデータフォルダに残す(捨ててよい派生物なので
            // 遅い外付けに 20GB を書かない)。ただしファイル名が {video_id}.mp4 固定なので、
            // ライブラリ id でサブフォルダを切らないと id 衝突で別の動画が再生される
            let cache_key = if healthy {
                library_id.as_str()
            } else {
                libraries::PLACEHOLDER_CACHE_KEY
            };
            let transcode_dir = data_dir.join("transcode").join(cache_key);
            std::fs::create_dir_all(&transcode_dir)?;
            // ピクチャが取れなくても起動は続ける(データフォルダに逃がす)
            let frames_dir = crate::core::frames::default_dir(
                app.path().picture_dir().ok().as_deref(),
                &data_dir,
            );
            let db_path = library_root.join("library.db");
            // 復元の予約があればここで差し替える。**db::init より前**であることが重要
            // (まだ誰も DB を開いていないので、コネクションと競合しない)
            if let Some(src) = crate::core::backup::apply_pending_restore(&library_root) {
                eprintln!("バックアップから復元しました: {}", src.display());
            }
            let conn = db::init(&db_path)?;
            // マイグレーション後に開く(スキーマが揃った状態を読ませる)
            let conn_read = db::open_read(&db_path)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(conn_read),
                app_db: Mutex::new(app_db),
                data_dir,
                library_root,
                library_id,
                library_status: resolved.status,
                library_message: resolved.message,
                thumbs_dir,
                backups_dir,
                transcode_dir,
                frames_dir,
                ffmpeg: crate::core::ffmpeg::FfmpegPaths::resolve(),
                scanning: AtomicBool::new(false),
                watcher: Mutex::new(None),
                watch_tx: Mutex::new(None),
                transcode_job: Mutex::new(None),
                prepare_lock: Mutex::new(()),
            });

            // 外部プロセス(MCP 等)からの DB 変更を検知して UI に反映する。
            // PRAGMA data_version は「他コネクションのコミット」でのみ増えるため、
            // アプリ自身の書き込みには反応しない。
            // ここは必ず書き込み用の db を使うこと(db_read で見ると自プロセスの
            // 書き込みコネクションのコミットにも反応してしまい、常時 emit になる)
            let watcher_handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                let mut last: i64 = -1;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let state = watcher_handle.state::<AppState>();
                    let v: i64 = {
                        let conn = state.db.lock().unwrap();
                        conn.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap_or(-1)
                    };
                    if last >= 0 && v != last {
                        let _ = watcher_handle.emit("library:changed", ());
                    }
                    last = v;
                }
            });

            // ファイル監視を開始し、自動バックアップ → 起動時スキャンを回す(バックグラウンド)。
            // **placeholder では一切走らせない** —— 空の DB をバックアップして世代を埋めたり、
            // 復旧画面の裏で誤ってスキャンが動いたりしないように
            if healthy {
                crate::core::watcher::init(app.handle());
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    {
                        let state = handle.state::<AppState>();
                        let conn = state.db.lock().unwrap();
                        // スキャン前の DB 状態を保全するため、先にバックアップする
                        if let Err(e) =
                            crate::core::backup::auto_backup_if_due(&conn, &state.backups_dir)
                        {
                            eprintln!("auto backup failed: {e}");
                        }
                    }
                    // 前回の書きかけ .tmp.mp4 掃除 + キャッシュ上限の適用
                    crate::core::playback::purge_cache(&handle, None);
                    crate::core::library::run_scan_all(&handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::folders::list_watched_folders,
            commands::folders::list_folder_tree,
            commands::folders::list_subfolders,
            commands::folders::add_watched_folder,
            commands::folders::remove_watched_folder,
            commands::folders::rescan_all,
            commands::videos::query_videos,
            commands::videos::count_videos,
            commands::videos::video_labels,
            commands::videos::register_files,
            commands::videos::open_video,
            commands::videos::open_with_default,
            commands::videos::open_with_dialog,
            commands::videos::get_video,
            commands::videos::mark_viewed,
            commands::videos::mark_opened,
            commands::videos::finish_view,
            commands::videos::set_resume,
            commands::videos::set_rating,
            commands::videos::remove_videos,
            commands::videos::set_thumb_time,
            commands::videos::save_frame,
            commands::videos::get_media_info,
            commands::tags::list_tags,
            commands::tags::list_tag_groups,
            commands::tags::tag_videos,
            commands::tags::untag_videos,
            commands::tags::create_tag,
            commands::tags::rename_tag,
            commands::tags::delete_tag,
            commands::tags::set_tag_color,
            commands::tags::set_tag_group,
            commands::tags::create_tag_group,
            commands::tags::rename_tag_group,
            commands::tags::delete_tag_group,
            commands::tags::reorder_tag_groups,
            commands::tags::tags_for_videos,
            commands::tags::tag_counts_for_videos,
            commands::series::list_series,
            commands::series::add_to_series,
            commands::series::remove_from_series,
            commands::series::rename_series,
            commands::series::delete_series,
            commands::series::series_for_videos,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::fonts::list_system_fonts,
            commands::display::is_hdr_display,
            commands::smart_folders::list_smart_folders,
            commands::smart_folders::create_smart_folder,
            commands::smart_folders::update_smart_folder,
            commands::smart_folders::delete_smart_folder,
            commands::smart_folders::reorder_smart_folders,
            commands::stats::library_stats,
            commands::maintenance::backup_db,
            commands::maintenance::list_db_backups,
            commands::maintenance::open_backups_dir,
            commands::maintenance::open_data_dir,
            commands::maintenance::open_library_dir,
            commands::maintenance::open_frame_dir,
            commands::maintenance::get_app_info,
            commands::maintenance::regenerate_thumbnails,
            commands::maintenance::purge_orphan_thumbnails,
            commands::maintenance::restore_backup,
            commands::fileops::plan_relink,
            commands::fileops::apply_relink,
            commands::fileops::plan_move,
            commands::fileops::plan_rename,
            commands::fileops::apply_move,
            commands::fileops::classify_paths,
            commands::fileops::plan_trash,
            commands::fileops::apply_trash,
            commands::history::list_operations,
            commands::history::list_view_history,
            commands::history::undo_operation,
            commands::playback::prepare_video,
            commands::playback::cancel_prepare,
            commands::libraries::list_libraries,
            commands::libraries::get_library_state,
            commands::libraries::default_library_dir,
            commands::libraries::create_library,
            commands::libraries::add_existing_library,
            commands::libraries::rename_library,
            commands::libraries::forget_library,
            commands::libraries::switch_library,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // アプリ終了時に変換中の ffmpeg を残さない(書きかけ .tmp は次回起動時に掃除)
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                crate::core::playback::kill_current(&state);
            }
        });
}
