use crate::core::library;
use crate::core::query::{self, VideoQuery, VideoRow};
use crate::AppState;
use rusqlite::params;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn count_videos(state: State<AppState>, query: VideoQuery) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    query::count(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_videos(
    state: State<AppState>,
    query: VideoQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoRow>, String> {
    let conn = state.db.lock().unwrap();
    query::query_rows(&conn, Some(&state.thumbs_dir), &query, limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_rating(state: State<AppState>, video_ids: Vec<i64>, rating: i64) -> Result<(), String> {
    let rating = rating.clamp(0, 5);
    let ids_csv = video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let conn = state.db.lock().unwrap();
    conn.execute(&format!("UPDATE videos SET rating = {rating} WHERE id IN ({ids_csv})"), [])
        .map_err(|e| e.to_string())?;
    crate::db::log_op(&conn, "user", "set_rating", &format!("rating={rating} videos={video_ids:?}"));
    Ok(())
}

/// ライブラリから登録を削除する(ファイル自体は消さない)。サムネイルキャッシュも掃除する
#[tauri::command]
pub fn remove_videos(state: State<AppState>, video_ids: Vec<i64>) -> Result<(), String> {
    let ids_csv = video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let conn = state.db.lock().unwrap();
    conn.execute(&format!("DELETE FROM videos WHERE id IN ({ids_csv})"), [])
        .map_err(|e| e.to_string())?;
    crate::db::log_op(&conn, "user", "remove_videos", &format!("videos={video_ids:?}"));
    drop(conn);
    for id in &video_ids {
        let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{id}.jpg")));
    }
    Ok(())
}

#[tauri::command]
pub async fn register_files(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || library::register_paths(&app, paths))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_video(state: State<AppState>, id: i64) -> Result<(), String> {
    let (path, player) = {
        let conn = state.db.lock().unwrap();
        let p: String = conn
            .query_row("SELECT path FROM videos WHERE id=?1", params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "UPDATE videos SET view_count=view_count+1, last_viewed_at=datetime('now','localtime') WHERE id=?1",
            params![id],
        );
        let player = crate::core::settings::get(&conn, "player_path").unwrap_or(None);
        (p, player)
    };

    match player.filter(|p| !p.trim().is_empty()) {
        Some(player) => {
            std::process::Command::new(&player)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("プレイヤーを起動できません ({player}): {e}"))?;
        }
        None => {
            tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
