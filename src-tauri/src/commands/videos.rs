use crate::core::query::{self, VideoQuery, VideoRow};
use crate::core::{library, metadata, videos};
use crate::AppState;
use rusqlite::params;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn count_videos(state: State<AppState>, query: VideoQuery) -> Result<i64, String> {
    let conn = state.db_read.lock().unwrap();
    query::count(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn query_videos(
    state: State<AppState>,
    query: VideoQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    query::query_rows(&conn, Some(&state.thumbs_dir), &query, limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_rating(
    state: State<AppState>,
    video_ids: Vec<i64>,
    rating: i64,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    videos::set_rating(&conn, &actor, &video_ids, rating).map_err(|e| e.to_string())
}

/// ライブラリから登録を削除する(ファイル自体は消さない)。サムネイルキャッシュも掃除する
#[tauri::command]
pub fn remove_videos(
    state: State<AppState>,
    video_ids: Vec<i64>,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    {
        let conn = state.db.lock().unwrap();
        videos::remove_videos(&conn, &actor, &video_ids).map_err(|e| e.to_string())?;
    }
    for id in &video_ids {
        let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{id}.jpg")));
        crate::core::playback::remove_cache_for(&state.transcode_dir, *id);
    }
    Ok(())
}

#[tauri::command]
pub async fn register_files(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || library::register_paths(&app, paths))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// 視聴カウントを進める(アプリ内再生の開始時にフロントから呼ぶ)
#[tauri::command]
pub fn mark_viewed(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    videos::mark_viewed(&conn, id).map_err(|e| e.to_string())
}

/// アプリ内再生のレジューム位置を保存する(再生中に数秒ごと + 閉じる時に呼ぶ)
#[tauri::command]
pub fn set_resume(state: State<AppState>, id: i64, resume_ms: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    videos::set_resume(&conn, id, resume_ms).map_err(|e| e.to_string())
}

/// サムネイルのコマ位置を指定して即座に作り直す。at_ms を省略すると自動選択に戻す
#[tauri::command]
pub async fn set_thumb_time(app: AppHandle, id: i64, at_ms: Option<i64>) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        crate::core::thumbs::set_thumb_time(&conn, id, at_ms).map_err(|e| e.to_string())?;
    }
    // 生成は既存のワーカーに任せる(ffprobe + サムネイル生成が同じ経路を通る)
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || library::process_pending(&app2, vec![id]));
    Ok(())
}

/// 詳細ペインの「メディア情報」を展開したときだけ呼ばれる(ffprobe を 1 回起動する)。
/// 一覧の描画やホバーからは**絶対に呼ばないこと** — 元動画に触るため
/// (CLAUDE.md パフォーマンス原則 2)。
/// 結果はキャッシュしない(理由は DESIGN.md「メディア情報の表示」)
#[tauri::command]
pub async fn get_media_info(app: AppHandle, id: i64) -> Result<metadata::MediaInfo, String> {
    // ffprobe を待つ前に State を手放す(State は await をまたげない)
    let (path, ff) = {
        let state = app.state::<AppState>();
        (path_of(&state, id)?, state.ffmpeg.clone())
    };
    tauri::async_runtime::spawn_blocking(move || metadata::media_info(&ff, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// DB からパスを引く小道具(open_* 系で共用)
fn path_of(state: &AppState, id: i64) -> Result<String, String> {
    let conn = state.db_read.lock().unwrap();
    conn.query_row("SELECT path FROM videos WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// 外部プレイヤー設定を**無視して**、Windows の関連付けアプリで開く(v1.14)。
/// `open_video` は「アプリ内でダブルクリックしたときの行き先」で設定に従うが、
/// 右クリックの「既定のアプリで開く」は名前どおり常に関連付けを使う
#[tauri::command]
pub fn open_with_default(state: State<AppState>, id: i64) -> Result<(), String> {
    let path = path_of(&state, id)?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    // 動画プレイヤーで開かれる想定なので open_video と同じく視聴として数える
    let conn = state.db.lock().unwrap();
    let _ = videos::mark_viewed(&conn, id);
    Ok(())
}

/// Windows の「プログラムから開く」ダイアログを出す(v1.14)。
/// アプリ一覧の管理は OS に任せる。何で開くか分からないので視聴カウントは進めない
#[tauri::command]
pub fn open_with_dialog(state: State<AppState>, id: i64) -> Result<(), String> {
    let path = path_of(&state, id)?;
    // Windows 専用。他 OS では rundll32 が無く spawn が失敗し、UI にトーストで出る
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("「プログラムから開く」を起動できません: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_video(state: State<AppState>, id: i64) -> Result<(), String> {
    let (path, player) = {
        let conn = state.db.lock().unwrap();
        let p: String = conn
            .query_row("SELECT path FROM videos WHERE id=?1", params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let _ = videos::mark_viewed(&conn, id);
        let player = crate::core::settings::get(&conn, "player_path").unwrap_or(None);
        (p, player)
    };

    match player.filter(|p| !p.trim().is_empty()) {
        Some(player) => {
            std::process::Command::new(&player)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("プレイヤーを起動できません ({player}): {e}"))?;
        }
        None => {
            tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
