use crate::core::ffmpeg::{command, FfmpegPaths};
use anyhow::{anyhow, Result};
use rusqlite::Connection;
use std::path::Path;

/// 自動選択のとき、この地点から何秒ぶんの中で代表フレームを探すか。
/// 長すぎると ffmpeg が余計にデコードして遅くなる
const SCAN_WINDOW_SEC: f64 = 10.0;

/// サムネイルを 1 枚生成する(JPEG, 幅 480px)。
///
/// 優先順位は **手動指定 > 埋め込みカバー > 自動抽出**:
///
/// - `at_ms = Some(t)`: その位置ちょうどのフレームを使う(ユーザーが再生中に指定した場合)。
///   明示操作なのでカバーより優先する
/// - `cover_stream_index = Some(i)`: 動画に埋め込まれたカバー画像(`attached_pic`)を使う(v1.22)。
///   本編をデコードしないぶん 3 倍前後速く、配信サービス由来の mp4 では絵も的確になる
/// - どちらも無ければ 10% 地点から 10 秒ぶんを ffmpeg の `thumbnail` フィルタに評価させ、
///   代表的なコマを選ばせる。10% 固定だと暗転・フェードを引きやすかったため(v1.8)
pub fn generate(
    ff: &FfmpegPaths,
    video_path: &str,
    duration_ms: Option<i64>,
    at_ms: Option<i64>,
    cover_stream_index: Option<i64>,
    out: &Path,
) -> Result<()> {
    // 埋め込みカバーを試す。壊れた PNG が入っていることもあるので、
    // 失敗したら黙って本編からの抽出に落ちる(ユーザーには縮退が見えない)
    if at_ms.is_none() {
        if let Some(index) = cover_stream_index {
            if run_cover(ff, video_path, index, out)? {
                return Ok(());
            }
        }
    }

    let (ss, pick_best) = match at_ms {
        // 手動指定はその位置を尊重する(代表フレーム選択で数秒ずれると指定の意味がない)
        Some(t) => ((t.max(0) as f64) / 1000.0, false),
        None => (
            duration_ms.map(|d| (d as f64 / 1000.0) * 0.10).unwrap_or(0.0).max(0.0),
            true,
        ),
    };

    if run_ffmpeg(ff, video_path, Some(ss), pick_best, out)? {
        return Ok(());
    }
    // 指定位置で失敗したら先頭から 1 フレームで再試行
    // (極端に短い・壊れかけのファイル、指定位置が尺を超えている場合の保険)
    if run_ffmpeg(ff, video_path, None, false, out)? {
        Ok(())
    } else {
        Err(anyhow!("thumbnail generation failed: {video_path}"))
    }
}

/// 埋め込みカバーのストリームだけをデコードして 480px に縮める。
/// `-map` でストリームを名指しするので本編は一切読まない
fn run_cover(ff: &FfmpegPaths, video_path: &str, index: i64, out: &Path) -> Result<bool> {
    let output = command(&ff.ffmpeg)
        // -nostdin は command() の stdin(null) と二重の保険(ffmpeg に触らせない明示)
        .args(["-v", "error", "-nostdin", "-i", video_path])
        .args(["-map", &format!("0:{index}")])
        // カバーが 480px より小さいことも 4K のこともある。どちらも 480px 幅に揃える
        .args(["-vf", "scale=480:-2"])
        .args(["-frames:v", "1", "-q:v", "4", "-y"])
        .arg(out)
        .output()?;
    Ok(output.status.success() && out.exists())
}

