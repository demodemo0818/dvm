//! 操作履歴の閲覧と取り消し(v1.9)。
//!
//! **取り消せるのは可逆なメタデータ操作だけ**。ファイルを動かす操作(ごみ箱送り・
//! リネーム・移動)や登録削除は元に戻せないので、履歴には出すが取り消しは拒否する。
//!
//! payload は v1.9 から構造化 JSON に統一した。それ以前の自由文字列は
//! 逆操作に必要な情報(変更前の値)が入っていないので取り消し不可として扱う。

use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

/// 取り消しに対応している action(逆操作に必要な情報を payload に持っているもの)
const UNDOABLE: &[&str] = &[
    "tag_videos",
    "untag_videos",
    "add_to_series",
    "remove_from_series",
    "set_rating",
    "set_video_info",
    "rename_tag",
    "relink",
];

/// 履歴 1 行。UI 側で人間向けの文言に整形する
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpEntry {
    pub id: i64,
    pub timestamp: String,
    /// "user" / "ai" / "system"
    pub actor: String,
    pub action: String,
    /// 構造化 JSON(v1.9 以降)。旧形式の自由文字列はそのまま入る
    pub payload: Option<String>,
    /// この操作を取り消せるか(取り消し済みなら false)
    pub undoable: bool,
    /// 取り消せない理由(UI に出す)
    pub reason: Option<String>,
    /// 取り消した日時(null = 未取り消し)
    pub undone_at: Option<String>,
}

fn parse_payload(payload: Option<&str>) -> Option<Value> {
    serde_json::from_str(payload?).ok()
}

fn judge(action: &str, payload: Option<&str>, undone_at: Option<&str>) -> (bool, Option<String>) {
    if undone_at.is_some() {
        return (false, Some("取り消し済みです".into()));
    }
    if !UNDOABLE.contains(&action) {
        let reason = match action {
            "trash_file" => "ごみ箱から手動で戻してください",
            "remove_videos" => "登録削除は元に戻せません(再スキャンで取り込み直せます)",
            "move_file" | "rename_file" => "逆向きの移動・リネームを実行してください",
            _ => "この操作は取り消せません",
        };
        return (false, Some(reason.into()));
    }
    if parse_payload(payload).is_none() {
        // v1.9 より前の記録。変更前の値が残っていないので戻しようがない
        return (false, Some("古い形式の記録のため取り消せません".into()));
    }
    (true, None)
}

