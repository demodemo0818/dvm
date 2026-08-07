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
    /// 所属グループ(NULL = 未分類)
    pub group_id: Option<i64>,
    /// グループ名。UI の見出しと、AI にタグの軸を伝えるために持たせている
    pub group_name: Option<String>,
    pub video_count: i64,
}

/// タグをまとめる軸(v1.19)。グループ自体は動画に付かない
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagGroup {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    /// このグループに属するタグの数
    pub tag_count: i64,
}

/// 選択中の動画に、そのタグが何件付いているか。
/// タグパレットの 3 状態(全部 / 一部 / なし)を出すために使う
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag_id: i64,
    pub count: i64,
}

fn map_tag(r: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        group_id: r.get(3)?,
        group_name: r.get(4)?,
        video_count: r.get(5)?,
    })
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.group_id, g.name,
                (SELECT COUNT(*) FROM video_tags vt WHERE vt.tag_id = t.id) AS cnt
         FROM tags t LEFT JOIN tag_groups g ON g.id = t.group_id
         ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], map_tag)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

pub fn list_tag_groups(conn: &Connection) -> Result<Vec<TagGroup>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.sort_order,
                (SELECT COUNT(*) FROM tags t WHERE t.group_id = g.id) AS cnt
         FROM tag_groups g ORDER BY g.sort_order, g.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                sort_order: r.get(2)?,
                tag_count: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 名前からタグ id を取得。無ければ作る(未分類で作られる)。
/// **名前で引く経路はここだけ**にしてある。MCP・AI アシスタントもこれを通る
pub fn ensure_tag(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "タグ名が空です");
    conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![name])?;
    let id = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))?;
    Ok(id)
}

/// タグを動画に付けずに作る(v1.19。あらかじめ体系を組んでおくための入口)。
/// 既にある名前は弾く — ensure_tag と違い「作ったつもりが既存タグだった」を隠したくないため
pub fn create_tag(conn: &Connection, actor: &str, name: &str, group_id: Option<i64>) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "タグ名が空です");
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM tags WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |r| r.get(0),
    )?;
    anyhow::ensure!(!exists, "タグ「{name}」は既にあります");
    conn.execute(
        "INSERT INTO tags (name, group_id) VALUES (?1, ?2)",
        params![name, group_id],
    )?;
    let id = conn.last_insert_rowid();
    db::log_op(
        conn,
        actor,
        "create_tag",
        &serde_json::json!({ "tagId": id, "tag": name, "groupId": group_id }).to_string(),
    );
    Ok(id)
}

pub fn tag_videos(conn: &Connection, actor: &str, video_ids: &[i64], tag_name: &str) -> Result<i64> {
    let tag_id = ensure_tag(conn, tag_name)?;
    // 取り消しのために「実際に付いた動画」だけを記録する。
    // 元から付いていたものまで記録すると、取り消しでそれも外れてしまう
    let mut added = Vec::new();
    // 生の BEGIN は途中の ? で抜けるとトランザクションが開きっぱなしになる。
    // unchecked_transaction なら drop で自動 ROLLBACK される(mark_opened と同じ)
    let tx = conn.unchecked_transaction()?;
    for vid in video_ids {
        let n = tx.execute(
            "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
            params![vid, tag_id],
        )?;
        if n > 0 {
            added.push(*vid);
        }
    }
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "tag_videos",
        &serde_json::json!({ "tagId": tag_id, "tag": tag_name, "added": added }).to_string(),
    );
    Ok(tag_id)
}

pub fn untag_videos(conn: &Connection, actor: &str, video_ids: &[i64], tag_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM tags WHERE id = ?1", params![tag_id], |r| r.get(0))
        .unwrap_or_default();
    let mut removed = Vec::new();
    let tx = conn.unchecked_transaction()?;
    for vid in video_ids {
        let n = tx.execute(
            "DELETE FROM video_tags WHERE video_id = ?1 AND tag_id = ?2",
            params![vid, tag_id],
        )?;
        if n > 0 {
            removed.push(*vid);
        }
    }
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "untag_videos",
        &serde_json::json!({ "tagId": tag_id, "tag": name, "removed": removed }).to_string(),
    );
    Ok(())
}

