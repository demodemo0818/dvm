use crate::core::offline;
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
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
    // 取り消し用に変更前の値を控える(動画ごとに違う値だったのを一律にする操作なので、
    // 「1 つ前の値」ではなく id ごとの対応表が要る)
    let before: Vec<serde_json::Value> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, rating FROM videos WHERE id IN ({})",
            ids_csv(video_ids)
        ))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, i64>(0)?, "rating": r.get::<_, i64>(1)? }))
            })?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    conn.execute(
        &format!("UPDATE videos SET rating = {rating} WHERE id IN ({})", ids_csv(video_ids)),
        [],
    )?;
    db::log_op(
        conn,
        actor,
        "set_rating",
        &serde_json::json!({ "rating": rating, "before": before }).to_string(),
    );
    Ok(())
}

/// 詳細パネルの編集フォーム用(v1.34)。メモは長文になりうるので一覧クエリ(`VideoRow`)には
/// 載せず、1 件選んだときだけここで引く
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub title: Option<String>,
    pub comment: Option<String>,
}

pub fn get_video_info(conn: &Connection, video_id: i64) -> Result<Option<VideoInfo>> {
    let info = conn
        .query_row(
            "SELECT title, comment FROM videos WHERE id = ?1",
            params![video_id],
            |r| Ok(VideoInfo { title: r.get(0)?, comment: r.get(1)? }),
        )
        .optional()?;
    Ok(info)
}

