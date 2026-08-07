//! ライブラリごとのセッション状態(v1.41)。最初の利用者は再生キューの自動保存(C-2)。
//!
//! `get_setting` / `set_setting`(app.db)を使わないのは、キューが video_id を含み
//! **ライブラリに紐づく**ため。ライブラリを切り替えれば別のキューが復元される。
//! 値は書き込む側(フロント)が決める JSON をそのまま持つ —— Rust 側で型にしないのは、
//! 復元できなくても実害が「前回のキューが空で始まる」だけで、
//! 型ずれのたびにマイグレーションを書く価値がないため。

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM session_state WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO session_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_overwrites_and_get_returns_none_for_unknown_keys() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        assert_eq!(get(&conn, "queue").unwrap(), None);

        set(&conn, "queue", r#"{"videoIds":[1,2]}"#).unwrap();
        set(&conn, "queue", r#"{"videoIds":[3]}"#).unwrap();
        assert_eq!(get(&conn, "queue").unwrap().as_deref(), Some(r#"{"videoIds":[3]}"#));
    }
}
