use crate::core::{metadata, offline, thumbs};
use crate::db;
use crate::AppState;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "avi", "wmv", "mov", "qt", "flv", "f4v", "webm",
    "mpg", "mpeg", "m2v", "ts", "m2ts", "mts", "vob", "ogv", "ogm",
    "rm", "rmvb", "asf", "divx", "3gp", "3g2",
];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanState {
    scanning: bool,
    message: String,
}

fn emit_state(app: &AppHandle, scanning: bool, message: impl Into<String>) {
    let _ = app.emit("scan:state", ScanState { scanning, message: message.into() });
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("library:changed", ());
}

/// 先頭 1MB + サイズから xxh3 ハッシュを計算する(移動・リネーム検出用)
fn partial_hash(path: &Path, size: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut read_total = 0usize;
    while read_total < buf.len() {
        match file.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(_) => return None,
        }
    }
    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
    hasher.update(&buf[..read_total]);
    hasher.update(&size.to_le_bytes());
    Some(format!("{:016x}", hasher.digest()))
}

fn unix_secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// 1 ファイルを DB に登録(既存なら状態更新)。メタデータ取得が必要なら id を返す
fn upsert_file(conn: &Connection, path: &Path, folder_id: Option<i64>) -> Result<Option<i64>> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let path_str = path.to_string_lossy().to_string();
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let mtime = unix_secs(meta.modified());
    let ctime = unix_secs(meta.created());

    // 既存レコード(同一パス)
    let existing: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT id, size, thumb_state FROM videos WHERE path = ?1",
            params![path_str],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    if let Some((id, old_size, thumb_state)) = existing {
        if old_size != size as i64 {
            // 中身が変わっている → 再プローブ対象
            let hash = partial_hash(path, size);
            conn.execute(
                "UPDATE videos SET size=?1, partial_hash=?2, is_missing=0, thumb_state=0,
                 file_modified_at=datetime(?3,'unixepoch','localtime') WHERE id=?4",
                params![size as i64, hash, mtime, id],
            )?;
            return Ok(Some(id));
        }
        conn.execute("UPDATE videos SET is_missing=0 WHERE id=?1", params![id])?;
        return Ok(if thumb_state == 0 { Some(id) } else { None });
    }

    // 移動・リネーム検出: missing の中から同サイズ・同ハッシュを探す
    let hash = partial_hash(path, size);
    if let Some(h) = &hash {
        let moved: Option<i64> = conn
            .query_row(
                "SELECT id FROM videos WHERE is_missing=1 AND size=?1 AND partial_hash=?2",
                params![size as i64, h],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = moved {
            conn.execute(
                "UPDATE videos SET path=?1, filename=?2, watched_folder_id=?3, is_missing=0 WHERE id=?4",
                params![path_str, filename, folder_id, id],
            )?;
            db::log_op(conn, "system", "move_detected", &path_str);
            return Ok(None);
        }
    }

    conn.execute(
        "INSERT INTO videos (path, filename, title, size, partial_hash, watched_folder_id,
         file_created_at, file_modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 datetime(?7,'unixepoch','localtime'), datetime(?8,'unixepoch','localtime'))",
        params![path_str, filename, filename, size as i64, hash, folder_id, ctime, mtime],
    )?;
    Ok(Some(conn.last_insert_rowid()))
}

/// 監視フォルダを 1 つスキャンし、メタデータ取得が必要な video id 一覧を返す
pub fn scan_folder(app: &AppHandle, folder_id: i64) -> Result<Vec<i64>> {
    let state = app.state::<AppState>();
    let (folder_path, recursive) = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT path, recursive FROM watched_folders WHERE id=?1 AND enabled=1",
            params![folder_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )?
    };

    // オフラインのドライブ/NAS には一切触らない(missing 誤判定防止)
    let mut roots = offline::RootCache::default();
    if !roots.is_online(&folder_path) {
        return Ok(Vec::new());
    }

    let walker = if recursive != 0 {
        WalkDir::new(&folder_path)
    } else {
        WalkDir::new(&folder_path).max_depth(1)
    };
    let files: Vec<_> = walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
        .collect();

    let mut pending: Vec<i64> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    {
        let conn = state.db.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        for entry in &files {
            seen.insert(entry.path().to_string_lossy().to_string());
            if let Ok(Some(id)) = upsert_file(&conn, entry.path(), Some(folder_id)) {
                pending.push(id);
            }
        }
        conn.execute_batch("COMMIT")?;

        // このフォルダ由来で今回見つからなかったものを missing に
        let known: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, path FROM videos WHERE watched_folder_id=?1 AND is_missing=0")?;
            let rows = stmt
                .query_map(params![folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        for (id, path) in known {
            if !seen.contains(&path) && !Path::new(&path).exists() {
                conn.execute("UPDATE videos SET is_missing=1 WHERE id=?1", params![id])?;
            }
        }
    }
    emit_changed(app);
    Ok(pending)
}

/// 個別登録ファイル(watched_folder_id IS NULL)の存在チェック
fn check_individual_files(app: &AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    let rows: Vec<(i64, String, i64)> = {
        let Ok(mut stmt) = conn.prepare("SELECT id, path, is_missing FROM videos WHERE watched_folder_id IS NULL") else {
            return;
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|it| it.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };
    let mut roots = offline::RootCache::default();
    for (id, path, was_missing) in rows {
        if !roots.is_online(&path) {
            continue; // オフライン: 判定保留
        }
        let exists = Path::new(&path).exists();
        if exists && was_missing != 0 {
            let _ = conn.execute("UPDATE videos SET is_missing=0 WHERE id=?1", params![id]);
        } else if !exists && was_missing == 0 {
            let _ = conn.execute("UPDATE videos SET is_missing=1 WHERE id=?1", params![id]);
        }
    }
}

/// ファイル/フォルダのパス群を個別登録として取り込む
pub fn register_paths(app: &AppHandle, paths: Vec<String>) -> Result<usize> {
    let state = app.state::<AppState>();
    let mut targets: Vec<std::path::PathBuf> = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        if path.is_dir() {
            // フォルダがドロップされた場合は中の動画を個別登録として展開
            targets.extend(
                WalkDir::new(path)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
                    .map(|e| e.into_path()),
            );
        } else if path.is_file() && is_video_file(path) {
            targets.push(path.to_path_buf());
        }
    }

    let mut pending: Vec<i64> = Vec::new();
    let count = targets.len();
    {
        let conn = state.db.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        for path in &targets {
            if let Ok(Some(id)) = upsert_file(&conn, path, None) {
                pending.push(id);
            }
        }
        conn.execute_batch("COMMIT")?;
        db::log_op(&conn, "user", "register_files", &format!("{count} files"));
    }
    emit_changed(app);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || process_pending(&app2, pending));
    Ok(count)
}

