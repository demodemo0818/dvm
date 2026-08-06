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
use serde::{Deserialize, Serialize};
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

/// 視聴履歴 1 行(v1.18)。`view_history` に動画の表示用の値を JOIN したもの。
/// **取り消しの概念は無い**(観たという事実は操作ではない)ので OpEntry とは別の型にする
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewEntry {
    pub id: i64,
    pub video_id: i64,
    /// 'YYYY-MM-DD HH:MM:SS'(localtime)
    pub viewed_at: String,
    /// 閉じた時点の再生位置。null = 不明(外部プレイヤー / 異常終了)
    pub watched_ms: Option<i64>,
    pub filename: String,
    pub title: Option<String>,
    pub duration_ms: Option<i64>,
    pub thumb_path: Option<String>,
    /// 再生できない動画はクリックしても開けないので、UI 側で落として見せる
    pub is_missing: bool,
}

/// 視聴履歴を見る期間(v1.36。YYYY-MM-DD。**両端を含む**。None = 制限なし)。
///
/// **絞る対象が `videos` ではなく `view_history` なので `VideoQuery` とは別物**。
/// 一覧側は「最後に観たのがこの期間」しか答えられないが、こちらは全回を持っているので
/// 「4 月に観て、昨日も観た」動画が 4 月の指定でも出る(DESIGN.md 参照)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewRange {
    pub after: Option<String>,
    pub before: Option<String>,
}

impl ViewRange {
    /// WHERE 句とバインド値。一覧と集計が**同じ条件**を通るように 1 か所に持つ
    /// (片方だけ直すと「◯ 本」と実際に並ぶ行数が食い違う)
    fn where_clause(&self) -> (String, Vec<String>) {
        let mut conds: Vec<String> = Vec::new();
        let mut params: Vec<String> = Vec::new();
        // viewed_at は 'YYYY-MM-DD HH:MM:SS'(localtime) なので date() で日付だけ取り出す
        if let Some(d) = self.after.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            params.push(d.to_string());
            conds.push(format!("date(h.viewed_at) >= ?{}", params.len()));
        }
        if let Some(d) = self.before.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            params.push(d.to_string());
            conds.push(format!("date(h.viewed_at) <= ?{}", params.len()));
        }
        let sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        (sql, params)
    }
}

/// 期間の集計(v1.36)。「いつ何を観たか」を振り返るのが期間指定の動機なので、
/// 絞った結果の数字を一緒に出さないと半分しか答えられない
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStats {
    /// 視聴回数(= 行数)。同じ動画を 3 回観れば 3
    pub count: i64,
    /// 観た動画の本数(同じ動画を何度観ても 1)
    pub video_count: i64,
    /// 到達位置の合計(ミリ秒)。**watched_ms が NULL の行は含まない**
    pub watched_ms: i64,
    /// watched_ms が不明な行数。合計に入っていないことを画面で断るために返す
    /// (「間違った数字を出すくらいなら記録が無いほうがよい」の系)
    pub unknown_count: i64,
}

/// 期間の集計を返す(v1.36)。行を引かずに SQL の集計だけで済ませる
pub fn view_stats(conn: &Connection, range: &ViewRange) -> Result<ViewStats> {
    let (where_sql, params) = range.where_clause();
    // JOIN しない —— 表示用の列が要らず、CASCADE で孤児も出ないため
    let sql = format!(
        "SELECT COUNT(*), COUNT(DISTINCT h.video_id),
                COALESCE(SUM(h.watched_ms), 0), SUM(h.watched_ms IS NULL)
         FROM view_history h {where_sql}"
    );
    let stats = conn.query_row(&sql, rusqlite::params_from_iter(params), |r| {
        Ok(ViewStats {
            count: r.get(0)?,
            video_count: r.get(1)?,
            watched_ms: r.get(2)?,
            // 0 行のとき SUM は NULL を返す
            unknown_count: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        })
    })?;
    Ok(stats)
}

