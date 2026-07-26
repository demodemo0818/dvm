use crate::core::backup::{self, BackupInfo};
use crate::core::{library, offline, thumbs};
use crate::db;
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub removed: usize,
    pub freed_bytes: u64,
}

/// videos に対応しない孤児サムネイルを掃除する
#[tauri::command]
pub fn purge_orphan_thumbnails(state: State<AppState>) -> Result<PurgeResult, String> {
    let conn = state.db.lock().unwrap();
    let (removed, freed_bytes) =
        thumbs::purge_orphans(&conn, &state.thumbs_dir).map_err(|e| e.to_string())?;
    if removed > 0 {
        db::log_op(&conn, "user", "purge_orphan_thumbnails", &format!("removed={removed}"));
    }
    Ok(PurgeResult { removed, freed_bytes })
}

#[tauri::command]
pub fn backup_db(state: State<AppState>) -> Result<BackupInfo, String> {
    let conn = state.db.lock().unwrap();
    let dest = backup::backup_now(&conn, &state.backups_dir, "manual").map_err(|e| e.to_string())?;
    db::log_op(&conn, "user", "backup_db", &dest.to_string_lossy());
    backup::list_backups(&state.backups_dir)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|b| b.path == dest.to_string_lossy())
        .ok_or_else(|| "バックアップファイルが見つかりません".to_string())
}

#[tauri::command]
pub fn list_db_backups(state: State<AppState>) -> Result<Vec<BackupInfo>, String> {
    backup::list_backups(&state.backups_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_backups_dir(state: State<AppState>) -> Result<(), String> {
    std::fs::create_dir_all(&state.backups_dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&state.backups_dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    tauri_plugin_opener::open_path(&state.data_dir, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub data_dir: String,
    pub db_path: String,
    pub db_size: i64,
    pub thumbs_dir: String,
    pub thumb_count: i64,
    pub thumb_cache_size: i64,
    pub backups_dir: String,
}

#[tauri::command]
pub fn get_app_info(state: State<AppState>) -> Result<AppInfo, String> {
    let db_path = state.data_dir.join("library.db");
    // WAL モードなので -wal も込みで実サイズを見せる
    let db_size = [db_path.clone(), state.data_dir.join("library.db-wal")]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len() as i64)
        .sum();

    let (thumb_count, thumb_cache_size) = std::fs::read_dir(&state.thumbs_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jpg"))
                .filter_map(|e| e.metadata().ok())
                .fold((0i64, 0i64), |(n, total), m| (n + 1, total + m.len() as i64))
        })
        .unwrap_or((0, 0));

    Ok(AppInfo {
        data_dir: state.data_dir.to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        db_size,
        thumbs_dir: state.thumbs_dir.to_string_lossy().to_string(),
        thumb_count,
        thumb_cache_size,
        backups_dir: state.backups_dir.to_string_lossy().to_string(),
    })
}

/// サムネイル再生成。only_failed=true なら生成失敗分のみ、false なら全件。
/// 対象は missing でなくルートがオンラインの動画に限る。進捗は既存の scan:state イベントで通知される
#[tauri::command]
pub async fn regenerate_thumbnails(app: AppHandle, only_failed: bool) -> Result<usize, String> {
    let ids: Vec<i64> = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let sql = if only_failed {
            "SELECT id, path FROM videos WHERE is_missing = 0 AND thumb_state = 2"
        } else {
            "SELECT id, path FROM videos WHERE is_missing = 0"
        };
        let rows: Vec<(i64, String)> = conn
            .prepare(sql)
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map(|it| it.filter_map(|r| r.ok()).collect())
            })
            .map_err(|e| e.to_string())?;
        let mut roots = offline::RootCache::default();
        let ids: Vec<i64> = rows
            .into_iter()
            .filter(|(_, path)| roots.is_online(path))
            .map(|(id, _)| id)
            .collect();

        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        for id in &ids {
            conn.execute(
                "UPDATE videos SET thumb_state = 0 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        db::log_op(
            &conn,
            "user",
            "regenerate_thumbnails",
            &format!("only_failed={only_failed}, count={}", ids.len()),
        );
        ids
    };
    let count = ids.len();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || library::process_pending(&app2, ids));
    Ok(count)
}
