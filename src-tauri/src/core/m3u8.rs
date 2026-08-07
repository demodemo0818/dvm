//! M3U8 エクスポート / インポート(v1.41、C-3)。
//!
//! プレイリストはフルパスの並びなので、UTF-8 の M3U8 を書くだけで外部プレイヤー
//! (mpv・VLC)がそのまま読める。「動画をコピーしない」方針とも整合する。
//! 取り込みは既存の個別登録(`library::register_paths`)に載せるため、
//! ここは**テキストとパスの変換だけ**を受け持つ(登録・プレイリスト作成はコマンド側)。

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

/// エクスポートする 1 行ぶん(パス・表示名・尺)
struct Entry {
    path: String,
    title: String,
    duration_ms: Option<i64>,
}

/// プレイリストを UTF-8 の M3U8 として書き出す。返り値は書いた動画数。
/// BOM は付けない —— 想定プレイヤー(mpv・VLC)はどちらも UTF-8 をそのまま読む
pub fn export(conn: &Connection, playlist_id: i64, dest: &Path) -> Result<usize> {
    // 消えたプレイリスト id で空ファイルを書かない(replace と同じ流儀で先に名前を引く)
    conn.query_row("SELECT name FROM playlists WHERE id = ?1", params![playlist_id], |r| {
        r.get::<_, String>(0)
    })
    .map_err(|_| anyhow::anyhow!("プレイリストが見つかりません"))?;
    let mut stmt = conn.prepare(
        "SELECT v.path, COALESCE(v.title, v.filename), v.duration_ms
         FROM playlist_entries pe JOIN videos v ON v.id = pe.video_id
         WHERE pe.playlist_id = ?1 ORDER BY pe.position, pe.video_id",
    )?;
    let rows: Vec<Entry> = stmt
        .query_map(params![playlist_id], |r| {
            Ok(Entry { path: r.get(0)?, title: r.get(1)?, duration_ms: r.get(2)? })
        })?
        .filter_map(|r| r.ok())
        .collect();
    std::fs::write(dest, render(&rows))?;
    Ok(rows.len())
}

/// M3U8 のテキストを組み立てる(ファイルに触らない層。テストはここを見る)
fn render(rows: &[Entry]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for e in rows {
        // EXTINF の尺は秒。不明は規格どおり -1
        let secs = e.duration_ms.map_or(-1, |ms| (ms + 500) / 1000);
        out.push_str(&format!("#EXTINF:{secs},{}\n{}\n", e.title, e.path));
    }
    out
}

/**
M3U8 のテキストから動画ファイルのパスを取り出す(現れた順)。

- `#` で始まる行(`#EXTM3U` / `#EXTINF` / コメント)は読み飛ばす
- URL(`http://` など `://` を含む行)は対象外 —— このアプリはローカルファイルしか扱わない
- 区切りの `/` は `\` に揃える(`videos.path` は `\` で持っているため)
- 相対パスは `base_dir`(m3u8 ファイルのあるフォルダ)から解決する
*/
pub fn parse(content: &str, base_dir: Option<&Path>) -> Vec<String> {
    let mut out = Vec::new();
    for raw in content.lines() {
        // 先頭行に UTF-8 BOM が残っていると `#EXTM3U` を data 行と誤読する
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') || line.contains("://") {
            continue;
        }
        let line = line.replace('/', "\\");
        if Path::new(&line).is_absolute() {
            out.push(line);
        } else if let Some(base) = base_dir {
            out.push(base.join(line).to_string_lossy().to_string());
        }
        // base_dir が無いのに相対パス、は解決しようがないので捨てる
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r"INSERT INTO videos (id, path, filename, title, duration_ms) VALUES
                (1, 'C:\動画\第 1 話.mp4', '第 1 話.mp4', NULL, 754400),
                (2, 'C:\動画\第 2 話.mp4', '第 2 話.mp4', '2 話(修正版)', NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn export_writes_paths_in_saved_order_with_titles() {
        let conn = setup();
        let id = crate::core::playlists::create(&conn, "user", "週末", &[2, 1]).unwrap();
        let dest = std::env::temp_dir().join("dvm-test-export.m3u8");
        assert_eq!(export(&conn, id, &dest).unwrap(), 2);

        let text = std::fs::read_to_string(&dest).unwrap();
        // 表示名は title があればそれ、無ければファイル名。尺は秒(不明は -1)
        assert_eq!(
            text,
            "#EXTM3U\n#EXTINF:-1,2 話(修正版)\nC:\\動画\\第 2 話.mp4\n#EXTINF:754,第 1 話.mp4\nC:\\動画\\第 1 話.mp4\n"
        );
        let _ = std::fs::remove_file(&dest);

        assert!(export(&conn, 9999, &dest).is_err(), "消えた id で空ファイルを書かない");
        assert!(!dest.exists());
    }

    #[test]
    fn parse_skips_comments_and_urls_and_resolves_relative_paths() {
        let text = "\u{feff}#EXTM3U\n#EXTINF:120,タイトル\nC:\\動画\\a.mp4\n\nD:/映像/b.mkv\nhttps://example.com/c.mp4\nsub/c.mp4\n";
        let paths = parse(text, Some(Path::new("E:\\lists")));
        assert_eq!(
            paths,
            vec![
                "C:\\動画\\a.mp4".to_string(),
                "D:\\映像\\b.mkv".to_string(),
                "E:\\lists\\sub\\c.mp4".to_string(),
            ]
        );
        // base_dir が無ければ相対パスは捨てる(絶対パスだけ残る)
        assert_eq!(parse("a.mp4\nC:\\b.mp4", None), vec!["C:\\b.mp4".to_string()]);
    }
}