/// 入力欄が空(空白だけ)なら NULL として保存する。
/// 空文字のまま入れると `title ?? filename` のフォールバックが効かず、名前欄が空で表示される
fn or_null(v: &str) -> Option<&str> {
    let t = v.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// タイトル・メモを更新する。`None` = その項目は触らない、`Some("")` = 未設定に戻す
pub fn set_video_info(
    conn: &Connection,
    actor: &str,
    video_id: i64,
    title: Option<&str>,
    comment: Option<&str>,
) -> Result<()> {
    let (old_title, old_comment): (Option<String>, Option<String>) = conn.query_row(
        "SELECT title, comment FROM videos WHERE id = ?1",
        params![video_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // 取り消し用に、変更した項目とその変更前の値を控える
    let mut fields: Vec<&str> = Vec::new();
    let mut before = serde_json::Map::new();
    if let Some(t) = title {
        conn.execute(
            "UPDATE videos SET title = ?1 WHERE id = ?2",
            params![or_null(t), video_id],
        )?;
        fields.push("title");
        before.insert("title".into(), serde_json::json!(old_title));
    }
    if let Some(c) = comment {
        conn.execute(
            "UPDATE videos SET comment = ?1 WHERE id = ?2",
            params![or_null(c), video_id],
        )?;
        fields.push("comment");
        before.insert("comment".into(), serde_json::json!(old_comment));
    }
    db::log_op(
        conn,
        actor,
        "set_video_info",
        &serde_json::json!({
            "id": video_id,
            // 変更した項目名(v1.34)。before の値だけでは「元が未設定だった」と
            // 「触っていない」がどちらも null になって区別できないので、別に持つ
            "fields": fields,
            "before": before,
        })
        .to_string(),
    );
    Ok(())
}

/// ライブラリから登録を削除する(ファイル自体は消さない)
pub fn remove_videos(conn: &Connection, actor: &str, video_ids: &[i64]) -> Result<()> {
    conn.execute(&format!("DELETE FROM videos WHERE id IN ({})", ids_csv(video_ids)), [])?;
    db::log_op(
        conn,
        actor,
        "remove_videos",
        &serde_json::json!({ "videos": video_ids }).to_string(),
    );
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

/// 再生が実際に始まった時点で呼ぶ(v1.18)。
/// `last_viewed_at` の更新と `view_history` への 1 行追加を同時に行い、履歴の行 id を返す。
///
/// **`mark_viewed`(視聴カウント)とは基準が違う**。あちらは尺の 5% or 30 秒を観たときだけ
/// 進むが、こちらは 1 フレームでも再生されたら必ず記録する。
/// 「ちょっと開いて閉じたやつ」を探し直せるようにするための区別
/// (結果として view_count = 0 でも last_viewed_at がある動画が生まれる。これは正しい)。
///
/// 記録の基準を 1 つに保ちたいので、2 つの書き込みは 1 トランザクションにまとめる。
/// ここだけ `unchecked_transaction` を使うのは、再生のたびに通る経路で
/// `BEGIN` を投げっぱなしにすると以後の書き込みが全部止まるため(drop で自動ロールバックされる)
pub fn mark_opened(conn: &Connection, video_id: i64) -> Result<i64> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE videos SET last_viewed_at = datetime('now','localtime') WHERE id = ?1",
        params![video_id],
    )?;
    tx.execute("INSERT INTO view_history (video_id) VALUES (?1)", params![video_id])?;
    let history_id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(history_id)
}

/// 再生を終える / 閉じるときに呼ぶ(v1.18)。到達位置を履歴の行に書き戻す。
/// 呼ばれないまま(異常終了・外部プレイヤー)なら watched_ms は NULL のまま = 不明
pub fn finish_view(conn: &Connection, history_id: i64, watched_ms: i64) -> Result<()> {
    conn.execute(
        "UPDATE view_history SET watched_ms = ?1 WHERE id = ?2",
        params![watched_ms.max(0), history_id],
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

pub fn paths_of(conn: &Connection, video_ids: &[i64]) -> Result<Vec<(i64, String)>> {
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

/// ごみ箱へ送るだけ(**DB には触らない**)。1 件ずつシェル API を待つので、
/// DB ロックを持たずに呼べるようにファイル操作だけを切り出してある。
/// オフラインドライブ上はスキップする
pub fn trash_paths(items: Vec<(i64, String)>) -> Vec<TrashResult> {
    let mut roots = offline::RootCache::default();
    let mut results = Vec::new();
    for (id, path) in items {
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
            Ok(()) => results.push(TrashResult { id, path, trashed: true, error: None }),
            Err(e) => {
                results.push(TrashResult { id, path, trashed: false, error: Some(e.to_string()) });
            }
        }
    }
    results
}

/// ごみ箱へ送れたぶんの DB 追従(is_missing=1 + 監査ログ)。1 トランザクションでまとめる
pub fn record_trashed(conn: &Connection, actor: &str, results: &[TrashResult]) -> Result<()> {
    if !results.iter().any(|r| r.trashed) {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for r in results.iter().filter(|r| r.trashed) {
        tx.execute("UPDATE videos SET is_missing = 1 WHERE id = ?1", params![r.id])?;
        db::log_op(
            &tx,
            actor,
            "trash_file",
            &serde_json::json!({ "id": r.id, "path": r.path }).to_string(),
        );
    }
    tx.commit()?;
    Ok(())
}

/// ファイルをごみ箱へ送る。成功分は is_missing=1 にして DB レコードは残す
/// (ごみ箱から戻して再スキャンすれば復帰できる)。
/// conn を渡している間ずっとロックを握る呼び方になるので、UI 経路は
/// paths_of → trash_paths → record_trashed の 3 分割で呼ぶこと(MCP・テストはこちらで良い)
pub fn trash_files(conn: &Connection, actor: &str, video_ids: &[i64]) -> Result<Vec<TrashResult>> {
    let items = paths_of(conn, video_ids)?;
    let results = trash_paths(items);
    record_trashed(conn, actor, &results)?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本物のスキーマを流したインメモリ DB で確かめる(SQL の実行結果で見る方針)。
    /// CASCADE を見たいので foreign_keys は明示的に ON にする(db::init と同じ設定)
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO videos (id, path, filename, size, added_at)
               VALUES (1, 'C:\v\a.mp4', 'a.mp4', 100, '2026-01-01 00:00:00');"#,
        )
        .unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// mark_opened は「開いた」だけを記録する。視聴カウント(5%/30 秒)は動かさない
    #[test]
    fn mark_opened_records_the_open_without_counting_a_view() {
        let conn = setup();
        mark_opened(&conn, 1).unwrap();

        assert_eq!(scalar(&conn, "SELECT view_count FROM videos WHERE id = 1"), 0);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM videos WHERE id = 1 AND last_viewed_at IS NOT NULL"),
            1,
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM view_history"), 1);
    }

    /// last_viewed_at は上書きされるが、履歴は 1 回ごとに 1 行貯まる(これが表を足した理由)
    #[test]
    fn every_open_adds_a_row_even_though_last_viewed_at_is_overwritten() {
        let conn = setup();
        for _ in 0..3 {
            mark_opened(&conn, 1).unwrap();
        }
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM view_history WHERE video_id = 1"), 3);
    }

    /// 閉じるまで watched_ms は NULL(= 不明)のまま。異常終了しても「見た」事実は残る
    #[test]
    fn watched_ms_is_null_until_the_view_finishes() {
        let conn = setup();
        let id = mark_opened(&conn, 1).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM view_history WHERE watched_ms IS NULL"), 1);

        finish_view(&conn, id, 743_000).unwrap();
        assert_eq!(scalar(&conn, "SELECT watched_ms FROM view_history WHERE id = 1"), 743_000);
    }

    fn text(conn: &Connection, sql: &str) -> Option<String> {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// 渡さなかった項目は触らない。UI は変えた欄だけ送るので、これが崩れると
    /// タイトルを直しただけでメモが消える
    #[test]
    fn set_video_info_leaves_the_omitted_field_alone() {
        let conn = setup();
        set_video_info(&conn, "user", 1, Some("第 1 話"), Some("作画が良い回")).unwrap();
        set_video_info(&conn, "user", 1, Some("第 1 話 出会い"), None).unwrap();

        assert_eq!(text(&conn, "SELECT title FROM videos WHERE id=1").as_deref(), Some("第 1 話 出会い"));
        assert_eq!(text(&conn, "SELECT comment FROM videos WHERE id=1").as_deref(), Some("作画が良い回"));
    }

    /// 欄を空にしたら NULL に戻すこと。空文字のまま入れると
    /// 一覧の `title ?? filename` が効かず、名前が空欄で表示される
    #[test]
    fn clearing_a_field_stores_null_not_an_empty_string() {
        let conn = setup();
        set_video_info(&conn, "user", 1, Some("第 1 話"), None).unwrap();
        set_video_info(&conn, "user", 1, Some("   "), None).unwrap();

        assert_eq!(text(&conn, "SELECT title FROM videos WHERE id=1"), None);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM videos WHERE id=1 AND title IS NULL"), 1);
    }

    /// 取り消し用の payload には「変更した項目名」が要る。
    /// before の値だけでは、元が未設定(null)なのか触っていない(null)のか区別できない
    #[test]
    fn the_log_names_the_changed_fields() {
        let conn = setup();
        set_video_info(&conn, "user", 1, Some("第 1 話"), None).unwrap();

        let payload = text(&conn, "SELECT payload FROM operations_log ORDER BY id DESC LIMIT 1").unwrap();
        let p: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(p["fields"], serde_json::json!(["title"]));
        assert!(p["before"]["title"].is_null(), "元は未設定だったこと");
        assert!(p["before"].get("comment").is_none(), "触っていない項目は before に載せない");
    }

    /// 動画を消したら履歴も一緒に消える(孤児掃除のワーカーを書かずに済ませている根拠)
    #[test]
    fn history_is_removed_with_the_video() {
        let conn = setup();
        mark_opened(&conn, 1).unwrap();
        remove_videos(&conn, "user", &[1]).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM view_history"), 0);
    }
}
