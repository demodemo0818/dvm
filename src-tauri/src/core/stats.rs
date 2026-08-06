use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use crate::core::query::ext_expr;

/// 「値 + ラベル + 件数」の 1 項目。棒グラフ 1 本ぶん。
/// key はクリックしたときにフィルタへ渡す値(コーデック名・フォルダ id 等)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub label: String,
    pub count: i64,
    /// この束の合計サイズ(バイト)と合計再生時間(ミリ秒)(v1.37)。
    /// 画面の軸切り替え(件数 / 容量 / 時間)がこの 3 つを出し分ける。
    ///
    /// **動画を数えていない内訳(`by_view_month`)では 0 が入る** ——
    /// 視聴 1 回にファイルサイズを足し込んでも意味がないため
    pub bytes: i64,
    pub duration_ms: i64,
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
    /// レーティング 0〜5 の内訳。**常に 6 本**(key = 星の数)
    pub by_rating: Vec<Bucket>,
    pub by_codec: Vec<Bucket>,
    pub by_resolution: Vec<Bucket>,
    pub by_folder: Vec<Bucket>,
    /// 追加月ごとの件数(古い順、直近 24 か月)
    pub by_month: Vec<Bucket>,

    // --- v1.37 で追加した内訳 ---
    /// 尺の分布。key は詳細検索のプリセット(`lt5` / `5to20` / `20to60` / `gt60` / `unknown`)
    pub by_duration: Vec<Bucket>,
    /// 拡張子別(上位 12)。key はドット無し・小文字
    pub by_extension: Vec<Bucket>,
    /// 画面の向き。key は `landscape` / `portrait` / `unknown`
    pub by_orientation: Vec<Bucket>,
    /// 再生回数の分布。key は絞り込みの範囲そのもの(`0` / `1` / `2-4` / `5-9` / `10-`)
    pub by_view_count: Vec<Bucket>,
    /// ファイル更新日の年別(古い順)。**ライブラリに入れた日(`by_month`)とは別物**
    pub by_file_year: Vec<Bucket>,
    /// 月ごとの視聴回数(古い順、直近 24 か月)。`view_history` 由来なので v1.18 以降だけ
    pub by_view_month: Vec<Bucket>,
}

/// 束ごとに数える 3 つの値。0 行のとき SUM は NULL を返すので COALESCE で 0 に落とす
const MEASURES: &str = "COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(duration_ms), 0)";

