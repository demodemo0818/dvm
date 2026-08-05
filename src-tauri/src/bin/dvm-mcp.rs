//! DVM MCP サーバー(stdio トランスポート)
//!
//! Claude Code などの MCP クライアントから起動して使う:
//!   claude mcp add dvm -- <path>\dvm-mcp.exe
//!
//! 既定では DB を読み取り専用で開くため、ライブラリを壊す操作は構造的にできない。
//! 環境変数 DVM_ALLOW_WRITE=1 を付けて起動したときだけ書き込みツール
//! (タグ・シリーズ・レーティング編集、ごみ箱送りなど)が有効になる。
//! アプリ(DVM)が起動していなくても動作する。

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use dvm_lib::core::query::{self, VideoQuery};
use dvm_lib::core::{dedupe, libraries, series, stats, tags, videos};

fn data_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").expect("APPDATA is not set");
    PathBuf::from(appdata).join("jp.demo2.dvm")
}

/// **アプリがいま開いているライブラリ**を見る(v1.27)。
///
/// スニペットに `DVM_DB` を書かせる方式は採らない —— 切り替えるたびに
/// クライアント側の設定を貼り直す必要が生じ、貼り忘れると
/// AI が古いライブラリを見たまま黙って書き込むことになる。
/// 代わりにここでレジストリ(app.db)を引いて追従する。
/// 明示指定したい人のために `DVM_DB` は最優先で残してある
fn default_db_path() -> PathBuf {
    let dir = data_dir();
    libraries::resolve_db_path(&dir).unwrap_or_else(|| dir.join("library.db"))
}

