//! 開発用 DB ツール(E2E テスト・デバッグ用)
//! 使い方:
//!   cargo run --example dbtool -- <db_path> seed <folder_path>
//!   cargo run --example dbtool -- <db_path> dump

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: dbtool <db_path> seed <folder> | dbtool <db_path> dump");
        std::process::exit(1);
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
