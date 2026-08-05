use crate::core::libraries::{self, LibraryEntry, LibraryStatus};
use crate::core::playback;
use crate::db;
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
// save_window_state(ライブラリ切り替えの再起動でウィンドウ位置を失わないため)
use tauri_plugin_window_state::AppHandleExt;

/// 起動時にライブラリを開けたかどうか。ok 以外ならフロントが復旧画面を出す
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    pub status: LibraryStatus,
    pub message: String,
    /// 開こうとしたライブラリ(status = none のときだけ null)
    pub current: Option<LibraryEntry>,
}

#[tauri::command]
pub fn list_libraries(state: State<AppState>) -> Result<Vec<LibraryEntry>, String> {
    let conn = state.app_db.lock().unwrap();
    libraries::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_library_state(state: State<AppState>) -> Result<LibraryState, String> {
    let current = {
        let conn = state.app_db.lock().unwrap();
        libraries::get(&conn, &state.library_id).ok().flatten()
    };
    Ok(LibraryState {
        status: state.library_status,
        message: state.library_message.clone(),
        current,
    })
}

/// 新規作成の既定の置き場。フォルダ選択ダイアログの初期位置に使う
#[tauri::command]
pub fn default_library_dir(state: State<AppState>) -> String {
    state
        .data_dir
        .join(libraries::LIBRARIES_DIR)
        .to_string_lossy()
        .to_string()
}

/// 空のライブラリを作る。`parent_dir` を省くと既定の置き場に作る
#[tauri::command]
pub fn create_library(
    state: State<AppState>,
    name: String,
    parent_dir: Option<String>,
) -> Result<LibraryEntry, String> {
    let parent = match parent_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => state.data_dir.join(libraries::LIBRARIES_DIR),
    };
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let conn = state.app_db.lock().unwrap();
    libraries::create(&conn, &name, &parent).map_err(|e| e.to_string())
}

/// 既存のライブラリフォルダを一覧に加える(外付け HDD を別 PC に挿したとき等)
#[tauri::command]
pub fn add_existing_library(state: State<AppState>, root: String) -> Result<LibraryEntry, String> {
    let conn = state.app_db.lock().unwrap();
    libraries::add_existing(&conn, Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_library(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    let conn = state.app_db.lock().unwrap();
    libraries::rename(&conn, &id, &name).map_err(|e| e.to_string())
}

/// 一覧から外す。**フォルダとファイルは消さない**。
///
/// 守るのは「いま実際に開いている」ものだけ。開けずに placeholder で起動しているときは
/// 現在の指定が指したままでも外せる —— そうしないと復旧画面から抜け出せない
#[tauri::command]
pub fn forget_library(state: State<AppState>, id: String) -> Result<(), String> {
    if id == state.library_id && state.library_status == LibraryStatus::Ok {
        return Err("開いているライブラリは一覧から外せません".into());
    }
    let conn = state.app_db.lock().unwrap();
    libraries::forget(&conn, &id).map_err(|e| e.to_string())
}

/// ライブラリを切り替える。**成功時はこの関数から返らない**(アプリが再起動する)。
///
/// 起動中に DB を差し替えると開いているコネクションと競合して壊れるので、
/// v1.9 のバックアップ復元と同じく「記録して再起動」にしている。
/// ただし復元と違って**予約ファイルは要らない** —— 切り替え先はまだ誰も開いていないし、
/// 記録先の app.db は差し替え対象ではないため
#[tauri::command]
pub fn switch_library(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    if id == state.library_id && state.library_status == LibraryStatus::Ok {
        return Ok(()); // 開いているものを選んだ = 何もしない
    }
    let entry = {
        let conn = state.app_db.lock().unwrap();
        libraries::get(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "そのライブラリは一覧にありません".to_string())?
    };
    // **再起動する前に必ず確かめる。** 開けないものに切り替えると次の起動が
    // 復旧画面から始まることになり、原因がユーザーから見えない
    libraries::validate_root(Path::new(&entry.root)).map_err(|e| e.to_string())?;

    // AppHandle::restart() は RunEvent::Exit の配送を保証しない(tauri#12310)。
    // 終了ハンドラを当てにせず、ここで変換中の ffmpeg を確実に殺す
    playback::kill_current(&state);
    /*
     * ウィンドウの位置・サイズも同じ理由でここで書き出す(v1.32)。
     * window-state プラグインの保存は RunEvent::Exit と CloseRequested に載っているので、
     * **ライブラリ切り替えの再起動だけがすり抜けて位置がリセットされる**。
     * 失敗しても切り替えは続ける(位置を覚え損ねるだけで、切り替えは成立させたい)
     */
    if let Err(e) = app.save_window_state(crate::WINDOW_STATE_FLAGS) {
        eprintln!("ウィンドウ位置の保存に失敗しました: {e}");
    }
    // ファイル監視を止める(None を入れると Drop でスレッドが畳まれる)
    {
        let mut w = state.watcher.lock().unwrap();
        *w = None;
    }
    {
        let conn = state.db.lock().unwrap();
        db::log_op(
            &conn,
            "user",
            "switch_library",
            &format!(r#"{{"to":{:?}}}"#, entry.name),
        );
        // ライブラリフォルダを自己完結させる(-wal を残さない)。
        // 外付け HDD ごと別 PC に持っていく使い方があるので、ここで畳んでおく
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    {
        let conn = state.app_db.lock().unwrap();
        libraries::set_current(&conn, &id).map_err(|e| e.to_string())?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    app.restart()
}