pub fn rename_tag(conn: &Connection, actor: &str, tag_id: i64, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "タグ名が空です");
    let before: String = conn
        .query_row("SELECT name FROM tags WHERE id = ?1", params![tag_id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![new_name, tag_id])?;
    db::log_op(
        conn,
        actor,
        "rename_tag",
        &serde_json::json!({ "tagId": tag_id, "before": before, "after": new_name }).to_string(),
    );
    Ok(())
}

pub fn delete_tag(conn: &Connection, actor: &str, tag_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM tags WHERE id = ?1", params![tag_id], |r| r.get(0))
        .unwrap_or_default();
    // video_tags は ON DELETE CASCADE で一緒に消える
    conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
    db::log_op(
        conn,
        actor,
        "delete_tag",
        &serde_json::json!({ "tagId": tag_id, "tag": name }).to_string(),
    );
    Ok(())
}

/// 指定した全動画に共通して付いているタグを返す(詳細ペインのチップ表示用)
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
        "SELECT t.id, t.name, t.color, t.group_id, g.name, COUNT(*) AS cnt
         FROM tags t
         JOIN video_tags vt ON vt.tag_id = t.id
         LEFT JOIN tag_groups g ON g.id = t.group_id
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

/// 選択中の動画それぞれについて、タグごとの付与件数を返す。
/// 呼び出し側は count == 選択数 なら「全部に付いている」、0 < count < 選択数 なら
/// 「一部に付いている」と判断する(タグパレットの半チェック表示)
pub fn tag_counts_for_videos(conn: &Connection, video_ids: &[i64]) -> Result<Vec<TagCount>> {
    if video_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_csv = video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT tag_id, COUNT(*) FROM video_tags
         WHERE video_id IN ({ids_csv}) GROUP BY tag_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagCount {
                tag_id: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
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
        &serde_json::json!({ "tagId": tag_id, "color": color }).to_string(),
    );
    Ok(())
}

/// タグの所属グループを変える(None で未分類に戻す)。
/// グループは階層を持たないので、旧 set_tag_parent にあった循環チェックは要らない
pub fn set_tag_group(
    conn: &Connection,
    actor: &str,
    tag_id: i64,
    group_id: Option<i64>,
) -> Result<()> {
    if let Some(gid) = group_id {
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM tag_groups WHERE id = ?1",
            params![gid],
            |r| r.get(0),
        )?;
        anyhow::ensure!(exists, "グループが見つかりません");
    }
    conn.execute("UPDATE tags SET group_id = ?1 WHERE id = ?2", params![group_id, tag_id])?;
    db::log_op(
        conn,
        actor,
        "set_tag_group",
        &serde_json::json!({ "tagId": tag_id, "groupId": group_id }).to_string(),
    );
    Ok(())
}

pub fn create_tag_group(conn: &Connection, actor: &str, name: &str) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "グループ名が空です");
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM tag_groups WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |r| r.get(0),
    )?;
    anyhow::ensure!(!exists, "グループ「{name}」は既にあります");
    // 新しいグループは末尾に置く(既存の並びを崩さない)
    conn.execute(
        "INSERT INTO tag_groups (name, sort_order)
         VALUES (?1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag_groups))",
        params![name],
    )?;
    let id = conn.last_insert_rowid();
    db::log_op(
        conn,
        actor,
        "create_tag_group",
        &serde_json::json!({ "groupId": id, "group": name }).to_string(),
    );
    Ok(id)
}

