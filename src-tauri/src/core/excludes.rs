//! 監視除外フォルダ(v1.33)
//!
//! 監視フォルダは再帰的に走査されるので、配下のファイルをライブラリから消しても
//! 次のスキャンで必ず再登録される。同じ内容のバックアップが世代ごとに置いてあるような
//! フォルダを「見なかったことにする」ための仕組み。
//!
//! **フォルダだけでなくファイル 1 個も登録できる**(判定は同じ前方一致で、パスが
//! そのものと一致すれば除外)。ライブラリから消した動画だけを狙って二度と拾わせない
//! ときに使う —— フォルダごと除外すると、そのフォルダに今後入る動画まで巻き込むため。
//!
//! ファイルには一切触らない。あくまで「取り込まない」だけ。

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// 比較用の正規化。Windows のパスは大文字小文字を区別せず、'/' と '\' の揺れも吸収し、
/// 末尾の区切りは落とす(`deepest_owner` と同じ流儀にそろえてある)
pub fn normalize(path: &str) -> String {
    path.to_lowercase()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_string()
}

/// スキャン中に毎ファイル呼ぶので、DB は引かず正規化済みの一覧を受け取る形にする
pub fn list_normalized(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT path FROM excluded_paths") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).map(|p| normalize(&p)).collect()
}

/// path が除外パスそのもの、またはその配下か。
/// 区切りの直後で切れているかまで見るので `N:\Twitter全データ2` が
/// `N:\Twitter全データ` の配下と誤判定されることはない
pub fn is_excluded(excludes: &[String], path: &str) -> bool {
    if excludes.is_empty() {
        return false;
    }
    let lower = normalize(path);
    excludes.iter().any(|e| {
        !e.is_empty()
            && lower.starts_with(e.as_str())
            && (lower.len() == e.len() || lower.as_bytes()[e.len()] == b'\\')
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedPath {
    pub id: i64,
    pub path: String,
    /// この除外パスの配下にまだ残っている登録数(0 でないなら消し残し)
    pub video_count: i64,
}

pub fn list(conn: &Connection) -> Result<Vec<ExcludedPath>> {
    let mut stmt = conn.prepare("SELECT id, path FROM excluded_paths ORDER BY path")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows
        .into_iter()
        .map(|(id, path)| {
            let video_count = count_videos_under(conn, &path).unwrap_or(0);
            ExcludedPath { id, path, video_count }
        })
        .collect())
}

/// 除外パス配下の登録数。LIKE ではなく前方一致で数える(パスに % や _ が入り得るため)
fn count_videos_under(conn: &Connection, path: &str) -> Result<i64> {
    let prefix = format!("{}\\", normalize(path));
    let mut stmt = conn.prepare("SELECT path FROM videos")?;
    let n = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .filter(|p| normalize(p).starts_with(&prefix))
        .count();
    Ok(n as i64)
}

pub fn add(conn: &Connection, path: &str) -> Result<i64> {
    let trimmed = path.trim_end_matches(['\\', '/']).to_string();
    anyhow::ensure!(!trimmed.is_empty(), "除外パスが空です");
    conn.execute(
        "INSERT OR IGNORE INTO excluded_paths (path) VALUES (?1)",
        params![trimmed],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM excluded_paths WHERE path=?1",
        params![trimmed],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM excluded_paths WHERE id=?1", params![id])?;
    Ok(())
}

/// 除外パスに該当する登録の id(そのパス自身と、その配下)。
/// **複数パスを 1 回の走査で判定する** —— 1 パスずつ全件走査すると、
/// ファイル単位で何十件も登録したときに走査が件数分だけ繰り返される
pub fn video_ids_under_any(conn: &Connection, paths: &[String]) -> Result<Vec<i64>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let normalized: Vec<String> = paths.iter().map(|p| normalize(p)).collect();
    let mut stmt = conn.prepare("SELECT id, path FROM videos")?;
    let ids = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .filter(|(_, p)| is_excluded(&normalized, p))
        .map(|(id, _)| id)
        .collect();
    Ok(ids)
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
    fn normalize_evens_out_windows_paths() {
        assert_eq!(normalize("N:/Foo/Bar\\"), "n:\\foo\\bar");
        assert_eq!(normalize("N:\\Foo\\"), "n:\\foo");
    }

    #[test]
    fn excluded_matches_self_and_children() {
        let ex = vec!["n:\\twitter全データ\\twitter-2020-04-24".to_string()];
        assert!(is_excluded(&ex, "N:\\Twitter全データ\\twitter-2020-04-24"));
        assert!(is_excluded(&ex, "N:/Twitter全データ/twitter-2020-04-24/data/a.mp4"));
        assert!(!is_excluded(&ex, "N:\\Twitter全データ\\twitter-2021-09-21\\a.mp4"));
    }

    #[test]
    fn sibling_with_same_prefix_is_not_excluded() {
        let ex = vec!["n:\\foo".to_string()];
        // 「n:\foo」で始まるだけの別フォルダを巻き込まない
        assert!(!is_excluded(&ex, "N:\\foobar\\a.mp4"));
        assert!(is_excluded(&ex, "N:\\foo\\a.mp4"));
    }

    #[test]
    fn empty_list_excludes_nothing() {
        assert!(!is_excluded(&[], "N:\\foo\\a.mp4"));
    }

    #[test]
    fn add_is_idempotent_and_trims_trailing_separator() {
        let conn = setup();
        let a = add(&conn, "N:\\Foo\\").unwrap();
        let b = add(&conn, "N:\\Foo").unwrap();
        assert_eq!(a, b, "末尾の区切り違いで二重登録しない");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    fn seed_videos(conn: &Connection) {
        conn.execute(
            "INSERT INTO videos (id, path, filename) VALUES
             (1, 'N:\\Foo\\a.mp4', 'a.mp4'),
             (2, 'N:\\Foobar\\b.mp4', 'b.mp4'),
             (3, 'N:\\Foo\\sub\\c.mp4', 'c.mp4')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn video_ids_under_finds_children_only() {
        let conn = setup();
        seed_videos(&conn);
        let mut ids = video_ids_under_any(&conn, &["N:\\Foo".to_string()]).unwrap();
        ids.sort();
        assert_eq!(ids, vec![1, 3], "Foobar は Foo の配下ではない");
    }

    #[test]
    fn video_ids_under_any_matches_a_single_file() {
        let conn = setup();
        seed_videos(&conn);
        // ファイル 1 個だけの除外(フォルダの他の動画は巻き込まない)
        let ids = video_ids_under_any(&conn, &["N:\\Foo\\a.mp4".to_string()]).unwrap();
        assert_eq!(ids, vec![1]);
    }

    #[test]
    fn video_ids_under_any_takes_several_paths_at_once() {
        let conn = setup();
        seed_videos(&conn);
        let mut ids = video_ids_under_any(
            &conn,
            &["N:\\Foo\\a.mp4".to_string(), "N:\\Foobar".to_string()],
        )
        .unwrap();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn video_ids_under_any_returns_nothing_for_no_paths() {
        let conn = setup();
        seed_videos(&conn);
        assert!(video_ids_under_any(&conn, &[]).unwrap().is_empty());
    }
}