fn run_ffmpeg(
    ff: &FfmpegPaths,
    video_path: &str,
    ss: Option<f64>,
    pick_best: bool,
    out: &Path,
) -> Result<bool> {
    let mut cmd = command(&ff.ffmpeg);
    cmd.args(["-v", "error", "-nostdin"]);
    if let Some(ss) = ss {
        if ss > 0.0 {
            cmd.args(["-ss", &format!("{ss:.3}")]);
        }
    }
    cmd.args(["-i", video_path]);
    if pick_best {
        // thumbnail フィルタは直前 N フレームの中から最も「代表的」なものを 1 枚返す。
        // -t で読む範囲を区切らないと長い動画で延々デコードし続ける
        cmd.args(["-t", &format!("{SCAN_WINDOW_SEC:.0}")])
            .args(["-vf", "thumbnail=100,scale=480:-2"]);
    } else {
        cmd.args(["-vf", "scale=480:-2"]);
    }
    cmd.args(["-frames:v", "1", "-q:v", "4", "-y"]).arg(out);
    let output = cmd.output()?;
    Ok(output.status.success() && out.exists())
}

/// サムネイルのコマ位置を保存し、次の生成で使われるようにする(thumb_state を未生成に戻す)。
/// ms に None を渡すと自動選択へ戻る
pub fn set_thumb_time(conn: &Connection, video_id: i64, at_ms: Option<i64>) -> Result<()> {
    conn.execute(
        "UPDATE videos SET thumb_time_ms = ?1, thumb_state = 0 WHERE id = ?2",
        rusqlite::params![at_ms.map(|m| m.max(0)), video_id],
    )?;
    Ok(())
}

/// videos に対応する行が無い孤児サムネイルを削除する。戻り値は (削除数, 解放バイト数)
pub fn purge_orphans(conn: &Connection, thumbs_dir: &Path) -> Result<(usize, u64)> {
    let mut stmt = conn.prepare("SELECT id FROM videos")?;
    let live: std::collections::HashSet<i64> =
        stmt.query_map([], |r| r.get(0))?.filter_map(|r| r.ok()).collect();

    let Ok(entries) = std::fs::read_dir(thumbs_dir) else {
        return Ok((0, 0));
    };
    let mut removed = 0usize;
    let mut freed = 0u64;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jpg") {
            continue;
        }
        // ファイル名は必ず "{video_id}.jpg"。読めない名前は触らない(想定外のファイルを消さない)
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        if live.contains(&id) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += size;
        }
    }
    Ok((removed, freed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purge_orphans_removes_only_unknown_ids() {
        let dir = std::env::temp_dir().join("dvm-test-thumbs");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r"INSERT INTO videos (id, path, filename) VALUES (7, 'C:\a.mp4', 'a.mp4');",
        )
        .unwrap();

        std::fs::write(dir.join("7.jpg"), b"live").unwrap();
        std::fs::write(dir.join("99.jpg"), b"orphan").unwrap();
        // 想定外の名前・拡張子には触らない
        std::fs::write(dir.join("notes.txt"), b"keep").unwrap();
        std::fs::write(dir.join("abc.jpg"), b"keep").unwrap();

        let (removed, freed) = purge_orphans(&conn, &dir).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(freed, 6);
        assert!(dir.join("7.jpg").exists());
        assert!(!dir.join("99.jpg").exists());
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("abc.jpg").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_thumb_time_resets_generation_state() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r"INSERT INTO videos (id, path, filename, thumb_state) VALUES (1, 'C:\a.mp4', 'a.mp4', 1);",
        )
        .unwrap();

        set_thumb_time(&conn, 1, Some(12_345)).unwrap();
        let (t, state): (Option<i64>, i64) = conn
            .query_row("SELECT thumb_time_ms, thumb_state FROM videos WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(t, Some(12_345));
        assert_eq!(state, 0, "再生成させるため未生成に戻すこと");

        // 負の値は 0 に丸める / None で自動選択へ戻せる
        set_thumb_time(&conn, 1, Some(-5)).unwrap();
        let t: Option<i64> = conn
            .query_row("SELECT thumb_time_ms FROM videos WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(t, Some(0));

        set_thumb_time(&conn, 1, None).unwrap();
        let t: Option<i64> = conn
            .query_row("SELECT thumb_time_ms FROM videos WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(t, None);
    }
}