pub fn rename_tag_group(conn: &Connection, actor: &str, group_id: i64, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "グループ名が空です");
    let before: String = conn
        .query_row("SELECT name FROM tag_groups WHERE id = ?1", params![group_id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute(
        "UPDATE tag_groups SET name = ?1 WHERE id = ?2",
        params![new_name, group_id],
    )?;
    db::log_op(
        conn,
        actor,
        "rename_tag_group",
        &serde_json::json!({ "groupId": group_id, "before": before, "after": new_name }).to_string(),
    );
    Ok(())
}

/// グループを削除する。**中のタグは消えない** — group_id が NULL になって未分類に落ちるだけで、
/// 動画に付いたタグはそのまま残る(tags.group_id の ON DELETE SET NULL)
pub fn delete_tag_group(conn: &Connection, actor: &str, group_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM tag_groups WHERE id = ?1", params![group_id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("DELETE FROM tag_groups WHERE id = ?1", params![group_id])?;
    db::log_op(
        conn,
        actor,
        "delete_tag_group",
        &serde_json::json!({ "groupId": group_id, "group": name }).to_string(),
    );
    Ok(())
}

/// グループの表示順を id の並び順どおりに振り直す。
/// 表示順は動画のメタデータではないので operations_log には残さない(履歴が並べ替えで埋まる)
pub fn reorder_tag_groups(conn: &Connection, group_ids: &[i64]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, gid) in group_ids.iter().enumerate() {
        tx.execute(
            "UPDATE tag_groups SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, gid],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO tag_groups (id, name, sort_order) VALUES (1, 'ジャンル', 0), (2, 'メディア', 1);
             INSERT INTO tags (id, name, group_id) VALUES
               (1, 'ファンタジー', 1), (2, 'SF', 1), (3, 'アニメ', 2), (4, '未分類タグ', NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn deleting_a_group_keeps_its_tags() {
        let conn = setup();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        delete_tag_group(&conn, "user", 1).unwrap();
        // タグは消えず、未分類に落ちるだけ
        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags.len(), 4);
        let fantasy = tags.iter().find(|t| t.name == "ファンタジー").unwrap();
        assert_eq!(fantasy.group_id, None);
        assert_eq!(fantasy.group_name, None);
    }

    #[test]
    fn create_tag_rejects_duplicates() {
        let conn = setup();
        assert!(create_tag(&conn, "user", "ホラー", Some(1)).is_ok());
        // 大文字小文字違いも同じ名前とみなす(タグ一覧に紛らわしい重複を作らない)
        assert!(create_tag(&conn, "user", "ホラー", Some(2)).is_err());
        assert!(create_tag(&conn, "user", "  ", None).is_err());
    }

    #[test]
    fn set_tag_group_moves_and_clears() {
        let conn = setup();
        set_tag_group(&conn, "user", 4, Some(1)).unwrap();
        let tags = list_tags(&conn).unwrap();
        let moved = tags.iter().find(|t| t.id == 4).unwrap();
        assert_eq!(moved.group_id, Some(1));
        assert_eq!(moved.group_name.as_deref(), Some("ジャンル"));

        set_tag_group(&conn, "user", 4, None).unwrap();
        assert_eq!(list_tags(&conn).unwrap().iter().find(|t| t.id == 4).unwrap().group_id, None);
        // 存在しないグループは弾く
        assert!(set_tag_group(&conn, "user", 4, Some(99)).is_err());
    }

    #[test]
    fn tag_counts_reports_partial_assignment() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO videos (id, path, filename) VALUES
               (10, 'X:\\a.mp4', 'a.mp4'), (11, 'X:\\b.mp4', 'b.mp4');
             INSERT INTO video_tags (video_id, tag_id) VALUES (10, 1), (11, 1), (10, 3);",
        )
        .unwrap();
        let counts = tag_counts_for_videos(&conn, &[10, 11]).unwrap();
        let get = |id: i64| counts.iter().find(|c| c.tag_id == id).map(|c| c.count);
        // ファンタジーは 2 件とも(= 全部に付いている)、アニメは 1 件だけ(= 一部)
        assert_eq!(get(1), Some(2));
        assert_eq!(get(3), Some(1));
        assert_eq!(get(2), None);
    }

    #[test]
    fn reorder_renumbers_groups() {
        let conn = setup();
        reorder_tag_groups(&conn, &[2, 1]).unwrap();
        let groups = list_tag_groups(&conn).unwrap();
        assert_eq!(groups[0].name, "メディア");
        assert_eq!(groups[1].name, "ジャンル");
        assert_eq!(groups[0].tag_count, 1);
        assert_eq!(groups[1].tag_count, 2);
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