/// ffprobe + サムネイル生成を並列実行する(UI スレッドは触らない)
pub fn process_pending(app: &AppHandle, ids: Vec<i64>) {
    if ids.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let total = ids.len();
    let done = AtomicUsize::new(0);

    let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(3).build() else {
        return;
    };
    let state_ref = &state;
    let done_ref = &done;

    pool.scope(|scope| {
        for id in ids {
            scope.spawn(move |_| {
                let path: Option<String> = {
                    let conn = state_ref.db.lock().unwrap();
                    conn.query_row("SELECT path FROM videos WHERE id=?1", params![id], |r| r.get(0))
                        .optional()
                        .unwrap_or(None)
                };
                let Some(path) = path else { return };

                let probed = metadata::probe(&state_ref.ffmpeg, &path);
                let duration = probed.as_ref().ok().and_then(|p| p.duration_ms);
                let thumb_path = state_ref.thumbs_dir.join(format!("{id}.jpg"));
                let thumb_ok = thumbs::generate(&state_ref.ffmpeg, &path, duration, &thumb_path).is_ok();
                let thumb_state = if thumb_ok { 1i64 } else { 2i64 };

                {
                    let conn = state_ref.db.lock().unwrap();
                    if let Ok(p) = &probed {
                        let _ = conn.execute(
                            "UPDATE videos SET duration_ms=?1, width=?2, height=?3, video_codec=?4,
                             audio_codec=?5, container=?6, fps=?7, bitrate=?8, thumb_state=?9 WHERE id=?10",
                            params![p.duration_ms, p.width, p.height, p.video_codec, p.audio_codec,
                                    p.container, p.fps, p.bitrate, thumb_state, id],
                        );
                    } else {
                        let _ = conn.execute(
                            "UPDATE videos SET thumb_state=?1 WHERE id=?2",
                            params![thumb_state, id],
                        );
                    }
                }

                let n = done_ref.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 10 == 0 || n == total {
                    emit_state(app, n < total, format!("サムネイル生成中 {n}/{total}"));
                    emit_changed(app);
                }
            });
        }
    });
    emit_state(app, false, "");
    emit_changed(app);
}

/// 全監視フォルダのスキャン + 個別登録ファイルのチェック(多重起動ガードつき)
pub fn run_scan_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    emit_state(app, true, "スキャン中...");

    let folder_ids: Vec<i64> = {
        let conn = state.db.lock().unwrap();
        conn.prepare("SELECT id FROM watched_folders WHERE enabled=1")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get(0))
                    .map(|it| it.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default()
    };

    let mut pending: Vec<i64> = Vec::new();
    for id in folder_ids {
        match scan_folder(app, id) {
            Ok(mut p) => pending.append(&mut p),
            Err(e) => eprintln!("scan_folder({id}) failed: {e}"),
        }
    }
    check_individual_files(app);
    emit_changed(app);

    process_pending(app, pending);
    emit_state(app, false, "");
    state.scanning.store(false, Ordering::SeqCst);
}

/// 監視フォルダ 1 つのスキャン + 後処理(多重起動ガードつき)
pub fn run_scan_folder(app: &AppHandle, folder_id: i64) {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    emit_state(app, true, "スキャン中...");
    match scan_folder(app, folder_id) {
        Ok(pending) => process_pending(app, pending),
        Err(e) => eprintln!("scan_folder({folder_id}) failed: {e}"),
    }
    emit_state(app, false, "");
    state.scanning.store(false, Ordering::SeqCst);
}
