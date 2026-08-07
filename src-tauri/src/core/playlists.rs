//! 保存プレイリスト(v1.40)。
//!
//! **キューはここに入らない。** 画面で組み立てている最中のキューはフロントのメモリだけに
//! あり、DB を触るのは「名前を付けて保存」「上書き保存」を押した瞬間だけ
//! (DESIGN.md「プレイリスト」節)。したがってこのモジュールの関数はどれも
//! 「リスト 1 本を丸ごと書く / 読む」の粒度で、1 件ずつ足し引きする API は持たない。

use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub video_count: i64,
    pub position: i64,
}

pub fn list(conn: &Connection) -> Result<Vec<Playlist>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name,
                (SELECT COUNT(*) FROM playlist_entries pe WHERE pe.playlist_id = p.id) AS cnt,
                p.position
         FROM playlists p ORDER BY p.position, p.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Playlist {
                id: r.get(0)?,
                name: r.get(1)?,
                video_count: r.get(2)?,
                position: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// リストの中身を position 順の video_id で返す(キューに読み込むときに使う)。
/// 行そのものは返さない —— 一覧と同じ `query_videos` で引き直すほうが、
/// カードの表示に必要な列の作り方が 1 か所で済む
pub fn entries(conn: &Connection, playlist_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT video_id FROM playlist_entries WHERE playlist_id = ?1 ORDER BY position, video_id",
    )?;
    let rows = stmt
        .query_map(params![playlist_id], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 名前が既に使われているか(自分自身は除く)。
/// UI は「上書きしますか?」を尋ねるためにこれを先に呼ぶ
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<i64>> {
    let name = name.trim();
    Ok(conn
        .query_row("SELECT id FROM playlists WHERE name = ?1", params![name], |r| r.get(0))
        .ok())
}

/// 新規作成して中身を書き込む。名前が既にあればエラー
/// (「上書きするか」の判断は UI が find_by_name で先に済ませ、上書きなら replace を呼ぶ)
pub fn create(conn: &Connection, actor: &str, name: &str, video_ids: &[i64]) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "名前が空です");
    anyhow::ensure!(
        find_by_name(conn, name)?.is_none(),
        "同じ名前のプレイリストがすでにあります"
    );
    // 行の作成とエントリ書き込みを 1 トランザクションに。分けると、エントリ側が
    // 失敗したときに「名前だけ取られた空のプレイリスト」が残る
    let tx = conn.unchecked_transaction()?;
    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM playlists",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO playlists (name, position) VALUES (?1, ?2)",
        params![name, next],
    )?;
    let id = tx.last_insert_rowid();
    write_entries(&tx, id, video_ids)?;
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "create_playlist",
        &serde_json::json!({ "playlistId": id, "name": name, "count": video_ids.len() }).to_string(),
    );
    Ok(id)
}

/// 中身を丸ごと差し替える(上書き保存)。名前は変えない
pub fn replace(conn: &Connection, actor: &str, playlist_id: i64, video_ids: &[i64]) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM playlists WHERE id = ?1", params![playlist_id], |r| {
            r.get(0)
        })
        .map_err(|_| anyhow::anyhow!("プレイリストが見つかりません"))?;
    let tx = conn.unchecked_transaction()?;
    write_entries(&tx, playlist_id, video_ids)?;
    tx.commit()?;
    db::log_op(
        conn,
        actor,
        "replace_playlist",
        &serde_json::json!({ "playlistId": playlist_id, "name": name, "count": video_ids.len() })
            .to_string(),
    );
    Ok(())
}