fn main() {
    let db_path = std::env::var("DVM_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_db_path());
    let allow_write = std::env::var("DVM_ALLOW_WRITE").as_deref() == Ok("1");
    // CREATE は付けない(DB が無ければ従来通りエラー終了)
    let flags = if allow_write {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = rusqlite::Connection::open_with_flags(&db_path, flags).unwrap_or_else(|e| {
        eprintln!("DB を開けません ({}): {e}", db_path.display());
        std::process::exit(1);
    });
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    if allow_write {
        // rusqlite の既定は foreign_keys=OFF。書き込み時は CASCADE を効かせる
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
    }

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
                        "name": "dvm",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }))
            }
            "ping" => ok(&id, json!({})),
            "tools/list" => ok(&id, json!({ "tools": tool_definitions(allow_write) })),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let args = &req["params"]["arguments"];
                match call_tool(&conn, allow_write, name, args) {
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

fn tool_definitions(allow_write: bool) -> Value {
    let mut tools = read_tool_definitions();
    if allow_write {
        if let (Some(arr), Some(Value::Array(write_arr))) =
            (tools.as_array_mut(), Some(write_tool_definitions()))
        {
            arr.extend(write_arr);
        }
    }
    tools
}

fn read_tool_definitions() -> Value {
    json!([
        {
            "name": "search_videos",
            "description": "動画ライブラリを検索する。テキスト(ファイル名・タイトルの部分一致。空白区切りで AND)、タグ名、シリーズ名、missing 状態、未視聴、タグなし、解像度、コーデック、追加日で絞り込める。結果は JSON 配列で返る。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "ファイル名・タイトルの部分一致検索。空白区切りで複数語すべてを含むものに絞る" },
                    "search_path": { "type": "boolean", "description": "true で text の検索対象にフルパスも含める" },
                    "dir_path": { "type": "string", "description": "このフォルダ直下にある動画だけに絞る(サブフォルダは含まない)。絶対パスで指定する" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "タグ名(完全一致)で絞る。同じグループのタグ同士は OR、グループをまたぐと AND になる(例: [\"ファンタジー\", \"SF\", \"アニメ\"] = (ファンタジー または SF) かつ アニメ)。グループは list_tags で確認できる" },
                    "series": { "type": "string", "description": "シリーズ名(完全一致)。指定時は登録順で返る" },
                    "missing": { "type": "boolean", "description": "true でファイルが見つからない動画のみ" },
                    "untagged": { "type": "boolean", "description": "true でタグが 1 つも付いていない動画のみ" },
                    "unwatched": { "type": "boolean", "description": "true で一度も再生していない動画のみ" },
                    "duplicates_only": { "type": "boolean", "description": "true で内容が同一(サイズ+部分ハッシュが一致)の動画だけを返す。sort=dup と併せると同じものが隣り合う" },
                    "min_rating": { "type": "integer", "minimum": 1, "maximum": 5, "description": "このレーティング以上の動画に絞る" },
                    "min_duration_sec": { "type": "integer", "description": "尺の下限(秒)" },
                    "max_duration_sec": { "type": "integer", "description": "尺の上限(秒)" },
                    "min_width": { "type": "integer", "description": "横解像度の下限(ピクセル)" },
                    "min_height": { "type": "integer", "description": "縦解像度の下限(ピクセル)。1080 で FHD 以上" },
                    "video_codecs": { "type": "array", "items": { "type": "string" }, "description": "映像コーデックで絞る(例: [\"h264\", \"hevc\"])" },
                    "added_after": { "type": "string", "description": "ライブラリ追加日の下限(YYYY-MM-DD。その日を含む)" },
                    "added_before": { "type": "string", "description": "ライブラリ追加日の上限(YYYY-MM-DD。その日を含む)" },
                    "sort": { "type": "string", "enum": ["added_desc", "added_asc", "name_asc", "name_desc", "size_desc", "duration_desc", "rating_desc", "viewed_desc", "dup"], "description": "並び順(既定: added_desc)" },
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
            "description": "全タグと各タグの動画数、所属グループを一覧する。グループは分類の軸(例:「ジャンル」「メディア種別」)で、検索では同じグループのタグ同士が OR になる",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_series",
            "description": "全シリーズと各シリーズの動画数を一覧する",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "library_stats",
            "description": "ライブラリ全体の統計(動画数・合計サイズ・合計再生時間・タグ数・シリーズ数・missing 数・未視聴数・タグなし数・重複数・レーティング分布・コーデック別/解像度別/フォルダ別/月別の内訳)を取得する",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn write_tool_definitions() -> Value {
    let video_ids = json!({ "type": "array", "items": { "type": "integer" }, "description": "対象の動画 ID 一覧" });
    json!([
        {
            "name": "tag_videos",
            "description": "動画にタグを付ける(タグが無ければ作成される)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "tag": { "type": "string", "description": "タグ名" }
                },
                "required": ["video_ids", "tag"]
            }
        },
        {
            "name": "untag_videos",
            "description": "動画からタグを外す",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "tag": { "type": "string", "description": "タグ名(完全一致)" }
                },
                "required": ["video_ids", "tag"]
            }
        },
        {
            "name": "add_to_series",
            "description": "動画をシリーズに追加する(シリーズが無ければ作成される。末尾に追加)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "series": { "type": "string", "description": "シリーズ名" }
                },
                "required": ["video_ids", "series"]
            }
        },
        {
            "name": "remove_from_series",
            "description": "動画をシリーズから外す",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "series": { "type": "string", "description": "シリーズ名(完全一致)" }
                },
                "required": ["video_ids", "series"]
            }
        },
        {
            "name": "set_rating",
            "description": "動画のレーティングを設定する(0 で解除)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "rating": { "type": "integer", "minimum": 0, "maximum": 5 }
                },
                "required": ["video_ids", "rating"]
            }
        },
        {
            "name": "set_video_info",
            "description": "動画のタイトル・コメントを設定する(指定したフィールドだけ更新)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "動画 ID" },
                    "title": { "type": "string" },
                    "comment": { "type": "string" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "remove_from_library",
            "description": "動画の登録をライブラリから削除する。ファイル自体は削除しない(タグ・レーティング等のメタデータは失われる)",
            "inputSchema": {
                "type": "object",
                "properties": { "video_ids": video_ids },
                "required": ["video_ids"]
            }
        },
        {
            "name": "dedupe",
            "description": "同じ内容(サイズ + 先頭ハッシュが一致)の動画を 1 本だけ残し、残りを整理する。既定はライブラリの登録を外すだけでファイルは残す。必ず dry_run: true で対象と件数を確認してから dry_run: false で実行すること。scope を指定すると、そのフォルダ配下だけが対象になる(配下と外にまたがるグループは触らない)。タグ・レーティング・視聴履歴が付いた動画は優先して残す。サイズ 0 のファイルは対象外",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "scope": { "type": "string", "description": "対象フォルダの絶対パス。省略するとライブラリ全体" },
                    "dry_run": { "type": "boolean", "description": "true: 件数と内訳のプレビューのみ / false: 実際に実行する" },
                    "trash_files": { "type": "boolean", "description": "true にすると重複したファイル本体を Windows のごみ箱へ送ってから登録を外す(完全削除ではない。ごみ箱から戻して再スキャンすれば復帰できる)。既定 false = 登録を外すだけでファイルは残す。ユーザーがファイルの削除まで明示的に求めたときだけ true にすること" }
                },
                "required": ["dry_run"]
            }
        },
        {
            "name": "trash_video_files",
            "description": "動画ファイル本体を Windows のごみ箱へ送る。必ず dry_run: true で実行内容(対象パス一覧)を確認し、ユーザーの意図と一致することを確かめてから dry_run: false で実行すること。実行後の登録は missing 状態で残る(ごみ箱から戻して再スキャンすれば復帰できる)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "video_ids": video_ids,
                    "dry_run": { "type": "boolean", "description": "true: 実行内容のプレビューのみ / false: 実際にごみ箱へ送る" }
                },
                "required": ["video_ids", "dry_run"]
            }
        }
    ])
}

