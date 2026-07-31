//! 一覧(グリッド・詳細リスト)に出すタグ・シリーズの一括取得(v1.23)。
//!
//! **一覧クエリ(core/query.rs)には混ぜない**。混ぜると次の 2 つを踏む:
//!
//! 1. SQLite は ORDER BY を索引で満たせないとき、SELECT に書いた式を
//!    LIMIT の手前(ソータに入る全行)で評価する。5 万本のライブラリを
//!    サイズ順に並べると 5 万回タグを引くことになる
//! 2. `VideoRow` は MCP の `search_videos` がそのまま返す型なので、
//!    画面の飾りのために AI へ渡すトークン量が増える
//!
//! そこで「表示中のページの video_id だけ」をまとめて引く別便にしている。
//! `video_tags` は PK が (video_id, tag_id)、`series_entries` は
//! `idx_series_entries_video`(db.rs)がそれぞれ効くので、200 件でも索引引きで済む。

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

/// 一覧のチップに出すタグ。色は枠線と文字色に使う(塗り潰さない)
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

/// 一覧のチップに出すシリーズ。`series` に色は無いので名前だけ
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesRef {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLabels {
    pub video_id: i64,
    pub tags: Vec<TagRef>,
    pub series: Vec<SeriesRef>,
}

/// 一度に問い合わせできる件数の上限。query_rows の limit と揃える
const MAX_IDS: usize = 1000;

/// 指定した動画のタグ・シリーズをまとめて返す。
///
/// **要求された id ごとに必ず 1 エントリ返す**(タグもシリーズも無ければ空の配列)。
/// 返さないと、フロントが「まだ取れていない」と「1 つも付いていない」を区別できず、
/// セルを `—` にするか空欄にするか決められなくなる。
///
/// 重複した id は 1 エントリにまとめる。並びは要求順ではなく id 昇順
pub fn labels_for_videos(conn: &Connection, video_ids: &[i64]) -> Result<Vec<VideoLabels>> {
    // 重複を潰しつつ上限で切る。BTreeSet なので id 昇順になる
    let ids: std::collections::BTreeSet<i64> = video_ids.iter().take(MAX_IDS).copied().collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // i64 なので直接埋め込んでも安全(既存の tags_for_videos と同じ作法)
    let ids_csv = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let mut out: Vec<VideoLabels> = ids
        .iter()
        .map(|&video_id| VideoLabels {
            video_id,
            tags: Vec::new(),
            series: Vec::new(),
        })
        .collect();
    // video_id から out の添字を引く。行ごとに線形探索すると 1000 件 × タグ数で効いてくる
    let index_of: std::collections::HashMap<i64, usize> =
        out.iter().enumerate().map(|(i, l)| (l.video_id, i)).collect();

    let sql = format!(
        "SELECT vt.video_id, t.id, t.name, t.color
           FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
          WHERE vt.video_id IN ({ids_csv})
          ORDER BY vt.video_id, t.name COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let tag_rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            TagRef {
                id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
            },
        ))
    })?;
    for (video_id, tag) in tag_rows.flatten() {
        if let Some(&i) = index_of.get(&video_id) {
            out[i].tags.push(tag);
        }
    }

    let sql = format!(
        "SELECT se.video_id, s.id, s.name
           FROM series_entries se JOIN series s ON s.id = se.series_id
          WHERE se.video_id IN ({ids_csv})
          ORDER BY se.video_id, s.name COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let series_rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            SeriesRef {
                id: r.get(1)?,
                name: r.get(2)?,
            },
        ))
    })?;
    for (video_id, series) in series_rows.flatten() {
        if let Some(&i) = index_of.get(&video_id) {
            out[i].series.push(series);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO videos (id, path, filename) VALUES
               (10, 'X:\\旅行\\a.mp4', 'a.mp4'),
               (11, 'X:\\旅行\\b.mp4', 'b.mp4'),
               (12, 'X:\\c.mp4', 'c.mp4');
             INSERT INTO tags (id, name, color) VALUES
               (1, 'ぜんぶ', '#e05252'), (2, 'あとで', NULL), (3, 'Beach', NULL);
             INSERT INTO video_tags (video_id, tag_id) VALUES
               (10, 2), (10, 1), (10, 3), (11, 1);
             INSERT INTO series (id, name) VALUES (1, '第 2 期'), (2, 'あ行');
             INSERT INTO series_entries (series_id, video_id, position) VALUES
               (2, 10, 0), (1, 10, 0), (1, 11, 1);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn returns_one_entry_per_requested_id() {
        let conn = setup();
        let labels = labels_for_videos(&conn, &[10, 11, 12]).unwrap();
        assert_eq!(labels.len(), 3);
        // 何も付いていない動画も空の配列で返す(「未取得」と区別させるため)
        let bare = labels.iter().find(|l| l.video_id == 12).unwrap();
        assert!(bare.tags.is_empty() && bare.series.is_empty());
    }

    #[test]
    fn sorts_by_name_ignoring_case() {
        let conn = setup();
        let labels = labels_for_videos(&conn, &[10]).unwrap();
        let names: Vec<&str> = labels[0].tags.iter().map(|t| t.name.as_str()).collect();
        // COLLATE NOCASE の昇順。ASCII が先、日本語が後
        assert_eq!(names, vec!["Beach", "あとで", "ぜんぶ"]);
        let series: Vec<&str> = labels[0].series.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(series, vec!["あ行", "第 2 期"]);
    }

    #[test]
    fn carries_tag_color() {
        let conn = setup();
        let labels = labels_for_videos(&conn, &[10]).unwrap();
        let colored = labels[0].tags.iter().find(|t| t.name == "ぜんぶ").unwrap();
        assert_eq!(colored.color.as_deref(), Some("#e05252"));
        let plain = labels[0].tags.iter().find(|t| t.name == "あとで").unwrap();
        assert_eq!(plain.color, None);
    }

    #[test]
    fn one_video_can_belong_to_several_series() {
        let conn = setup();
        let labels = labels_for_videos(&conn, &[10]).unwrap();
        assert_eq!(labels[0].series.len(), 2);
    }

    #[test]
    fn empty_input_does_not_query() {
        let conn = setup();
        assert!(labels_for_videos(&conn, &[]).unwrap().is_empty());
    }

    #[test]
    fn duplicate_and_unknown_ids_are_handled() {
        let conn = setup();
        // 重複はまとめる。存在しない id もエントリだけは返す(要求 id ごとに 1 つの約束)
        let labels = labels_for_videos(&conn, &[10, 10, 999]).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].video_id, 10);
        assert_eq!(labels[1].video_id, 999);
        assert!(labels[1].tags.is_empty());
    }

    #[test]
    fn series_lookup_uses_the_video_index() {
        let conn = setup();
        // PK は (series_id, video_id) なので、索引が無いと全走査になる(db.rs で足した)
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN
                 SELECT se.video_id FROM series_entries se WHERE se.video_id IN (10, 11)",
                [],
                |r| r.get(3),
            )
            .unwrap();
        assert!(
            plan.contains("idx_series_entries_video"),
            "video_id の検索が索引を使っていない: {plan}"
        );
    }
}
