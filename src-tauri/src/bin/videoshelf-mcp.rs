//! VideoShelf 読み取り専用 MCP サーバー(stdio トランスポート)
//!
//! Claude Code などの MCP クライアントから起動して使う:
//!   claude mcp add videoshelf -- <path>\videoshelf-mcp.exe
//!
//! DB は読み取り専用で開くため、ライブラリを壊す操作は構造的にできない。
//! アプリ(VideoShelf)が起動していなくても動作する。

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use tauri_app_lib::core::query::{self, VideoQuery};
use tauri_app_lib::core::{series, tags};

fn default_db_path() -> PathBuf {
    let appdata = std::env::var("APPDATA").expect("APPDATA is not set");
    PathBuf::from(appdata).join("com.taiki.videoshelf").join("library.db")
}

fn main() {
    let db_path = std::env::var("VIDEOSHELF_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_db_path());
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap_or_else(|e| {
        eprintln!("DB を開けません ({}): {e}", db_path.display());
        std::process::exit(1);
    });

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let method = req["method"].as_str().unwrap_or("");
        let id = req["id"].clone();

        // 通知(id なし)には応答しない
        if id.is_null() {
            continue;
        }

        let response = match method {
            "initialize" => {
                let proto = req["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or("2024-11-05");
                ok(&id, json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "videoshelf",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }))
            }
            "ping" => ok(&id, json!({})),
            "tools/list" => ok(&id, json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let args = &req["params"]["arguments"];
                match call_tool(&conn, name, args) {
                    Ok(text) => ok(&id, json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": false,
                    })),
                    Err(e) => ok(&id, json!({
                        "content": [{ "type": "text", "text": format!("エラー: {e}") }],
                        "isError": true,
                    })),
                }
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            }),
        };

        let mut out = stdout.lock();
        let _ = writeln!(out, "{response}");
        let _ = out.flush();
    }
}

