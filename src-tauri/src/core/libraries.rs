//! 複数ライブラリのレジストリ(v1.27)。
//!
//! **アプリ全体のもの**(どのライブラリを開いていても同じであるべきもの)を
//! `%APPDATA%\jp.demo2.dvm\app.db` に集め、**ライブラリの中身**は各ライブラリフォルダの
//! `library.db` に置く、という二層構造にする。
//!
//! app.db を JSON ではなく SQLite にしたのは、`core/settings.rs` の `get`/`set` が
//! `&Connection` を受けるだけなので、**同名同形の settings テーブル**を持たせれば
//! フロント(`api.getSetting`)からコマンドまで一切変えずに流用できるため。
//!
//! app.db は読み書きコネクションを分けない(CLAUDE.md パフォーマンス原則 6 の例外)。
//! 原則 6 は取り込みワーカーの UPDATE 連発と一覧クエリのロック競合を避けるためのもので、
//! app.db には取り込みワーカーが存在せず、書き込みは設定変更時の単発だけ。

use crate::core::{backup, offline, settings, volumes};
use crate::db;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// レジストリ + アプリ全体設定
pub const APP_DB: &str = "app.db";
/// ライブラリ本体のファイル名(ライブラリフォルダ直下)
pub const DB_NAME: &str = "library.db";
/// 新規作成の既定の置き場(data_dir 配下)
pub const LIBRARIES_DIR: &str = "libraries";
/// ライブラリフォルダの目印。別 PC で開き直しても同じ id を保つために置く
pub const MARKER: &str = "dvm-library.json";
/// ライブラリが開けないときの逃げ場(空の DB を毎回作り直す)
const PLACEHOLDER_DIR: &str = ".placeholder";
/// placeholder で起動したときの変換キャッシュのサブフォルダ名。
/// 実在するライブラリ id(16 桁 hex)とは衝突しない
pub const PLACEHOLDER_CACHE_KEY: &str = "_placeholder";

const CURRENT_KEY: &str = "current_library_id";
const MIGRATED_KEY: &str = "migrated_from_v126_at";
/// v1.26 以前の単一ライブラリを移す先の名前
const LEGACY_NAME: &str = "マイライブラリ";

/// フォルダ名に使えない文字(Windows)
const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
/// フォルダ名の最大文字数。深い階層に置かれても MAX_PATH(260)に触れにくい長さ
const NAME_MAX_CHARS: usize = 60;

