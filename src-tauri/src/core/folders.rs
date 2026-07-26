//! フォルダーツリー(サイドバーの「フォルダー」タブ)。
//!
//! DB にフォルダ階層は持たない。`videos.path` の文字列だけからツリーを組み立てる。
//! **ディスクを走査しない**のが要点で、外付け HDD / NAS が未接続でも即座に返る
//! (オフライン判定だけはドライブのルート単位で `RootCache` を使う)。

use crate::core::offline::RootCache;
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;

/// ツリーの 1 ノード。フロントは path をキーに親子を組み直す
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    /// 正規化した絶対パス(ドライブ直下を除き末尾に区切りは付けない)。ツリーの識別子
    pub path: String,
    /// 親ノードの path。ルート(監視フォルダ / 監視フォルダ外の置き場)は None
    pub parent: Option<String>,
    /// 表示名。ルートはフルパス、それ以外は末尾セグメント
    pub name: String,
    /// このフォルダ直下の動画数(= クリックしたときに出る件数)
    pub direct_count: i64,
    /// 配下すべての動画数(自分を含む)
    pub total_count: i64,
    /// 監視フォルダのルートなら その id
    pub watched_folder_id: Option<i64>,
    /// ルートが到達できるドライブ上にあるか(オフライン表示用)
    pub online: bool,
}

/// パスをツリーのキー形式に揃える。区切りは `\`、末尾の区切りは落とす。
/// ただしドライブ直下(`C:\`)は区切りまで含めないと意味が変わるので残す
fn normalize_dir(path: &str) -> String {
    let p = path.replace('/', "\\");
    let trimmed = p.trim_end_matches('\\');
    if trimmed.is_empty() {
        return p;
    }
    if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

/// 親ディレクトリを返す。`C:\v\a.mp4` → `C:\v`、`C:\a.mp4` → `C:\`
fn parent_dir(path: &str) -> Option<String> {
    let p = path.replace('/', "\\");
    let p = p.trim_end_matches('\\');
    let idx = p.rfind('\\')?;
    let head = &p[..idx];
    if head.is_empty() {
        return None;
    }
    Some(normalize_dir(head))
}

/// 大文字小文字を無視した比較キー。
/// SQL 側(`query.rs` の dir_path)の `lower()` に合わせて **ASCII のみ**畳む
fn key_of(path: &str) -> String {
    path.to_ascii_lowercase()
}

/// 末尾セグメント(表示名)
fn last_segment(path: &str) -> String {
    let p = path.trim_end_matches('\\');
    match p.rfind('\\') {
        Some(i) => p[i + 1..].to_string(),
        None => path.to_string(),
    }
}

/// メインビューに出すサブフォルダ一覧(v1.10)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubfolderView {
    /// 「上のフォルダ」。監視フォルダの外に出るときは None(ライブラリの外へは登らせない)
    pub parent: Option<String>,
    pub children: Vec<FolderNode>,
}

/// 監視フォルダのパス(正規化済み)
fn watched_roots(conn: &Connection) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM watched_folders")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .map(|(id, path)| (id, normalize_dir(&path)))
        .collect();
    Ok(rows)
}

/// key が root_key の中(root 自身を含む)にあるか。境界(`\`)まで見る
fn is_within(root_key: &str, key: &str) -> bool {
    if key == root_key {
        return true;
    }
    let boundary =
        if root_key.ends_with('\\') { root_key.to_string() } else { format!("{root_key}\\") };
    key.starts_with(&boundary)
}

/// 渡されたパスを DB に入っている表記に直す(呼び出し側の大文字小文字・区切りに引きずられないため)。
/// そのフォルダ配下に動画が 1 件も無ければ None
fn canonical_dir(conn: &Connection, dir: &str) -> Option<String> {
    let key = key_of(&normalize_dir(dir));
    let prefix = if key.ends_with('\\') { key.clone() } else { format!("{key}\\") };
    let n = prefix.chars().count();
    let sql = format!(
        "SELECT path FROM videos
         WHERE lower(replace(substr(path, 1, {n}), '/', '\\')) = ?1 LIMIT 1"
    );
    let sample: String = conn.query_row(&sql, [&prefix], |r| r.get(0)).ok()?;
    // 実データの表記で頭から取り直す(末尾の区切りは normalize_dir が落とす)
    Some(normalize_dir(&sample.chars().take(n).collect::<String>()))
}

