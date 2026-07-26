use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

/// スキーマの現行バージョン。列追加などの変更時は MIGRATIONS に差分を足してここを上げる。
/// **新テーブルの追加では上げない**(SCHEMA の CREATE TABLE IF NOT EXISTS が既存 DB にも流れるため)
const LATEST_VERSION: i32 = 3;

/// v(N) -> v(N+1) の差分 SQL。PRAGMA user_version の更新は migrate() 側で同一トランザクションに含める
const MIGRATIONS: &[&str] = &[
    // v0 -> v1: ドライブレター変動対策(ボリュームシリアル記録)
    "ALTER TABLE watched_folders ADD COLUMN volume_serial TEXT;",
    // v1 -> v2: アプリ内再生のレジューム位置
    "ALTER TABLE videos ADD COLUMN resume_ms INTEGER NOT NULL DEFAULT 0;",
    // v2 -> v3: サムネイルのコマ位置(NULL = 自動選択)
    "ALTER TABLE videos ADD COLUMN thumb_time_ms INTEGER;",
];

pub fn init(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // MCP 等の別プロセスと書き込みが重なったとき即エラーにせず待つ
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 一覧・サイドバー用の読み取り専用コネクションを開く(init() の後に呼ぶこと)。
/// 書き込み用と分けることで、取り込み中(ffprobe / サムネイル生成の UPDATE 連発)に
/// 一覧クエリがロック待ちで固まるのを防ぐ。WAL なので読み取りは書き込みと並行できる
pub fn open_read(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // 誤って書き込み経路に使われないよう明示的に読み取り専用にしておく
    conn.execute_batch("PRAGMA query_only = ON;")?;
    Ok(conn)
}

/// 最新スキーマを流す(すべて IF NOT EXISTS)。テストでインメモリ DB を組むときにも使う
pub fn apply_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    // user_version 導入前(v0.4 以前)の DB は 0 のままなので、新規 DB かどうかは videos の有無で見分ける
    let fresh: bool = conn.query_row(
        "SELECT COUNT(*) = 0 FROM sqlite_master WHERE type = 'table' AND name = 'videos'",
        [],
        |r| r.get(0),
    )?;
    if fresh {
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", LATEST_VERSION)?;
        return Ok(());
    }
    // 既存 DB: 新テーブルの追加は IF NOT EXISTS の SCHEMA で拾い、列追加は差分を順次適用する
    conn.execute_batch(SCHEMA)?;
    let mut v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    while v < LATEST_VERSION {
        let body = MIGRATIONS[v as usize];
        conn.execute_batch(&format!(
            "BEGIN; {body} PRAGMA user_version = {}; COMMIT;",
            v + 1
        ))?;
        v += 1;
    }
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS watched_folders (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  recursive INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  volume_serial TEXT
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
  resume_ms INTEGER NOT NULL DEFAULT 0,
  file_created_at TEXT,
  file_modified_at TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  is_missing INTEGER NOT NULL DEFAULT 0,
  thumb_state INTEGER NOT NULL DEFAULT 0,
  thumb_time_ms INTEGER,
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 保存した検索条件(VideoQuery の JSON)。サイドバーに出す
CREATE TABLE IF NOT EXISTS smart_folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 読み取り用コネクションが (1) 書き込み用のコミットをそのまま見られること
    /// (2) 書き込みを拒否すること。WAL の実挙動を見たいので実ファイルで検証する
    #[test]
    fn read_connection_sees_commits_and_refuses_writes() {
        let dir = std::env::temp_dir().join("videoshelf-test-dbread");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");

        let write = init(&path).unwrap();
        let read = open_read(&path).unwrap();

        write
            .execute("INSERT INTO videos (path, filename) VALUES ('X:\\a.mp4', 'a.mp4')", [])
            .unwrap();

        let count: i64 = read
            .query_row("SELECT COUNT(*) FROM videos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "別コネクションからコミット済みの行が見えていない");
        assert!(read.execute("DELETE FROM videos", []).is_err(), "読み取り専用のはずが書けてしまう");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
