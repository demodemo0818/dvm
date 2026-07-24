use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let v = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?;
    Ok(v)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
