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
    /// 親タグ(NULL = トップレベル)。サイドバーのツリー表示に使う
    pub parent_id: Option<i64>,
    pub video_count: i64,
}

fn map_tag(r: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        parent_id: r.get(3)?,
        video_count: r.get(4)?,
    })
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.parent_id,
                (SELECT COUNT(*) FROM video_tags vt WHERE vt.tag_id = t.id) AS cnt
         FROM tags t ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], map_tag)?.filter_map(|r| r.ok()).collect();
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
        "SELECT t.id, t.name, t.color, t.parent_id, COUNT(*) AS cnt
         FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         WHERE vt.video_id IN ({ids_csv})
         GROUP BY t.id
         HAVING COUNT(*) = {n}
         ORDER BY t.name COLLATE NOCASE",
        n = video_ids.len()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_tag)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

/// タグの表示色を設定する(None で色なしに戻す)。`#rrggbb` 形式だけ受け付ける
pub fn set_tag_color(conn: &Connection, actor: &str, tag_id: i64, color: Option<&str>) -> Result<()> {
    let color = color.map(str::trim).filter(|c| !c.is_empty());
    if let Some(c) = color {
        anyhow::ensure!(
            c.len() == 7
                && c.starts_with('#')
                && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()),
            "色は #rrggbb 形式で指定してください"
        );
    }
    conn.execute("UPDATE tags SET color = ?1 WHERE id = ?2", params![color, tag_id])?;
    db::log_op(
        conn,
        actor,
        "set_tag_color",
        &format!("tag_id={tag_id} color={}", color.unwrap_or("(なし)")),
    );
    Ok(())
}

/// 指定タグの子孫 id をすべて返す(自分自身を含む)
fn descendants(conn: &Connection, tag_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id
         ) SELECT id FROM sub",
    )?;
    let ids = stmt
        .query_map(params![tag_id], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

/// タグの親を設定する(None でトップレベルに戻す)。
/// 自分自身や自分の子孫を親にすると木が循環して再帰 CTE が無限に回るので必ず弾く
pub fn set_tag_parent(
    conn: &Connection,
    actor: &str,
    tag_id: i64,
    parent_id: Option<i64>,
) -> Result<()> {
    if let Some(pid) = parent_id {
        anyhow::ensure!(pid != tag_id, "タグ自身を親にはできません");
        anyhow::ensure!(
            !descendants(conn, tag_id)?.contains(&pid),
            "自分の子タグを親にはできません(循環します)"
        );
    }
    conn.execute("UPDATE tags SET parent_id = ?1 WHERE id = ?2", params![parent_id, tag_id])?;
    db::log_op(
        conn,
        actor,
        "set_tag_parent",
        &format!("tag_id={tag_id} parent_id={parent_id:?}"),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO tags (id, name, parent_id) VALUES
               (1, '家族', NULL), (2, '旅行', 1), (3, '沖縄', 2), (4, '料理', NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn set_tag_parent_rejects_cycles() {
        let conn = setup();
        // 家族 → 旅行 → 沖縄 の木。沖縄を家族の親にすると循環する
        assert!(set_tag_parent(&conn, "user", 1, Some(3)).is_err());
        assert!(set_tag_parent(&conn, "user", 1, Some(1)).is_err());
        // 無関係なタグを親にするのは通る
        assert!(set_tag_parent(&conn, "user", 4, Some(1)).is_ok());
        // 親を外してトップレベルに戻せる
        assert!(set_tag_parent(&conn, "user", 3, None).is_ok());
    }

    #[test]
    fn set_tag_color_validates_format() {
        let conn = setup();
        assert!(set_tag_color(&conn, "user", 1, Some("#ff8800")).is_ok());
        assert!(set_tag_color(&conn, "user", 1, Some("ff8800")).is_err());
        assert!(set_tag_color(&conn, "user", 1, Some("#xyz")).is_err());
        // 空文字は「色なし」として受け取る
        assert!(set_tag_color(&conn, "user", 1, Some("")).is_ok());
        let color: Option<String> = conn
            .query_row("SELECT color FROM tags WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(color, None);
    }
}
