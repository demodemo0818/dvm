use crate::core::playlists::{self, Playlist};
use crate::core::query::{self, VideoRow};
use crate::core::{m3u8, session};
use crate::AppState;
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn list_playlists(state: State<AppState>) -> Result<Vec<Playlist>, String> {
    let conn = state.db_read.lock().unwrap();
    playlists::list(&conn, Some(&state.thumbs_dir)).map_err(|e| e.to_string())
}

/// リストの中身を一覧と同じ行の形で、保存した並び順のまま返す(キューへの読み込み)
#[tauri::command]
pub fn get_playlist_videos(state: State<AppState>, id: i64) -> Result<Vec<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    let ids = playlists::entries(&conn, id).map_err(|e| e.to_string())?;
    query::videos_by_ids(&conn, Some(&state.thumbs_dir), &ids).map_err(|e| e.to_string())
}

/// キューの引き直し(v1.40)。`library:changed` のたびにフロントが呼ぶ。
/// 消えた動画は結果から落ちるので、フロントはこれで置き換えるだけでよい
#[tauri::command]
pub fn get_videos_by_ids(state: State<AppState>, ids: Vec<i64>) -> Result<Vec<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    query::videos_by_ids(&conn, Some(&state.thumbs_dir), &ids).map_err(|e| e.to_string())
}

/// 名前が使われているかを先に尋ねる(UI が「上書きしますか?」を出すため)
#[tauri::command]
pub fn find_playlist_by_name(state: State<AppState>, name: String) -> Result<Option<i64>, String> {
    let conn = state.db_read.lock().unwrap();
    playlists::find_by_name(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(
    state: State<AppState>,
    name: String,
    video_ids: Vec<i64>,
    actor: Option<String>,
) -> Result<i64, String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    playlists::create(&conn, &actor, &name, &video_ids).map_err(|e| e.to_string())
}

/// 中身を丸ごと差し替える(上書き保存)
#[tauri::command]
pub fn replace_playlist(
    state: State<AppState>,
    id: i64,
    video_ids: Vec<i64>,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    playlists::replace(&conn, &actor, id, &video_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_playlist(state: State<AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::rename(&conn, "user", id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn duplicate_playlist(state: State<AppState>, id: i64) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    playlists::duplicate(&conn, "user", id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_playlist(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::delete(&conn, "user", id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlists(state: State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    playlists::reorder(&conn, &ids).map_err(|e| e.to_string())
}

// --- 再生キューの自動保存(v1.41、C-2)---
//
// 値はフロントが組む JSON をそのまま預かる(形は lib/queueStorage.ts が決める)。
// operations_log には残さない —— キューはメタデータではなくセッション状態で、
// 編集のたびに履歴が 1 行ずつ増えると本来の記録が埋まる

#[tauri::command]
pub fn get_queue_state(state: State<AppState>) -> Result<Option<String>, String> {
    let conn = state.db_read.lock().unwrap();
    session::get(&conn, "queue").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_queue_state(state: State<AppState>, value: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    session::set(&conn, "queue", &value).map_err(|e| e.to_string())
}

// --- M3U8 エクスポート / インポート(v1.41、C-3)---

/// プレイリストを UTF-8 の M3U8 に書き出す。返り値は書いた動画数
#[tauri::command]
pub fn export_m3u8(state: State<AppState>, id: i64, dest: String) -> Result<usize, String> {
    let conn = state.db_read.lock().unwrap();
    m3u8::export(&conn, id, std::path::Path::new(&dest)).map_err(|e| e.to_string())
}

/// M3U8 の取り込み結果。skipped = 実在しない・対応形式でない等で登録できなかった行数
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3u8Import {
    pub playlist_id: i64,
    pub name: String,
    pub count: usize,
    pub skipped: usize,
}

/// M3U8 を読み、パスを個別登録に載せてから同名のプレイリストを作る。
/// 登録はファイルのハッシュ読みを伴うので register_files と同じく blocking スレッドで
#[tauri::command]
pub async fn import_m3u8(app: AppHandle, path: String) -> Result<M3u8Import, String> {
    tauri::async_runtime::spawn_blocking(move || import_m3u8_inner(&app, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn import_m3u8_inner(app: &AppHandle, path: &str) -> anyhow::Result<M3u8Import> {
    let file = std::path::Path::new(path);
    let content = std::fs::read_to_string(file)?;
    let paths = m3u8::parse(&content, file.parent());
    anyhow::ensure!(!paths.is_empty(), "M3U8 に動画ファイルのパスがありませんでした");

    // 既存の個別登録に載せる(登録済み・監視除外・実在しないものはここで自然に落ちる)。
    // register_paths は内部で DB ロックを取るので、こちらのロックより先に済ませる
    crate::core::library::register_paths(app, paths.clone())?;

    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    // m3u8 の並び順のまま id に引き直す。ドライブレターの大小のような差は
    // NOCASE で吸収する(Windows のパスは大文字小文字を区別しない)
    let mut ids: Vec<i64> = Vec::new();
    let mut skipped = 0usize;
    for p in &paths {
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM videos WHERE path = ?1 COLLATE NOCASE",
                rusqlite::params![p],
                |r| r.get(0),
            )
            .optional()?;
        match id {
            Some(id) => ids.push(id),
            None => skipped += 1,
        }
    }
    anyhow::ensure!(
        !ids.is_empty(),
        "M3U8 の動画を 1 件も登録できませんでした(ファイルが見つからないか、対応形式ではありません)"
    );

    let base = file
        .file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "インポート".to_string());
    let name = free_name(&conn, &base)?;
    let playlist_id = playlists::create(&conn, "user", &name, &ids)?;
    // write_entries が重複を畳むので、件数は作ったあとの実数を返す
    let count = playlists::entries(&conn, playlist_id)?.len();
    Ok(M3u8Import { playlist_id, name, count, skipped })
}

/// 「◯◯」「◯◯ (2)」… と空いている名前を探す(playlists::free_copy_name と同じ流儀)。
/// 取り込みは「新しいリストが欲しい」操作なので、同名があっても上書きは尋ねない
fn free_name(conn: &rusqlite::Connection, base: &str) -> anyhow::Result<String> {
    if playlists::find_by_name(conn, base)?.is_none() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let cand = format!("{base} ({n})");
        if playlists::find_by_name(conn, &cand)?.is_none() {
            return Ok(cand);
        }
    }
    anyhow::bail!("プレイリスト名の空きが見つかりませんでした")
}
