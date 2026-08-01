use crate::core::fonts;

/// 字幕設定のフォント候補(v1.24)。
/// DB も AppState も触らないので引数なし。失敗しても空配列(UI は手入力できる)
#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    fonts::list_families()
}