/// 消してから順に入れ直す。**呼び出し側のトランザクションの中で呼ぶ**
/// (create / replace が unchecked_transaction を張ってから渡してくる)。
/// 重複した video_id は最初の 1 つだけが残る(PK が (playlist_id, video_id) なので
/// INSERT OR IGNORE が 2 つ目を落とす)—— キュー側でも重複は作らせないが、
/// MCP や壊れた入力から来ても position が飛ばないようにここでも受け止める。
/// ライブラリから消えた動画 id は SELECT が空になって静かに落ちる
/// (INSERT OR IGNORE は FK 違反を握り潰さないので、VALUES 直書きだと
/// 保存の往復中に動画が消えただけで保存全体が生エラーになる)
fn write_entries(conn: &Connection, playlist_id: i64, video_ids: &[i64]) -> Result<()> {
    conn.execute(
        "DELETE FROM playlist_entries WHERE playlist_id = ?1",
        params![playlist_id],
    )?;
    let mut pos: i64 = 0;
    for vid in video_ids {
        let n = conn.execute(
            "INSERT OR IGNORE INTO playlist_entries (playlist_id, video_id, position)
             SELECT ?1, id, ?3 FROM videos WHERE id = ?2",
            params![playlist_id, vid, pos],
        )?;
        if n > 0 {
            pos += 1;
        }
    }
    Ok(())
}

/// 名前を変える。同名は弾く(DB の UNIQUE でも止まるが、
/// メッセージを日本語で出したいので先に見る)
pub fn rename(conn: &Connection, actor: &str, playlist_id: i64, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "名前が空です");
    if let Some(other) = find_by_name(conn, new_name)? {
        anyhow::ensure!(other == playlist_id, "同じ名前のプレイリストがすでにあります");
    }
    let before: String = conn
        .query_row("SELECT name FROM playlists WHERE id = ?1", params![playlist_id], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    conn.execute(
        "UPDATE playlists SET name = ?1 WHERE id = ?2",
        params![new_name, playlist_id],
    )?;
    db::log_op(
        conn,
        actor,
        "rename_playlist",
        &serde_json::json!({ "playlistId": playlist_id, "before": before, "after": new_name })
            .to_string(),
    );
    Ok(())
}

/// 複製する。名前は「◯◯ のコピー」→ 空くまで連番。
/// **複製だけは上書きを尋ねない** —— 新しいものが欲しい操作なので、尋ねる意味がない
pub fn duplicate(conn: &Connection, actor: &str, playlist_id: i64) -> Result<i64> {
    let base: String = conn
        .query_row("SELECT name FROM playlists WHERE id = ?1", params![playlist_id], |r| {
            r.get(0)
        })
        .map_err(|_| anyhow::anyhow!("プレイリストが見つかりません"))?;
    let ids = entries(conn, playlist_id)?;
    let name = free_copy_name(conn, &base)?;
    create(conn, actor, &name, &ids)
}

/// 「◯◯ のコピー」「◯◯ のコピー (2)」… と空いている名前を探す
fn free_copy_name(conn: &Connection, base: &str) -> Result<String> {
    let first = format!("{base} のコピー");
    if find_by_name(conn, &first)?.is_none() {
        return Ok(first);
    }
    // 上限は付ける。無限ループにしない(現実には 2〜3 で空く)
    for n in 2..1000 {
        let cand = format!("{first} ({n})");
        if find_by_name(conn, &cand)?.is_none() {
            return Ok(cand);
        }
    }
    anyhow::bail!("コピー名の空きが見つかりませんでした")
}