/// 集計中の 1 ノード
struct Acc {
    /// 表示用のパス。最初に見つかった表記を使う(大文字小文字の揺れでノードを割らない)
    path: String,
    direct: i64,
    total: i64,
    watched_folder_id: Option<i64>,
    is_root: bool,
}

/// 監視フォルダをルートに、`videos.path` からフォルダーツリーを組み立てる。
///
/// - どの監視フォルダにも属さないパスは、その動画の親ディレクトリ自体をルートにする
/// - 判定に `videos.watched_folder_id` は使わない。パスだけで見るので、
///   D&D で個別登録したファイルも監視フォルダ配下にあればそのツリーに出る
pub fn folder_tree(conn: &Connection) -> Result<Vec<FolderNode>> {
    // --- 監視フォルダ = ルート候補 ---
    let watched = watched_roots(conn)?;
    let watched_keys: Vec<String> = watched.iter().map(|(_, path)| key_of(path)).collect();

    // 他の監視フォルダの中にある監視フォルダはツリーのルートにしない。
    // 親フォルダを後から登録したときに、同じ階層がトップレベルに 2 つ並ぶのを防ぐ
    // (入れ子の監視フォルダは親のツリーの中の 1 ノードとして出る)
    let root_keys: Vec<String> = watched_keys
        .iter()
        .filter(|k| !watched_keys.iter().any(|o| o != *k && is_within(o, k)))
        .cloned()
        .collect();

    let mut nodes: HashMap<String, Acc> = HashMap::new();

    // 動画がまだ 1 件も無い監視フォルダも出す(登録直後・スキャン中に空にならないように)
    for (id, path) in &watched {
        let k = key_of(path);
        nodes.entry(k.clone()).or_insert_with(|| Acc {
            path: path.clone(),
            direct: 0,
            total: 0,
            watched_folder_id: Some(*id),
            is_root: root_keys.contains(&k),
        });
    }

    // --- 動画のパスを 1 本ずつ畳み込む ---
    let mut stmt = conn.prepare("SELECT path FROM videos")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;

    for path in rows.filter_map(|r| r.ok()) {
        let Some(dir) = parent_dir(&path) else { continue };
        let dir_key = key_of(&dir);

        // ルートは入れ子を潰してあるので、当てはまるのは高々 1 つ
        let root_key = root_keys.iter().find(|k| is_within(k, &dir_key)).cloned();

        match root_key {
            // 監視フォルダ配下: ルートまで遡って中間ノードも作る
            Some(root_key) => {
                let mut cur = Some(dir);
                let mut first = true;
                while let Some(c) = cur {
                    let k = key_of(&c);
                    let is_root = k == root_key;
                    let parent = if is_root { None } else { parent_dir(&c) };
                    let e = nodes.entry(k).or_insert_with(|| Acc {
                        path: c.clone(),
                        direct: 0,
                        total: 0,
                        watched_folder_id: None,
                        is_root,
                    });
                    e.total += 1;
                    if first {
                        e.direct += 1;
                        first = false;
                    }
                    if is_root {
                        break;
                    }
                    cur = parent;
                }
            }
            // 監視フォルダ外: そのディレクトリ自体をルートにする(「その他の場所」)
            None => {
                let e = nodes.entry(dir_key).or_insert_with(|| Acc {
                    path: dir,
                    direct: 0,
                    total: 0,
                    watched_folder_id: None,
                    is_root: true,
                });
                e.direct += 1;
                e.total += 1;
            }
        }
    }
    drop(stmt);

    // --- FolderNode に変換 ---
    let mut roots_cache = RootCache::default();
    let mut out: Vec<FolderNode> = nodes
        .values()
        .map(|a| FolderNode {
            // 親は必ず先に作られている(ルートまで遡りながら作るため)。
            // 入れ子の監視フォルダは is_root=false なので、親のツリーにぶら下がる
            parent: if a.is_root {
                None
            } else {
                parent_dir(&a.path).and_then(|p| nodes.get(&key_of(&p)).map(|pa| pa.path.clone()))
            },
            name: if a.is_root { a.path.clone() } else { last_segment(&a.path) },
            online: roots_cache.is_online(&a.path),
            path: a.path.clone(),
            direct_count: a.direct,
            total_count: a.total,
            watched_folder_id: a.watched_folder_id,
        })
        .collect();

    // 出力順を決めておく(フロントは親子で並べ直すが、同階層はこの順に出る)
    out.sort_by(|a, b| key_of(&a.path).cmp(&key_of(&b.path)));
    Ok(out)
}

