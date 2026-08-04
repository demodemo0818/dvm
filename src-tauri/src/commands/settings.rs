use crate::core::settings;
use crate::AppState;
use tauri::State;

/// このコマンドが読み書きするのは**アプリ全体の設定**(app.db。v1.27)。
///
/// ライブラリを切り替えても見た目や API キーが変わらないようにするため、
/// コマンド経由の設定はすべて app.db に置く。ライブラリごとの記録
/// (`last_auto_backup_at`)は `core/backup.rs` がライブラリの conn を直接受け取る形なので、
/// **ここでキーを振り分ける必要はない**(分類ミスの余地が構造的に無い)
#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.app_db.lock().unwrap();
    settings::get(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.app_db.lock().unwrap();
    settings::set(&conn, &key, &value).map_err(|e| e.to_string())
}