pub fn list_ops(conn: &Connection, limit: i64, offset: i64) -> Result<Vec<OpEntry>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, timestamp, actor, action, payload, undone_at
         FROM operations_log ORDER BY id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset.max(0)], |r| {
            let id: i64 = r.get(0)?;
            let timestamp: String = r.get(1)?;
            let actor: String = r.get(2)?;
            let action: String = r.get(3)?;
            let payload: Option<String> = r.get(4)?;
            let undone_at: Option<String> = r.get(5)?;
            let (undoable, reason) = judge(&action, payload.as_deref(), undone_at.as_deref());
            Ok(OpEntry { id, timestamp, actor, action, payload, undoable, reason, undone_at })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 履歴 1 件を取り消す。取り消し自体も operations_log に記録し、元の行に undone_at を立てる
pub fn undo_op(conn: &Connection, op_id: i64) -> Result<String> {
    let (action, payload, undone_at): (String, Option<String>, Option<String>) = conn.query_row(
        "SELECT action, payload, undone_at FROM operations_log WHERE id = ?1",
        params![op_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    let (undoable, reason) = judge(&action, payload.as_deref(), undone_at.as_deref());
    anyhow::ensure!(undoable, "{}", reason.unwrap_or_else(|| "取り消せません".into()));
    let p = parse_payload(payload.as_deref()).unwrap();

    let summary = match action.as_str() {
        "tag_videos" => {
            let tag_id = p["tagId"].as_i64().unwrap_or(0);
            let ids = id_list(&p["added"]);
            for vid in &ids {
                conn.execute(
                    "DELETE FROM video_tags WHERE video_id = ?1 AND tag_id = ?2",
                    params![vid, tag_id],
                )?;
            }
            format!("{} 件からタグを外しました", ids.len())
        }
        "untag_videos" => {
            let tag_id = p["tagId"].as_i64().unwrap_or(0);
            let ids = id_list(&p["removed"]);
            for vid in &ids {
                conn.execute(
                    "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?1, ?2)",
                    params![vid, tag_id],
                )?;
            }
            format!("{} 件にタグを戻しました", ids.len())
        }
        "add_to_series" => {
            let series_id = p["seriesId"].as_i64().unwrap_or(0);
            let ids = id_list(&p["added"]);
            for vid in &ids {
                conn.execute(
                    "DELETE FROM series_entries WHERE series_id = ?1 AND video_id = ?2",
                    params![series_id, vid],
                )?;
            }
            format!("{} 件をシリーズから外しました", ids.len())
        }
        "remove_from_series" => {
            let series_id = p["seriesId"].as_i64().unwrap_or(0);
            let entries = p["removed"].as_array().cloned().unwrap_or_default();
            for e in &entries {
                conn.execute(
                    "INSERT OR IGNORE INTO series_entries (series_id, video_id, position)
                     VALUES (?1, ?2, ?3)",
                    params![series_id, e["id"].as_i64(), e["position"].as_i64().unwrap_or(0)],
                )?;
            }
            format!("{} 件をシリーズに戻しました", entries.len())
        }
        "set_rating" => {
            let before = p["before"].as_array().cloned().unwrap_or_default();
            for e in &before {
                conn.execute(
                    "UPDATE videos SET rating = ?1 WHERE id = ?2",
                    params![e["rating"].as_i64().unwrap_or(0), e["id"].as_i64()],
                )?;
            }
            format!("{} 件のレーティングを戻しました", before.len())
        }
        "set_video_info" => {
            let id = p["id"].as_i64().unwrap_or(0);
            // 変更した項目だけ before に入っている(null は「触っていない」)
            if !p["before"]["title"].is_null() {
                conn.execute(
                    "UPDATE videos SET title = ?1 WHERE id = ?2",
                    params![p["before"]["title"].as_str(), id],
                )?;
            }
            if !p["before"]["comment"].is_null() {
                conn.execute(
                    "UPDATE videos SET comment = ?1 WHERE id = ?2",
                    params![p["before"]["comment"].as_str(), id],
                )?;
            }
            "情報を元に戻しました".to_string()
        }
        "rename_tag" => {
            conn.execute(
                "UPDATE tags SET name = ?1 WHERE id = ?2",
                params![p["before"].as_str(), p["tagId"].as_i64()],
            )?;
            "タグ名を戻しました".to_string()
        }
        "relink" => {
            let items = p["items"].as_array().cloned().unwrap_or_default();
            for e in &items {
                let from = e["from"].as_str().unwrap_or_default();
                let filename = std::path::Path::new(from)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();
                let exists = std::path::Path::new(from).exists();
                conn.execute(
                    "UPDATE videos SET path = ?1, filename = ?2, is_missing = ?3 WHERE id = ?4",
                    params![from, filename, if exists { 0 } else { 1 }, e["id"].as_i64()],
                )?;
            }
            format!("{} 件のパスを戻しました", items.len())
        }
        other => anyhow::bail!("取り消しに未対応の操作です: {other}"),
    };

    conn.execute(
        "UPDATE operations_log SET undone_at = datetime('now','localtime') WHERE id = ?1",
        params![op_id],
    )?;
    db::log_op(
        conn,
        "user",
        "undo",
        &serde_json::json!({ "opId": op_id, "action": action }).to_string(),
    );
    Ok(summary)
}

/// 数値の配列を i64 として取り出す
fn id_list(v: &Value) -> Vec<i64> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{series, tags, videos};

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r"INSERT INTO videos (id, path, filename, rating) VALUES
                (1, 'C:\a.mp4', 'a.mp4', 0),
                (2, 'C:\b.mp4', 'b.mp4', 3);",
        )
        .unwrap();
        conn
    }

    fn last_op(conn: &Connection) -> i64 {
        conn.query_row("SELECT MAX(id) FROM operations_log", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn undo_tagging_only_removes_what_it_added() {
        let conn = setup();
        // 1 番には先にタグを付けておく。取り消しでこれが外れてはいけない
        tags::tag_videos(&conn, "user", &[1], "旅行").unwrap();
        tags::tag_videos(&conn, "ai", &[1, 2], "旅行").unwrap();
        let op = last_op(&conn);

        undo_op(&conn, op).unwrap();
        let ids: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT video_id FROM video_tags ORDER BY video_id").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().flatten().collect()
        };
        assert_eq!(ids, vec![1], "元から付いていた 1 番のタグは残すこと");
    }

    #[test]
    fn undo_rating_restores_each_previous_value() {
        let conn = setup();
        videos::set_rating(&conn, "user", &[1, 2], 5).unwrap();
        let op = last_op(&conn);
        undo_op(&conn, op).unwrap();

        let r1: i64 = conn.query_row("SELECT rating FROM videos WHERE id=1", [], |r| r.get(0)).unwrap();
        let r2: i64 = conn.query_row("SELECT rating FROM videos WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!((r1, r2), (0, 3), "動画ごとに違っていた元の値へ戻すこと");
    }

    #[test]
    fn undo_series_restores_position() {
        let conn = setup();
        series::add_videos_to_series(&conn, "user", &[1, 2], "第 1 期").unwrap();
        let sid: i64 = conn.query_row("SELECT id FROM series", [], |r| r.get(0)).unwrap();
        series::remove_videos_from_series(&conn, "user", &[1], sid).unwrap();
        let op = last_op(&conn);

        undo_op(&conn, op).unwrap();
        let pos: i64 = conn
            .query_row(
                "SELECT position FROM series_entries WHERE series_id=?1 AND video_id=1",
                params![sid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pos, 1, "並び順ごと戻すこと");
    }

    #[test]
    fn destructive_and_old_records_are_not_undoable() {
        let conn = setup();
        // ファイル操作は取り消し不可
        db::log_op(&conn, "user", "trash_file", r#"{"id":1,"path":"C:\\a.mp4"}"#);
        let op = last_op(&conn);
        assert!(undo_op(&conn, op).is_err());
        assert!(list_ops(&conn, 10, 0).unwrap()[0].reason.is_some());

        // v1.9 以前の自由文字列 payload も取り消し不可
        db::log_op(&conn, "user", "set_rating", "rating=5 videos=[1, 2]");
        let old = last_op(&conn);
        let e = undo_op(&conn, old).unwrap_err().to_string();
        assert!(e.contains("古い形式"), "理由が伝わること: {e}");
    }

    #[test]
    fn undo_is_recorded_and_not_repeatable() {
        let conn = setup();
        videos::set_rating(&conn, "user", &[1], 4).unwrap();
        let op = last_op(&conn);
        undo_op(&conn, op).unwrap();

        // 2 回目は拒否される
        assert!(undo_op(&conn, op).is_err());

        let entry = list_ops(&conn, 50, 0)
            .unwrap()
            .into_iter()
            .find(|e| e.id == op)
            .unwrap();
        assert!(entry.undone_at.is_some());
        assert!(!entry.undoable);

        // 取り消したこと自体も履歴に残る
        assert!(list_ops(&conn, 50, 0).unwrap().iter().any(|e| e.action == "undo"));
    }
}
