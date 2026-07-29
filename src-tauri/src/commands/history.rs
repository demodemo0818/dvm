use crate::core::history::{self, OpEntry, ViewEntry};
use crate::AppState;
use tauri::State;

/// 視聴履歴(v1.18)。操作履歴と同じモーダルの別タブに出す
#[tauri::command]
pub fn list_view_history(
    state: State<AppState>,
    limit: i64,
    offset: i64,
) -> Result<Vec<ViewEntry>, String> {
    let conn = state.db_read.lock().unwrap();
    history::list_view_history(&conn, Some(&state.thumbs_dir), limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_operations(
    state: State<AppState>,
    limit: i64,
    offset: i64,
) -> Result<Vec<OpEntry>, String> {
    let conn = state.db_read.lock().unwrap();
    history::list_ops(&conn, limit, offset).map_err(|e| e.to_string())
}

/// 履歴 1 件を取り消す。可逆なメタデータ操作だけが対象(core 側で検証する)
#[tauri::command]
pub fn undo_operation(state: State<AppState>, op_id: i64) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    history::undo_op(&conn, op_id).map_err(|e| e.to_string())
}
