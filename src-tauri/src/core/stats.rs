use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

/// 「値 + ラベル + 件数」の 1 項目。棒グラフ 1 本ぶん。
/// key はクリックしたときにフィルタへ渡す値(コーデック名・フォルダ id 等)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub label: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub video_count: i64,
    pub total_size_bytes: i64,
    /// 尺が取れている動画の合計再生時間(ミリ秒)
    pub total_duration_ms: i64,
    pub tag_count: i64,
    pub series_count: i64,
    pub missing_count: i64,
    pub unwatched_count: i64,
    pub untagged_count: i64,
    /// 重複(size + partial_hash が同じ仲間がいる)動画の数
    pub duplicate_count: i64,
    /// レーティング 0〜5 の件数(index = 星の数)
    pub rating_counts: Vec<i64>,
    pub by_codec: Vec<Bucket>,
    pub by_resolution: Vec<Bucket>,
    pub by_folder: Vec<Bucket>,
    /// 追加月ごとの件数(古い順、直近 24 か月)
    pub by_month: Vec<Bucket>,
}

fn scalar(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

fn buckets(conn: &Connection, sql: &str) -> Result<Vec<Bucket>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Bucket {
                key: r.get(0)?,
                label: r.get(1)?,
                count: r.get(2)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// ライブラリ全体の統計。アプリの統計画面と MCP の library_stats が共有する
pub fn library_stats(conn: &Connection) -> Result<LibraryStats> {
    let (video_count, total_size_bytes, total_duration_ms): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(duration_ms), 0) FROM videos",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    let mut rating_counts = vec![0i64; 6];
    let mut stmt = conn.prepare("SELECT rating, COUNT(*) FROM videos GROUP BY rating")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
        if let Ok((rating, n)) = row {
            if (0..=5).contains(&rating) {
                rating_counts[rating as usize] = n;
            }
        }
    }

    Ok(LibraryStats {
        video_count,
        total_size_bytes,
        total_duration_ms,
        tag_count: scalar(conn, "SELECT COUNT(*) FROM tags")?,
        series_count: scalar(conn, "SELECT COUNT(*) FROM series")?,
        missing_count: scalar(conn, "SELECT COUNT(*) FROM videos WHERE is_missing = 1")?,
        unwatched_count: scalar(conn, "SELECT COUNT(*) FROM videos WHERE view_count = 0")?,
        untagged_count: scalar(
            conn,
            "SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM video_tags)",
        )?,
        duplicate_count: scalar(
            conn,
            "SELECT COUNT(*) FROM videos WHERE partial_hash IS NOT NULL
               AND (size, partial_hash) IN (
                 SELECT size, partial_hash FROM videos WHERE partial_hash IS NOT NULL
                 GROUP BY size, partial_hash HAVING COUNT(*) > 1)",
        )?,
        rating_counts,
        by_codec: buckets(
            conn,
            "SELECT COALESCE(video_codec, ''), COALESCE(video_codec, '(不明)'), COUNT(*)
             FROM videos GROUP BY video_codec ORDER BY COUNT(*) DESC LIMIT 12",
        )?,
        // 高さで代表的な解像度に丸める。width ではなく height で見るのは
        // シネスコ(横長)でも 1080p と呼ぶのが普通なため
        by_resolution: buckets(
            conn,
            "SELECT CAST(bucket AS TEXT), label, COUNT(*) FROM (
               SELECT CASE
                 WHEN height IS NULL THEN 0
                 WHEN height >= 2160 THEN 2160
                 WHEN height >= 1440 THEN 1440
                 WHEN height >= 1080 THEN 1080
                 WHEN height >= 720  THEN 720
                 WHEN height >= 480  THEN 480
                 ELSE 1 END AS bucket,
               CASE
                 WHEN height IS NULL THEN '(不明)'
                 WHEN height >= 2160 THEN '4K 以上'
                 WHEN height >= 1440 THEN '1440p'
                 WHEN height >= 1080 THEN '1080p'
                 WHEN height >= 720  THEN '720p'
                 WHEN height >= 480  THEN '480p'
                 ELSE '480p 未満' END AS label
               FROM videos
             ) GROUP BY bucket, label ORDER BY bucket DESC",
        )?,
        by_folder: buckets(
            conn,
            "SELECT CAST(COALESCE(v.watched_folder_id, 0) AS TEXT),
                    COALESCE(w.path, '(個別登録)'), COUNT(*)
             FROM videos v LEFT JOIN watched_folders w ON w.id = v.watched_folder_id
             GROUP BY v.watched_folder_id ORDER BY COUNT(*) DESC",
        )?,
        by_month: buckets(
            conn,
            "SELECT m, m, n FROM (
               SELECT substr(added_at, 1, 7) AS m, COUNT(*) AS n
               FROM videos GROUP BY m ORDER BY m DESC LIMIT 24
             ) ORDER BY m",
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_an_empty_library_without_panicking() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        let s = library_stats(&conn).unwrap();
        assert_eq!(s.video_count, 0);
        assert_eq!(s.total_size_bytes, 0);
        assert_eq!(s.rating_counts, vec![0; 6], "星 0〜5 の 6 要素は常に埋まっていること");
        assert!(s.by_codec.is_empty());
    }

    #[test]
    fn aggregates_counts_and_buckets() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO watched_folders (id, path) VALUES (1, 'C:\v');
            INSERT INTO videos (id, path, filename, size, partial_hash, duration_ms, height,
                                video_codec, rating, view_count, is_missing, watched_folder_id, added_at)
            VALUES
              (1, 'C:\v\a.mp4', 'a.mp4', 100, 'aaa', 1000, 1080, 'h264', 5, 2, 0, 1,    '2026-01-05 00:00:00'),
              (2, 'C:\v\b.mp4', 'b.mp4', 100, 'aaa', 2000, 2160, 'h264', 0, 0, 0, 1,    '2026-01-20 00:00:00'),
              (3, 'D:\c.mkv',   'c.mkv', 300, NULL,  3000, NULL,  'hevc', 3, 0, 1, NULL, '2026-02-01 00:00:00');
            INSERT INTO tags (id, name) VALUES (1, 'x');
            INSERT INTO video_tags (video_id, tag_id) VALUES (1, 1);
            "#,
        )
        .unwrap();

        let s = library_stats(&conn).unwrap();
        assert_eq!(s.video_count, 3);
        assert_eq!(s.total_size_bytes, 500);
        assert_eq!(s.total_duration_ms, 6000);
        assert_eq!(s.missing_count, 1);
        assert_eq!(s.unwatched_count, 2);
        assert_eq!(s.untagged_count, 2);
        assert_eq!(s.duplicate_count, 2, "hash が NULL の 1 件は重複に数えない");
        assert_eq!(s.rating_counts[5], 1);
        assert_eq!(s.rating_counts[0], 1);

        // 解像度は高さで丸める。未取得は「(不明)」に落ちる
        let labels: Vec<&str> = s.by_resolution.iter().map(|b| b.label.as_str()).collect();
        assert!(labels.contains(&"4K 以上") && labels.contains(&"1080p") && labels.contains(&"(不明)"));

        // 個別登録(watched_folder_id = NULL)も 1 グループとして出す
        assert!(s.by_folder.iter().any(|b| b.label == "(個別登録)" && b.count == 1));
        // 月別は古い順
        assert_eq!(s.by_month.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(), vec!["2026-01", "2026-02"]);
    }
}