/// app.db のスキーマ。**`db.rs` の SCHEMA は絶対に流さないこと** ——
/// videos テーブルができてしまい、`validate_db` が app.db をライブラリと誤認する
const APP_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS libraries (
  -- 名前変更・フォルダ移動・ドライブレター変動をまたいで不変。マーカーにも同じ値を書く
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- ライブラリフォルダの絶対パス。直下に library.db / thumbs / backups がある
  root TEXT NOT NULL,
  -- 外付け HDD のレター変動対策(watched_folders.volume_serial と同じ発想)
  volume_serial TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 表示用。**並び順には使わない**(切り替えるたびに並びが変わると押す位置がずれる)
  last_opened_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"#;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    pub root: String,
    pub sort_order: i64,
    pub last_opened_at: Option<String>,
    /// ルートに到達できるか。**DB には持たず毎回判定する**
    /// (DESIGN.md「オフラインドライブの扱い」と同じ方針)
    pub online: bool,
    /// レター変動の追跡用。フロントには送らない
    #[serde(skip)]
    pub volume_serial: Option<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LibraryStatus {
    /// 正常に開けた
    Ok,
    /// ルート(ドライブ / 共有)に到達できない。**missing とは区別する**
    Offline,
    /// ルートはオンラインだが library.db が無い
    Missing,
    /// 開けるが DVM のデータベースではない / 壊れている
    Broken,
    /// 登録が 1 つも無い、または current が空
    None,
}

/// 起動時に「どのライブラリを開くか」を解決した結果
pub struct Resolved {
    pub status: LibraryStatus,
    pub entry: Option<LibraryEntry>,
    pub message: String,
    /// 実際に開くフォルダ。status != Ok のときは placeholder を指す
    pub root: PathBuf,
}

// ---------------------------------------------------------------- app.db

/// app.db を開く(無ければ作る)。初回は `bootstrap` で既存データを引き継ぐ
pub fn open_app_db(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join(APP_DB);
    let fresh = !path.exists();
    let conn = Connection::open(&path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(APP_SCHEMA)?;
    if fresh {
        bootstrap(&conn, data_dir)?;
    } else {
        // 初回に移せなかったぶんを毎回そっと再挑戦する(下のコメント参照)
        let _ = retry_legacy_move(&conn, data_dir);
    }
    Ok(conn)
}

/// 移行で移せなかったレガシー配置(root がデータフォルダそのもの)を起動のたびに再挑戦する。
///
/// **MCP サーバーが起動していると初回の移動は必ず失敗する** —— dvm-mcp.exe が
/// `library.db` を開いたままだと Windows は rename に必要な DELETE 共有を許さない。
/// Claude Desktop を開いたまま DVM を更新すれば普通に踏むので、
/// 「次にその邪魔が無かったとき」に自然と片付くようにしておく。
///
/// `db::init` より前(まだ自分も開いていない状態)に呼ばれることが前提
fn retry_legacy_move(conn: &Connection, data_dir: &Path) -> Result<()> {
    // 移行由来であることを確かめる。ユーザーが自分でデータフォルダを選んだ
    // ライブラリを勝手に動かさないため
    if settings::get(conn, MIGRATED_KEY)?.is_none() {
        return Ok(());
    }
    let here = normalize_root(&data_dir.to_string_lossy());
    let Some(entry) = list(conn)?
        .into_iter()
        .find(|e| normalize_root(&e.root) == here)
    else {
        return Ok(()); // 移行済み
    };

    let dest = data_dir.join(LIBRARIES_DIR).join(LEGACY_NAME);
    if move_legacy(data_dir, &dest).is_err() {
        return Ok(()); // まだ誰かが掴んでいる。次の起動でまた試す
    }
    conn.execute(
        "UPDATE libraries SET root = ?1 WHERE id = ?2",
        params![dest.to_string_lossy(), entry.id],
    )?;
    let _ = write_marker(&dest, &entry.id, &entry.name);
    // データフォルダ直下に残った目印は紛らわしいので片付ける
    let _ = std::fs::remove_file(data_dir.join(MARKER));
    purge_legacy_transcode(data_dir);
    eprintln!("既存ライブラリを {} へ移しました", dest.display());
    Ok(())
}

/// 初回起動時の移行。**app.db を新規作成したときだけ**呼ばれる。
///
/// v1.26 までの `%APPDATA%\jp.demo2.dvm\library.db` を `libraries\マイライブラリ\` へ移し、
/// アプリ全体の設定を app.db にコピーする。移動に失敗したら元の場所のまま登録して続行する
/// —— `root` は任意パスを許す設計なのでどちらも「普通のライブラリ」であり、
/// レガシー専用の分岐は増えない
fn bootstrap(conn: &Connection, data_dir: &Path) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM libraries", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(()); // 冪等
    }

    let legacy_db = data_dir.join(DB_NAME);
    if !legacy_db.is_file() {
        // 完全な新規インストール
        let root = data_dir.join(LIBRARIES_DIR).join(LEGACY_NAME);
        let entry = create_at(conn, LEGACY_NAME, &root)?;
        set_current(conn, &entry.id)?;
        return Ok(());
    }

    let dest = data_dir.join(LIBRARIES_DIR).join(LEGACY_NAME);
    let root = match move_legacy(data_dir, &dest) {
        Ok(()) => dest,
        Err(e) => {
            eprintln!("既存ライブラリの移動を見送りました({e})。元の場所のまま使います");
            data_dir.to_path_buf()
        }
    };
    let entry = register(conn, LEGACY_NAME, &root)?;
    copy_settings_from_library(conn, &root.join(DB_NAME))?;
    set_current(conn, &entry.id)?;
    let now: String = conn.query_row("SELECT datetime('now', 'localtime')", [], |r| r.get(0))?;
    settings::set(conn, MIGRATED_KEY, &now)?;
    // 旧 transcode は {video_id}.mp4 のフラット配置。新構成はライブラリ id で
    // サブフォルダを切るので、捨ててよい派生物として消す(次の再生で作り直される)
    purge_legacy_transcode(data_dir);
    Ok(())
}

