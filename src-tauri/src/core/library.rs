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
use std::sync::Mutex;
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

/// 1 ファイルを DB に登録(既存なら状態更新)。メタデータ取得が必要なら id を返す。
/// roots は移動検出で「旧パスが本当に消えたのか、ドライブ未接続なだけか」を見分けるのに使う
fn upsert_file(
    conn: &Connection,
    roots: &mut offline::RootCache,
    path: &Path,
    folder_id: Option<i64>,
) -> Result<Option<i64>> {
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
        // 所属も張り直す。監視フォルダを解除すると ON DELETE SET NULL で watched_folder_id が
        // NULL になるので、同じフォルダを登録し直したときにここで拾わないと件数が 0 のままになる。
        // COALESCE なので個別登録(folder_id = None)では既存の所属を消さない
        if old_size != size as i64 {
            // 中身が変わっている → 再プローブ対象
            let hash = partial_hash(path, size);
            conn.execute(
                "UPDATE videos SET size=?1, partial_hash=?2, is_missing=0, thumb_state=0,
                 watched_folder_id=COALESCE(?5, watched_folder_id),
                 file_modified_at=datetime(?3,'unixepoch','localtime') WHERE id=?4",
                params![size as i64, hash, mtime, id, folder_id],
            )?;
            return Ok(Some(id));
        }
        conn.execute(
            "UPDATE videos SET is_missing=0, watched_folder_id=COALESCE(?1, watched_folder_id)
             WHERE id=?2",
            params![folder_id, id],
        )?;
        return Ok(if thumb_state == 0 { Some(id) } else { None });
    }

    // 移動・リネーム検出: 同サイズ・同ハッシュの既存レコードのうち、旧パスの実体が
    // 消えているものを移動元とみなす。
    // is_missing フラグで絞らないのは、フォルダをまたぐ移動でスキャン順が「移動先が先」に
    // なると旧レコードがまだ is_missing=0 のままで、取りこぼして二重登録になるため
    // (タグ・レーティング・視聴履歴が旧レコード側に取り残される)
    let hash = partial_hash(path, size);
    if let Some(h) = &hash {
        let candidates: Vec<(i64, String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT id, path, thumb_state FROM videos WHERE size=?1 AND partial_hash=?2",
            )?;
            let rows = stmt
                .query_map(params![size as i64, h], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        // オフラインのドライブ上にある旧パスは「消えた」と判断できないので候補から外す
        // (同じ内容のファイルが両方に実在するだけ、というケースも実体チェックで弾ける)
        let moved = candidates.into_iter().find(|(_, old_path, _)| {
            old_path.as_str() != path_str
                && roots.is_online(old_path)
                && !Path::new(old_path).exists()
        });
        if let Some((id, old_path, thumb_state)) = moved {
            conn.execute(
                "UPDATE videos SET path=?1, filename=?2, watched_folder_id=?3, is_missing=0 WHERE id=?4",
                params![path_str, filename, folder_id, id],
            )?;
            db::log_op(conn, "system", "move_detected", &format!("{old_path} -> {path_str}"));
            // 移動元がサムネイル未生成だった場合はここで拾わないと永久に生成されない
            return Ok(if thumb_state == 0 { Some(id) } else { None });
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

/// 監視フォルダの一覧(id, 比較用に小文字化・区切りを揃えたパス)
fn watched_folder_index(conn: &Connection) -> Vec<(i64, String)> {
    let Ok(mut stmt) = conn.prepare("SELECT id, path FROM watched_folders") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok())
        .map(|(id, p)| {
            (id, p.to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string())
        })
        .collect()
}

/// path を含む監視フォルダのうち**最も深い**ものの id。
///
/// 親フォルダを後から監視フォルダに追加しても、既に登録されている子フォルダの動画を
/// 親が奪わないようにするため。watcher.rs のイベント振り分けと
/// fileops.rs の owning_folder も同じ「最も深いものを採る」判定にそろえている
fn deepest_owner(index: &[(i64, String)], path: &str) -> Option<i64> {
    let lower = path.to_lowercase().replace('/', "\\");
    index
        .iter()
        .filter(|(_, f)| lower.starts_with(&format!("{f}\\")))
        .max_by_key(|(_, f)| f.len())
        .map(|(id, _)| *id)
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
        // 入れ子の監視フォルダがあり得るので、所属は「このフォルダ」ではなく
        // パスを含む最も深い監視フォルダに決める
        let index = watched_folder_index(&conn);
        conn.execute_batch("BEGIN")?;
        for entry in &files {
            let path_str = entry.path().to_string_lossy().to_string();
            let owner = deepest_owner(&index, &path_str).or(Some(folder_id));
            seen.insert(path_str);
            if let Ok(Some(id)) = upsert_file(&conn, &mut roots, entry.path(), owner) {
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
    let mut roots = offline::RootCache::default();
    {
        let conn = state.db.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        for path in &targets {
            if let Ok(Some(id)) = upsert_file(&conn, &mut roots, path, None) {
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
    // library:changed を最後に投げた時刻(下の間引きで使う)
    let last_changed = Mutex::new(std::time::Instant::now());

    let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(3).build() else {
        return;
    };
    let state_ref = &state;
    let done_ref = &done;
    let last_changed_ref = &last_changed;

    pool.scope(|scope| {
        for id in ids {
            scope.spawn(move |_| {
                // ユーザーが指定したサムネイル位置(thumb_time_ms)があればそれを使う
                let row: Option<(String, Option<i64>)> = {
                    let conn = state_ref.db.lock().unwrap();
                    conn.query_row(
                        "SELECT path, thumb_time_ms FROM videos WHERE id=?1",
                        params![id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .unwrap_or(None)
                };
                let Some((path, thumb_time_ms)) = row else { return };

                let probed = metadata::probe(&state_ref.ffmpeg, &path);
                let duration = probed.as_ref().ok().and_then(|p| p.duration_ms);
                let thumb_path = state_ref.thumbs_dir.join(format!("{id}.jpg"));
                let thumb_ok =
                    thumbs::generate(&state_ref.ffmpeg, &path, duration, thumb_time_ms, &thumb_path)
                        .is_ok();
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
                    // 進捗テキストはこまめに出してよい(ステータスバーの文字が変わるだけ)
                    emit_state(app, n < total, format!("サムネイル生成中 {n}/{total}"));
                    // library:changed は一覧の再取得を誘発するので 2 秒に 1 回までに抑える。
                    // 10 件ごとに投げると数千件の取り込み中ずっと再取得が走り続けてしまう
                    let should_emit = {
                        let mut last = last_changed_ref.lock().unwrap();
                        if n == total || last.elapsed() >= std::time::Duration::from_secs(2) {
                            *last = std::time::Instant::now();
                            true
                        } else {
                            false
                        }
                    };
                    if should_emit {
                        emit_changed(app);
                    }
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

    // ドライブレター変動(E: → F: 等)を検出したら path を再マッピングしてからスキャンする
    let remapped = {
        let conn = state.db.lock().unwrap();
        crate::core::volumes::sync_drive_letters(&conn)
            .map(|r| !r.is_empty())
            .unwrap_or_else(|e| {
                eprintln!("sync_drive_letters failed: {e}");
                false
            })
    };
    if remapped {
        crate::core::watcher::rebuild(app);
        emit_changed(app);
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup(name: &str) -> (PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("videoshelf-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::init(&dir.join("library.db")).unwrap();
        // watched_folder_id の外部キー用に監視フォルダ 2 件(A / B)を用意しておく
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (1, ?1), (2, ?2)",
            params![
                dir.join("A").to_string_lossy(),
                dir.join("B").to_string_lossy()
            ],
        )
        .unwrap();
        (dir, conn)
    }

    fn write_video(path: &Path, content: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn video_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM videos", [], |r| r.get(0)).unwrap()
    }

    /// フォルダをまたぐ移動で、スキャン順が「移動先が先」(旧レコードがまだ
    /// is_missing=0)でも移動として検出され、二重登録にならないこと
    #[test]
    fn detects_move_across_folders_when_destination_scanned_first() {
        let (dir, conn) = setup("move-across");
        let old = dir.join("A").join("動画.mp4");
        let new = dir.join("B").join("動画.mp4");
        write_video(&old, b"videoshelf-test-content");

        let mut roots = offline::RootCache::default();
        upsert_file(&conn, &mut roots, &old, Some(1)).unwrap();
        // ユーザーが付けたデータが引き継がれることの確認用
        conn.execute("UPDATE videos SET rating = 5", []).unwrap();

        // 実ファイルを別フォルダへ移動。旧レコードは is_missing=0 のまま
        write_video(&new, b"videoshelf-test-content");
        std::fs::remove_file(&old).unwrap();
        upsert_file(&conn, &mut roots, &new, Some(2)).unwrap();

        let (path, rating, missing, folder): (String, i64, i64, i64) = conn
            .query_row("SELECT path, rating, is_missing, watched_folder_id FROM videos", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!(video_count(&conn), 1, "移動なのに二重登録されている");
        assert_eq!(path, new.to_string_lossy());
        assert_eq!(rating, 5, "レーティングが引き継がれていない");
        assert_eq!(missing, 0);
        assert_eq!(folder, 2, "移動先の監視フォルダに付け替わっていない");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同じ内容のファイルが両方に実在する場合は移動ではないので、別レコードになること
    #[test]
    fn keeps_copies_as_separate_entries() {
        let (dir, conn) = setup("copy");
        let a = dir.join("A").join("同じ中身.mp4");
        let b = dir.join("B").join("同じ中身.mp4");
        write_video(&a, b"videoshelf-test-content");
        write_video(&b, b"videoshelf-test-content");

        let mut roots = offline::RootCache::default();
        upsert_file(&conn, &mut roots, &a, Some(1)).unwrap();
        upsert_file(&conn, &mut roots, &b, Some(1)).unwrap();

        assert_eq!(video_count(&conn), 2, "実在するコピーが移動扱いにされている");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 旧レコードが missing 済みのケース(従来からの経路)も引き続き動くこと
    #[test]
    fn detects_move_from_missing_entry() {
        let (dir, conn) = setup("move-missing");
        let old = dir.join("A").join("旧.mp4");
        let new = dir.join("A").join("新.mp4");
        write_video(&old, b"videoshelf-test-content");

        let mut roots = offline::RootCache::default();
        upsert_file(&conn, &mut roots, &old, Some(1)).unwrap();
        write_video(&new, b"videoshelf-test-content");
        std::fs::remove_file(&old).unwrap();
        conn.execute("UPDATE videos SET is_missing = 1", []).unwrap();

        upsert_file(&conn, &mut roots, &new, Some(1)).unwrap();

        let (path, missing): (String, i64) = conn
            .query_row("SELECT path, is_missing FROM videos", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(video_count(&conn), 1);
        assert_eq!(path, new.to_string_lossy());
        assert_eq!(missing, 0, "復帰したのに missing のまま");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 監視フォルダを解除して同じフォルダを登録し直したとき、
    /// 既存レコードの所属が張り直されて件数が 0 にならないこと。
    /// 解除時は ON DELETE SET NULL で watched_folder_id が NULL になるため、
    /// 再スキャンで拾わないと「動画はあるのに件数 0」になる
    #[test]
    fn re_registering_a_watched_folder_reattaches_its_videos() {
        let (dir, conn) = setup("re-register");
        let file = dir.join("A").join("動画.mp4");
        write_video(&file, b"videoshelf-test-content");

        let mut roots = offline::RootCache::default();
        upsert_file(&conn, &mut roots, &file, Some(1)).unwrap();

        // 監視フォルダを解除(動画は残す)。FK の ON DELETE SET NULL が効く
        conn.execute("DELETE FROM watched_folders WHERE id = 1", []).unwrap();
        let orphan: Option<i64> = conn
            .query_row("SELECT watched_folder_id FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphan, None, "解除で所属が外れる前提が崩れている");

        // 同じフォルダを登録し直す(id は新しくなる)
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (9, ?1)",
            params![dir.join("A").to_string_lossy()],
        )
        .unwrap();
        upsert_file(&conn, &mut roots, &file, Some(9)).unwrap();

        let folder: Option<i64> = conn
            .query_row("SELECT watched_folder_id FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(video_count(&conn), 1);
        assert_eq!(folder, Some(9), "再登録したフォルダに所属が戻っていない");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 個別登録(folder_id = None)で既存の所属を消さないこと
    #[test]
    fn individual_registration_keeps_existing_ownership() {
        let (dir, conn) = setup("individual");
        let file = dir.join("A").join("動画.mp4");
        write_video(&file, b"videoshelf-test-content");

        let mut roots = offline::RootCache::default();
        upsert_file(&conn, &mut roots, &file, Some(1)).unwrap();
        upsert_file(&conn, &mut roots, &file, None).unwrap();

        let folder: Option<i64> = conn
            .query_row("SELECT watched_folder_id FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(folder, Some(1), "個別登録で監視フォルダの所属が外れている");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 親フォルダを後から監視フォルダに追加しても、既に子フォルダに所属している
    /// 動画を親が奪わないこと(常に最も深い監視フォルダに所属させる)
    #[test]
    fn nested_watched_folder_keeps_the_deeper_owner() {
        let (dir, conn) = setup("nested-owner");
        // A = 子(id 1)、その親(id 3)を後から追加した状況を作る
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (3, ?1)",
            params![dir.to_string_lossy()],
        )
        .unwrap();
        let index = watched_folder_index(&conn);

        let inside = dir.join("A").join("子の動画.mp4").to_string_lossy().to_string();
        assert_eq!(deepest_owner(&index, &inside), Some(1), "深い方(A)に所属させるはず");

        let outside = dir.join("直下の動画.mp4").to_string_lossy().to_string();
        assert_eq!(deepest_owner(&index, &outside), Some(3), "親フォルダ直下は親に所属");

        // 大文字小文字と区切りの揺れも吸収する
        let messy = inside.to_uppercase().replace('\\', "/");
        assert_eq!(deepest_owner(&index, &messy), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
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
