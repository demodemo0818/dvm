use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub video_count: i64,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color,
                (SELECT COUNT(*) FROM video_tags vt WHERE vt.tag_id = t.id) AS cnt
         FROM tags t ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                video_count: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 名前からタグ id を取得。無ければ作る
pub fn ensure_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "タグ名が空です");
    conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![name])?;
    let id = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))?;
    Ok(id)
}

pub fn tag_videos(conn: &Connection, actor: &str, video_ids: &[i64], tag_name: &str) -> Result<i64> {
    let tag_id = ensure_tag(conn, tag_name)?;
    conn.execute_batch("BEGIN")?;
    for vid in video_ids {
        conn.execute(
            "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
            params![vid, tag_id],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    db::log_op(conn, actor, "tag_videos", &format!("tag={tag_name} videos={video_ids:?}"));
    Ok(tag_id)
}

pub fn untag_videos(conn: &Connection, actor: &str, video_ids: &[i64], tag_id: i64) -> Result<()> {
    conn.execute_batch("BEGIN")?;
    for vid in video_ids {
        conn.execute(
            "DELETE FROM video_tags WHERE video_id = ?1 AND tag_id = ?2",
            params![vid, tag_id],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    db::log_op(conn, actor, "untag_videos", &format!("tag_id={tag_id} videos={video_ids:?}"));
    Ok(())
}

pub fn rename_tag(conn: &Connection, actor: &str, tag_id: i64, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "タグ名が空です");
    conn.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![new_name, tag_id])?;
    db::log_op(conn, actor, "rename_tag", &format!("tag_id={tag_id} new_name={new_name}"));
    Ok(())
}

pub fn delete_tag(conn: &Connection, actor: &str, tag_id: i64) -> Result<()> {
    // video_tags は ON DELETE CASCADE で一緒に消える
    conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
    db::log_op(conn, actor, "delete_tag", &format!("tag_id={tag_id}"));
    Ok(())
}

/// 指定した全動画に共通して付いているタグを返す(インスペクタ表示用)
pub fn tags_for_videos(conn: &Connection, video_ids: &[i64]) -> Result<Vec<Tag>> {
    if video_ids.is_empty() {
        return Ok(Vec::new());
    }
    // video_ids は i64 なので直接埋め込んでも安全
    let ids_csv = video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT t.id, t.name, t.color, COUNT(*) AS cnt
         FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         WHERE vt.video_id IN ({ids_csv})
         GROUP BY t.id
         HAVING COUNT(*) = {n}
         ORDER BY t.name COLLATE NOCASE",
        n = video_ids.len()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                video_count: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
