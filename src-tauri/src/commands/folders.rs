use crate::core::{library, offline};
use crate::db;
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub recursive: bool,
    pub enabled: bool,
    pub online: bool,
    pub video_count: i64,
}

#[tauri::command]
pub fn list_watched_folders(state: State<AppState>) -> Result<Vec<WatchedFolder>, String> {
    let conn = state.db_read.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.path, f.recursive, f.enabled,
                    (SELECT COUNT(*) FROM videos v WHERE v.watched_folder_id = f.id) AS cnt
             FROM watched_folders f ORDER BY f.path",
        )
        .map_err(|e| e.to_string())?;
    let mut roots = offline::RootCache::default();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|(id, path, recursive, enabled, cnt)| WatchedFolder {
            online: roots.is_online(&path),
            id,
            path,
            recursive: recursive != 0,
            enabled: enabled != 0,
            video_count: cnt,
        })
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn add_watched_folder(app: AppHandle, path: String, recursive: Option<bool>) -> Result<i64, String> {
    let id = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let serial = crate::core::volumes::volume_serial(&offline::root_of(&path));
        conn.execute(
            "INSERT OR IGNORE INTO watched_folders (path, recursive, volume_serial) VALUES (?1, ?2, ?3)",
            params![path, recursive.unwrap_or(true) as i64, serial],
        )
        .map_err(|e| e.to_string())?;
        let id: i64 = conn
            .query_row("SELECT id FROM watched_folders WHERE path=?1", params![path], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        db::log_op(&conn, "user", "add_watched_folder", &path);
        id
    };
    crate::core::watcher::rebuild(&app);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || library::run_scan_folder(&app2, id));
    Ok(id)
}

#[tauri::command]
pub fn remove_watched_folder(app: AppHandle, id: i64, remove_videos: bool) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        if remove_videos {
            conn.execute("DELETE FROM videos WHERE watched_folder_id=?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM watched_folders WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        db::log_op(
            &conn,
            "user",
            "remove_watched_folder",
            &format!("id={id}, remove_videos={remove_videos}"),
        );
    }
    crate::core::watcher::rebuild(&app);
    Ok(())
}

#[tauri::command]
pub async fn rescan_all(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || library::run_scan_all(&app2));
    Ok(())
}
