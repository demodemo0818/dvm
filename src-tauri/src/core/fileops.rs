//! ファイル操作(再リンク・リネーム・移動)の dry-run 基盤。
//!
//! **実行前に必ず plan_* を返してユーザーに見せる**。UI はプレビューを承認して初めて
//! apply_* を呼ぶ。既存の `videos::plan_trash` / `trash_files` と同じ二段構えにしている。
//!
//! 再リンクは DB の path を書き換えるだけでファイルには触らない(最も安全)。
//! リネーム / 移動は実ファイルを動かすので、1 件ずつ DB を更新して途中失敗でも
//! 実体と DB がずれないようにする。

use crate::core::offline::{self, RootCache};
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanStatus {
    /// 実行できる
    Ok,
    /// 変更後のパスに別のファイルが既にある(上書きしない)
    Conflict,
    /// 変更前のファイルが見つからない
    SourceMissing,
    /// ドライブが未接続(消えたのか未接続なのか区別できないので触らない)
    Offline,
    /// 変更前後が同じ。何もしない
    Unchanged,
}

/// dry-run の 1 行。UI はこれをそのまま表で見せる
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub video_id: i64,
    pub from: String,
    pub to: String,
    pub status: PlanStatus,
    pub note: Option<String>,
}

impl PlanItem {
    pub fn is_actionable(&self) -> bool {
        self.status == PlanStatus::Ok
    }
}

/// apply_* の実行結果 1 件
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub video_id: i64,
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// 監視フォルダのうち、指定パスを含むもの(最も深いもの)の id を返す。
/// 移動先が監視フォルダ配下なら watched_folder_id を張り替えるために使う
fn owning_folder(conn: &Connection, path: &str) -> Option<i64> {
    let mut stmt = conn.prepare("SELECT id, path FROM watched_folders").ok()?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    let lower = path.to_lowercase().replace('/', "\\");
    rows.into_iter()
        .filter(|(_, fp)| {
            let f = fp.to_lowercase().replace('/', "\\");
            let f = f.trim_end_matches('\\').to_string();
            lower.starts_with(&format!("{f}\\"))
        })
        // 入れ子の監視フォルダがあり得るので、より深い(長い)方を採る
        .max_by_key(|(_, fp)| fp.len())
        .map(|(id, _)| id)
}

// ---------------------------------------------------------------------------
// 再リンク(DB のパスだけ書き換える。ファイルは動かさない)
// ---------------------------------------------------------------------------

/// `from_prefix` で始まるパスを `to_prefix` に置き換える計画を返す。
/// フォルダごと移動した / ドライブレターが変わったのに自動再マップが効かなかったときの出口
pub fn plan_relink(conn: &Connection, from_prefix: &str, to_prefix: &str) -> Result<Vec<PlanItem>> {
    let from_prefix = from_prefix.trim_end_matches(['\\', '/']);
    let to_prefix = to_prefix.trim_end_matches(['\\', '/']);
    anyhow::ensure!(!from_prefix.is_empty(), "変更前のフォルダを指定してください");
    anyhow::ensure!(!to_prefix.is_empty(), "変更後のフォルダを指定してください");

    let mut stmt = conn.prepare("SELECT id, path FROM videos ORDER BY path")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    // Windows のパスは大文字小文字を区別しない。区切りの揺れ(/ と \)も吸収する
    let needle = from_prefix.to_lowercase().replace('/', "\\");
    let mut roots = RootCache::default();
    let mut items = Vec::new();

    for (id, path) in rows {
        let normalized = path.to_lowercase().replace('/', "\\");
        if !(normalized == needle || normalized.starts_with(&format!("{needle}\\"))) {
            continue;
        }
        let rest = &path[from_prefix.len()..];
        let to = format!("{to_prefix}{rest}");

        let (status, note) = if to == path {
            (PlanStatus::Unchanged, None)
        } else if !roots.is_online(&to) {
            (
                PlanStatus::Offline,
                Some(format!("{} が未接続です", offline::root_of(&to))),
            )
        } else if !Path::new(&to).exists() {
            (PlanStatus::SourceMissing, Some("変更後の場所にファイルがありません".into()))
        } else {
            (PlanStatus::Ok, None)
        };
        items.push(PlanItem { video_id: id, from: path, to, status, note });
    }
    Ok(items)
}