pub fn delete(conn: &Connection, actor: &str, playlist_id: i64) -> Result<()> {
    let name: String = conn
        .query_row("SELECT name FROM playlists WHERE id = ?1", params![playlist_id], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    // playlist_entries は ON DELETE CASCADE
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
    db::log_op(
        conn,
        actor,
        "delete_playlist",
        &serde_json::json!({ "playlistId": playlist_id, "name": name }).to_string(),
    );
    Ok(())
}

/// 渡された順に position を振り直す(サイドバーのドラッグ並べ替え。smart_folders と同じ)
pub fn reorder(conn: &Connection, ids: &[i64]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (pos, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE playlists SET position = ?1 WHERE id = ?2",
            params![pos as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::apply_schema(&conn).unwrap();
        for i in 1..=5 {
            conn.execute(
                "INSERT INTO videos (id, path, filename) VALUES (?1, ?2, ?3)",
                params![i, format!("C:\\動画\\{i}.mp4"), format!("{i}.mp4")],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn keeps_given_order_and_rewrites_on_replace() {
        let conn = setup();
        let id = create(&conn, "user", "週末に観る", &[3, 1, 2]).unwrap();
        assert_eq!(entries(&conn, id).unwrap(), vec![3, 1, 2]);

        // 上書き保存は「消して入れ直す」。position は 0 から詰め直る
        replace(&conn, "user", id, &[2, 5]).unwrap();
        assert_eq!(entries(&conn, id).unwrap(), vec![2, 5]);
        assert_eq!(list(&conn).unwrap()[0].video_count, 2);
    }

    #[test]
    fn duplicate_video_ids_collapse_without_gaps() {
        let conn = setup();
        let id = create(&conn, "user", "重複あり", &[1, 2, 1, 3]).unwrap();
        // 2 つ目の 1 は落ちる。position が飛ぶと並べ替えの結果がずれるので詰まっていること
        assert_eq!(entries(&conn, id).unwrap(), vec![1, 2, 3]);
        let positions: Vec<i64> = conn
            .prepare("SELECT position FROM playlist_entries WHERE playlist_id = ?1 ORDER BY position")
            .unwrap()
            .query_map(params![id], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(positions, vec![0, 1, 2]);
    }

    #[test]
    fn names_are_unique_case_insensitively() {
        let conn = setup();
        create(&conn, "user", "週末に観る", &[1]).unwrap();
        assert!(create(&conn, "user", "週末に観る", &[2]).is_err());
        create(&conn, "user", "Weekend", &[1]).unwrap();
        // COLLATE NOCASE なので大文字小文字違いも同じ名前
        assert!(create(&conn, "user", "weekend", &[2]).is_err());
        assert!(create(&conn, "user", "  ", &[1]).is_err());
    }

    #[test]
    fn rename_allows_self_and_rejects_others() {
        let conn = setup();
        let a = create(&conn, "user", "あとで", &[1]).unwrap();
        create(&conn, "user", "お気に入り", &[2]).unwrap();
        assert!(rename(&conn, "user", a, "お気に入り").is_err());
        // 自分自身と同じ名前は通す(大文字小文字だけ直したいことがある)
        assert!(rename(&conn, "user", a, "あとで").is_ok());
        assert!(rename(&conn, "user", a, "あとで観る").is_ok());
        assert!(rename(&conn, "user", a, "").is_err());
    }

    #[test]
    fn duplicate_finds_a_free_name() {
        let conn = setup();
        let a = create(&conn, "user", "夜", &[2, 1]).unwrap();
        let b = duplicate(&conn, "user", a).unwrap();
        let c = duplicate(&conn, "user", a).unwrap();
        let names: Vec<String> = list(&conn).unwrap().into_iter().map(|p| p.name).collect();
        assert!(names.contains(&"夜 のコピー".to_string()));
        assert!(names.contains(&"夜 のコピー (2)".to_string()));
        // 中身も並びごと複製される
        assert_eq!(entries(&conn, b).unwrap(), vec![2, 1]);
        assert_eq!(entries(&conn, c).unwrap(), vec![2, 1]);
    }

    #[test]
    fn deleting_a_video_removes_it_from_lists() {
        let conn = setup();
        let id = create(&conn, "user", "掃除前", &[1, 2, 3]).unwrap();
        conn.execute("DELETE FROM videos WHERE id = 2", []).unwrap();
        // ON DELETE CASCADE。保存リスト側の追随はここに任せている(フロントは何もしない)
        assert_eq!(entries(&conn, id).unwrap(), vec![1, 3]);
    }

    #[test]
    fn reorder_moves_lists_in_the_sidebar() {
        let conn = setup();
        let a = create(&conn, "user", "A", &[1]).unwrap();
        let b = create(&conn, "user", "B", &[2]).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|p| p.id).collect::<Vec<_>>(), vec![a, b]);
        reorder(&conn, &[b, a]).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|p| p.id).collect::<Vec<_>>(), vec![b, a]);

        delete(&conn, "user", a).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
