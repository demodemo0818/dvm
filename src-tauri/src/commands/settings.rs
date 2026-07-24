use crate::core::settings;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.db.lock().unwrap();
    settings::get(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    settings::set(&conn, &key, &value).map_err(|e| e.to_string())
}