/// 新しい順に視聴履歴を返す(v1.18。期間指定は v1.36)。ページングは operations_log と同じ作法。
///
/// **日付ごとのまとめはここでやらない**。区切りの入れ方は表示の都合なので
/// フロントの純関数(`lib/viewHistory.ts`)に任せ、ここは並んだ行を返すだけにする
pub fn list_view_history(
    conn: &Connection,
    thumbs_dir: Option<&std::path::Path>,
    range: &ViewRange,
    limit: i64,
    offset: i64,
) -> Result<Vec<ViewEntry>> {
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let (where_sql, binds) = range.where_clause();
    // 動画が消えれば履歴も CASCADE で消えるので、JOIN が空振りすることはない。
    // limit / offset は i64 なので直接埋める(バインドするのは文字列だけ。core/query.rs と同じ方針)
    let sql = format!(
        "SELECT h.id, h.video_id, h.viewed_at, h.watched_ms,
                v.filename, v.title, v.duration_ms, v.thumb_state, v.is_missing
         FROM view_history h JOIN videos v ON v.id = h.video_id
         {where_sql}
         ORDER BY h.viewed_at DESC, h.id DESC LIMIT {limit} OFFSET {offset}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds), |r| {
            let video_id: i64 = r.get(1)?;
            let thumb_state: i64 = r.get(7)?;
            Ok(ViewEntry {
                id: r.get(0)?,
                video_id,
                viewed_at: r.get(2)?,
                watched_ms: r.get(3)?,
                filename: r.get(4)?,
                title: r.get(5)?,
                duration_ms: r.get(6)?,
                // 一覧と同じく実在確認はしない(行ごとのファイル I/O をしない。原則 7)
                thumb_path: thumbs_dir
                    .filter(|_| thumb_state == 1)
                    .map(|dir| dir.join(format!("{video_id}.jpg")).to_string_lossy().to_string()),
                is_missing: r.get::<_, i64>(8)? != 0,
            })
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
            // v1.34 以降は fields に変更した項目名が入る。それ以前の記録には無いので、
            // 従来どおり「before の値が null でないもの = 変更した項目」とみなす
            // (元が未設定だった項目は戻せないが、古い記録なので許容する)
            let changed: Vec<&str> = match p["fields"].as_array() {
                Some(a) => a.iter().filter_map(|v| v.as_str()).collect(),
                None => ["title", "comment"]
                    .into_iter()
                    .filter(|k| !p["before"][k].is_null())
                    .collect(),
            };
            for key in changed {
                // 列名は SQL に埋めるのでホワイトリストで受ける
                let sql = match key {
                    "title" => "UPDATE videos SET title = ?1 WHERE id = ?2",
                    "comment" => "UPDATE videos SET comment = ?1 WHERE id = ?2",
                    _ => continue,
                };
                conn.execute(sql, params![p["before"][key].as_str(), id])?;
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

    /// 元が未設定だった項目も空へ戻すこと(v1.34)。
    /// before の値が null かどうかで判定していた頃は、ここでタイトルが残ってしまっていた
    #[test]
    fn undo_video_info_clears_a_title_that_was_empty_before() {
        let conn = setup();
        videos::set_video_info(&conn, "user", 1, Some("第 1 話"), None).unwrap();
        let op = last_op(&conn);
        undo_op(&conn, op).unwrap();

        let title: Option<String> =
            conn.query_row("SELECT title FROM videos WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(title, None, "元が未設定だったのだから未設定に戻すこと");
    }

    /// 取り消しは変更した項目だけを戻す。一緒に送らなかった項目は触らない
    #[test]
    fn undo_video_info_leaves_the_untouched_field_alone() {
        let conn = setup();
        videos::set_video_info(&conn, "user", 1, None, Some("あとで見返す")).unwrap();
        videos::set_video_info(&conn, "user", 1, Some("第 1 話"), None).unwrap();
        undo_op(&conn, last_op(&conn)).unwrap();

        let (title, comment): (Option<String>, Option<String>) = conn
            .query_row("SELECT title, comment FROM videos WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, None);
        assert_eq!(comment.as_deref(), Some("あとで見返す"), "メモは取り消しの対象外");
    }

    /// v1.34 より前の記録(fields が無い)も、従来どおりの読み方で戻せること
    #[test]
    fn undo_video_info_reads_old_records_without_fields() {
        let conn = setup();
        conn.execute("UPDATE videos SET title = '新しい題名' WHERE id = 1", []).unwrap();
        db::log_op(
            &conn,
            "ai",
            "set_video_info",
            r#"{"id":1,"before":{"title":"元の題名","comment":null}}"#,
        );
        undo_op(&conn, last_op(&conn)).unwrap();

        let title: Option<String> =
            conn.query_row("SELECT title FROM videos WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(title.as_deref(), Some("元の題名"));
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

    /// v1.18。同じ動画を複数回観たら、その回数ぶん新しい順に並ぶこと
    #[test]
    fn view_history_lists_every_view_newest_first() {
        let conn = setup();
        videos::mark_opened(&conn, 1).unwrap();
        videos::mark_opened(&conn, 2).unwrap();
        let last = videos::mark_opened(&conn, 1).unwrap();
        videos::finish_view(&conn, last, 743_000).unwrap();

        let rows = list_view_history(&conn, None, &ViewRange::default(), 50, 0).unwrap();
        assert_eq!(rows.len(), 3, "1 番を 2 回観た記録が畳まれてはいけない");
        // viewed_at は秒精度で同着になりうるので、同着なら id の降順で新しい順を保つ
        assert_eq!(rows[0].id, last);
        assert_eq!(rows[0].video_id, 1);
        assert_eq!(rows[0].watched_ms, Some(743_000));
        assert_eq!(rows[1].watched_ms, None, "閉じていない視聴は不明のまま");
        assert_eq!(rows[0].filename, "a.mp4", "動画側の表示用の値が JOIN されること");
    }

    /// 視聴は操作ではないので、操作履歴のほうには 1 件も出ないこと
    #[test]
    fn views_are_not_mixed_into_the_operations_log() {
        let conn = setup();
        videos::mark_opened(&conn, 1).unwrap();
        assert!(list_ops(&conn, 50, 0).unwrap().is_empty());
    }

    // --- v1.36: 期間フィルタと集計 ---

    /// 日付をばらけさせた視聴履歴。**`mark_opened` は now を入れてしまうので直接 INSERT する**
    fn setup_views() -> Connection {
        let conn = setup();
        conn.execute_batch(
            r"INSERT INTO view_history (id, video_id, viewed_at, watched_ms) VALUES
                (1, 1, '2026-07-01 10:00:00', 60000),
                (2, 2, '2026-07-15 22:30:00', 120000),
                (3, 1, '2026-07-15 23:00:00', NULL),
                (4, 1, '2026-08-01 09:00:00', 30000);",
        )
        .unwrap();
        conn
    }

    fn range(after: &str, before: &str) -> ViewRange {
        let opt = |s: &str| if s.is_empty() { None } else { Some(s.to_string()) };
        ViewRange { after: opt(after), before: opt(before) }
    }

    #[test]
    fn view_range_is_inclusive_on_both_ends() {
        let conn = setup_views();
        let ids = |r: &ViewRange| -> Vec<i64> {
            list_view_history(&conn, None, r, 50, 0).unwrap().into_iter().map(|e| e.id).collect()
        };
        // 両端の日を含む。並びは新しい順のまま
        assert_eq!(ids(&range("2026-07-01", "2026-07-15")), vec![3, 2, 1]);
        assert_eq!(ids(&range("2026-07-15", "")), vec![4, 3, 2]);
        assert_eq!(ids(&range("", "2026-07-01")), vec![1]);
        // 時刻ではなく日付で比べる(22:30 の行が「7/15 まで」で落ちない)
        assert_eq!(ids(&range("2026-07-15", "2026-07-15")), vec![3, 2]);
    }

    #[test]
    fn blank_range_is_not_a_filter() {
        let conn = setup_views();
        assert_eq!(range("", "").where_clause().0, "", "空文字は条件にしない");
        assert_eq!(list_view_history(&conn, None, &range("   ", ""), 50, 0).unwrap().len(), 4);
    }

    #[test]
    fn view_stats_counts_views_and_videos_separately() {
        let conn = setup_views();
        let all = view_stats(&conn, &ViewRange::default()).unwrap();
        assert_eq!(all.count, 4, "視聴回数は行数");
        assert_eq!(all.video_count, 2, "動画の本数は重複を畳む");
        assert_eq!(all.watched_ms, 210_000, "60+120+30 秒。NULL は足さない");
        assert_eq!(all.unknown_count, 1, "watched_ms が不明な行を別に数える");
    }

    /// 一覧と集計が**同じ条件**を通ること。片方だけ直すと画面の数字と行数が食い違う
    #[test]
    fn view_stats_uses_the_same_range_as_the_list() {
        let conn = setup_views();
        let r = range("2026-07-15", "2026-07-15");
        let rows = list_view_history(&conn, None, &r, 500, 0).unwrap();
        let stats = view_stats(&conn, &r).unwrap();
        assert_eq!(stats.count, rows.len() as i64);
        assert_eq!(stats.video_count, 2);
        assert_eq!(stats.watched_ms, 120_000);
        assert_eq!(stats.unknown_count, 1);
    }

    /// 1 件も無い期間で 0 が返ること(SUM が NULL になる経路)
    #[test]
    fn view_stats_on_an_empty_range_is_all_zero() {
        let conn = setup_views();
        let stats = view_stats(&conn, &range("2020-01-01", "2020-12-31")).unwrap();
        assert_eq!(stats.count, 0);
        assert_eq!(stats.video_count, 0);
        assert_eq!(stats.watched_ms, 0);
        assert_eq!(stats.unknown_count, 0);
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