fn scalar(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

/// key, label, 件数, 合計サイズ, 合計時間 の **5 列**を返す SQL を読む
fn buckets(conn: &Connection, sql: &str) -> Result<Vec<Bucket>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Bucket {
                key: r.get(0)?,
                label: r.get(1)?,
                count: r.get(2)?,
                bytes: r.get(3)?,
                duration_ms: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// key, label, 件数 の **3 列**だけの SQL を読む(容量・時間の軸を持たない内訳用)
fn count_buckets(conn: &Connection, sql: &str) -> Result<Vec<Bucket>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Bucket {
                key: r.get(0)?,
                label: r.get(1)?,
                count: r.get(2)?,
                bytes: 0,
                duration_ms: 0,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// レーティングの内訳。**0 件の星も含めて必ず 6 本返す** ——
/// 「★5 が 0 本」も知りたい情報なので、GROUP BY に現れない星を落とさない
fn rating_buckets(conn: &Connection) -> Result<Vec<Bucket>> {
    let mut out: Vec<Bucket> = (0..=5)
        .map(|star: i64| Bucket {
            key: star.to_string(),
            label: if star == 0 { "未評価".to_string() } else { "★".repeat(star as usize) },
            count: 0,
            bytes: 0,
            duration_ms: 0,
        })
        .collect();

    let sql = format!("SELECT rating, {m} FROM videos GROUP BY rating", m = MEASURES);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })?;
    for (rating, count, bytes, duration_ms) in rows.flatten() {
        // 範囲外の値が混じっていても★5 に足し込まない(clamp しない)
        if let Some(b) = usize::try_from(rating).ok().and_then(|i| out.get_mut(i)) {
            b.count = count;
            b.bytes = bytes;
            b.duration_ms = duration_ms;
        }
    }
    Ok(out)
}

/// ライブラリ全体の統計。アプリの統計画面と MCP の library_stats が共有する
pub fn library_stats(conn: &Connection) -> Result<LibraryStats> {
    let (video_count, total_size_bytes, total_duration_ms): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(duration_ms), 0) FROM videos",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

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
        by_rating: rating_buckets(conn)?,
        by_codec: buckets(
            conn,
            &format!(
                "SELECT COALESCE(video_codec, ''), COALESCE(video_codec, '(不明)'), {m}
                 FROM videos GROUP BY video_codec ORDER BY COUNT(*) DESC LIMIT 12",
                m = MEASURES
            ),
        )?,
        // 高さで代表的な解像度に丸める。width ではなく height で見るのは
        // シネスコ(横長)でも 1080p と呼ぶのが普通なため
        by_resolution: buckets(
            conn,
            &format!(
                "SELECT CAST(bucket AS TEXT), label, {m} FROM (
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
                     ELSE '480p 未満' END AS label,
                   size, duration_ms
                   FROM videos
                 ) GROUP BY bucket, label ORDER BY bucket DESC",
                m = MEASURES
            ),
        )?,
        by_folder: buckets(
            conn,
            &format!(
                "SELECT CAST(COALESCE(v.watched_folder_id, 0) AS TEXT),
                        COALESCE(w.path, '(個別登録)'), {m}
                 FROM videos v LEFT JOIN watched_folders w ON w.id = v.watched_folder_id
                 GROUP BY v.watched_folder_id ORDER BY COUNT(*) DESC",
                m = MEASURES
            ),
        )?,
        // 直近 24 か月に絞ってから古い順に並べ直すので、集計を先に済ませる形になる
        // (MEASURES をそのまま埋められない唯一の内訳)
        by_month: buckets(
            conn,
            "SELECT m, m, n, bytes, ms FROM (
               SELECT substr(added_at, 1, 7) AS m,
                      COUNT(*) AS n,
                      COALESCE(SUM(size), 0) AS bytes,
                      COALESCE(SUM(duration_ms), 0) AS ms
               FROM videos GROUP BY m ORDER BY m DESC LIMIT 24
             ) ORDER BY m",
        )?,

        // --- v1.37 ---
        //
        // 尺の境界は**上側を含む**(`duration_ms <= 300000` が「5 分未満」)。
        // クリックで飛ぶ先の詳細検索プリセット(`DURATION_RANGES`)が
        // `max_duration_ms`(= 以下)で組まれているので、そちらに合わせてある
        by_duration: buckets(
            conn,
            &format!(
                "SELECT key, label, {m} FROM (
                   SELECT CASE
                            WHEN duration_ms IS NULL     THEN 'unknown'
                            WHEN duration_ms <=  300000  THEN 'lt5'
                            WHEN duration_ms <= 1200000  THEN '5to20'
                            WHEN duration_ms <= 3600000  THEN '20to60'
                            ELSE 'gt60' END AS key,
                          CASE
                            WHEN duration_ms IS NULL     THEN '(不明)'
                            WHEN duration_ms <=  300000  THEN '5 分未満'
                            WHEN duration_ms <= 1200000  THEN '5〜20 分'
                            WHEN duration_ms <= 3600000  THEN '20〜60 分'
                            ELSE '60 分以上' END AS label,
                          CASE WHEN duration_ms IS NULL THEN 1 ELSE 0 END AS unknown_last,
                          size, duration_ms
                   FROM videos
                 ) GROUP BY key, label, unknown_last ORDER BY unknown_last, MIN(duration_ms)",
                m = MEASURES
            ),
        )?,
        // 拡張子の取り出しは絞り込みと同じ式を使う(core/query.rs の ext_expr)
        by_extension: buckets(
            conn,
            &format!(
                "SELECT ext, ext, {m} FROM (
                   SELECT {ext} AS ext, size, duration_ms FROM videos
                 ) WHERE ext <> '' GROUP BY ext ORDER BY COUNT(*) DESC, ext ASC LIMIT 12",
                m = MEASURES,
                ext = ext_expr()
            ),
        )?,
        // 正方形は横長に入れる(query.rs の orientation と同じ分け方)。
        // 幅か高さが未取得のものはどちらにも入れず「(不明)」にする
        by_orientation: buckets(
            conn,
            &format!(
                "SELECT key, label, {m} FROM (
                   SELECT CASE
                            WHEN width IS NULL OR height IS NULL THEN 'unknown'
                            WHEN height > width THEN 'portrait'
                            ELSE 'landscape' END AS key,
                          CASE
                            WHEN width IS NULL OR height IS NULL THEN '(不明)'
                            WHEN height > width THEN '縦長'
                            ELSE '横長' END AS label,
                          size, duration_ms
                   FROM videos
                 ) GROUP BY key, label ORDER BY COUNT(*) DESC",
                m = MEASURES
            ),
        )?,
        by_view_count: buckets(
            conn,
            &format!(
                "SELECT key, label, {m} FROM (
                   SELECT CASE
                            WHEN view_count <= 0 THEN '0'
                            WHEN view_count =  1 THEN '1'
                            WHEN view_count <= 4 THEN '2-4'
                            WHEN view_count <= 9 THEN '5-9'
                            ELSE '10-' END AS key,
                          CASE
                            WHEN view_count <= 0 THEN '未視聴'
                            WHEN view_count =  1 THEN '1 回'
                            WHEN view_count <= 4 THEN '2〜4 回'
                            WHEN view_count <= 9 THEN '5〜9 回'
                            ELSE '10 回以上' END AS label,
                          size, duration_ms, view_count
                   FROM videos
                 ) GROUP BY key, label ORDER BY MIN(view_count)",
                m = MEASURES
            ),
        )?,
        // ファイル更新日の年。**追加月(by_month)とは別物** ——
        // あちらは「ライブラリに入れた日」で、こちらは「ファイルそのものの古さ」
        by_file_year: buckets(
            conn,
            &format!(
                "SELECT key, label, {m} FROM (
                   SELECT CASE
                            WHEN file_modified_at IS NULL OR file_modified_at = '' THEN ''
                            ELSE substr(file_modified_at, 1, 4) END AS key,
                          CASE
                            WHEN file_modified_at IS NULL OR file_modified_at = '' THEN '(不明)'
                            ELSE substr(file_modified_at, 1, 4) || ' 年' END AS label,
                          size, duration_ms
                   FROM videos
                 ) GROUP BY key, label
                 ORDER BY CASE WHEN key = '' THEN 1 ELSE 0 END, key",
                m = MEASURES
            ),
        )?,
        // 視聴は動画を数えていないので容量・時間の軸を持たない(count_buckets)
        by_view_month: count_buckets(
            conn,
            "SELECT m, m, n FROM (
               SELECT substr(viewed_at, 1, 7) AS m, COUNT(*) AS n
               FROM view_history GROUP BY m ORDER BY m DESC LIMIT 24
             ) ORDER BY m",
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// key → その束を引く小道具(順序に依存しない検証をするため)
    fn find<'a>(buckets: &'a [Bucket], key: &str) -> &'a Bucket {
        buckets.iter().find(|b| b.key == key).unwrap_or_else(|| panic!("key={key} が無い"))
    }

    #[test]
    fn aggregates_an_empty_library_without_panicking() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        let s = library_stats(&conn).unwrap();
        assert_eq!(s.video_count, 0);
        assert_eq!(s.total_size_bytes, 0);
        assert_eq!(s.by_rating.len(), 6, "星 0〜5 の 6 本は常に埋まっていること");
        assert!(s.by_rating.iter().all(|b| b.count == 0));
        assert!(s.by_codec.is_empty());
        assert!(s.by_view_month.is_empty());
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
        assert_eq!(find(&s.by_rating, "5").count, 1);
        assert_eq!(find(&s.by_rating, "0").count, 1);
        assert_eq!(find(&s.by_rating, "4").count, 0, "0 件の星も本数ぶん返すこと");

        // 解像度は高さで丸める。未取得は「(不明)」に落ちる
        let labels: Vec<&str> = s.by_resolution.iter().map(|b| b.label.as_str()).collect();
        assert!(labels.contains(&"4K 以上") && labels.contains(&"1080p") && labels.contains(&"(不明)"));

        // 個別登録(watched_folder_id = NULL)も 1 グループとして出す
        assert!(s.by_folder.iter().any(|b| b.label == "(個別登録)" && b.count == 1));
        // 月別は古い順
        assert_eq!(s.by_month.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(), vec!["2026-01", "2026-02"]);
    }

    /// v1.37。束ごとに合計サイズ・合計時間も返すこと(画面の「容量 / 時間」軸がこれを使う)
    #[test]
    fn buckets_carry_size_and_duration_totals() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO watched_folders (id, path) VALUES (1, 'C:\v');
            INSERT INTO videos (id, path, filename, size, duration_ms, video_codec, rating, watched_folder_id)
            VALUES
              (1, 'C:\v\a.mp4', 'a.mp4', 100, 1000, 'h264', 5, 1),
              (2, 'C:\v\b.mp4', 'b.mp4', 200, 2000, 'h264', 5, 1),
              (3, 'C:\v\c.mp4', 'c.mp4', 400, NULL, 'hevc', 0, 1);
            "#,
        )
        .unwrap();

        let s = library_stats(&conn).unwrap();
        let h264 = find(&s.by_codec, "h264");
        assert_eq!((h264.count, h264.bytes, h264.duration_ms), (2, 300, 3000));
        // 尺が取れていない動画は容量だけ足され、時間には 0 として入る
        let hevc = find(&s.by_codec, "hevc");
        assert_eq!((hevc.count, hevc.bytes, hevc.duration_ms), (1, 400, 0));
        assert_eq!(find(&s.by_rating, "5").bytes, 300, "レーティングの束にも容量が乗ること");
        assert_eq!(find(&s.by_folder, "1").bytes, 700);
    }

    /// v1.37 で足した 5 つの内訳。**分け方は絞り込み(core/query.rs)と同じ切り方**
    fn setup_variety() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO videos (id, path, filename, size, duration_ms, width, height,
                                view_count, file_modified_at)
            VALUES
              -- 5 分ちょうど(境界は「5 分未満」側)・横長・未視聴・2024 年
              (1, 'C:\a.mp4',  'a.mp4',  100,   300000, 1920, 1080, 0, '2024-05-01 00:00:00'),
              -- 10 分・縦長・1 回・2024 年
              (2, 'C:\b.mkv',  'b.mkv',  200,   600000, 1080, 1920, 1, '2024-11-20 00:00:00'),
              -- 90 分・正方形(横長側)・3 回・2025 年
              (3, 'C:\c.mp4',  'c.mp4',  300,  5400000, 1000, 1000, 3, '2025-02-02 00:00:00'),
              -- 尺・解像度が未取得・12 回・更新日も不明
              (4, 'C:\d',      'd',      400,     NULL, NULL, NULL, 12, NULL),
              -- 30 分・横長・7 回・2025 年
              (5, 'C:\e.MP4',  'e.MP4',  500,  1800000, 1280,  720, 7, '2025-12-31 00:00:00');
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn splits_duration_at_the_same_boundaries_as_the_filter_presets() {
        let s = library_stats(&setup_variety()).unwrap();
        let keys: Vec<&str> = s.by_duration.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, vec!["lt5", "5to20", "20to60", "gt60", "unknown"], "短い順・不明は最後");
        // 5 分ちょうどは「5 分未満」に入る(詳細検索の maxDurationMs = 5 分 が「以下」なので合わせた)
        assert_eq!(find(&s.by_duration, "lt5").count, 1);
        assert_eq!(find(&s.by_duration, "gt60").count, 1);
        assert_eq!(find(&s.by_duration, "unknown").count, 1);
        assert_eq!(find(&s.by_duration, "20to60").bytes, 500);
    }

    #[test]
    fn groups_extensions_case_insensitively_and_skips_names_without_one() {
        let s = library_stats(&setup_variety()).unwrap();
        // 'e.MP4' は mp4 に畳まれ、拡張子の無い 'd' は数えない
        assert_eq!(find(&s.by_extension, "mp4").count, 3);
        assert_eq!(find(&s.by_extension, "mkv").count, 1);
        assert!(s.by_extension.iter().all(|b| !b.key.is_empty()), "拡張子なしは出さない");
    }

    #[test]
    fn counts_squares_as_landscape_and_unknown_separately() {
        let s = library_stats(&setup_variety()).unwrap();
        assert_eq!(find(&s.by_orientation, "landscape").count, 3, "正方形は横長側");
        assert_eq!(find(&s.by_orientation, "portrait").count, 1);
        assert_eq!(find(&s.by_orientation, "unknown").count, 1);
    }

    #[test]
    fn splits_view_counts_into_ranges_that_match_the_filter() {
        let s = library_stats(&setup_variety()).unwrap();
        let keys: Vec<&str> = s.by_view_count.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, vec!["0", "1", "2-4", "5-9", "10-"], "回数の少ない順");
        assert_eq!(find(&s.by_view_count, "0").count, 1);
        assert_eq!(find(&s.by_view_count, "10-").count, 1);
    }

    #[test]
    fn groups_file_years_oldest_first_with_unknown_last() {
        let s = library_stats(&setup_variety()).unwrap();
        let keys: Vec<&str> = s.by_file_year.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, vec!["2024", "2025", ""], "古い順・不明は最後");
        assert_eq!(find(&s.by_file_year, "2024").count, 2);
        assert_eq!(find(&s.by_file_year, "").label, "(不明)");
    }

    /// v1.37。視聴の内訳は `view_history`(全回が残っている)から数える
    #[test]
    fn counts_views_per_month_oldest_first() {
        let conn = setup_variety();
        conn.execute_batch(
            r"INSERT INTO view_history (video_id, viewed_at) VALUES
                (1, '2026-06-30 22:00:00'),
                (2, '2026-07-01 10:00:00'),
                (1, '2026-07-15 23:00:00'),
                (1, '2026-07-16 01:00:00');",
        )
        .unwrap();

        let s = library_stats(&conn).unwrap();
        assert_eq!(
            s.by_view_month.iter().map(|b| (b.key.as_str(), b.count)).collect::<Vec<_>>(),
            vec![("2026-06", 1), ("2026-07", 3)]
        );
        assert!(
            s.by_view_month.iter().all(|b| b.bytes == 0 && b.duration_ms == 0),
            "視聴回数の内訳は容量・時間の軸を持たない"
        );
    }
}
