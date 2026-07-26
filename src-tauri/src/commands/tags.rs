use crate::core::tags::{self, Tag};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::list_tags(&conn).map_err(|e| e.to_string())
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
pub fn tags_for_videos(state: State<AppState>, video_ids: Vec<i64>) -> Result<Vec<Tag>, String> {
    let conn = state.db_read.lock().unwrap();
    tags::tags_for_videos(&conn, &video_ids).map_err(|e| e.to_string())
}