/// 指定フォルダ直下のサブフォルダ一覧(メインビューのフォルダカード用)。
///
/// ツリー全体を組み直さず、そのフォルダ配下の動画だけを読む。
/// `folder_tree()` と違って**そのフォルダの中しか見ない**ので、一覧を開くたびに呼んでも軽い
pub fn subfolders(conn: &Connection, dir: &str) -> Result<SubfolderView> {
    // 返すパスはそのまま次の絞り込み条件になるので、DB の表記に揃えておく
    let base = canonical_dir(conn, dir).unwrap_or_else(|| normalize_dir(dir));
    let base_key = key_of(&base);
    let prefix =
        if base_key.ends_with('\\') { base_key.clone() } else { format!("{base_key}\\") };
    let n = prefix.chars().count();

    // このフォルダの**サブフォルダ**にある動画だけを読む(直下のファイルは対象外)。
    // 条件の組み方は query.rs の dir_path と同じ(LIKE を使わない理由もそちらのコメント参照)
    let sql = format!(
        "SELECT path FROM videos
         WHERE lower(replace(substr(path, 1, {n}), '/', '\\')) = ?1
           AND instr(replace(substr(path, {n} + 1), '/', '\\'), '\\') > 0"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([&prefix], |r| r.get::<_, String>(0))?;

    let watched = watched_roots(conn)?;
    let mut acc: HashMap<String, Acc> = HashMap::new();

    for path in rows.filter_map(|r| r.ok()) {
        let Some(vdir) = parent_dir(&path) else { continue };
        // 動画のあるフォルダから base に向かって遡り、base の直下にあたる子を見つける
        let mut cur = vdir;
        let mut is_direct = true;
        loop {
            let Some(p) = parent_dir(&cur) else { break };
            if key_of(&p) == base_key {
                let watched_folder_id = watched
                    .iter()
                    .find(|(_, rp)| key_of(rp) == key_of(&cur))
                    .map(|(id, _)| *id);
                let e = acc.entry(key_of(&cur)).or_insert_with(|| Acc {
                    path: cur.clone(),
                    direct: 0,
                    total: 0,
                    watched_folder_id,
                    is_root: false,
                });
                e.total += 1;
                if is_direct {
                    e.direct += 1;
                }
                break;
            }
            cur = p;
            is_direct = false;
        }
    }
    drop(stmt);

    let mut roots_cache = RootCache::default();
    let mut children: Vec<FolderNode> = acc
        .values()
        .map(|a| FolderNode {
            path: a.path.clone(),
            parent: Some(base.clone()),
            name: last_segment(&a.path),
            direct_count: a.direct,
            total_count: a.total,
            watched_folder_id: a.watched_folder_id,
            online: roots_cache.is_online(&a.path),
        })
        .collect();
    children.sort_by(|a, b| key_of(&a.name).cmp(&key_of(&b.name)));

    // 「上のフォルダ」は監視フォルダの中に留まるときだけ返す(ライブラリの外へは登らせない)
    let parent = parent_dir(&base).filter(|p| {
        let pk = key_of(p);
        watched.iter().any(|(_, rp)| is_within(&key_of(rp), &pk))
    });

    Ok(SubfolderView { parent, children })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(watched: &[(i64, &str)], videos: &[&str]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        for (id, path) in watched {
            conn.execute(
                "INSERT INTO watched_folders (id, path) VALUES (?1, ?2)",
                rusqlite::params![id, path],
            )
            .unwrap();
        }
        for (i, path) in videos.iter().enumerate() {
            conn.execute(
                "INSERT INTO videos (id, path, filename, size, added_at)
                 VALUES (?1, ?2, 'x.mp4', 1, '2026-01-01 00:00:00')",
                rusqlite::params![i as i64 + 1, path],
            )
            .unwrap();
        }
        conn
    }

    fn find<'a>(tree: &'a [FolderNode], path: &str) -> &'a FolderNode {
        tree.iter()
            .find(|n| key_of(&n.path) == key_of(path))
            .unwrap_or_else(|| panic!("{path} がツリーに無い: {:?}", tree.iter().map(|n| &n.path).collect::<Vec<_>>()))
    }

    #[test]
    fn builds_intermediate_nodes_and_totals() {
        let conn = setup(
            &[(1, r"C:\動画")],
            &[
                r"C:\動画\a.mp4",
                r"C:\動画\アニメ\b.mp4",
                r"C:\動画\アニメ\2024\c.mp4",
                r"C:\動画\アニメ\2024\d.mp4",
            ],
        );
        let tree = folder_tree(&conn).unwrap();

        let root = find(&tree, r"C:\動画");
        assert_eq!(root.direct_count, 1);
        assert_eq!(root.total_count, 4, "配下すべてを積み上げるはず");
        assert_eq!(root.parent, None);
        assert_eq!(root.watched_folder_id, Some(1));

        let anime = find(&tree, r"C:\動画\アニメ");
        assert_eq!(anime.direct_count, 1);
        assert_eq!(anime.total_count, 3);
        assert_eq!(anime.parent.as_deref(), Some(r"C:\動画"));
        assert_eq!(anime.name, "アニメ", "ルート以外は末尾セグメントだけを出す");

        let y2024 = find(&tree, r"C:\動画\アニメ\2024");
        assert_eq!(y2024.direct_count, 2);
        assert_eq!(y2024.total_count, 2);
        assert_eq!(y2024.parent.as_deref(), Some(r"C:\動画\アニメ"));
    }

    /// 親フォルダを後から監視フォルダに追加したケース。
    /// トップレベルに同じ階層が 2 つ並ばず、子は親のツリーの中に入ること
    #[test]
    fn nested_watched_folder_hangs_under_its_parent() {
        let conn = setup(
            &[(1, r"C:\動画"), (2, r"C:\動画\アニメ")],
            &[r"C:\動画\a.mp4", r"C:\動画\アニメ\2024\b.mp4"],
        );
        let tree = folder_tree(&conn).unwrap();

        let roots: Vec<&str> =
            tree.iter().filter(|n| n.parent.is_none()).map(|n| n.path.as_str()).collect();
        assert_eq!(roots, vec![r"C:\動画"], "入れ子の監視フォルダをルートにしてはいけない");

        let root = find(&tree, r"C:\動画");
        assert_eq!(root.direct_count, 1);
        assert_eq!(root.total_count, 2, "入れ子の監視フォルダの中身も配下として数える");

        let anime = find(&tree, r"C:\動画\アニメ");
        assert_eq!(anime.parent.as_deref(), Some(r"C:\動画"));
        assert_eq!(anime.watched_folder_id, Some(2), "監視フォルダの印は残す");
        assert_eq!(anime.direct_count, 0);
        assert_eq!(anime.total_count, 1);

        assert_eq!(find(&tree, r"C:\動画\アニメ\2024").direct_count, 1);
    }

    #[test]
    fn case_and_separator_variants_merge_into_one_node() {
        let conn = setup(
            &[(1, r"C:\動画")],
            &[r"C:\動画\a.mp4", r"c:\動画\b.mp4", "C:/動画/c.mp4"],
        );
        let tree = folder_tree(&conn).unwrap();
        assert_eq!(tree.len(), 1, "表記違いでノードを割ってはいけない: {tree:?}");
        assert_eq!(find(&tree, r"C:\動画").direct_count, 3);
    }

    #[test]
    fn paths_outside_watched_folders_become_their_own_roots() {
        let conn = setup(&[(1, r"C:\動画")], &[r"C:\動画\a.mp4", r"D:\dl\b.mp4"]);
        let tree = folder_tree(&conn).unwrap();

        let other = find(&tree, r"D:\dl");
        assert_eq!(other.parent, None);
        assert_eq!(other.watched_folder_id, None);
        assert_eq!(other.direct_count, 1);
        assert_eq!(other.name, r"D:\dl", "ルートはフルパスを表示する");
    }

    #[test]
    fn watched_folder_without_videos_still_appears() {
        let conn = setup(&[(1, r"C:\空っぽ")], &[]);
        let tree = folder_tree(&conn).unwrap();
        let root = find(&tree, r"C:\空っぽ");
        assert_eq!(root.direct_count, 0);
        assert_eq!(root.total_count, 0);
    }

    #[test]
    fn drive_root_keeps_its_separator() {
        assert_eq!(normalize_dir(r"C:\"), r"C:\");
        assert_eq!(normalize_dir("C:/"), r"C:\");
        assert_eq!(normalize_dir(r"C:\動画\"), r"C:\動画");
        assert_eq!(parent_dir(r"C:\a.mp4").as_deref(), Some(r"C:\"));
        assert_eq!(parent_dir(r"C:\v\a.mp4").as_deref(), Some(r"C:\v"));

        let conn = setup(&[], &[r"C:\a.mp4"]);
        let tree = folder_tree(&conn).unwrap();
        assert_eq!(find(&tree, r"C:\").direct_count, 1);
    }

    #[test]
    fn subfolders_lists_direct_children_with_counts() {
        let conn = setup(
            &[(1, r"C:\動画")],
            &[
                r"C:\動画\a.mp4",
                r"C:\動画\アニメ\b.mp4",
                r"C:\動画\アニメ\2024\c.mp4",
                r"C:\動画\映画\d.mp4",
            ],
        );
        let view = subfolders(&conn, r"C:\動画").unwrap();

        let names: Vec<&str> = view.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["アニメ", "映画"], "直下のサブフォルダだけを名前順で返す");

        let anime = &view.children[0];
        assert_eq!(anime.direct_count, 1, "アニメ 直下は b.mp4 の 1 件");
        assert_eq!(anime.total_count, 2, "2024\\c.mp4 も配下として数える");
        assert_eq!(anime.parent.as_deref(), Some(r"C:\動画"));

        // 監視フォルダのルートなので「上のフォルダ」は出さない
        assert_eq!(view.parent, None);
    }

    #[test]
    fn subfolders_reports_parent_inside_the_library() {
        let conn = setup(&[(1, r"C:\動画")], &[r"C:\動画\アニメ\2024\c.mp4"]);

        let deep = subfolders(&conn, r"C:\動画\アニメ\2024").unwrap();
        assert!(deep.children.is_empty());
        assert_eq!(deep.parent.as_deref(), Some(r"C:\動画\アニメ"));

        // 表記が違っても同じ結果になること
        let same = subfolders(&conn, "c:/動画/アニメ/").unwrap();
        assert_eq!(same.children.len(), 1);
        assert_eq!(same.parent.as_deref(), Some(r"C:\動画"));
    }

    #[test]
    fn subfolders_does_not_treat_wildcards_as_patterns() {
        let conn = setup(
            &[(1, r"C:\v")],
            &[r"C:\v\100%_test\sub\a.mp4", r"C:\v\100XX-test\sub\b.mp4"],
        );
        let view = subfolders(&conn, r"C:\v\100%_test").unwrap();
        assert_eq!(view.children.len(), 1);
        assert_eq!(view.children[0].name, "sub");
        assert_eq!(view.children[0].total_count, 1, "100XX-test 側を巻き込んではいけない");
    }

    #[test]
    fn unc_paths_are_supported() {
        let conn = setup(
            &[(1, r"\\nas\share\動画")],
            &[r"\\nas\share\動画\a.mp4", r"\\nas\share\動画\2024\b.mp4"],
        );
        let tree = folder_tree(&conn).unwrap();
        let root = find(&tree, r"\\nas\share\動画");
        assert_eq!(root.total_count, 2);
        assert_eq!(find(&tree, r"\\nas\share\動画\2024").parent.as_deref(), Some(r"\\nas\share\動画"));
    }
}
