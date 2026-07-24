use crate::core::offline::RootCache;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// UI と AI(MCP)が共有する構造化検索クエリ
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoQuery {
    pub text: Option<String>,
    pub sort: Option<String>,
    pub folder_id: Option<i64>,
    /// 指定タグすべてが付いている動画に絞る(AND 条件)
    pub tag_ids: Option<Vec<i64>>,
    /// シリーズで絞る
    pub series_id: Option<i64>,
    /// true: missing のみ / false: missing 以外
    pub missing: Option<bool>,
    /// このレーティング以上に絞る(1〜5。0 / None は無条件)
    pub min_rating: Option<i64>,
    /// 尺の下限・上限(ミリ秒)。範囲指定時、duration_ms が NULL(プローブ未了・失敗)の動画は含まれない
    pub min_duration_ms: Option<i64>,
    pub max_duration_ms: Option<i64>,
}

/// 一覧表示用の 1 行(UI・MCP 共通)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRow {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub title: Option<String>,
    pub size: i64,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub rating: i64,
    pub view_count: i64,
    pub last_viewed_at: Option<String>,
    pub is_missing: bool,
    pub is_offline: bool,
    pub thumb_state: i64,
    pub thumb_path: Option<String>,
    pub added_at: String,
}

impl VideoQuery {
    /// WHERE 句と LIKE パラメータを返す
    pub fn where_clause(&self) -> (String, Option<String>) {
        let mut conds: Vec<String> = Vec::new();
        let mut like: Option<String> = None;

        if let Some(text) = self.text.as_deref() {
            let t = text.trim();
            if !t.is_empty() {
                let escaped = t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                like = Some(format!("%{escaped}%"));
                conds.push("(filename LIKE ?1 ESCAPE '\\' OR COALESCE(title,'') LIKE ?1 ESCAPE '\\')".into());
            }
        }
        if let Some(fid) = self.folder_id {
            conds.push(format!("watched_folder_id = {fid}"));
        }
        if let Some(tag_ids) = &self.tag_ids {
            // i64 なので直接埋め込んでも安全。タグごとに IN 条件を重ねて AND にする
            for tid in tag_ids {
                conds.push(format!(
                    "id IN (SELECT video_id FROM video_tags WHERE tag_id = {tid})"
                ));
            }
        }
        if let Some(sid) = self.series_id {
            conds.push(format!(
                "id IN (SELECT video_id FROM series_entries WHERE series_id = {sid})"
            ));
        }
        if let Some(missing) = self.missing {
            conds.push(format!("is_missing = {}", if missing { 1 } else { 0 }));
        }
        if let Some(r) = self.min_rating {
            let r = r.clamp(0, 5);
            if r > 0 {
                conds.push(format!("rating >= {r}"));
            }
        }
        if let Some(ms) = self.min_duration_ms {
            conds.push(format!("duration_ms >= {}", ms.max(0)));
        }
        if let Some(ms) = self.max_duration_ms {
            conds.push(format!("duration_ms <= {}", ms.max(0)));
        }

        let sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        (sql, like)
    }

    /// ORDER BY 句(ホワイトリスト方式。任意文字列を SQL に混ぜない)
    pub fn order_clause(&self) -> String {
        if self.sort.as_deref() == Some("series_asc") {
            if let Some(sid) = self.series_id {
                return format!(
                    "ORDER BY (SELECT se.position FROM series_entries se
                               WHERE se.video_id = videos.id AND se.series_id = {sid}), id"
                );
            }
        }
        match self.sort.as_deref() {
            Some("name_asc") => "ORDER BY filename COLLATE NOCASE ASC",
            Some("name_desc") => "ORDER BY filename COLLATE NOCASE DESC",
            Some("size_asc") => "ORDER BY size ASC",
            Some("size_desc") => "ORDER BY size DESC",
            Some("duration_asc") => "ORDER BY duration_ms ASC NULLS FIRST",
            Some("duration_desc") => "ORDER BY duration_ms DESC NULLS LAST",
            Some("added_asc") => "ORDER BY added_at ASC, id ASC",
            Some("rating_desc") => "ORDER BY rating DESC, added_at DESC, id DESC",
            Some("viewed_desc") => "ORDER BY last_viewed_at DESC NULLS LAST, id DESC",
            _ => "ORDER BY added_at DESC, id DESC",
        }
        .to_string()
    }
}

pub fn count(conn: &Connection, query: &VideoQuery) -> Result<i64> {
    let (where_sql, like) = query.where_clause();
    let sql = format!("SELECT COUNT(*) FROM videos {where_sql}");
    let count = match &like {
        Some(l) => conn.query_row(&sql, rusqlite::params![l], |r| r.get(0)),
        None => conn.query_row(&sql, [], |r| r.get(0)),
    }?;
    Ok(count)
}

type RawRow = (
    i64,            // id
    String,         // path
    String,         // filename
    Option<String>, // title
    i64,            // size
    Option<i64>,    // duration_ms
    Option<i64>,    // width
    Option<i64>,    // height
    i64,            // rating
    i64,            // view_count
    Option<String>, // last_viewed_at
    i64,            // is_missing
    i64,            // thumb_state
    String,         // added_at
);

/// 検索を実行して一覧行を返す。thumbs_dir が None のときはサムネイルパスを解決しない(MCP 用)
pub fn query_rows(
    conn: &Connection,
    thumbs_dir: Option<&Path>,
    query: &VideoQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoRow>> {
    let (where_sql, like) = query.where_clause();
    let order = query.order_clause();
    let limit = limit.clamp(1, 1000);
    let offset = offset.max(0);
    let sql = format!(
        "SELECT id, path, filename, title, size, duration_ms, width, height, rating,
                view_count, last_viewed_at, is_missing, thumb_state, added_at
         FROM videos {where_sql} {order} LIMIT {limit} OFFSET {offset}"
    );

    let mut stmt = conn.prepare(&sql)?;

    fn map_row(r: &rusqlite::Row) -> rusqlite::Result<RawRow> {
        Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
            r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?,
        ))
    }

    let raw: Vec<RawRow> = match &like {
        Some(l) => stmt.query_map(rusqlite::params![l], map_row),
        None => stmt.query_map([], map_row),
    }?
    .filter_map(|r| r.ok())
    .collect();

    let mut roots = RootCache::default();
    let rows = raw
        .into_iter()
        .map(|(id, path, filename, title, size, duration_ms, width, height, rating, view_count, last_viewed_at, is_missing, thumb_state, added_at)| {
            let thumb_path = thumbs_dir.and_then(|dir| {
                let thumb = dir.join(format!("{id}.jpg"));
                if thumb_state == 1 && thumb.exists() {
                    Some(thumb.to_string_lossy().to_string())
                } else {
                    None
                }
            });
            VideoRow {
                is_offline: !roots.is_online(&path),
                thumb_path,
                id, path, filename, title, size, duration_ms, width, height, rating,
                view_count, last_viewed_at,
                is_missing: is_missing != 0,
                thumb_state,
                added_at,
            }
        })
        .collect();
    Ok(rows)
}
