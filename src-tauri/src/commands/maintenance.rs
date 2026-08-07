use crate::core::backup::{self, BackupInfo};
use crate::core::{dedupe, frames, libraries, library, offline, settings, thumbs};
use crate::db;
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub removed: usize,
    pub freed_bytes: u64,
}

/// 重複解消の計画を立てる(DB は読むだけ。実行はしない)。
/// `scope` にフォルダの絶対パスを渡すと、その配下だけを対象にする
#[tauri::command]
pub fn plan_dedupe(
    state: State<AppState>,
    scope: Option<String>,
) -> Result<dedupe::DedupePlan, String> {
    let conn = state.db_read.lock().unwrap();
    dedupe::plan(&conn, scope.as_deref()).map_err(|e| e.to_string())
}

/// 重複解消を実行する。計画を立て直してから実行するので、
/// 画面を開いている間に増えた動画も反映される。
///
/// `trash_files` を立てるとファイルを**ごみ箱へ**送ってから登録を外す(完全削除はしない)。
/// 立てなければ従来どおり登録を外すだけで、ファイルには触らない。
/// ごみ箱送りは 1 件ずつシェル API を叩いて待つので、UI を止めないよう別スレッドに逃がす
#[tauri::command]
pub async fn apply_dedupe(
    app: AppHandle,
    scope: Option<String>,
    trash_files: bool,
) -> Result<dedupe::DedupeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 計画とパスは短いロックで読み、ごみ箱送り(シェル API 待ち)はロックの外で行う。
        // 実行までの隙間に消えた id があっても DELETE が空振りするだけで害はない
        let (plan, paths) = {
            let conn = state.db.lock().unwrap();
            dedupe::plan_for_apply(&conn, scope.as_deref()).map_err(|e| e.to_string())?
        };
        let trash_results = if trash_files {
            Some(crate::core::videos::trash_paths(paths))
        } else {
            None
        };
        let (result, removed_ids) = {
            let conn = state.db.lock().unwrap();
            dedupe::finish(&conn, "user", scope.as_deref(), &plan, trash_results.as_deref())
                .map_err(|e| e.to_string())?
        };
        for id in &removed_ids {
            let _ = std::fs::remove_file(state.thumbs_dir.join(format!("{id}.jpg")));
            crate::core::playback::remove_cache_for(&state.transcode_dir, *id);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// videos に対応しない孤児サムネイルを掃除する
#[tauri::command]
pub fn purge_orphan_thumbnails(state: State<AppState>) -> Result<PurgeResult, String> {
    let conn = state.db.lock().unwrap();
    let (removed, freed_bytes) =
        thumbs::purge_orphans(&conn, &state.thumbs_dir).map_err(|e| e.to_string())?;
    if removed > 0 {
        db::log_op(&conn, "user", "purge_orphan_thumbnails", &format!("removed={removed}"));
    }
    Ok(PurgeResult { removed, freed_bytes })
}

#[tauri::command]
pub fn backup_db(state: State<AppState>) -> Result<BackupInfo, String> {
    let conn = state.db.lock().unwrap();
    let dest = backup::backup_now(&conn, &state.backups_dir, "manual").map_err(|e| e.to_string())?;
    db::log_op(&conn, "user", "backup_db", &dest.to_string_lossy());
    backup::list_backups(&state.backups_dir)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|b| b.path == dest.to_string_lossy())
        .ok_or_else(|| "バックアップファイルが見つかりません".to_string())
}

#[tauri::command]
pub fn list_db_backups(state: State<AppState>) -> Result<Vec<BackupInfo>, String> {
    backup::list_backups(&state.backups_dir).map_err(|e| e.to_string())
}