/// 再リンクを適用する。ファイルは動かさず DB の path / filename を書き換え、
/// 実在確認で is_missing を張り直す
pub fn apply_relink(conn: &Connection, actor: &str, items: &[PlanItem]) -> Result<Vec<OpResult>> {
    let targets: Vec<&PlanItem> = items.iter().filter(|i| i.is_actionable()).collect();
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    // path は UNIQUE。移動先が既に別レコードに使われていたら DB エラーになるので
    // 1 件ずつ結果を拾い、失敗しても残りを続ける
    let tx = conn.unchecked_transaction()?;
    let mut results = Vec::new();
    for item in &targets {
        let exists = Path::new(&item.to).exists();
        let r = tx.execute(
            "UPDATE videos SET path = ?1, filename = ?2, is_missing = ?3 WHERE id = ?4",
            params![
                item.to,
                file_name_of(&item.to),
                if exists { 0 } else { 1 },
                item.video_id
            ],
        );
        match r {
            Ok(_) => results.push(OpResult {
                video_id: item.video_id,
                from: item.from.clone(),
                to: item.to.clone(),
                ok: true,
                error: None,
            }),
            Err(e) => results.push(OpResult {
                video_id: item.video_id,
                from: item.from.clone(),
                to: item.to.clone(),
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }
    tx.commit()?;

    let applied: Vec<&OpResult> = results.iter().filter(|r| r.ok).collect();
    if !applied.is_empty() {
        // 取り消しに使えるよう、実際に変えた組を JSON で残す
        let payload = serde_json::json!({
            "items": applied.iter()
                .map(|r| serde_json::json!({ "id": r.video_id, "from": r.from, "to": r.to }))
                .collect::<Vec<_>>(),
        });
        db::log_op(conn, actor, "relink", &payload.to_string());
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// リネーム / 移動(実ファイルを動かす)
// ---------------------------------------------------------------------------

fn plan_one_move(roots: &mut RootCache, video_id: i64, from: &str, to: &str) -> PlanItem {
    let (status, note) = if to == from {
        (PlanStatus::Unchanged, None)
    } else if !roots.is_online(from) || !roots.is_online(to) {
        (PlanStatus::Offline, Some("ドライブが未接続です".into()))
    } else if !Path::new(from).exists() {
        (PlanStatus::SourceMissing, Some("元のファイルが見つかりません".into()))
    } else if Path::new(to).exists() {
        (PlanStatus::Conflict, Some("移動先に同名のファイルがあります".into()))
    } else if !Path::new(to).parent().map(|p| p.exists()).unwrap_or(false) {
        (PlanStatus::SourceMissing, Some("移動先のフォルダがありません".into()))
    } else {
        (PlanStatus::Ok, None)
    };
    PlanItem { video_id, from: from.to_string(), to: to.to_string(), status, note }
}

fn paths_of(conn: &Connection, video_ids: &[i64]) -> Result<Vec<(i64, String)>> {
    // 空リストだと `WHERE id IN ()` の SQL 構文エラーになる
    if video_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_csv = video_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let mut stmt =
        conn.prepare(&format!("SELECT id, path FROM videos WHERE id IN ({ids_csv})"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 指定した動画を dest_dir へ移動する計画
pub fn plan_move(conn: &Connection, video_ids: &[i64], dest_dir: &str) -> Result<Vec<PlanItem>> {
    let dest = dest_dir.trim_end_matches(['\\', '/']);
    anyhow::ensure!(!dest.is_empty(), "移動先フォルダを指定してください");
    let mut roots = RootCache::default();
    let items = paths_of(conn, video_ids)?
        .into_iter()
        .map(|(id, path)| {
            let to = format!("{dest}\\{}", file_name_of(&path));
            plan_one_move(&mut roots, id, &path, &to)
        })
        .collect();
    Ok(items)
}

/// 1 件のファイル名を変更する計画(フォルダは変えない)
pub fn plan_rename(conn: &Connection, video_id: i64, new_name: &str) -> Result<PlanItem> {
    let new_name = new_name.trim();
    anyhow::ensure!(!new_name.is_empty(), "新しいファイル名を入力してください");
    anyhow::ensure!(
        !new_name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']),
        r#"ファイル名に \ / : * ? " < > | は使えません"#
    );

    let path: String = conn.query_row(
        "SELECT path FROM videos WHERE id = ?1",
        params![video_id],
        |r| r.get(0),
    )?;
    let parent: PathBuf = Path::new(&path)
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| anyhow::anyhow!("親フォルダを特定できません: {path}"))?;
    let to = parent.join(new_name).to_string_lossy().to_string();

    let mut roots = RootCache::default();
    Ok(plan_one_move(&mut roots, video_id, &path, &to))
}

/// 計画を実行して実ファイルを動かす。
/// **1 件ずつコミットする** — 全体を 1 トランザクションにすると途中失敗で
/// 実ファイルと DB がずれる。失敗は個別に報告して残りは続ける
/// ファイルを動かすだけ(**DB には触らない**)。ドライブ間コピーは何分もかかるので、
/// DB ロックを持たずに呼べるようファイル操作だけを切り出してある。
/// 戻り値は (動かせた PlanItem, 失敗の OpResult)
pub fn move_files(
    items: &[PlanItem],
    mut on_progress: impl FnMut(usize, usize, &str),
) -> (Vec<PlanItem>, Vec<OpResult>) {
    let targets: Vec<&PlanItem> = items.iter().filter(|i| i.is_actionable()).collect();
    let total = targets.len();
    let mut moved = Vec::new();
    let mut failed = Vec::new();

    for (i, item) in targets.iter().enumerate() {
        on_progress(i, total, &item.from);

        // 実行の直前にもう一度確かめる(プレビューを見ている間に状況が変わりうる)
        if Path::new(&item.to).exists() {
            failed.push(OpResult {
                video_id: item.video_id,
                from: item.from.clone(),
                to: item.to.clone(),
                ok: false,
                error: Some("移動先に同名のファイルがあります".into()),
            });
            continue;
        }

        if let Err(e) = move_file(&item.from, &item.to) {
            failed.push(OpResult {
                video_id: item.video_id,
                from: item.from.clone(),
                to: item.to.clone(),
                ok: false,
                error: Some(e.to_string()),
            });
            continue;
        }
        moved.push((*item).clone());
    }
    on_progress(total, total, "");
    (moved, failed)
}

/// 動かせたファイルの DB 追従(1 トランザクション)。移動先が監視フォルダ配下なら所属も張り替える
pub fn record_moves(
    conn: &Connection,
    actor: &str,
    moved: &[PlanItem],
    action: &str,
) -> Result<Vec<OpResult>> {
    let tx = conn.unchecked_transaction()?;
    let mut results = Vec::new();
    for item in moved {
        let folder_id = owning_folder(&tx, &item.to);
        let updated = tx.execute(
            "UPDATE videos SET path = ?1, filename = ?2, watched_folder_id = ?3, is_missing = 0
             WHERE id = ?4",
            params![item.to, file_name_of(&item.to), folder_id, item.video_id],
        );
        let error = updated.err().map(|e| e.to_string());
        if error.is_none() {
            db::log_op(
                &tx,
                actor,
                action,
                &serde_json::json!({ "id": item.video_id, "from": item.from, "to": item.to })
                    .to_string(),
            );
        }
        results.push(OpResult {
            video_id: item.video_id,
            from: item.from.clone(),
            to: item.to.clone(),
            // ファイルは動いているので ok。DB 更新の失敗だけ error に載せる
            ok: true,
            error,
        });
    }
    tx.commit()?;
    Ok(results)
}

/// 失敗と成功を元の items の並びに戻す(結果ダイアログの行順を計画と揃えるため)
pub fn merge_move_results(
    items: &[PlanItem],
    moved: Vec<OpResult>,
    failed: Vec<OpResult>,
) -> Vec<OpResult> {
    let mut by_id: std::collections::HashMap<i64, OpResult> = failed
        .into_iter()
        .chain(moved)
        .map(|r| (r.video_id, r))
        .collect();
    items
        .iter()
        .filter(|i| i.is_actionable())
        .filter_map(|i| by_id.remove(&i.video_id))
        .collect()
}

/// conn を渡している間ずっとロックを握る呼び方になるので、UI 経路は
/// move_files → record_moves の 2 分割で呼ぶこと(テストはこちらで良い)
pub fn apply_move(
    conn: &Connection,
    actor: &str,
    items: &[PlanItem],
    action: &str,
    on_progress: impl FnMut(usize, usize, &str),
) -> Result<Vec<OpResult>> {
    let (moved, failed) = move_files(items, on_progress);
    let recorded = record_moves(conn, actor, &moved, action)?;
    Ok(merge_move_results(items, recorded, failed))
}

/// 同一ボリュームなら rename、別ボリュームなら copy + remove。
/// rename は別ドライブ間では必ず失敗するので、そのときだけコピーに落とす
fn move_file(from: &str, to: &str) -> Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(e) = std::fs::copy(from, to) {
        // コピー途中の失敗(ディスクフル・ケーブル抜け)は書きかけの to が残り、
        // 再実行が Conflict 誤報告になる。掃除してから失敗を返す
        let _ = std::fs::remove_file(to);
        return Err(e.into());
    }
    if let Err(e) = std::fs::remove_file(from) {
        // コピーは成功したが元が消せない。中途半端に 2 つ残すより
        // コピーを取り消して「失敗」に倒す(ユーザーが原因を直して再実行できる)
        let _ = std::fs::remove_file(to);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(tmp: &Path) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        let a = tmp.join("src").join("動画 1.mp4");
        let b = tmp.join("src").join("動画 2.mp4");
        conn.execute(
            "INSERT INTO videos (id, path, filename) VALUES (1, ?1, '動画 1.mp4')",
            params![a.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO videos (id, path, filename) VALUES (2, ?1, '動画 2.mp4')",
            params![b.to_string_lossy()],
        )
        .unwrap();
        conn
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dvm-test-fileops-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("dst")).unwrap();
        std::fs::write(dir.join("src").join("動画 1.mp4"), b"one").unwrap();
        std::fs::write(dir.join("src").join("動画 2.mp4"), b"two").unwrap();
        dir
    }

    #[test]
    fn plan_move_flags_conflicts_and_missing() {
        let dir = tmpdir("plan");
        let conn = setup(&dir);
        // 移動先に同名ファイルを置いて衝突させる
        std::fs::write(dir.join("dst").join("動画 1.mp4"), b"existing").unwrap();
        // 2 番は実体を消して SourceMissing にする
        std::fs::remove_file(dir.join("src").join("動画 2.mp4")).unwrap();

        let plan = plan_move(&conn, &[1, 2], &dir.join("dst").to_string_lossy()).unwrap();
        let by_id = |id: i64| plan.iter().find(|p| p.video_id == id).unwrap().status;
        assert_eq!(by_id(1), PlanStatus::Conflict);
        assert_eq!(by_id(2), PlanStatus::SourceMissing);
        // 実行対象は 0 件。dry-run の時点でファイルには一切触っていない
        assert!(plan.iter().all(|p| !p.is_actionable()));
        assert_eq!(std::fs::read(dir.join("dst").join("動画 1.mp4")).unwrap(), b"existing");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_move_moves_file_and_updates_db() {
        let dir = tmpdir("apply");
        let conn = setup(&dir);
        let plan = plan_move(&conn, &[1], &dir.join("dst").to_string_lossy()).unwrap();
        assert_eq!(plan[0].status, PlanStatus::Ok);

        let results = apply_move(&conn, "user", &plan, "move_file", |_, _, _| {}).unwrap();
        assert!(results[0].ok && results[0].error.is_none());
        assert!(!dir.join("src").join("動画 1.mp4").exists());
        assert!(dir.join("dst").join("動画 1.mp4").exists());

        let path: String = conn
            .query_row("SELECT path FROM videos WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, dir.join("dst").join("動画 1.mp4").to_string_lossy());

        // 監査ログに JSON で残っていること
        let (action, payload): (String, String) = conn
            .query_row("SELECT action, payload FROM operations_log ORDER BY id DESC LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(action, "move_file");
        assert!(serde_json::from_str::<serde_json::Value>(&payload).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_rename_validates_name_and_keeps_folder() {
        let dir = tmpdir("rename");
        let conn = setup(&dir);
        assert!(plan_rename(&conn, 1, "").is_err());
        assert!(plan_rename(&conn, 1, r"別\名前.mp4").is_err(), "区切り文字は拒否する");

        let plan = plan_rename(&conn, 1, "旅行 2024.mp4").unwrap();
        assert_eq!(plan.status, PlanStatus::Ok);
        assert_eq!(plan.to, dir.join("src").join("旅行 2024.mp4").to_string_lossy());

        // 既にある名前への変更は衝突として出す
        let conflict = plan_rename(&conn, 1, "動画 2.mp4").unwrap();
        assert_eq!(conflict.status, PlanStatus::Conflict);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relink_rewrites_paths_without_touching_files() {
        let dir = tmpdir("relink");
        let conn = setup(&dir);
        let from = dir.join("src").to_string_lossy().to_string();
        let to = dir.join("dst").to_string_lossy().to_string();
        // 移動先に実体を用意する(フォルダごと動かした状況を作る)
        std::fs::copy(dir.join("src").join("動画 1.mp4"), dir.join("dst").join("動画 1.mp4")).unwrap();

        let plan = plan_relink(&conn, &from, &to).unwrap();
        assert_eq!(plan.len(), 2);
        let p1 = plan.iter().find(|p| p.video_id == 1).unwrap();
        let p2 = plan.iter().find(|p| p.video_id == 2).unwrap();
        assert_eq!(p1.status, PlanStatus::Ok);
        // 移動先に実体が無いものは実行対象にしない
        assert_eq!(p2.status, PlanStatus::SourceMissing);

        apply_relink(&conn, "user", &plan).unwrap();
        let path: String = conn
            .query_row("SELECT path FROM videos WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, dir.join("dst").join("動画 1.mp4").to_string_lossy());
        // 2 番は触られていない
        let path2: String = conn
            .query_row("SELECT path FROM videos WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path2, dir.join("src").join("動画 2.mp4").to_string_lossy());
        // ファイルは動かしていない
        assert!(dir.join("src").join("動画 1.mp4").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relink_is_case_insensitive_and_ignores_other_paths() {
        let dir = tmpdir("relink-case");
        let conn = setup(&dir);
        // 対象外のパスを 1 件足す
        conn.execute(
            "INSERT INTO videos (id, path, filename) VALUES (3, 'Z:\\other\\x.mp4', 'x.mp4')",
            [],
        )
        .unwrap();

        let from = dir.join("SRC").to_string_lossy().to_string(); // 大文字
        let to = dir.join("dst").to_string_lossy().to_string();
        let plan = plan_relink(&conn, &from, &to).unwrap();
        assert_eq!(plan.len(), 2, "大文字小文字を区別せずに拾うこと");
        assert!(plan.iter().all(|p| p.video_id != 3), "無関係なパスを巻き込まないこと");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