/// v1.26 のデータフォルダ直下にあるライブラリ一式を dest へ移す。
/// **同一ボリューム内の rename なので一瞬で終わる。**
/// 途中で失敗したら移動済みのものを全部戻す(中途半端な状態を残さない)
fn move_legacy(data_dir: &Path, dest: &Path) -> Result<()> {
    anyhow::ensure!(!dest.exists(), "移行先が既にあります: {}", dest.display());
    std::fs::create_dir_all(dest)?;
    // restore.pending も一緒に運ぶ(復元予約したまま更新した人のため)
    const ITEMS: &[&str] = &[
        "library.db",
        "library.db-wal",
        "library.db-shm",
        "thumbs",
        "backups",
        "restore.pending",
    ];
    let mut moved: Vec<&str> = Vec::new();
    for name in ITEMS {
        let src = data_dir.join(name);
        if !src.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&src, dest.join(name)) {
            for done in &moved {
                let _ = std::fs::rename(dest.join(done), data_dir.join(done));
            }
            let _ = std::fs::remove_dir_all(dest);
            return Err(anyhow!("{name} を移せません: {e}"));
        }
        moved.push(name);
    }
    Ok(())
}

/// 旧 library.db の settings をアプリ全体設定として引き継ぐ。
///
/// **`last_auto_backup_at` だけは持ってこない** —— あれは「そのライブラリの DB を
/// いつバックアップしたか」の記録で、app.db に移すと「A を開いた 24 時間以内に B を
/// 開くと B のバックアップが取られない」というバグになる。
///
/// 旧 library.db 側の行は消さない(片方向コピー)。消すメリットが無く、
/// 万一この版を戻したときに設定が生きているほうが安全
fn copy_settings_from_library(app: &Connection, lib_db: &Path) -> Result<()> {
    let src = Connection::open_with_flags(lib_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let rows: Vec<(String, Option<String>)> = {
        let mut stmt = src.prepare("SELECT key, value FROM settings")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    app.execute_batch("BEGIN")?;
    for (k, v) in rows {
        if k == backup::LAST_AUTO_KEY {
            continue;
        }
        app.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![k, v],
        )?;
    }
    app.execute_batch("COMMIT")?;
    Ok(())
}

fn purge_legacy_transcode(data_dir: &Path) {
    let dir = data_dir.join("transcode");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.filter_map(|e| e.ok()) {
        if e.path().is_file() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ---------------------------------------------------------------- 一覧・CRUD

pub fn list(conn: &Connection) -> Result<Vec<LibraryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, root, volume_serial, sort_order, last_opened_at
         FROM libraries ORDER BY sort_order, name",
    )?;
    let rows: Vec<LibraryEntry> = stmt
        .query_map([], |r| {
            let root: String = r.get(2)?;
            Ok(LibraryEntry {
                id: r.get(0)?,
                name: r.get(1)?,
                online: is_online(&root),
                root,
                volume_serial: r.get(3)?,
                sort_order: r.get(4)?,
                last_opened_at: r.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<LibraryEntry>> {
    Ok(list(conn)?.into_iter().find(|e| e.id == id))
}

pub fn current_id(conn: &Connection) -> Option<String> {
    settings::get(conn, CURRENT_KEY)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

pub fn set_current(conn: &Connection, id: &str) -> Result<()> {
    settings::set(conn, CURRENT_KEY, id)?;
    conn.execute(
        "UPDATE libraries SET last_opened_at = datetime('now', 'localtime') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// 空のライブラリを新規作成する。`parent_dir` の下に名前のフォルダを作る
pub fn create(conn: &Connection, name: &str, parent_dir: &Path) -> Result<LibraryEntry> {
    let folder = sanitize_folder_name(name)?;
    create_at(conn, name.trim(), &parent_dir.join(folder))
}

fn create_at(conn: &Connection, name: &str, root: &Path) -> Result<LibraryEntry> {
    if root.exists() {
        let empty = std::fs::read_dir(root)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        anyhow::ensure!(
            empty,
            "そのフォルダには既に中身があります: {}",
            root.display()
        );
    }
    std::fs::create_dir_all(root.join("thumbs"))?;
    std::fs::create_dir_all(root.join("backups"))?;
    // 空の library.db を作って閉じる(スキーマは db::init が流す)
    drop(db::init(&root.join(DB_NAME))?);
    register(conn, name, root)
}

/// 既存のライブラリフォルダを一覧に加える(外付け HDD を別 PC に挿したとき等)
pub fn add_existing(conn: &Connection, root: &Path) -> Result<LibraryEntry> {
    validate_root(root)?;
    let marker = read_marker(root);
    let target = normalize_root(&root.to_string_lossy());
    for e in list(conn)? {
        let same_path = normalize_root(&e.root) == target;
        let same_id = marker.as_ref().map(|m| m.id == e.id).unwrap_or(false);
        if same_path || same_id {
            return Err(anyhow!("そのライブラリは既に一覧にあります:「{}」", e.name));
        }
    }
    let name = marker
        .map(|m| m.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| folder_name(root));
    register(conn, &name, root)
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "名前を入力してください");
    conn.execute(
        "UPDATE libraries SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    // フォルダ名は変えない(中身が入ったフォルダの rename は失敗しうるし、
    // 開いている最中に動かせない)。マーカーだけ追従させる
    if let Some(e) = get(conn, id)? {
        let _ = write_marker(Path::new(&e.root), id, name);
    }
    Ok(())
}

/// 一覧から外す。**フォルダとファイルは一切消さない**。
///
/// 開いているものを守るのは呼び出し側(`commands/libraries.rs`)の仕事 ——
/// 消えた・壊れたライブラリを開けずに placeholder で起動しているときは、
/// **current が指したままでも外せなければ復旧できない**
pub fn forget(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM libraries WHERE id = ?1", params![id])?;
    // 消した行を指したままにしない(次の起動は「ライブラリを選んでください」になる)
    if current_id(conn).as_deref() == Some(id) {
        settings::set(conn, CURRENT_KEY, "")?;
    }
    Ok(())
}

/// レジストリに 1 行足す(フォルダの中身は触らない)
fn register(conn: &Connection, name: &str, root: &Path) -> Result<LibraryEntry> {
    // マーカーに id があればそれを使う。別 PC で開き直しても同じ id になり、
    // 変換キャッシュの名前空間やタググループの折りたたみ状態が引き継がれる
    let id = match read_marker(root) {
        Some(m) => m.id,
        None => new_id(conn)?,
    };
    let root_s = root.to_string_lossy().to_string();
    let serial = volumes::volume_serial(&offline::root_of(&root_s));
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM libraries",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO libraries (id, name, root, volume_serial, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, root_s, serial, order],
    )?;
    // 読み取り専用メディアでは書けないので、失敗しても続行する
    let _ = write_marker(root, &id, name);
    Ok(LibraryEntry {
        id,
        name: name.to_string(),
        online: is_online(&root_s),
        root: root_s,
        volume_serial: serial,
        sort_order: order,
        last_opened_at: None,
    })
}

fn new_id(conn: &Connection) -> Result<String> {
    // uuid クレートを増やさない。8 バイトあれば衝突は実質起きない
    Ok(conn.query_row("SELECT lower(hex(randomblob(8)))", [], |r| r.get(0))?)
}

// ---------------------------------------------------------------- 解決

/// 起動時に開くライブラリを決める。
///
/// **開けないときに「代わりに 1 番目を開く」ことは絶対にしない** ——
/// 普通に起動したように見えるので、ユーザーが違うライブラリにタグを付けてしまう。
/// 静かに壊れる最悪の失敗なので、必ず理由を出して止める
pub fn resolve_current(conn: &Connection, data_dir: &Path) -> Resolved {
    let fallback = |status, message: String, entry| Resolved {
        status,
        entry,
        message,
        root: placeholder_root(data_dir),
    };

    let Some(id) = current_id(conn) else {
        return fallback(
            LibraryStatus::None,
            "ライブラリを選んでください".into(),
            None,
        );
    };
    let entry = match get(conn, &id) {
        Ok(Some(e)) => e,
        _ => {
            return fallback(
                LibraryStatus::None,
                "ライブラリを選んでください".into(),
                None,
            )
        }
    };

    // ドライブレターが変わっただけなら追従する(watched_folders と同じ発想)
    let entry = remap_if_moved(conn, entry);
    let root = PathBuf::from(&entry.root);

    if !is_online(&entry.root) {
        let drive = offline::root_of(&entry.root);
        return fallback(
            LibraryStatus::Offline,
            format!("{drive} に接続できません。ドライブを繋いでから再試行してください"),
            Some(entry),
        );
    }
    let db_path = root.join(DB_NAME);
    if !db_path.is_file() {
        return fallback(
            LibraryStatus::Missing,
            format!("ライブラリが見つかりません: {}", entry.root),
            Some(entry),
        );
    }
    if let Err(e) = validate_db(&db_path) {
        return fallback(LibraryStatus::Broken, e.to_string(), Some(entry));
    }
    Resolved {
        status: LibraryStatus::Ok,
        message: String::new(),
        root,
        entry: Some(entry),
    }
}

/// 記録したボリュームシリアルと現在のレターが食い違っていたら、同シリアルの別レターを探す。
/// 見つからなければ何もしない(単なる未接続として Offline に倒す)
fn remap_if_moved(conn: &Connection, entry: LibraryEntry) -> LibraryEntry {
    if PathBuf::from(&entry.root).join(DB_NAME).is_file() {
        return entry; // そのまま開ける
    }
    let Some(serial) = entry.volume_serial.clone() else {
        return entry;
    };
    let old_root = offline::root_of(&entry.root);
    if old_root.starts_with("\\\\") || old_root.len() < 3 || entry.root.len() < 2 {
        return entry;
    }
    let old_upper = format!("{}{}", old_root[..2].to_ascii_uppercase(), &old_root[2..]);
    let current = volumes::drive_serial_map();
    let Some(new_root) = current
        .iter()
        .find(|(r, s)| **s == serial && **r != old_upper)
        .map(|(r, _)| r.clone())
    else {
        return entry;
    };
    let moved = format!("{}{}", &new_root[..2], &entry.root[2..]);
    // SUBST 等でシリアルが重複する偽陽性への保険。中身を見て確かめてから採用する
    if !Path::new(&moved).join(DB_NAME).is_file() {
        return entry;
    }
    let _ = conn.execute(
        "UPDATE libraries SET root = ?1 WHERE id = ?2",
        params![moved, entry.id],
    );
    eprintln!("ライブラリのドライブレター変動を検出: {} -> {moved}", entry.root);
    LibraryEntry {
        online: is_online(&moved),
        root: moved,
        ..entry
    }
}

/// ライブラリが開けないときの逃げ場。**毎回空で作り直す**。
///
/// `AppState` が必ず有効な Connection を持てるようにするための仕組み。
/// `Mutex<Option<Connection>>` にすると 60 以上ある既存コマンドが全部 unwrap 地獄になる
pub fn placeholder_root(data_dir: &Path) -> PathBuf {
    data_dir.join(PLACEHOLDER_DIR)
}

pub fn reset_placeholder(data_dir: &Path) -> Result<PathBuf> {
    let root = placeholder_root(data_dir);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("thumbs"))?;
    std::fs::create_dir_all(root.join("backups"))?;
    Ok(root)
}

/// MCP(別プロセス)から「いま DVM が開いているライブラリ」の DB を引く。
///
/// **UI 非依存**(CLAUDE.md アーキテクチャ原則 1)。`lib.rs` の setup と
/// `bin/dvm-mcp.rs` の両方から呼べるよう rusqlite だけで完結させる
pub fn resolve_db_path(data_dir: &Path) -> Option<PathBuf> {
    let app_db = data_dir.join(APP_DB);
    if app_db.is_file() {
        if let Ok(conn) = Connection::open_with_flags(&app_db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let root: Option<String> = conn
                .query_row(
                    "SELECT root FROM libraries
                     WHERE id = (SELECT value FROM settings WHERE key = ?1)",
                    params![CURRENT_KEY],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten();
            if let Some(root) = root {
                let db = PathBuf::from(root).join(DB_NAME);
                if db.is_file() {
                    return Some(db);
                }
            }
        }
    }
    // app.db が無い(v1.26 以前)環境へのフォールバック
    let legacy = data_dir.join(DB_NAME);
    legacy.is_file().then_some(legacy)
}

// ---------------------------------------------------------------- 検証

/// DVM のライブラリとして開けるかを確かめる。
/// **壊れたものに切り替えると次回起動がエラー画面から始まる**ので、
/// 切り替えの前と復元の予約の前に必ず通す(`core/backup.rs` と共有)
pub fn validate_db(path: &Path) -> Result<()> {
    anyhow::ensure!(path.is_file(), "ファイルが見つかりません: {}", path.display());
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| anyhow!("データベースを開けません: {e}"))?;
    let has_videos: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='videos'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    anyhow::ensure!(has_videos, "DVM のデータベースではないようです");
    Ok(())
}

/// ライブラリフォルダとして使えるかを確かめる(到達性 → 中身の順)
pub fn validate_root(root: &Path) -> Result<()> {
    let s = root.to_string_lossy().to_string();
    anyhow::ensure!(
        is_online(&s),
        "{} に接続できません",
        offline::root_of(&s)
    );
    validate_db(&root.join(DB_NAME))
}

fn is_online(root: &str) -> bool {
    Path::new(&offline::root_of(root)).exists()
}

// ---------------------------------------------------------------- マーカー

#[derive(Debug)]
pub struct Marker {
    pub id: String,
    pub name: String,
}

/// ライブラリフォルダの目印を読む。壊れていれば None(パスで同一性判定に落ちる)
pub fn read_marker(root: &Path) -> Option<Marker> {
    let text = std::fs::read_to_string(root.join(MARKER)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let name = v
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .to_string();
    Some(Marker { id, name })
}

pub fn write_marker(root: &Path, id: &str, name: &str) -> Result<()> {
    let body = serde_json::json!({
        "app": "DVM",
        "id": id,
        "name": name,
    });
    std::fs::write(root.join(MARKER), serde_json::to_vec_pretty(&body)?)?;
    Ok(())
}

// ---------------------------------------------------------------- パス

/// Windows のパス比較用に畳む(大小文字を無視し、末尾の区切りを落とす)。
/// `store.ts` の `toggleDirPath` と同じ流儀
pub fn normalize_root(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "ライブラリ".to_string())
}

/// ライブラリ名からフォルダ名を作る。`core/frames.rs` と同じ禁止文字を使う
pub fn sanitize_folder_name(name: &str) -> Result<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if FORBIDDEN.contains(&c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows は末尾がドットや空白のフォルダ名を扱えない
    let cleaned = match cleaned.char_indices().nth(NAME_MAX_CHARS) {
        Some((i, _)) => cleaned[..i].to_string(),
        None => cleaned,
    };
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    anyhow::ensure!(!cleaned.is_empty(), "フォルダ名にできない名前です");
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dvm-test-lib-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// v1.26 相当のデータフォルダを作る
    fn legacy_data_dir(name: &str) -> PathBuf {
        let dir = workspace(name);
        let conn = db::init(&dir.join(DB_NAME)).unwrap();
        settings::set(&conn, "player_path", "C:\\mpc.exe").unwrap();
        settings::set(&conn, "card_width", "220").unwrap();
        settings::set(&conn, backup::LAST_AUTO_KEY, "2026-07-31 10:00:00").unwrap();
        drop(conn);
        std::fs::create_dir_all(dir.join("thumbs")).unwrap();
        std::fs::write(dir.join("thumbs").join("1.jpg"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        std::fs::create_dir_all(dir.join("transcode")).unwrap();
        std::fs::write(dir.join("transcode").join("1.mp4"), b"x").unwrap();
        dir
    }

    #[test]
    fn bootstrap_moves_legacy_library() {
        let dir = legacy_data_dir("move");
        let app = open_app_db(&dir).unwrap();

        let libs = list(&app).unwrap();
        assert_eq!(libs.len(), 1);
        let root = PathBuf::from(&libs[0].root);
        assert_eq!(root, dir.join(LIBRARIES_DIR).join(LEGACY_NAME));
        assert!(root.join(DB_NAME).is_file(), "library.db を移すこと");
        assert!(root.join("thumbs").join("1.jpg").is_file(), "サムネイルも一緒に運ぶ");
        assert!(root.join("backups").is_dir());
        assert!(root.join(MARKER).is_file(), "マーカーを置くこと");
        assert!(!dir.join(DB_NAME).exists(), "元の場所には残さない");
        assert_eq!(current_id(&app).as_deref(), Some(libs[0].id.as_str()));

        // アプリ全体の設定は引き継ぐ
        assert_eq!(
            settings::get(&app, "player_path").unwrap().as_deref(),
            Some("C:\\mpc.exe")
        );
        assert_eq!(settings::get(&app, "card_width").unwrap().as_deref(), Some("220"));
        // ライブラリごとの記録は持ってこない
        assert_eq!(settings::get(&app, backup::LAST_AUTO_KEY).unwrap(), None);
        // 旧 library.db 側は消さない(片方向コピー)
        let old = Connection::open(root.join(DB_NAME)).unwrap();
        assert_eq!(
            settings::get(&old, backup::LAST_AUTO_KEY).unwrap().as_deref(),
            Some("2026-07-31 10:00:00")
        );
        // 旧 transcode のフラットファイルは捨てる
        assert!(!dir.join("transcode").join("1.mp4").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bootstrap_falls_back_when_move_fails() {
        let dir = legacy_data_dir("fallback");
        // 移行先を塞いでおく
        let blocker = dir.join(LIBRARIES_DIR).join(LEGACY_NAME);
        std::fs::create_dir_all(&blocker).unwrap();

        let app = open_app_db(&dir).unwrap();
        let libs = list(&app).unwrap();
        assert_eq!(libs.len(), 1);
        assert_eq!(
            normalize_root(&libs[0].root),
            normalize_root(&dir.to_string_lossy()),
            "移せなければ元の場所のまま登録して起動を続ける"
        );
        assert!(dir.join(DB_NAME).is_file(), "巻き戻して元の場所に残すこと");
        assert_eq!(
            settings::get(&app, "player_path").unwrap().as_deref(),
            Some("C:\\mpc.exe"),
            "設定の引き継ぎは移動の成否と無関係"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// MCP が library.db を掴んでいて初回に移せなかったケース。
    /// 邪魔が消えた次の起動で自動的に片付くこと
    #[test]
    fn legacy_move_is_retried_on_later_startups() {
        let dir = legacy_data_dir("retry");
        let blocker = dir.join(LIBRARIES_DIR).join(LEGACY_NAME);
        std::fs::create_dir_all(&blocker).unwrap();

        let app = open_app_db(&dir).unwrap();
        let id = list(&app).unwrap()[0].id.clone();
        assert_eq!(
            normalize_root(&list(&app).unwrap()[0].root),
            normalize_root(&dir.to_string_lossy()),
            "初回は移せず元の場所のまま"
        );
        drop(app);

        // 邪魔が消えた(= MCP を閉じた)状態で起動し直す
        std::fs::remove_dir(&blocker).unwrap();
        let app = open_app_db(&dir).unwrap();
        let libs = list(&app).unwrap();
        assert_eq!(libs.len(), 1, "行を増やさないこと");
        assert_eq!(libs[0].id, id, "id は変えないこと(キャッシュの名前空間が変わる)");
        assert_eq!(PathBuf::from(&libs[0].root), blocker);
        assert!(blocker.join(DB_NAME).is_file());
        assert!(blocker.join("thumbs").join("1.jpg").is_file());
        assert!(!dir.join(MARKER).exists(), "元の場所の目印は片付けること");
        assert_eq!(resolve_current(&app, &dir).status, LibraryStatus::Ok);

        // 3 回目以降は何もしない
        drop(app);
        let app = open_app_db(&dir).unwrap();
        assert_eq!(PathBuf::from(&list(&app).unwrap()[0].root), blocker);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 自分でデータフォルダを選んだライブラリは動かさない(移行由来だけを対象にする)
    #[test]
    fn retry_leaves_a_deliberately_placed_library_alone() {
        let dir = workspace("retry-manual");
        let app = open_app_db(&dir).unwrap();
        // 新規インストール相当なので migrated の印が無い。そこへ手で登録する
        app.execute("DELETE FROM libraries", []).unwrap();
        drop(db::init(&dir.join(DB_NAME)).unwrap());
        let entry = register(&app, "手で選んだ", &dir).unwrap();
        set_current(&app, &entry.id).unwrap();
        drop(app);

        let app = open_app_db(&dir).unwrap();
        assert_eq!(
            normalize_root(&list(&app).unwrap()[0].root),
            normalize_root(&dir.to_string_lossy()),
            "移行由来でないものは動かさない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bootstrap_is_idempotent() {
        let dir = legacy_data_dir("idempotent");
        let app = open_app_db(&dir).unwrap();
        let first = list(&app).unwrap();
        // ユーザーが設定を変えた後で
        settings::set(&app, "player_path", "D:\\vlc.exe").unwrap();
        drop(app);

        let app = open_app_db(&dir).unwrap();
        assert_eq!(list(&app).unwrap().len(), 1, "2 回目で増やさない");
        assert_eq!(list(&app).unwrap()[0].id, first[0].id);
        assert_eq!(
            settings::get(&app, "player_path").unwrap().as_deref(),
            Some("D:\\vlc.exe"),
            "旧 library.db の値で上書きし返さない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bootstrap_on_fresh_install() {
        let dir = workspace("fresh");
        let app = open_app_db(&dir).unwrap();
        let libs = list(&app).unwrap();
        assert_eq!(libs.len(), 1);
        let root = PathBuf::from(&libs[0].root);
        assert!(root.join(DB_NAME).is_file());
        assert!(validate_root(&root).is_ok());
        assert_eq!(current_id(&app).as_deref(), Some(libs[0].id.as_str()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_existing_dedupes() {
        let dir = workspace("dedupe");
        let app = open_app_db(&dir).unwrap();
        let other = dir.join("外付け");
        let created = create_at(&app, "外付け", &other).unwrap();

        // 同じフォルダ(マーカーの id 一致)
        assert!(add_existing(&app, &other).is_err());
        // マーカーを消しても大小文字違いのパスで弾く
        std::fs::remove_file(other.join(MARKER)).unwrap();
        let upper = PathBuf::from(other.to_string_lossy().to_uppercase());
        assert!(add_existing(&app, &upper).is_err());

        assert_eq!(list(&app).unwrap().len(), 2, "既定 + 外付けの 2 つのまま");
        assert!(!created.id.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_existing_reuses_marker_id() {
        let dir = workspace("marker");
        let app = open_app_db(&dir).unwrap();
        let root = dir.join("持ち運び");
        let created = create_at(&app, "持ち運び", &root).unwrap();
        forget(&app, &created.id).unwrap();

        // 別 PC で開き直した想定
        let again = add_existing(&app, &root).unwrap();
        assert_eq!(again.id, created.id, "マーカーの id を引き継ぐこと");
        assert_eq!(again.name, "持ち運び", "名前も引き継ぐこと");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_keeps_files_and_clears_current() {
        let dir = workspace("forget");
        let app = open_app_db(&dir).unwrap();
        let current = list(&app).unwrap().remove(0);

        let root = dir.join("second");
        let second = create_at(&app, "second", &root).unwrap();
        forget(&app, &second.id).unwrap();
        assert_eq!(list(&app).unwrap().len(), 1);
        assert!(root.join(DB_NAME).is_file(), "ファイルは消さないこと");
        assert_eq!(
            current_id(&app).as_deref(),
            Some(current.id.as_str()),
            "他のものを外しても current は動かさない"
        );

        // 開けなくなったライブラリを外す経路(復旧画面から呼ばれる)
        forget(&app, &current.id).unwrap();
        assert!(list(&app).unwrap().is_empty());
        assert_eq!(current_id(&app), None, "消した行を指したままにしない");
        assert_eq!(resolve_current(&app, &dir).status, LibraryStatus::None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_db_rejects_junk() {
        let dir = workspace("validate");
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(validate_db(&junk).is_err());

        let other = dir.join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE t (x)")
            .unwrap();
        assert!(validate_db(&other).is_err());

        assert!(validate_db(&dir.join("nope.db")).is_err());

        // app.db 自体をライブラリと誤認しないこと(settings テーブルが同名なので)
        let app_db = dir.join(APP_DB);
        Connection::open(&app_db)
            .unwrap()
            .execute_batch(APP_SCHEMA)
            .unwrap();
        assert!(validate_db(&app_db).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_reports_missing_and_broken() {
        let dir = workspace("resolve");
        let app = open_app_db(&dir).unwrap();
        assert_eq!(resolve_current(&app, &dir).status, LibraryStatus::Ok);

        let root = PathBuf::from(&list(&app).unwrap()[0].root);
        // 壊す
        std::fs::write(root.join(DB_NAME), b"broken").unwrap();
        let r = resolve_current(&app, &dir);
        assert_eq!(r.status, LibraryStatus::Broken);
        assert_eq!(r.root, placeholder_root(&dir), "placeholder に逃がす");

        // 消す
        std::fs::remove_file(root.join(DB_NAME)).unwrap();
        assert_eq!(resolve_current(&app, &dir).status, LibraryStatus::Missing);

        // 登録から外す(current が指す先が消える)
        app.execute("DELETE FROM libraries", []).unwrap();
        assert_eq!(resolve_current(&app, &dir).status, LibraryStatus::None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_db_path_prefers_current_then_legacy() {
        let dir = legacy_data_dir("dbpath");
        // app.db がまだ無い状態 = v1.26 以前
        assert_eq!(resolve_db_path(&dir), Some(dir.join(DB_NAME)));

        let app = open_app_db(&dir).unwrap();
        let root = PathBuf::from(&list(&app).unwrap()[0].root);
        drop(app);
        assert_eq!(
            resolve_db_path(&dir),
            Some(root.join(DB_NAME)),
            "app.db があれば現在のライブラリを指す"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_folder_names() {
        assert_eq!(sanitize_folder_name(" アニメ ").unwrap(), "アニメ");
        assert_eq!(sanitize_folder_name("E:/仕事?").unwrap(), "E__仕事_");
        assert_eq!(sanitize_folder_name("末尾のドット...").unwrap(), "末尾のドット");
        assert!(sanitize_folder_name("   ").is_err());
        assert!(sanitize_folder_name("...").is_err());
        let long = "あ".repeat(200);
        assert_eq!(sanitize_folder_name(&long).unwrap().chars().count(), NAME_MAX_CHARS);
    }

    #[test]
    fn placeholder_is_recreated_empty() {
        let dir = workspace("placeholder");
        let root = reset_placeholder(&dir).unwrap();
        let conn = db::init(&root.join(DB_NAME)).unwrap();
        conn.execute(
            "INSERT INTO videos (id, path, filename) VALUES (1, 'C:\\a.mp4', 'a.mp4')",
            [],
        )
        .unwrap();
        drop(conn);

        let root = reset_placeholder(&dir).unwrap();
        assert!(!root.join(DB_NAME).exists(), "毎回まっさらにすること");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
