use crate::core::playback;
use crate::AppState;
use tauri::{AppHandle, State};

/// 動画を再生用 mp4 に変換する(完了までブロック)。キャッシュ mp4 の絶対パスを返す。
/// 進捗は transcode:progress イベントで通知される
#[tauri::command]
pub async fn prepare_video(app: AppHandle, id: i64, mode: String) -> Result<String, String> {
    if mode != "remux" && mode != "transcode" {
        return Err(format!("不正な mode です: {mode}"));
    }
    tauri::async_runtime::spawn_blocking(move || playback::prepare(&app, id, &mode))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// 進行中の変換を中止する(準備中にプレイヤーを閉じたとき)
#[tauri::command]
pub fn cancel_prepare(state: State<AppState>) -> Result<(), String> {
    playback::kill_current(&state);
    Ok(())
}
