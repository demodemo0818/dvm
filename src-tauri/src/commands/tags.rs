use crate::core::tags::{self, Tag, TagCount, TagGroup};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::list_tags(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tag_groups(state: State<AppState>) -> Result<Vec<TagGroup>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::list_tag_groups(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tag_videos(
    state: State<AppState>,
    video_ids: Vec<i64>,
    name: String,
    actor: Option<String>,
) -> Result<i64, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    tags::tag_videos(&conn, &actor, &video_ids, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn untag_videos(
    state: State<AppState>,
    video_ids: Vec<i64>,
    tag_id: i64,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    tags::untag_videos(&conn, &actor, &video_ids, tag_id).map_err(|e| e.to_string())
}

/// 動画に付けずにタグだけ作る(サイドバーの「＋ タグ」)。
/// グループの編集は人間の担当なので actor は 'user' 固定にしてある
#[tauri::command]
pub fn create_tag(
    state: State<AppState>,
    name: String,
    group_id: Option<i64>,
) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    tags::create_tag(&conn, "user", &name, group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_tag(state: State<AppState>, tag_id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::rename_tag(&conn, "user", tag_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, tag_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::delete_tag(&conn, "user", tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_tag_color(
    state: State<AppState>,
    tag_id: i64,
    color: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::set_tag_color(&conn, "user", tag_id, color.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_tag_group(
    state: State<AppState>,
    tag_id: i64,
    group_id: Option<i64>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::set_tag_group(&conn, "user", tag_id, group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_tag_group(state: State<AppState>, name: String) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    tags::create_tag_group(&conn, "user", &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_tag_group(state: State<AppState>, group_id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::rename_tag_group(&conn, "user", group_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tag_group(state: State<AppState>, group_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::delete_tag_group(&conn, "user", group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_tag_groups(state: State<AppState>, group_ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    tags::reorder_tag_groups(&conn, &group_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tags_for_videos(state: State<AppState>, video_ids: Vec<i64>) -> Result<Vec<Tag>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::tags_for_videos(&conn, &video_ids).map_err(|e| e.to_string())
}

/// タグパレットの 3 状態(全部 / 一部 / なし)用。タグ名は list_tags 側が持っているので
/// ここでは id と件数だけ返す
#[tauri::command]
pub fn tag_counts_for_videos(
    state: State<AppState>,
    video_ids: Vec<i64>,
) -> Result<Vec<TagCount>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::tag_counts_for_videos(&conn, &video_ids).map_err(|e| e.to_string())
}