fn ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "search_videos",
            "description": "動画ライブラリを検索する。テキスト(ファイル名・タイトルの部分一致)、タグ名、シリーズ名、missing 状態で絞り込める。結果は JSON 配列で返る。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "ファイル名・タイトルの部分一致検索" },
                    "tag": { "type": "string", "description": "タグ名(完全一致)。このタグが付いた動画に絞る" },
                    "series": { "type": "string", "description": "シリーズ名(完全一致)。指定時は登録順で返る" },
                    "missing": { "type": "boolean", "description": "true でファイルが見つからない動画のみ" },
                    "sort": { "type": "string", "enum": ["added_desc", "added_asc", "name_asc", "name_desc", "size_desc", "duration_desc", "rating_desc", "viewed_desc"], "description": "並び順(既定: added_desc)" },
                    "limit": { "type": "integer", "description": "最大件数(既定 50、最大 1000)" }
                }
            }
        },
        {
            "name": "get_video",
            "description": "動画 1 件の詳細(メタデータ・タグ・シリーズ)を取得する",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "integer", "description": "動画 ID" } },
                "required": ["id"]
            }
        },
        {
            "name": "list_tags",
            "description": "全タグと各タグの動画数を一覧する",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_series",
            "description": "全シリーズと各シリーズの動画数を一覧する",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "library_stats",
            "description": "ライブラリ全体の統計(動画数・合計サイズ・タグ数・シリーズ数・missing 数)を取得する",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn call_tool(conn: &rusqlite::Connection, name: &str, args: &Value) -> anyhow::Result<String> {
    match name {
        "search_videos" => {
            let mut q = VideoQuery {
                text: args["text"].as_str().map(String::from),
                sort: args["sort"].as_str().map(String::from),
                missing: args["missing"].as_bool(),
                ..Default::default()
            };
            if let Some(tag) = args["tag"].as_str() {
                let tag_id: i64 = conn
                    .query_row(
                        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                        [tag],
                        |r| r.get(0),
                    )
                    .map_err(|_| anyhow::anyhow!("タグ「{tag}」が見つかりません"))?;
                q.tag_ids = Some(vec![tag_id]);
            }
            if let Some(series_name) = args["series"].as_str() {
                let sid: i64 = conn
                    .query_row(
                        "SELECT id FROM series WHERE name = ?1 COLLATE NOCASE",
                        [series_name],
                        |r| r.get(0),
                    )
                    .map_err(|_| anyhow::anyhow!("シリーズ「{series_name}」が見つかりません"))?;
                q.series_id = Some(sid);
                if q.sort.is_none() {
                    q.sort = Some("series_asc".into());
                }
            }
            let limit = args["limit"].as_i64().unwrap_or(50);
            let total = query::count(conn, &q)?;
            let rows = query::query_rows(conn, None, &q, limit, 0)?;
            Ok(serde_json::to_string_pretty(&json!({
                "total": total,
                "returned": rows.len(),
                "videos": rows,
            }))?)
        }
        "get_video" => {
            let id = args["id"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("id が必要です"))?;
            let video = conn
                .query_row(
                    "SELECT id, path, filename, title, comment, size, duration_ms, width, height,
                            video_codec, audio_codec, container, fps, bitrate, rating, view_count,
                            last_viewed_at, added_at, is_missing
                     FROM videos WHERE id = ?1",
                    [id],
                    |r| {
                        Ok(json!({
                            "id": r.get::<_, i64>(0)?,
                            "path": r.get::<_, String>(1)?,
                            "filename": r.get::<_, String>(2)?,
                            "title": r.get::<_, Option<String>>(3)?,
                            "comment": r.get::<_, Option<String>>(4)?,
                            "size": r.get::<_, i64>(5)?,
                            "durationMs": r.get::<_, Option<i64>>(6)?,
                            "width": r.get::<_, Option<i64>>(7)?,
                            "height": r.get::<_, Option<i64>>(8)?,
                            "videoCodec": r.get::<_, Option<String>>(9)?,
                            "audioCodec": r.get::<_, Option<String>>(10)?,
                            "container": r.get::<_, Option<String>>(11)?,
                            "fps": r.get::<_, Option<f64>>(12)?,
                            "bitrate": r.get::<_, Option<i64>>(13)?,
                            "rating": r.get::<_, i64>(14)?,
                            "viewCount": r.get::<_, i64>(15)?,
                            "lastViewedAt": r.get::<_, Option<String>>(16)?,
                            "addedAt": r.get::<_, String>(17)?,
                            "isMissing": r.get::<_, i64>(18)? != 0,
                        }))
                    },
                )
                .map_err(|_| anyhow::anyhow!("id={id} の動画が見つかりません"))?;
            let video_tags = tags::tags_for_videos(conn, &[id])?;
            let video_series = series::series_for_videos(conn, &[id])?;
            let mut obj = video;
            obj["tags"] = json!(video_tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>());
            obj["series"] = json!(video_series.iter().map(|s| s.name.clone()).collect::<Vec<_>>());
            Ok(serde_json::to_string_pretty(&obj)?)
        }
        "list_tags" => Ok(serde_json::to_string_pretty(&tags::list_tags(conn)?)?),
        "list_series" => Ok(serde_json::to_string_pretty(&series::list_series(conn)?)?),
        "library_stats" => {
            let (count, size): (i64, i64) = conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM videos",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let missing: i64 =
                conn.query_row("SELECT COUNT(*) FROM videos WHERE is_missing=1", [], |r| r.get(0))?;
            let tag_count: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))?;
            let series_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM series", [], |r| r.get(0))?;
            Ok(serde_json::to_string_pretty(&json!({
                "videoCount": count,
                "totalSizeBytes": size,
                "tagCount": tag_count,
                "seriesCount": series_count,
                "missingCount": missing,
            }))?)
        }
        other => Err(anyhow::anyhow!("unknown tool: {other}")),
    }
}
