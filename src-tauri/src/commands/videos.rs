use crate::core::library;
use crate::core::offline::RootCache;
use crate::core::query::VideoQuery;
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRow {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub title: Option<String>,
    pub size: i64,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub rating: i64,
    pub view_count: i64,
    pub last_viewed_at: Option<String>,
    pub is_missing: bool,
    pub is_offline: bool,
    pub thumb_state: i64,
    pub thumb_path: Option<String>,
    pub added_at: String,
}

#[tauri::command]
pub fn count_videos(state: State<AppState>, query: VideoQuery) -> Result<i64, String> {
    let (where_sql, like) = query.where_clause();
    let sql = format!("SELECT COUNT(*) FROM videos {where_sql}");
    let conn = state.db.lock().unwrap();
    let count = match &like {
        Some(l) => conn.query_row(&sql, params![l], |r| r.get(0)),
        None => conn.query_row(&sql, [], |r| r.get(0)),
    }
    .map_err(|e| e.to_string())?;
    Ok(count)
}

type RawRow = (
    i64,            // id
    String,         // path
    String,         // filename
    Option<String>, // title
    i64,            // size
    Option<i64>,    // duration_ms
    Option<i64>,    // width
    Option<i64>,    // height
    i64,            // rating
    i64,            // view_count
    Option<String>, // last_viewed_at
    i64,            // is_missing
    i64,            // thumb_state
    String,         // added_at
);

#[tauri::command]
pub fn query_videos(
    state: State<AppState>,
    query: VideoQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoRow>, String> {
    let (where_sql, like) = query.where_clause();
    let order = query.order_clause();
    let limit = limit.clamp(1, 1000);
    let offset = offset.max(0);
    let sql = format!(
        "SELECT id, path, filename, title, size, duration_ms, width, height, rating,
                view_count, last_viewed_at, is_missing, thumb_state, added_at
         FROM videos {where_sql} {order} LIMIT {limit} OFFSET {offset}"
    );

    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    fn map_row(r: &rusqlite::Row) -> rusqlite::Result<RawRow> {
        Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
            r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?,
        ))
    }

    let raw: Vec<RawRow> = match &like {
        Some(l) => stmt.query_map(params![l], map_row),
        None => stmt.query_map([], map_row),
    }
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    let mut roots = RootCache::default();
    let rows = raw
        .into_iter()
        .map(|(id, path, filename, title, size, duration_ms, width, height, rating, view_count, last_viewed_at, is_missing, thumb_state, added_at)| {
            let thumb = state.thumbs_dir.join(format!("{id}.jpg"));
            VideoRow {
                is_offline: !roots.is_online(&path),
                thumb_path: if thumb_state == 1 && thumb.exists() {
                    Some(thumb.to_string_lossy().to_string())
                } else {
                    None
                },
                id, path, filename, title, size, duration_ms, width, height, rating,
                view_count, last_viewed_at,
                is_missing: is_missing != 0,
                thumb_state,
                added_at,
            }
        })
        .collect();
    Ok(rows)
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
