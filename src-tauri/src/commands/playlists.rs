use crate::core::playlists::{self, Playlist};
use crate::core::query::{self, VideoRow};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn list_playlists(state: State<AppState>) -> Result<Vec<Playlist>, String> {
    let conn = state.db_read.lock().unwrap();
    playlists::list(&conn).map_err(|e| e.to_string())
}

/// リストの中身を一覧と同じ行の形で、保存した並び順のまま返す(キューへの読み込み)
#[tauri::command]
pub fn get_playlist_videos(state: State<AppState>, id: i64) -> Result<Vec<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    let ids = playlists::entries(&conn, id).map_err(|e| e.to_string())?;
    query::videos_by_ids(&conn, Some(&state.thumbs_dir), &ids).map_err(|e| e.to_string())
}

/// キューの引き直し(v1.40)。`library:changed` のたびにフロントが呼ぶ。
/// 消えた動画は結果から落ちるので、フロントはこれで置き換えるだけでよい
#[tauri::command]
pub fn get_videos_by_ids(state: State<AppState>, ids: Vec<i64>) -> Result<Vec<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    query::videos_by_ids(&conn, Some(&state.thumbs_dir), &ids).map_err(|e| e.to_string())
}

/// 名前が使われているかを先に尋ねる(UI が「上書きしますか?」を出すため)
#[tauri::command]
pub fn find_playlist_by_name(state: State<AppState>, name: String) -> Result<Option<i64>, String> {
    let conn = state.db_read.lock().unwrap();
    playlists::find_by_name(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(
    state: State<AppState>,
    name: String,
    video_ids: Vec<i64>,
    actor: Option<String>,
) -> Result<i64, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    playlists::create(&conn, &actor, &name, &video_ids).map_err(|e| e.to_string())
}

/// 中身を丸ごと差し替える(上書き保存)
#[tauri::command]
pub fn replace_playlist(
    state: State<AppState>,
    id: i64,
    video_ids: Vec<i64>,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    playlists::replace(&conn, &actor, id, &video_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_playlist(state: State<AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::rename(&conn, "user", id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn duplicate_playlist(state: State<AppState>, id: i64) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    playlists::duplicate(&conn, "user", id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_playlist(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::delete(&conn, "user", id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlists(state: State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::reorder(&conn, &ids).map_err(|e| e.to_string())
}