/// JSON 配列引数から i64 の Vec を取り出す
fn ids_arg(args: &Value) -> anyhow::Result<Vec<i64>> {
    let ids: Vec<i64> = args["video_ids"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("video_ids が必要です"))?
        .iter()
        .filter_map(|v| v.as_i64())
        .collect();
    anyhow::ensure!(!ids.is_empty(), "video_ids が空です");
    Ok(ids)
}

fn call_tool(
    conn: &rusqlite::Connection,
    allow_write: bool,
    name: &str,
    args: &Value,
) -> anyhow::Result<String> {
    const WRITE_TOOLS: &[&str] = &[
        "tag_videos", "untag_videos", "add_to_series", "remove_from_series",
        "set_rating", "set_video_info", "remove_from_library", "trash_video_files",
        "dedupe",
    ];
    if WRITE_TOOLS.contains(&name) && !allow_write {
        anyhow::bail!("書き込みは無効です。環境変数 DVM_ALLOW_WRITE=1 を付けて起動してください");
    }
    match name {
        "search_videos" => {
            let mut q = VideoQuery {
                text: args["text"].as_str().map(String::from),
                sort: args["sort"].as_str().map(String::from),
                missing: args["missing"].as_bool(),
                min_rating: args["min_rating"].as_i64(),
                min_duration_ms: args["min_duration_sec"].as_i64().map(|s| s * 1000),
                max_duration_ms: args["max_duration_sec"].as_i64().map(|s| s * 1000),
                search_path: args["search_path"].as_bool(),
                dir_path: args["dir_path"].as_str().map(String::from),
                untagged: args["untagged"].as_bool(),
                unwatched: args["unwatched"].as_bool(),
                duplicates_only: args["duplicates_only"].as_bool(),
                min_width: args["min_width"].as_i64(),
                min_height: args["min_height"].as_i64(),
                video_codecs: args["video_codecs"].as_array().map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }),
                added_after: args["added_after"].as_str().map(String::from),
                added_before: args["added_before"].as_str().map(String::from),
                ..Default::default()
            };
            if let Some(names) = args["tags"].as_array() {
                let mut tag_ids = Vec::new();
                for tag in names.iter().filter_map(|v| v.as_str()) {
                    let tag_id: i64 = conn
                        .query_row(
                            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                            [tag],
                            |r| r.get(0),
                        )
                        .map_err(|_| anyhow::anyhow!("タグ「{tag}」が見つかりません"))?;
                    tag_ids.push(tag_id);
                }
                if !tag_ids.is_empty() {
                    q.tag_ids = Some(tag_ids);
                }
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
        // 集計はアプリの統計画面と同じ core::stats を使う(数字が食い違わないように)
        "library_stats" => Ok(serde_json::to_string_pretty(&stats::library_stats(conn)?)?),
        "tag_videos" => {
            let ids = ids_arg(args)?;
            let tag = args["tag"].as_str().ok_or_else(|| anyhow::anyhow!("tag が必要です"))?;
            tags::tag_videos(conn, "ai", &ids, tag)?;
            Ok(format!("{} 件にタグ「{tag}」を付けました", ids.len()))
        }
        "untag_videos" => {
            let ids = ids_arg(args)?;
            let tag = args["tag"].as_str().ok_or_else(|| anyhow::anyhow!("tag が必要です"))?;
            let tag_id: i64 = conn
                .query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", [tag], |r| r.get(0))
                .map_err(|_| anyhow::anyhow!("タグ「{tag}」が見つかりません"))?;
            tags::untag_videos(conn, "ai", &ids, tag_id)?;
            Ok(format!("{} 件からタグ「{tag}」を外しました", ids.len()))
        }
        "add_to_series" => {
            let ids = ids_arg(args)?;
            let name = args["series"].as_str().ok_or_else(|| anyhow::anyhow!("series が必要です"))?;
            series::add_videos_to_series(conn, "ai", &ids, name)?;
            Ok(format!("{} 件をシリーズ「{name}」に追加しました", ids.len()))
        }
        "remove_from_series" => {
            let ids = ids_arg(args)?;
            let name = args["series"].as_str().ok_or_else(|| anyhow::anyhow!("series が必要です"))?;
            let sid: i64 = conn
                .query_row("SELECT id FROM series WHERE name = ?1 COLLATE NOCASE", [name], |r| r.get(0))
                .map_err(|_| anyhow::anyhow!("シリーズ「{name}」が見つかりません"))?;
            series::remove_videos_from_series(conn, "ai", &ids, sid)?;
            Ok(format!("{} 件をシリーズ「{name}」から外しました", ids.len()))
        }
        "set_rating" => {
            let ids = ids_arg(args)?;
            let rating = args["rating"].as_i64().ok_or_else(|| anyhow::anyhow!("rating が必要です"))?;
            videos::set_rating(conn, "ai", &ids, rating)?;
            Ok(format!("{} 件のレーティングを {} にしました", ids.len(), rating.clamp(0, 5)))
        }
        "set_video_info" => {
            let id = args["id"].as_i64().ok_or_else(|| anyhow::anyhow!("id が必要です"))?;
            let title = args["title"].as_str();
            let comment = args["comment"].as_str();
            anyhow::ensure!(title.is_some() || comment.is_some(), "title か comment のどちらかが必要です");
            videos::set_video_info(conn, "ai", id, title, comment)?;
            Ok(format!("id={id} の情報を更新しました"))
        }
        "remove_from_library" => {
            let ids = ids_arg(args)?;
            videos::remove_videos(conn, "ai", &ids)?;
            // サムネイルキャッシュも掃除(DB と同じフォルダの thumbs/)
            if let Some(dir) = default_thumbs_dir() {
                for id in &ids {
                    let _ = std::fs::remove_file(dir.join(format!("{id}.jpg")));
                }
            }
            Ok(format!("{} 件をライブラリから削除しました(ファイルは残っています)", ids.len()))
        }
        "dedupe" => {
            let dry_run = args["dry_run"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("dry_run (true/false) が必要です"))?;
            let scope = args["scope"].as_str().filter(|s| !s.trim().is_empty());
            let trash = args["trash_files"].as_bool().unwrap_or(false);
            if dry_run {
                let plan = dedupe::plan(conn, scope)?;
                return Ok(serde_json::to_string_pretty(&json!({
                    "dryRun": true,
                    "scope": scope.unwrap_or("(ライブラリ全体)"),
                    "groups": plan.groups,
                    "removeCount": plan.remove_count,
                    "skippedOutsideScope": plan.skipped_outside,
                    "skippedZeroSize": plan.skipped_zero_size,
                    "byFolder": plan.by_folder,
                    "samples": plan.samples,
                    "trashFiles": trash,
                    "note": if trash {
                        "実行するには dry_run: false で再度呼び出してください。対象のファイルはごみ箱へ送られます(完全削除ではありません)"
                    } else {
                        "実行するには dry_run: false で再度呼び出してください。ファイルは削除されません"
                    },
                }))?);
            }
            let (result, removed_ids) = dedupe::apply(conn, "ai", scope, trash)?;
            if removed_ids.is_empty() && result.failed == 0 {
                return Ok("解消できる重複はありませんでした".to_string());
            }
            if let Some(dir) = default_thumbs_dir() {
                for id in &removed_ids {
                    let _ = std::fs::remove_file(dir.join(format!("{id}.jpg")));
                }
            }
            if trash {
                Ok(format!(
                    "{} 件をごみ箱へ送り、ライブラリからも外しました(失敗 {} 件)",
                    result.trashed, result.failed
                ))
            } else {
                Ok(format!(
                    "{} 件をライブラリから外しました(ファイルは残っています)",
                    result.removed
                ))
            }
        }
        "trash_video_files" => {
            let ids = ids_arg(args)?;
            let dry_run = args["dry_run"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("dry_run (true/false) が必要です"))?;
            if dry_run {
                let plan = videos::plan_trash(conn, &ids)?;
                Ok(serde_json::to_string_pretty(&json!({
                    "dryRun": true,
                    "items": plan,
                    "note": "実行するには dry_run: false で再度呼び出してください",
                }))?)
            } else {
                let results = videos::trash_files(conn, "ai", &ids)?;
                Ok(serde_json::to_string_pretty(&json!({
                    "dryRun": false,
                    "results": results,
                }))?)
            }
        }
        other => Err(anyhow::anyhow!("unknown tool: {other}")),
    }
}

/// DB と同じデータフォルダ配下の thumbs ディレクトリ
fn default_thumbs_dir() -> Option<PathBuf> {
    let db_path = std::env::var("DVM_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_db_path());
    db_path.parent().map(|p| p.join("thumbs"))
}
