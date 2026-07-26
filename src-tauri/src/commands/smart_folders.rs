use crate::core::smart_folders::{self, SmartFolder};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn list_smart_folders(state: State<AppState>) -> Result<Vec<SmartFolder>, String> {
    let conn = state.db_read.lock().unwrap();
    smart_folders::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_smart_folder(
    state: State<AppState>,
    name: String,
    query_json: String,
    actor: Option<String>,
) -> Result<i64, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    smart_folders::create(&conn, &actor, &name, &query_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_smart_folder(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    query_json: Option<String>,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    smart_folders::update(&conn, &actor, id, name.as_deref(), query_json.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_smart_folder(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    smart_folders::delete(&conn, "user", id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_smart_folders(state: State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    smart_folders::reorder(&conn, &ids).map_err(|e| e.to_string())
}
