use crate::core::offline;
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

fn ids_csv(video_ids: &[i64]) -> String {
    // i64 なので直接埋め込んでも安全
    video_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

pub fn set_rating(conn: &Connection, actor: &str, video_ids: &[i64], rating: i64) -> Result<()> {
    let rating = rating.clamp(0, 5);
    conn.execute(
        &format!("UPDATE videos SET rating = {rating} WHERE id IN ({})", ids_csv(video_ids)),
        [],
    )?;
    db::log_op(conn, actor, "set_rating", &format!("rating={rating} videos={video_ids:?}"));
    Ok(())
}

pub fn set_video_info(
    conn: &Connection,
    actor: &str,
    video_id: i64,
    title: Option<&str>,
    comment: Option<&str>,
) -> Result<()> {
    if let Some(t) = title {
        conn.execute("UPDATE videos SET title = ?1 WHERE id = ?2", params![t, video_id])?;
    }
    if let Some(c) = comment {
        conn.execute("UPDATE videos SET comment = ?1 WHERE id = ?2", params![c, video_id])?;
    }
    db::log_op(
        conn,
        actor,
        "set_video_info",
        &format!("id={video_id} title={} comment={}", title.is_some(), comment.is_some()),
    );
    Ok(())
}

/// ライブラリから登録を削除する(ファイル自体は消さない)
pub fn remove_videos(conn: &Connection, actor: &str, video_ids: &[i64]) -> Result<()> {
    conn.execute(&format!("DELETE FROM videos WHERE id IN ({})", ids_csv(video_ids)), [])?;
    db::log_op(conn, actor, "remove_videos", &format!("videos={video_ids:?}"));
    Ok(())
}

/// アプリ内再生のレジューム位置を保存する(0 = 位置なし)。
/// 数秒ごとに呼ばれるため operations_log には記録しない(mark_viewed と同格の扱い)
pub fn set_resume(conn: &Connection, video_id: i64, resume_ms: i64) -> Result<()> {
    conn.execute(
        "UPDATE videos SET resume_ms = ?1 WHERE id = ?2",
        params![resume_ms.max(0), video_id],
    )?;
    Ok(())
}

/// 視聴カウントを進める(外部プレイヤー起動時・アプリ内再生開始時)
pub fn mark_viewed(conn: &Connection, video_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE videos SET view_count = view_count + 1,
         last_viewed_at = datetime('now','localtime') WHERE id = ?1",
        params![video_id],
    )?;
    Ok(())
}

/// ごみ箱送りの dry-run 結果 1 件分
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: i64,
    pub path: String,
    pub exists: bool,
    pub is_offline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub id: i64,
    pub path: String,
    pub trashed: bool,
    pub error: Option<String>,
}

fn paths_of(conn: &Connection, video_ids: &[i64]) -> Result<Vec<(i64, String)>> {
    let sql = format!("SELECT id, path FROM videos WHERE id IN ({})", ids_csv(video_ids));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// ごみ箱送りの実行内容プレビュー(dry-run)
pub fn plan_trash(conn: &Connection, video_ids: &[i64]) -> Result<Vec<TrashItem>> {
    let mut roots = offline::RootCache::default();
    let items = paths_of(conn, video_ids)?
        .into_iter()
        .map(|(id, path)| {
            let is_offline = !roots.is_online(&path);
            TrashItem {
                exists: !is_offline && Path::new(&path).exists(),
                id,
                path,
                is_offline,
            }
        })
        .collect();
    Ok(items)
}

/// ファイルをごみ箱へ送る。成功分は is_missing=1 にして DB レコードは残す
/// (ごみ箱から戻して再スキャンすれば復帰できる)。オフラインドライブ上はスキップする
pub fn trash_files(conn: &Connection, actor: &str, video_ids: &[i64]) -> Result<Vec<TrashResult>> {
    let mut roots = offline::RootCache::default();
    let mut results = Vec::new();
    for (id, path) in paths_of(conn, video_ids)? {
        if !roots.is_online(&path) {
            results.push(TrashResult {
                id,
                path,
                trashed: false,
                error: Some("ドライブが未接続です".into()),
            });
            continue;
        }
        if !Path::new(&path).exists() {
            results.push(TrashResult {
                id,
                path,
                trashed: false,
                error: Some("ファイルが見つかりません".into()),
            });
            continue;
        }
        match trash::delete(&path) {
            Ok(()) => {
                let _ = conn.execute("UPDATE videos SET is_missing = 1 WHERE id = ?1", params![id]);
                db::log_op(conn, actor, "trash_file", &path);
                results.push(TrashResult { id, path, trashed: true, error: None });
            }
            Err(e) => {
                results.push(TrashResult { id, path, trashed: false, error: Some(e.to_string()) });
            }
        }
    }
    Ok(results)
}
