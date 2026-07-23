use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub fn init(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS watched_folders (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  recursive INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  partial_hash TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  container TEXT,
  fps REAL,
  bitrate INTEGER,
  title TEXT,
  comment TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  file_created_at TEXT,
  file_modified_at TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  is_missing INTEGER NOT NULL DEFAULT 0,
  thumb_state INTEGER NOT NULL DEFAULT 0,
  watched_folder_id INTEGER REFERENCES watched_folders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(size, partial_hash);
CREATE INDEX IF NOT EXISTS idx_videos_added ON videos(added_at);
CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(watched_folder_id);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id, video_id);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  comment TEXT
);

CREATE TABLE IF NOT EXISTS series_entries (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, video_id)
);

CREATE TABLE IF NOT EXISTS operations_log (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  actor TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  payload TEXT
);
"#;

pub fn log_op(conn: &Connection, actor: &str, action: &str, payload: &str) {
    let _ = conn.execute(
        "INSERT INTO operations_log (actor, action, payload) VALUES (?1, ?2, ?3)",
        rusqlite::params![actor, action, payload],
    );
}
