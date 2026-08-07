//! 重複の解消 —— 同じ内容の動画を 1 本だけ残して、残りをライブラリから外す(v1.33)
//!
//! **ファイルには一切触らない**。外すのはライブラリの登録だけで、ごみ箱にも送らない。
//!
//! 設計の要点(事故を起こさないためのルール):
//!
//! - **スコープの全員が揃っているグループだけ触る**。`N:\写真` を指定したとき、同じ内容が
//!   `Q:\backup` にもあるなら、そのグループは見送る。片方だけ消えると「バックアップの
//!   つもりで置いた 2 本目」を黙って外すことになるため
//! - **必ず 1 本残す**。グループが空になることはない
//! - **サイズ 0 は対象外**。空ファイル同士は中身が同じでもハッシュが一致してしまい、
//!   まったく無関係な動画が同じグループに入る(実際に壊れた mp4 で起きた)
//! - **ユーザーが手を入れたものを優先して残す**。タグ・レーティング・視聴履歴・シリーズ
//!   所属のどれかがあれば、それを残す側に回す

use crate::core::excludes::normalize;
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeSample {
    /// 残すパス
    pub keep: String,
    /// ライブラリから外すパス
    pub remove: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupePlan {
    /// 対象になった重複グループ数(= 残る本数)
    pub groups: i64,
    /// ライブラリから外す本数
    pub remove_count: i64,
    /// スコープの外にも同じ内容があったので見送ったグループ数
    pub skipped_outside: i64,
    /// サイズ 0 で判定できず見送ったグループ数
    pub skipped_zero_size: i64,
    /// 外す本数のフォルダ別内訳(多い順・上位 20)
    pub by_folder: Vec<FolderCount>,
    /// 先頭 20 グループの中身(確認用)
    pub samples: Vec<DedupeSample>,
    /// 実際に外す video id
    pub remove_ids: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCount {
    pub path: String,
    pub count: i64,
}

/// 実行結果。ごみ箱に送らなかったときは trashed / failed とも 0
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DedupeResult {
    /// ライブラリから外した本数
    pub removed: i64,
    /// ごみ箱へ送れた本数
    pub trashed: i64,
    /// ごみ箱へ送れなかった本数(未接続のドライブ・権限・使用中など)
    pub failed: i64,
}

struct Member {
    id: i64,
    path: String,
    /// 0 = ユーザーが手を入れている(優先して残す)/ 1 = 手つかず
    untouched: i64,
    in_scope: bool,
}

/// 重複解消の計画を立てる(DB は読むだけ)。
/// `scope` にフォルダの絶対パスを渡すと、その配下だけを対象にする(None でライブラリ全体)
pub fn plan(conn: &Connection, scope: Option<&str>) -> Result<DedupePlan> {
    let scope_norm = scope
        .map(|s| normalize(s))
        .filter(|s| !s.is_empty());

    let mut stmt = conn.prepare(
        "SELECT v.id, v.path, v.size, v.partial_hash,
            CASE WHEN v.rating > 0 OR v.view_count > 0 OR v.last_viewed_at IS NOT NULL
                   OR v.resume_ms > 0
                   OR EXISTS(SELECT 1 FROM video_tags t WHERE t.video_id = v.id)
                   OR EXISTS(SELECT 1 FROM series_entries s WHERE s.video_id = v.id)
                 THEN 0 ELSE 1 END AS untouched
         FROM videos v
         WHERE v.partial_hash IS NOT NULL AND v.size > 0
           AND (v.size, v.partial_hash) IN (
             SELECT size, partial_hash FROM videos
             WHERE partial_hash IS NOT NULL AND size > 0
             GROUP BY size, partial_hash HAVING COUNT(*) > 1)
         ORDER BY v.size, v.partial_hash, v.added_at, v.id",
    )?;

    // (size, hash) ごとにまとめる。SQL 側で並べてあるので順番に積むだけ
    let mut groups: Vec<Vec<Member>> = Vec::new();
    let mut last_key: Option<(i64, String)> = None;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    for row in rows.flatten() {
        let (id, path, size, hash, untouched) = row;
        let in_scope = match &scope_norm {
            None => true,
            Some(s) => {
                let p = normalize(&path);
                p.starts_with(s.as_str())
                    && (p.len() == s.len() || p.as_bytes()[s.len()] == b'\\')
            }
        };
        let key = (size, hash);
        if last_key.as_ref() != Some(&key) {
            groups.push(Vec::new());
            last_key = Some(key);
        }
        groups
            .last_mut()
            .expect("直前に push している")
            .push(Member { id, path, untouched, in_scope });
    }

    // サイズ 0 のグループは上の WHERE で既に外してあるが、件数はユーザーに見せたいので数える
    let skipped_zero_size = count_zero_size_groups(conn)?;

    let mut skipped_outside = 0i64;
    let mut remove_ids: Vec<i64> = Vec::new();
    let mut remove_paths: Vec<String> = Vec::new();
    let mut samples: Vec<DedupeSample> = Vec::new();
    let mut group_count = 0i64;

    for mut members in groups {
        if members.len() < 2 {
            continue; // スコープ外を除いた結果 1 本になったグループは触らない
        }
        // スコープ指定時は「全員がスコープの中にいる」グループだけ触る
        if scope_norm.is_some() {
            let inside = members.iter().filter(|m| m.in_scope).count();
            // まったく関係のないグループは数にも入れない。
            // ここを skipped_outside に混ぜると「外にも同じ内容がある」と報告してしまい、
            // ライブラリの他の場所にある無関係な重複の数を見せることになる
            if inside == 0 {
                continue;
            }
            if inside != members.len() {
                skipped_outside += 1;
                continue;
            }
        }
        // ユーザーが手を入れたもの → 登録が古いもの の順で先頭を残す
        // (SQL で added_at, id の昇順に並べてあるので、安定ソートで順序が保たれる)
        members.sort_by_key(|m| m.untouched);
        group_count += 1;
        let keep = members.remove(0);
        if samples.len() < 20 {
            samples.push(DedupeSample {
                keep: keep.path.clone(),
                remove: members.iter().map(|m| m.path.clone()).collect(),
            });
        }
        for m in members {
            remove_ids.push(m.id);
            remove_paths.push(m.path);
        }
    }

    Ok(DedupePlan {
        groups: group_count,
        remove_count: remove_ids.len() as i64,
        skipped_outside,
        skipped_zero_size,
        by_folder: folder_breakdown(&remove_paths),
        samples,
        remove_ids,
    })
}

/// 重複解消を実行する。計画はこの中で立て直すので、下見からの時間差で
/// 増えた動画も反映される。
///
/// `trash` を立てると**ファイルをごみ箱へ送ってから**登録を外す。
/// ごみ箱に送れなかったもの(未接続のドライブなど)は登録も残す ——
/// ファイルが残っているのに一覧から消えると、行方が分からなくなるため。
///
/// 戻り値の 2 つめは登録を外した video id(サムネイル・変換キャッシュの掃除に使う)。
/// **完全削除はしない**。取り消したいときは Windows のごみ箱から戻して再スキャンする
/// 実行用の計画。ごみ箱送りの対象パスも一緒に返す
/// (ごみ箱送りを DB ロックの外で行えるよう、読むものはここで全部読んでおく)
pub fn plan_for_apply(
    conn: &Connection,
    scope: Option<&str>,
) -> Result<(DedupePlan, Vec<(i64, String)>)> {
    let plan = plan(conn, scope)?;
    let paths = crate::core::videos::paths_of(conn, &plan.remove_ids)?;
    Ok((plan, paths))
}

/// ごみ箱送りの結果(使わなかったなら None)を受けて、登録を外してログを書く。
/// 送れたぶんの DB 追従(record_trashed)もここでまとめて行う
pub fn finish(
    conn: &Connection,
    actor: &str,
    scope: Option<&str>,
    plan: &DedupePlan,
    trash_results: Option<&[crate::core::videos::TrashResult]>,
) -> Result<(DedupeResult, Vec<i64>)> {
    if plan.remove_ids.is_empty() {
        return Ok((DedupeResult::default(), Vec::new()));
    }

    let (to_remove, trashed, failed) = match trash_results {
        Some(results) => {
            crate::core::videos::record_trashed(conn, actor, results)?;
            let ok: Vec<i64> = results.iter().filter(|r| r.trashed).map(|r| r.id).collect();
            let failed = (results.len() - ok.len()) as i64;
            let trashed = ok.len() as i64;
            (ok, trashed, failed)
        }
        None => (plan.remove_ids.clone(), 0, 0),
    };

    if to_remove.is_empty() {
        return Ok((DedupeResult { removed: 0, trashed, failed }, Vec::new()));
    }
    crate::core::videos::remove_videos(conn, actor, &to_remove)?;
    crate::db::log_op(
        conn,
        actor,
        "dedupe",
        &serde_json::json!({
            "scope": scope.unwrap_or("(ライブラリ全体)"),
            "groups": plan.groups,
            "removed": to_remove.len(),
            "trashed": trashed,
            "failed": failed,
        })
        .to_string(),
    );
    Ok((
        DedupeResult { removed: to_remove.len() as i64, trashed, failed },
        to_remove,
    ))
}

/// conn を渡している間ずっとロックを握る呼び方になるので、UI 経路は
/// plan_for_apply → videos::trash_paths → finish の 3 分割で呼ぶこと(テストはこちらで良い)
pub fn apply(
    conn: &Connection,
    actor: &str,
    scope: Option<&str>,
    trash: bool,
) -> Result<(DedupeResult, Vec<i64>)> {
    let (plan, paths) = plan_for_apply(conn, scope)?;
    let trash_results = if trash {
        Some(crate::core::videos::trash_paths(paths))
    } else {
        None
    };
    finish(conn, actor, scope, &plan, trash_results.as_deref())
}

/// サイズ 0 で「同じ内容」と言い切れないグループの数(対象外にした理由を見せるため)
fn count_zero_size_groups(conn: &Connection) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT 1 FROM videos WHERE partial_hash IS NOT NULL AND size = 0
           GROUP BY size, partial_hash HAVING COUNT(*) > 1)",
        [],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 外す本数を親フォルダ単位で数える(多い順・上位 20)
fn folder_breakdown(paths: &[String]) -> Vec<FolderCount> {
    let mut map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for p in paths {
        let dir = match p.rfind(['\\', '/']) {
            Some(i) => p[..i].to_string(),
            None => p.clone(),
        };
        *map.entry(dir).or_insert(0) += 1;
    }
    let mut v: Vec<FolderCount> = map
        .into_iter()
        .map(|(path, count)| FolderCount { path, count })
        .collect();
    v.sort_by(|a, b| b.count.cmp(&a.count).then(a.path.cmp(&b.path)));
    v.truncate(20);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn
    }

    fn insert(conn: &Connection, id: i64, path: &str, size: i64, hash: Option<&str>) {
        conn.execute(
            "INSERT INTO videos (id, path, filename, size, partial_hash, added_at)
             VALUES (?1, ?2, 'f.mp4', ?3, ?4, '2026-01-01 00:00:00')",
            rusqlite::params![id, path, size, hash],
        )
        .unwrap();
    }

    #[test]
    fn keeps_one_per_group() {
        let conn = setup();
        insert(&conn, 1, "N:\\a\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\b\\x.mp4", 100, Some("h1"));
        insert(&conn, 3, "N:\\c\\x.mp4", 100, Some("h1"));
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.groups, 1);
        assert_eq!(p.remove_count, 2);
        assert_eq!(p.remove_ids, vec![2, 3], "登録が古い 1 を残す");
    }

    #[test]
    fn zero_size_group_is_never_touched() {
        let conn = setup();
        // 壊れた 0 バイトファイル同士は同じハッシュになるが、中身は無関係
        insert(&conn, 1, "N:\\a\\壊れ.mp4", 0, Some("zero"));
        insert(&conn, 2, "Q:\\b\\別物.mp4", 0, Some("zero"));
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.remove_count, 0);
        assert_eq!(p.skipped_zero_size, 1);
    }

    #[test]
    fn group_spanning_outside_scope_is_skipped() {
        let conn = setup();
        insert(&conn, 1, "N:\\twitter\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "Q:\\backup\\x.mp4", 100, Some("h1"));
        let p = plan(&conn, Some("N:\\twitter")).unwrap();
        assert_eq!(p.remove_count, 0, "スコープ外に同じ内容があるので触らない");
        assert_eq!(p.skipped_outside, 1);
    }

    #[test]
    fn scope_limits_to_its_own_subtree() {
        let conn = setup();
        insert(&conn, 1, "N:\\twitter\\2020\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\twitter\\2022\\x.mp4", 100, Some("h1"));
        // スコープ外の別グループ(こちらは触られない)
        insert(&conn, 3, "Q:\\a\\y.mp4", 200, Some("h2"));
        insert(&conn, 4, "Q:\\b\\y.mp4", 200, Some("h2"));
        let p = plan(&conn, Some("N:\\twitter")).unwrap();
        assert_eq!(p.groups, 1);
        assert_eq!(p.remove_ids, vec![2]);
    }

    #[test]
    fn groups_entirely_outside_scope_are_not_reported_as_skipped() {
        let conn = setup();
        insert(&conn, 1, "N:\\twitter\\a\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\twitter\\b\\x.mp4", 100, Some("h1"));
        // スコープと縁のない重複。「外にもある」と報告してはいけない
        insert(&conn, 3, "Q:\\a\\y.mp4", 200, Some("h2"));
        insert(&conn, 4, "Q:\\b\\y.mp4", 200, Some("h2"));
        let p = plan(&conn, Some("N:\\twitter")).unwrap();
        assert_eq!(p.groups, 1);
        assert_eq!(p.remove_count, 1);
        assert_eq!(p.skipped_outside, 0, "無関係なグループは数えない");
    }

    #[test]
    fn sibling_folder_with_same_prefix_is_outside_scope() {
        let conn = setup();
        insert(&conn, 1, "N:\\twitter\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\twitter2\\x.mp4", 100, Some("h1"));
        let p = plan(&conn, Some("N:\\twitter")).unwrap();
        assert_eq!(p.remove_count, 0, "twitter2 は twitter の配下ではない");
        assert_eq!(p.skipped_outside, 1);
    }

    #[test]
    fn tagged_video_is_kept_even_if_newer() {
        let conn = setup();
        insert(&conn, 1, "N:\\a\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\b\\x.mp4", 100, Some("h1"));
        conn.execute("INSERT INTO tags (id, name) VALUES (1, 'お気に入り')", [])
            .unwrap();
        conn.execute("INSERT INTO video_tags (video_id, tag_id) VALUES (2, 1)", [])
            .unwrap();
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.remove_ids, vec![1], "タグが付いた 2 を残す");
    }

    #[test]
    fn viewed_video_is_kept() {
        let conn = setup();
        insert(&conn, 1, "N:\\a\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\b\\x.mp4", 100, Some("h1"));
        conn.execute("UPDATE videos SET view_count = 1 WHERE id = 2", [])
            .unwrap();
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.remove_ids, vec![1]);
    }

    #[test]
    fn videos_without_hash_are_not_duplicates() {
        let conn = setup();
        insert(&conn, 1, "N:\\a\\x.mp4", 100, None);
        insert(&conn, 2, "N:\\b\\x.mp4", 100, None);
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.remove_count, 0);
    }

    #[test]
    fn folder_breakdown_counts_parents() {
        let conn = setup();
        insert(&conn, 1, "N:\\keep\\x.mp4", 100, Some("h1"));
        insert(&conn, 2, "N:\\dup\\x.mp4", 100, Some("h1"));
        insert(&conn, 3, "N:\\keep\\y.mp4", 200, Some("h2"));
        insert(&conn, 4, "N:\\dup\\y.mp4", 200, Some("h2"));
        let p = plan(&conn, None).unwrap();
        assert_eq!(p.by_folder.len(), 1);
        assert_eq!(p.by_folder[0].path, "N:\\dup");
        assert_eq!(p.by_folder[0].count, 2);
    }
}
