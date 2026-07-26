use crate::core::series::{self, Series};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn list_series(state: State<AppState>) -> Result<Vec<Series>, String> {
    let conn = state.db.lock().unwrap();
    series::list_series(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_to_series(
    state: State<AppState>,
    video_ids: Vec<i64>,
    name: String,
    actor: Option<String>,
) -> Result<i64, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    series::add_videos_to_series(&conn, &actor, &video_ids, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_from_series(
    state: State<AppState>,
    video_ids: Vec<i64>,
    series_id: i64,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    series::remove_videos_from_series(&conn, &actor, &video_ids, series_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_series(state: State<AppState>, series_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    series::delete_series(&conn, "user", series_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn series_for_videos(state: State<AppState>, video_ids: Vec<i64>) -> Result<Vec<Series>, String> {
    let conn = state.db.lock().unwrap();
    series::series_for_videos(&conn, &video_ids).map_err(|e| e.to_string())
}
