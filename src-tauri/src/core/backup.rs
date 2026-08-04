use crate::core::settings;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 起動時自動バックアップの保持世代数(manual- は対象外)
pub const AUTO_KEEP: usize = 5;

/// **ライブラリごと**の記録(v1.27)。アプリ全体設定(app.db)には移さない ——
/// 移すと「A を開いた 24 時間以内に B を開くと B のバックアップが取られない」ことになる
pub const LAST_AUTO_KEY: &str = "last_auto_backup_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub path: String,
    pub size: i64,
    pub created_at: String, // "YYYY-MM-DD HH:MM"
}

/// VACUUM INTO でスナップショットを作る。kind は "auto" | "manual"
pub fn backup_now(conn: &Connection, backups_dir: &Path, kind: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(backups_dir)?;
    let stamp: String = conn.query_row(
        "SELECT strftime('%Y%m%d-%H%M%S', 'now', 'localtime')",
        [],
        |r| r.get(0),
    )?;
    let dest = backups_dir.join(format!("{kind}-{stamp}.db"));
    // VACUUM INTO は既存ファイルがあると失敗するため先に消す(同秒の再実行対策)
    if dest.exists() {
        std::fs::remove_file(&dest)?;
    }
    conn.execute(
        "VACUUM INTO ?1",
        params![dest.to_string_lossy().to_string()],
    )?;
    Ok(dest)
}

/// auto- プレフィックスのバックアップを新しい順 keep 件残して削除する(manual- は消さない)
pub fn prune_auto(backups_dir: &Path, keep: usize) -> Result<()> {
    let mut autos: Vec<BackupInfo> = list_backups(backups_dir)?
        .into_iter()
        .filter(|b| b.file_name.starts_with("auto-"))
        .collect();
    // list_backups は新しい順なので keep 件目以降を削除
    for old in autos.drain(..).skip(keep) {
        let _ = std::fs::remove_file(&old.path);
    }
    Ok(())
}

/// バックアップ一覧(新しい順)
pub fn list_backups(backups_dir: &Path) -> Result<Vec<BackupInfo>> {
    let mut out: Vec<BackupInfo> = Vec::new();
    let Ok(entries) = std::fs::read_dir(backups_dir) else {
        return Ok(out); // フォルダ未作成 = バックアップなし
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_file() || !name.ends_with(".db") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(BackupInfo {
            file_name: name,
            path: path.to_string_lossy().to_string(),
            size: meta.len() as i64,
            created_at: format_local(mtime),
        });
    }
    // ファイル名にタイムスタンプが入っているので名前の降順 = 新しい順
    out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(out)
}

fn format_local(unix_secs: i64) -> String {
    // chrono を増やさず SQLite に整形させる(接続不要のワンショット)
    Connection::open_in_memory()
        .and_then(|c| {
            c.query_row(
                "SELECT strftime('%Y-%m-%d %H:%M', ?1, 'unixepoch', 'localtime')",
                params![unix_secs],
                |r| r.get(0),
            )
        })
        .unwrap_or_default()
}

/// 復元の予約ファイル名。ここに書いたパスを次回起動時に library.db へコピーする
const PENDING_RESTORE: &str = "restore.pending";

/// バックアップからの復元を**予約**する(v1.9)。
///
/// 起動中に library.db を差し替えると、開いているコネクション(書き込み用・読み取り用・
/// data_version 監視スレッド)と競合して壊れる。そこで「次回起動時に適用」方式にする:
/// ここでは中身を検証して予約ファイルを書くだけで、実際の差し替えは
/// `apply_pending_restore` が db::init の**前**に行う。
///
/// `lib_root` は**現在開いているライブラリのフォルダ**(v1.27。予約ファイルもそこに置く)。
///
/// 戻り値は退避した現行 DB のパス(取り違えたときの戻り先)
pub fn request_restore(
    conn: &Connection,
    lib_root: &Path,
    backups_dir: &Path,
    backup_path: &Path,
) -> Result<PathBuf> {
    // 壊れたファイルを予約すると次回起動できなくなるので、ここで必ず開いて確かめる
    // (検証はライブラリ切り替えと共用。core/libraries.rs)
    crate::core::libraries::validate_db(backup_path)?;

    // 今の DB もバックアップとして残す(復元を取り違えても戻せるように)
    let safety = backup_now(conn, backups_dir, "pre-restore")?;

    std::fs::write(
        lib_root.join(PENDING_RESTORE),
        backup_path.to_string_lossy().as_bytes(),
    )?;
    Ok(safety)
}

/// 予約された復元を適用する。**db::init より前に呼ぶこと**(まだ誰も DB を開いていない状態)。
/// 戻り値は適用したバックアップのパス
pub fn apply_pending_restore(lib_root: &Path) -> Option<PathBuf> {
    let pending = lib_root.join(PENDING_RESTORE);
    let src = std::fs::read_to_string(&pending).ok()?;
    let src = PathBuf::from(src.trim());
    // 予約は成否にかかわらず消す(失敗したまま毎回試し続けないように)
    let _ = std::fs::remove_file(&pending);
    if !src.is_file() {
        return None;
    }

    let db_path = lib_root.join("library.db");
    if std::fs::copy(&src, &db_path).is_err() {
        return None;
    }
    // 差し替え前の WAL / SHM が残っていると新しい本体と食い違う。
    // VACUUM INTO の出力は単一ファイルなので消してよい
    let _ = std::fs::remove_file(lib_root.join("library.db-wal"));
    let _ = std::fs::remove_file(lib_root.join("library.db-shm"));
    Some(src)
}

