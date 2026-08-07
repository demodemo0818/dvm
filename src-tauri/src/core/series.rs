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
pub fn add_videos_to_series(conn: &Connection, actor: &str, video_ids: &[i64], name: &str) -> Result<i64> {
    let series_id = ensure_series(conn, name)?;
    // 取り消しのために「実際に増えた組」だけを記録する。
    // 既に入っていた動画まで記録すると、取り消しで元から入っていたものまで外れてしまう
    let mut added = Vec::new();
    // 生の BEGIN は途中の ? で抜けると開きっぱなしになる(drop で自動 ROLLBACK させる)
    let tx = conn.unchecked_transaction()?;
    for vid in video_ids {
        let n = tx.execute(
            "INSERT OR IGNORE INTO series_entries (series_id, video_id, position)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(position), 0) + 1 FROM series_entries WHERE series_id = ?1))",
            params![series_id, vid],
        )?;
        if n > 0 {
            added.push(*vid);
        }
    }
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "add_to_series",
        &serde_json::json!({ "seriesId": series_id, "series": name, "added": added }).to_string(),
    );
    Ok(series_id)
}

pub fn remove_videos_from_series(conn: &Connection, actor: &str, video_ids: &[i64], series_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM series WHERE id = ?1", params![series_id], |r| r.get(0))
        .unwrap_or_default();
    // 取り消しで並び順まで戻せるよう position ごと控えておく
    let mut removed = Vec::new();
    let tx = conn.unchecked_transaction()?;
    for vid in video_ids {
        let position: Option<i64> = tx
            .query_row(
                "SELECT position FROM series_entries WHERE series_id = ?1 AND video_id = ?2",
                params![series_id, vid],
                |r| r.get(0),
            )
            .ok();
        let n = tx.execute(
            "DELETE FROM series_entries WHERE series_id = ?1 AND video_id = ?2",
            params![series_id, vid],
        )?;
        if n > 0 {
            removed.push(serde_json::json!({ "id": vid, "position": position.unwrap_or(0) }));
        }
    }
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "remove_from_series",
        &serde_json::json!({ "seriesId": series_id, "series": name, "removed": removed })
            .to_string(),
    );
    Ok(())
}

/// シリーズ名を変える(v1.20。サイドバーの右クリックメニューから)。
///
/// **同名チェックはここで持つ**。tags と違って series には UNIQUE 制約が無く
/// (ensure_series が COLLATE NOCASE の検索で拾っているだけ)、DB は止めてくれない。
/// 素通しすると同名のシリーズが 2 つ並び、以後 ensure_series は片方しか掴めなくなる
pub fn rename_series(conn: &Connection, actor: &str, series_id: i64, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "シリーズ名が空です");
    let taken: Option<i64> = conn
        .query_row(
            "SELECT id FROM series WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![new_name, series_id],
            |r| r.get(0),
        )
        .ok();
    anyhow::ensure!(taken.is_none(), "同じ名前のシリーズがすでにあります");
    let before: String = conn
        .query_row("SELECT name FROM series WHERE id = ?1", params![series_id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("UPDATE series SET name = ?1 WHERE id = ?2", params![new_name, series_id])?;
    db::log_op(
        conn,
        actor,
        "rename_series",
        &serde_json::json!({ "seriesId": series_id, "before": before, "after": new_name })
            .to_string(),
    );
    Ok(())
}

pub fn delete_series(conn: &Connection, actor: &str, series_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM series WHERE id = ?1", params![series_id], |r| r.get(0))
        .unwrap_or_default();
    // series_entries は ON DELETE CASCADE
    conn.execute("DELETE FROM series WHERE id = ?1", params![series_id])?;
    db::log_op(
        conn,
        actor,
        "delete_series",
        &serde_json::json!({ "seriesId": series_id, "series": name }).to_string(),
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn rename_rejects_duplicate_names() {
        let conn = setup();
        let a = ensure_series(&conn, "第 1 期").unwrap();
        ensure_series(&conn, "第 2 期").unwrap();

        // series には UNIQUE が無いので、ここで弾けないと同名が 2 つ並ぶ
        assert!(rename_series(&conn, "user", a, "第 2 期").is_err());
        // 大文字小文字違いも同じ名前とみなす(ensure_series の検索と揃える)
        ensure_series(&conn, "Season 2").unwrap();
        assert!(rename_series(&conn, "user", a, "season 2").is_err());
        assert!(rename_series(&conn, "user", a, "  ").is_err());

        // 自分自身と同じ名前は通す(大文字小文字だけ直したいことがある)
        assert!(rename_series(&conn, "user", a, "第 1 期").is_ok());
        assert!(rename_series(&conn, "user", a, "第 1 期(再)").is_ok());
        let names: Vec<String> = list_series(&conn).unwrap().into_iter().map(|s| s.name).collect();
        assert!(names.contains(&"第 1 期(再)".to_string()));
    }
}
