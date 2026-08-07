use crate::core::fileops::{self, OpResult, PlanItem, PlanStatus};
use crate::core::videos;
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// ごみ箱送りの PlanItem で「移動先」として見せる文字列(実際のパスは持たない)
const TRASH_LABEL: &str = "ごみ箱";

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
        let app2 = app.clone();
        // 実ファイルの移動(ドライブ間なら何分もかかる)は **DB ロックを持たずに**行い、
        // DB の追従だけ短いロックで書く。ロックを握ったままだと、その間の
        // レーティングやタグ付け・MCP の書き込みが全部ブロックする
        let (moved, failed) = fileops::move_files(&items, |done, total, current| {
            let _ = app2.emit(
                "fileop:progress",
                FileOpProgress { done, total, current: current.to_string() },
            );
        });
        let recorded = {
            let conn = state.db.lock().unwrap();
            fileops::record_moves(&conn, &actor, &moved, &action).map_err(|e| e.to_string())?
        };
        Ok(fileops::merge_move_results(&items, recorded, failed))
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

// --- ごみ箱送り(v1.14。右クリックメニューから使う) ---
//
// コアの `videos::plan_trash` / `trash_files` は MCP と共有しているのでそのまま使い、
// ここで UI 共通の PlanItem / OpResult に詰め替える。
// コアは「ごみ箱に送ったら is_missing=1 にして DB レコードは残す」方針だが、
// UI から実行したときは**続けてライブラリ登録も消す**。
// 「捨てたのに一覧に残っている」のはユーザーには不具合にしか見えないため

#[tauri::command]
pub fn plan_trash(state: State<AppState>, video_ids: Vec<i64>) -> Result<Vec<PlanItem>, String> {
    let conn = state.db_read.lock().unwrap();
    let items = videos::plan_trash(&conn, &video_ids).map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .map(|t| PlanItem {
            video_id: t.id,
            from: t.path,
            to: TRASH_LABEL.to_string(),
            // オフラインは「消えた」のか「未接続」なのか区別できないので触らない
            status: if t.is_offline {
                PlanStatus::Offline
            } else if !t.exists {
                PlanStatus::SourceMissing
            } else {
                PlanStatus::Ok
            },
            note: None,
        })
        .collect())
}

/// ごみ箱へ送り、成功したものはライブラリ登録・サムネイル・変換キャッシュも消す
#[tauri::command]
pub async fn apply_trash(
    app: AppHandle,
    items: Vec<PlanItem>,
    actor: Option<String>,
) -> Result<Vec<OpResult>, String> {
    let actor = super::validate_actor(actor)?;
    let ids: Vec<i64> = items.iter().map(|i| i.video_id).collect();
    // ごみ箱送りは 1 件ずつシェル API を叩くので、件数が多いと待つ。UI を止めない
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // パスの取得だけ短いロックで済ませ、ごみ箱送り(シェル API 待ち)はロックの外で
        let paths = {
            let conn = state.db.lock().unwrap();
            videos::paths_of(&conn, &ids).map_err(|e| e.to_string())?
        };
        let results = videos::trash_paths(paths);

        let trashed: Vec<i64> = results.iter().filter(|r| r.trashed).map(|r| r.id).collect();
        {
            let conn = state.db.lock().unwrap();
            videos::record_trashed(&conn, &actor, &results).map_err(|e| e.to_string())?;
            if !trashed.is_empty() {
                videos::remove_videos(&conn, &actor, &trashed).map_err(|e| e.to_string())?;
            }
        }
        for id in &trashed {
            let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{id}.jpg")));
            crate::core::playback::remove_cache_for(&state.transcode_dir, *id);
        }

        Ok(results
            .into_iter()
            .map(|r| OpResult {
                video_id: r.id,
                from: r.path,
                to: TRASH_LABEL.to_string(),
                ok: r.trashed,
                error: r.error,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
