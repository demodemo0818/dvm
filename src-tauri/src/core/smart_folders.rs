use crate::core::query::VideoQuery;
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// 保存した検索条件。query_json は VideoQuery をそのまま JSON にしたもの
/// (UI・MCP・AI が同じクエリ型を使うので、保存形式もそれに揃える)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolder {
    pub id: i64,
    pub name: String,
    pub query_json: String,
    pub position: i64,
}

/// 保存前に VideoQuery として解釈できるか確かめる。
/// 壊れた JSON を貯めるとサイドバーのクリックが毎回失敗するようになるため
fn validate(query_json: &str) -> Result<()> {
    serde_json::from_str::<VideoQuery>(query_json)
        .map_err(|e| anyhow::anyhow!("検索条件の形式が不正です: {e}"))?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<SmartFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, query_json, position FROM smart_folders
         ORDER BY position, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SmartFolder {
                id: r.get(0)?,
                name: r.get(1)?,
                query_json: r.get(2)?,
                position: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn create(conn: &Connection, actor: &str, name: &str, query_json: &str) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "名前が空です");
    validate(query_json)?;
    // 末尾に追加する
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM smart_folders",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO smart_folders (name, query_json, position) VALUES (?1, ?2, ?3)",
        params![name, query_json, next],
    )?;
    let id = conn.last_insert_rowid();
    db::log_op(conn, actor, "create_smart_folder", &format!("id={id} name={name}"));
    Ok(id)
}

/// 名前と条件を更新する。どちらも None なら何もしない
pub fn update(
    conn: &Connection,
    actor: &str,
    id: i64,
    name: Option<&str>,
    query_json: Option<&str>,
) -> Result<()> {
    if let Some(n) = name {
        let n = n.trim();
        anyhow::ensure!(!n.is_empty(), "名前が空です");
        conn.execute("UPDATE smart_folders SET name = ?1 WHERE id = ?2", params![n, id])?;
    }
    if let Some(q) = query_json {
        validate(q)?;
        conn.execute("UPDATE smart_folders SET query_json = ?1 WHERE id = ?2", params![q, id])?;
    }
    db::log_op(conn, actor, "update_smart_folder", &format!("id={id}"));
    Ok(())
}

pub fn delete(conn: &Connection, actor: &str, id: i64) -> Result<()> {
    conn.execute("DELETE FROM smart_folders WHERE id = ?1", params![id])?;
    db::log_op(conn, actor, "delete_smart_folder", &format!("id={id}"));
    Ok(())
}

/// 渡された順に position を振り直す(ドラッグ並べ替え用)
pub fn reorder(conn: &Connection, ids: &[i64]) -> Result<()> {
    conn.execute_batch("BEGIN")?;
    for (pos, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE smart_folders SET position = ?1 WHERE id = ?2",
            params![pos as i64, id],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
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
    fn rejects_broken_query_json() {
        let conn = setup();
        assert!(create(&conn, "user", "壊れた", "{ not json").is_err());
        // 空の条件("すべて")は有効
        assert!(create(&conn, "user", "すべて", "{}").is_ok());
        assert!(create(&conn, "user", "", "{}").is_err(), "名前が空なら拒否する");
    }

    #[test]
    fn keeps_insertion_order_and_reorders() {
        let conn = setup();
        let a = create(&conn, "user", "未視聴", r#"{"unwatched":true}"#).unwrap();
        let b = create(&conn, "user", "高評価", r#"{"minRating":4}"#).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|s| s.id).collect::<Vec<_>>(), vec![a, b]);

        reorder(&conn, &[b, a]).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|s| s.id).collect::<Vec<_>>(), vec![b, a]);
    }

    #[test]
    fn update_validates_and_delete_removes() {
        let conn = setup();
        let id = create(&conn, "user", "未視聴", r#"{"unwatched":true}"#).unwrap();
        assert!(update(&conn, "user", id, None, Some("{ broken")).is_err());
        update(&conn, "user", id, Some("見てない"), Some(r#"{"unwatched":true,"minRating":3}"#)).unwrap();
        assert_eq!(list(&conn).unwrap()[0].name, "見てない");

        delete(&conn, "user", id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
