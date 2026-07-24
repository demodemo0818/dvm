use crate::core::settings;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 起動時自動バックアップの保持世代数(manual- は対象外)
pub const AUTO_KEEP: usize = 5;

const LAST_AUTO_KEY: &str = "last_auto_backup_at";

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
