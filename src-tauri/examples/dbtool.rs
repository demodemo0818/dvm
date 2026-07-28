//! 開発用 DB ツール(E2E テスト・デバッグ用)
//! 使い方:
//!   cargo run --example dbtool -- <db_path> seed <folder_path>
//!   cargo run --example dbtool -- <db_path> dump
//!   cargo run --example dbtool -- <db_path> check   # マイグレーション適用と統計の確認

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: dbtool <db_path> seed <folder> | dbtool <db_path> dump | dbtool <db_path> check");
        std::process::exit(1);
    }

    // check は init 経由でマイグレーションを実際に走らせる(本番と同じ経路を通す)
    if args[2] == "check" {
        let conn = dvm_lib::db::init(std::path::Path::new(&args[1])).expect("init db");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("user_version");
        println!("user_version = {version}");

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .expect("prepare");
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .expect("query")
            .flatten()
            .collect();
        println!("tables = {}", tables.join(", "));

        let stats = dvm_lib::core::stats::library_stats(&conn).expect("stats");
        println!(
            "videos={} missing={} unwatched={} untagged={} duplicates={} tags={} series={}",
            stats.video_count,
            stats.missing_count,
            stats.unwatched_count,
            stats.untagged_count,
            stats.duplicate_count,
            stats.tag_count,
            stats.series_count,
        );
        println!("smart_folders = {}", dvm_lib::core::smart_folders::list(&conn).unwrap().len());
        return;
    }

    let conn = rusqlite::Connection::open(&args[1]).expect("open db");

    match args[2].as_str() {
        "seed" => {
            let folder = args.get(3).expect("folder path required");
            conn.execute(
                "INSERT OR IGNORE INTO watched_folders (path, recursive) VALUES (?1, 1)",
                [folder],
            )
            .expect("insert watched_folder");
            println!("seeded: {folder}");
        }
        "dump" => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, filename, duration_ms, width, height, video_codec, thumb_state, is_missing
                     FROM videos ORDER BY id",
                )
                .expect("prepare");
            let rows = stmt
                .query_map([], |r| {
                    Ok(format!(
                        "id={} file={} duration_ms={:?} {}x{} codec={:?} thumb_state={} missing={}",
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                        r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                    ))
                })
                .expect("query");
            for row in rows.flatten() {
                println!("{row}");
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(1);
        }
    }
}
