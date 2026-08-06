use crate::core::history::{self, OpEntry, ViewEntry, ViewRange, ViewStats};
use crate::AppState;
use tauri::State;

/// 視聴履歴(v1.18。期間指定は v1.36)。操作履歴と同じモーダルの別タブに出す
#[tauri::command]
pub fn list_view_history(
    state: State<AppState>,
    range: ViewRange,
    limit: i64,
    offset: i64,
) -> Result<Vec<ViewEntry>, String> {
    let conn = state.db_read.lock().unwrap();
    history::list_view_history(&conn, Some(&state.thumbs_dir), &range, limit, offset)
        .map_err(|e| e.to_string())
}

/// 期間の集計(v1.36)。一覧と同じ条件で数えるので、画面の数字と並ぶ行が食い違わない
#[tauri::command]
pub fn view_stats(state: State<AppState>, range: ViewRange) -> Result<ViewStats, String> {
    let conn = state.db_read.lock().unwrap();
    history::view_stats(&conn, &range).map_err(|e| e.to_string())
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
