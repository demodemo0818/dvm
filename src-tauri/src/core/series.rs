use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub id: i64,
    pub name: String,
    pub video_count: i64,
}

pub fn list_series(conn: &Connection) -> Result<Vec<Series>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name,
                (SELECT COUNT(*) FROM series_entries se WHERE se.series_id = s.id) AS cnt
         FROM series s ORDER BY s.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Series { id: r.get(0)?, name: r.get(1)?, video_count: r.get(2)? })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 名前からシリーズ id を取得。無ければ作る
pub fn ensure_series(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "シリーズ名が空です");
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM series WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute("INSERT INTO series (name) VALUES (?1)", params![name])?;
    Ok(conn.last_insert_rowid())
}

/// 動画をシリーズに追加(末尾に追加。既に入っていれば何もしない)
pub fn add_videos_to_series(conn: &Connection, video_ids: &[i64], name: &str) -> Result<i64> {
    let series_id = ensure_series(conn, name)?;
    conn.execute_batch("BEGIN")?;
    for vid in video_ids {
        conn.execute(
            "INSERT OR IGNORE INTO series_entries (series_id, video_id, position)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM series_entries WHERE series_id = ?1))",
            params![series_id, vid],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    db::log_op(conn, "user", "add_to_series", &format!("series={name} videos={video_ids:?}"));
    Ok(series_id)
}

pub fn remove_videos_from_series(conn: &Connection, video_ids: &[i64], series_id: i64) -> Result<()> {
    conn.execute_batch("BEGIN")?;
    for vid in video_ids {
        conn.execute(
            "DELETE FROM series_entries WHERE series_id = ?1 AND video_id = ?2",
            params![series_id, vid],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    db::log_op(
        conn,
        "user",
        "remove_from_series",
        &format!("series_id={series_id} videos={video_ids:?}"),
    );
    Ok(())
}

pub fn delete_series(conn: &Connection, series_id: i64) -> Result<()> {
    // series_entries は ON DELETE CASCADE
    conn.execute("DELETE FROM series WHERE id = ?1", params![series_id])?;
    db::log_op(conn, "user", "delete_series", &format!("series_id={series_id}"));
    Ok(())
}

/// 指定した全動画が共通して属しているシリーズ(インスペクタ表示用)
pub fn series_for_videos(conn: &Connection, video_ids: &[i64]) -> Result<Vec<Series>> {
    if video_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_csv = video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT s.id, s.name, COUNT(*) AS cnt
         FROM series s
         JOIN series_entries se ON se.series_id = s.id
         WHERE se.video_id IN ({ids_csv})
         GROUP BY s.id
         HAVING COUNT(*) = {n}
         ORDER BY s.name COLLATE NOCASE",
        n = video_ids.len()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Series { id: r.get(0)?, name: r.get(1)?, video_count: r.get(2)? })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
