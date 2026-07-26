use crate::core::fileops::{self, OpResult, PlanItem};
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 移動・リネームの進捗(大きいファイルを別ドライブへ動かすと時間がかかるため)
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOpProgress {
    done: usize,
    total: usize,
    current: String,
}

// --- dry-run(読み取りだけ。ここではファイルにも DB にも触らない) ---

#[tauri::command]
pub fn plan_relink(
    state: State<AppState>,
    from_prefix: String,
    to_prefix: String,
) -> Result<Vec<PlanItem>, String> {
    let conn = state.db_read.lock().unwrap();
    fileops::plan_relink(&conn, &from_prefix, &to_prefix).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_move(
    state: State<AppState>,
    video_ids: Vec<i64>,
    dest_dir: String,
) -> Result<Vec<PlanItem>, String> {
    let conn = state.db_read.lock().unwrap();
    fileops::plan_move(&conn, &video_ids, &dest_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plan_rename(
    state: State<AppState>,
    video_id: i64,
    new_name: String,
) -> Result<PlanItem, String> {
    let conn = state.db_read.lock().unwrap();
    fileops::plan_rename(&conn, video_id, &new_name).map_err(|e| e.to_string())
}

// --- 実行(UI がプレビューを承認したあとにだけ呼ばれる) ---

#[tauri::command]
pub fn apply_relink(
    state: State<AppState>,
    items: Vec<PlanItem>,
    actor: Option<String>,
) -> Result<Vec<OpResult>, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    fileops::apply_relink(&conn, &actor, &items).map_err(|e| e.to_string())
}

/// 実ファイルを動かす。action は "move_file" / "rename_file"
#[tauri::command]
pub async fn apply_move(
    app: AppHandle,
    items: Vec<PlanItem>,
    action: String,
    actor: Option<String>,
) -> Result<Vec<OpResult>, String> {
    let actor = super::validate_actor(actor)?;
    let action = match action.as_str() {
        "move_file" | "rename_file" => action,
        other => return Err(format!("不正な操作です: {other}")),
    };
    // ファイル I/O で UI を止めないようワーカーで実行する
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let app2 = app.clone();
        fileops::apply_move(&conn, &actor, &items, &action, |done, total, current| {
            let _ = app2.emit(
                "fileop:progress",
                FileOpProgress { done, total, current: current.to_string() },
            );
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// D&D で落とされたパスをフォルダとファイルに仕分ける
/// (フォルダなら監視フォルダにするか個別登録かをユーザーに尋ねるため)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedPaths {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

#[tauri::command]
pub fn classify_paths(paths: Vec<String>) -> ClassifiedPaths {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for p in paths {
        if std::path::Path::new(&p).is_dir() {
            dirs.push(p);
        } else {
            files.push(p);
        }
    }
    ClassifiedPaths { dirs, files }
}