/// 起動時用: 前回の自動バックアップから 24 時間以上経過していたら実行し、世代を整理する
pub fn auto_backup_if_due(conn: &Connection, backups_dir: &Path) -> Result<Option<PathBuf>> {
    if let Some(last) = settings::get(conn, LAST_AUTO_KEY)? {
        let due: bool = conn.query_row(
            "SELECT (julianday('now', 'localtime') - julianday(?1)) >= 1.0",
            params![last],
            |r| r.get(0),
        )?;
        if !due {
            return Ok(None);
        }
    }
    let dest = backup_now(conn, backups_dir, "auto")?;
    let now: String = conn.query_row(
        "SELECT datetime('now', 'localtime')",
        [],
        |r| r.get(0),
    )?;
    settings::set(conn, LAST_AUTO_KEY, &now)?;
    prune_auto(backups_dir, AUTO_KEEP)?;
    Ok(Some(dest))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1.27 以降、予約ファイルと DB の置き場は**ライブラリフォルダ**。
    /// アプリのデータフォルダと同じ場所ではないので、テストでも別の階層に作る
    fn workspace(name: &str) -> PathBuf {
        let data_dir = std::env::temp_dir().join(format!("dvm-test-backup-{name}"));
        let _ = std::fs::remove_dir_all(&data_dir);
        let lib_root = data_dir.join("libraries").join("マイライブラリ");
        std::fs::create_dir_all(lib_root.join("backups")).unwrap();
        lib_root
    }

    /// 予約 → 再起動相当(apply)→ 中身が入れ替わっていることを通しで見る
    #[test]
    fn restore_is_applied_on_next_startup() {
        let dir = workspace("restore");
        let db_path = dir.join("library.db");
        let backups = dir.join("backups");

        // 「昔の状態」を作ってバックアップを取る
        let conn = crate::db::init(&db_path).unwrap();
        conn.execute("INSERT INTO videos (id, path, filename) VALUES (1, 'C:\\a.mp4', 'a.mp4')", [])
            .unwrap();
        let snapshot = backup_now(&conn, &backups, "manual").unwrap();

        // その後さらに動画を足す(復元で消えるはずの変更)
        conn.execute("INSERT INTO videos (id, path, filename) VALUES (2, 'C:\\b.mp4', 'b.mp4')", [])
            .unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM videos", [], |r| r.get(0)).unwrap(),
            2
        );

        let safety = request_restore(&conn, &dir, &backups, &snapshot).unwrap();
        assert!(safety.exists(), "復元前の状態も退避しておくこと");
        // 予約しただけの時点では現行 DB は変わっていない
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM videos", [], |r| r.get(0)).unwrap(),
            2
        );
        drop(conn);

        // 次回起動相当
        assert!(apply_pending_restore(&dir).is_some());
        assert!(!dir.join("restore.pending").exists(), "予約は消費すること");

        let restored = crate::db::init(&db_path).unwrap();
        assert_eq!(
            restored.query_row::<i64, _, _>("SELECT COUNT(*) FROM videos", [], |r| r.get(0)).unwrap(),
            1,
            "バックアップ時点の状態に戻ること"
        );

        // 2 回目の起動では何も起きない
        assert!(apply_pending_restore(&dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_files_that_are_not_a_library() {
        let dir = workspace("reject");
        let db_path = dir.join("library.db");
        let backups = dir.join("backups");
        let conn = crate::db::init(&db_path).unwrap();

        // ただのテキスト(SQLite ですらない)
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(request_restore(&conn, &dir, &backups, &junk).is_err());

        // SQLite だが videos テーブルが無い
        let other = dir.join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE t (x)")
            .unwrap();
        assert!(request_restore(&conn, &dir, &backups, &other).is_err());

        assert!(!dir.join("restore.pending").exists(), "拒否したら予約を残さないこと");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_manual_and_pre_restore_backups() {
        let dir = workspace("prune");
        let backups = dir.join("backups");
        for name in [
            "auto-20260101-000000.db",
            "auto-20260102-000000.db",
            "auto-20260103-000000.db",
            "manual-20260101-000000.db",
            "pre-restore-20260101-000000.db",
        ] {
            std::fs::write(backups.join(name), b"x").unwrap();
        }
        prune_auto(&backups, 2).unwrap();

        let names: Vec<String> =
            list_backups(&backups).unwrap().into_iter().map(|b| b.file_name).collect();
        assert!(!names.iter().any(|n| n == "auto-20260101-000000.db"), "古い auto は消す");
        assert_eq!(names.iter().filter(|n| n.starts_with("auto-")).count(), 2);
        assert!(names.iter().any(|n| n.starts_with("manual-")), "manual は消さない");
        assert!(
            names.iter().any(|n| n.starts_with("pre-restore-")),
            "復元前の退避は消さない(取り違えたときの戻り先なので)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