/// バックアップからの復元を予約する(実際の差し替えは次回起動時)。
/// 起動中に library.db を差し替えると開いているコネクションと競合するため
#[tauri::command]
pub fn restore_backup(state: State<AppState>, path: String) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    let safety = backup::request_restore(
        &conn,
        &state.library_root,
        &state.backups_dir,
        std::path::Path::new(&path),
    )
    .map_err(|e| e.to_string())?;
    db::log_op(&conn, "user", "request_restore", &format!("{{\"from\":{path:?}}}"));
    Ok(safety
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[tauri::command]
pub fn open_backups_dir(state: State<AppState>) -> Result<(), String> {
    std::fs::create_dir_all(&state.backups_dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&state.backups_dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    tauri_plugin_opener::open_path(&state.data_dir, None::<&str>).map_err(|e| e.to_string())
}

/// ライブラリのフォルダを開く(v1.27)。id を省くといま開いているもの。
/// データフォルダとは別物 —— ライブラリは外付け HDD 上にも置ける
#[tauri::command]
pub fn open_library_dir(state: State<AppState>, id: Option<String>) -> Result<(), String> {
    let dir = match id {
        Some(id) => {
            let conn = state.app_db.lock().unwrap();
            let entry = libraries::get(&conn, &id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "そのライブラリは一覧にありません".to_string())?;
            std::path::PathBuf::from(entry.root)
        }
        None => state.library_root.clone(),
    };
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// コマの画像の保存先を開く(v1.26)。設定が空なら既定(ピクチャ\DVM)。
/// **実効フォルダを Rust 側で解決する**ので、フロントは既定値を知らなくてよい。
/// まだ 1 枚も撮っていなければフォルダが無いので、ここで作ってから開く
#[tauri::command]
pub fn open_frame_dir(state: State<AppState>) -> Result<(), String> {
    let configured = {
        let conn = state.app_db.lock().unwrap();
        settings::get(&conn, "frame_save_dir").ok().flatten()
    };
    let dir = frames::resolve_dir(configured.as_deref(), &state.frames_dir);
    frames::prepare_dir(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub data_dir: String,
    /// いま開いているライブラリ(v1.27)。設定画面と MCP の案内に出す
    pub library_id: String,
    pub library_name: String,
    pub library_root: String,
    pub db_path: String,
    pub db_size: i64,
    pub thumbs_dir: String,
    pub thumb_count: i64,
    pub thumb_cache_size: i64,
    pub backups_dir: String,
    /// コマの画像の**既定**の保存先(v1.26)。設定画面が placeholder に出して、
    /// 「空欄にしたときどこへ行くのか」を実際のパスで見せるために使う
    pub frames_dir: String,
    /// MCP サーバーの実行ファイル。見つからなければ null(設定画面がその旨を出す)
    pub mcp_path: Option<String>,
    /// 再生用の変換キャッシュ(v1.38)。**ライブラリ横断の合計**。上限だけ出して
    /// 実測が無いと「今どれだけ貯まっているか」が分からないので一緒に返す
    pub transcode_count: i64,
    pub transcode_size: i64,
}

#[tauri::command]
pub fn get_app_info(state: State<AppState>) -> Result<AppInfo, String> {
    let db_path = state.library_root.join("library.db");
    // WAL モードなので -wal も込みで実サイズを見せる
    let db_size = [db_path.clone(), state.library_root.join("library.db-wal")]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len() as i64)
        .sum();

    let (thumb_count, thumb_cache_size) = std::fs::read_dir(&state.thumbs_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jpg"))
                .filter_map(|e| e.metadata().ok())
                .fold((0i64, 0i64), |(n, total), m| (n + 1, total + m.len() as i64))
        })
        .unwrap_or((0, 0));

    let library_name = {
        let conn = state.app_db.lock().unwrap();
        libraries::get(&conn, &state.library_id)
            .ok()
            .flatten()
            .map(|e| e.name)
            .unwrap_or_default()
    };

    let (transcode_count, transcode_size) =
        crate::core::playback::cache_size(&state.data_dir.join("transcode"));

    Ok(AppInfo {
        data_dir: state.data_dir.to_string_lossy().to_string(),
        library_id: state.library_id.clone(),
        library_name,
        library_root: state.library_root.to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        db_size,
        thumbs_dir: state.thumbs_dir.to_string_lossy().to_string(),
        thumb_count,
        thumb_cache_size,
        backups_dir: state.backups_dir.to_string_lossy().to_string(),
        frames_dir: state.frames_dir.to_string_lossy().to_string(),
        mcp_path: crate::core::mcp::server_path().map(|p| p.to_string_lossy().to_string()),
        transcode_count: transcode_count as i64,
        transcode_size: transcode_size as i64,
    })
}

/// 変換キャッシュを今すぐ掃除する(v1.38)。
///
/// 上限は `purge_cache` が app.db から読み直すので、設定を書き換えたあと押せば
/// その値で効く。戻り値は返さない —— 呼び出し側が `get_app_info` を取り直せば、
/// 減ったサイズがそのまま画面に出る
#[tauri::command]
pub fn purge_transcode_cache(app: AppHandle) -> Result<(), String> {
    crate::core::playback::purge_cache(&app, None);
    Ok(())
}

/// サムネイル再生成。only_failed=true なら生成失敗分のみ、false なら全件。
/// 対象は missing でなくルートがオンラインの動画に限る。進捗は既存の scan:state イベントで通知される
#[tauri::command]
pub async fn regenerate_thumbnails(app: AppHandle, only_failed: bool) -> Result<usize, String> {
    let ids: Vec<i64> = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let sql = if only_failed {
            "SELECT id, path FROM videos WHERE is_missing = 0 AND thumb_state = 2"
        } else {
            "SELECT id, path FROM videos WHERE is_missing = 0"
        };
        let rows: Vec<(i64, String)> = conn
            .prepare(sql)
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map(|it| it.filter_map(|r| r.ok()).collect())
            })
            .map_err(|e| e.to_string())?;
        let mut roots = offline::RootCache::default();
        let ids: Vec<i64> = rows
            .into_iter()
            .filter(|(_, path)| roots.is_online(path))
            .map(|(id, _)| id)
            .collect();

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for id in &ids {
            tx.execute(
                "UPDATE videos SET thumb_state = 0 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        db::log_op(
            &conn,
            "user",
            "regenerate_thumbnails",
            &format!("only_failed={only_failed}, count={}", ids.len()),
        );
        ids
    };
    let count = ids.len();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || library::process_pending(&app2, ids));
    Ok(count)
}
