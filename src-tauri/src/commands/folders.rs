use crate::core::{self, library, offline};
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

/// サイドバー「フォルダー」タブ用のツリー。ディスクは走査せず DB のパスから組み立てる
#[tauri::command]
pub fn list_folder_tree(state: State<AppState>) -> Result<Vec<core::folders::FolderNode>, String> {
    let conn = state.db_read.lock().unwrap();
    core::folders::folder_tree(&conn).map_err(|e| e.to_string())
}

/// メインビューに出すサブフォルダ(フォルダカード)。ツリー全体は組み直さない
#[tauri::command]
pub fn list_subfolders(
    state: State<AppState>,
    dir_path: String,
) -> Result<core::folders::SubfolderView, String> {
    let conn = state.db_read.lock().unwrap();
    core::folders::subfolders(&conn, &dir_path).map_err(|e| e.to_string())
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
    // 動画ごと消すときは、消える id を先に控えておく(キャッシュ掃除に使う)
    let removed_ids: Vec<i64> = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let mut removed = Vec::new();
        if remove_videos {
            let mut stmt = conn
                .prepare("SELECT id FROM videos WHERE watched_folder_id=?1")
                .map_err(|e| e.to_string())?;
            removed = stmt
                .query_map(params![id], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
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
        removed
    };
    // サムネイル・変換キャッシュの孤児を残さない(remove_videos コマンドと同じ後始末)。
    // ファイル I/O なので DB のロックを手放してから行う
    {
        let state = app.state::<AppState>();
        for vid in &removed_ids {
            let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{vid}.jpg")));
            crate::core::playback::remove_cache_for(&state.transcode_dir, *vid);
        }
    }
    crate::core::watcher::rebuild(&app);
    Ok(())
}

/// 監視除外フォルダの一覧(フォルダのほか、ファイル 1 個の登録も混ざる)
#[tauri::command]
pub fn list_excluded_paths(
    state: State<AppState>,
) -> Result<Vec<core::excludes::ExcludedPath>, String> {
    let conn = state.db_read.lock().unwrap();
    core::excludes::list(&conn).map_err(|e| e.to_string())
}

/// 監視除外に登録する(フォルダでもファイルでもよい)。
/// `remove_videos` が true なら、該当する登録も外す(ファイルは消さない)。外した件数を返す。
/// 削除ダイアログからは「先に除外へ入れてから消す」ので false で呼ばれる
#[tauri::command]
pub fn add_excluded_paths(
    app: AppHandle,
    paths: Vec<String>,
    remove_videos: bool,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let removed = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        for path in &paths {
            if let Err(e) = core::excludes::add(&conn, path) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.to_string());
            }
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

        let ids = if remove_videos {
            core::excludes::video_ids_under_any(&conn, &paths).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if !ids.is_empty() {
            core::videos::remove_videos(&conn, "user", &ids).map_err(|e| e.to_string())?;
        }
        db::log_op(
            &conn,
            "user",
            "add_excluded_paths",
            &format!("{} 件 (removed={}): {}", paths.len(), ids.len(), paths.join(", ")),
        );
        for id in &ids {
            let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{id}.jpg")));
            core::playback::remove_cache_for(&state.transcode_dir, *id);
        }
        ids.len()
    };
    // 除外が増えた分、監視の対象も狭める
    crate::core::watcher::rebuild(&app);
    Ok(removed)
}

/// 監視除外を解除する。該当するファイルは次のスキャンで取り込まれる
#[tauri::command]
pub fn remove_excluded_path(app: AppHandle, id: i64) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        core::excludes::remove(&conn, id).map_err(|e| e.to_string())?;
        db::log_op(&conn, "user", "remove_excluded_path", &format!("id={id}"));
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
