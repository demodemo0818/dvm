use crate::core::labels::{self, VideoLabels};
use crate::core::query::{self, VideoQuery, VideoRow};
use crate::core::{frames, library, metadata, settings, videos};
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

/// 表示中のページぶんのタグ・シリーズをまとめて引く(v1.23)。
/// 一覧クエリには混ぜない(理由は core/labels.rs の冒頭)
#[tauri::command]
pub fn video_labels(
    state: State<AppState>,
    video_ids: Vec<i64>,
) -> Result<Vec<VideoLabels>, String> {
    let conn = state.db_read.lock().unwrap();
    labels::labels_for_videos(&conn, &video_ids).map_err(|e| e.to_string())
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
/// 詳細パネルの編集フォームに出すタイトル・メモを引く(v1.34)。
/// メモは長文になりうるので一覧クエリには載せず、1 件選んだときだけここで引く
#[tauri::command]
pub fn get_video_info(state: State<AppState>, id: i64) -> Result<Option<videos::VideoInfo>, String> {
    let conn = state.db_read.lock().unwrap();
    videos::get_video_info(&conn, id).map_err(|e| e.to_string())
}

/// タイトル・メモを保存する(v1.34)。省略した項目は触らない。空文字を渡すと未設定に戻る
#[tauri::command]
pub fn set_video_info(
    state: State<AppState>,
    id: i64,
    title: Option<String>,
    comment: Option<String>,
    actor: Option<String>,
) -> Result<(), String> {
    let actor = super::validate_actor(actor)?;
    let conn = state.db.lock().unwrap();
    videos::set_video_info(&conn, &actor, id, title.as_deref(), comment.as_deref())
        .map_err(|e| e.to_string())
}

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

/// id 1 件を一覧と同じ形で引く(v1.18。視聴履歴からその動画を再生するため)
#[tauri::command]
pub fn get_video(state: State<AppState>, id: i64) -> Result<Option<VideoRow>, String> {
    let conn = state.db_read.lock().unwrap();
    query::video_by_id(&conn, Some(&state.thumbs_dir), id).map_err(|e| e.to_string())
}

/// 再生が実際に始まったときにフロントから呼ぶ(v1.18)。返り値は view_history の行 id で、
/// 閉じるときに finish_view へ渡す。`mark_viewed` とは基準が違う(core 側のコメント参照)
#[tauri::command]
pub fn mark_opened(state: State<AppState>, id: i64) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    videos::mark_opened(&conn, id).map_err(|e| e.to_string())
}

/// 視聴履歴の行に到達位置を書き戻す(v1.18。閉じる / 終わるときに 1 回)
#[tauri::command]
pub fn finish_view(state: State<AppState>, history_id: i64, watched_ms: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    videos::finish_view(&conn, history_id, watched_ms).map_err(|e| e.to_string())
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

/// 再生中のコマを画像として保存する(v1.26)。返り値は保存したフルパス。
///
/// `set_thumb_time` とは**別の機能**。あちらは DB を書いてサムネイルキャッシュを作り直させるが、
/// こちらは **DB を一切触らず**、ユーザーのフォルダに PNG を 1 枚出すだけ
#[tauri::command]
pub async fn save_frame(app: AppHandle, id: i64, at_ms: i64) -> Result<String, String> {
    // ffmpeg を待つ前に State を手放す(State は await をまたげない)
    let (path, filename, ff, dir) = {
        let state = app.state::<AppState>();
        let conn = state.db_read.lock().unwrap();
        let (path, filename): (String, String) = conn
            .query_row(
                "SELECT path, filename FROM videos WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        drop(conn);
        // 保存先はアプリ全体の設定(app.db。ライブラリを切り替えても変わらない)
        let configured = {
            let app_conn = state.app_db.lock().unwrap();
            settings::get(&app_conn, "frame_save_dir").ok().flatten()
        };
        let dir = frames::resolve_dir(configured.as_deref(), &state.frames_dir);
        (path, filename, state.ffmpeg.clone(), dir)
    };

    // 元動画が読めないなら ffmpeg を起動する前に止める(未接続と消失で文言を分ける)
    if !std::path::Path::new(&path).exists() {
        let root = crate::core::offline::root_of(&path);
        return Err(if std::path::Path::new(&root).exists() {
            format!("元の動画ファイルが見つかりません: {path}")
        } else {
            format!("動画のあるドライブに接続できません: {root}")
        });
    }

    tauri::async_runtime::spawn_blocking(move || {
        frames::prepare_dir(&dir)?;
        let stem = frames::frame_file_stem(&filename, at_ms);
        let out = frames::unique_path(&dir, &stem, "png")?;
        frames::save_frame(&ff, &path, at_ms, &out)?;
        Ok::<String, anyhow::Error>(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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
        drop(conn);
        // 外部プレイヤーはマシンの設定なのでアプリ全体側(app.db)
        let app_conn = state.app_db.lock().unwrap();
        let player = crate::core::settings::get(&app_conn, "player_path").unwrap_or(None);
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
