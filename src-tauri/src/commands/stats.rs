use crate::core::stats::{self, LibraryStats};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn library_stats(state: State<AppState>) -> Result<LibraryStats, String> {
    let conn = state.db_read.lock().unwrap();
    stats::library_stats(&conn).map_err(|e| e.to_string())
}
