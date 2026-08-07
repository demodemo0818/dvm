use crate::core::offline;
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;

/// ドライブレターの変動("E:" → "F:")を表す
#[derive(Debug)]
pub struct DriveRemap {
    pub old_drive: String,
    pub new_drive: String,
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// "E:\" 形式のルートのボリュームシリアルを 8 桁 hex で返す。UNC・未接続は None
#[cfg(windows)]
pub fn volume_serial(root: &str) -> Option<String> {
    if root.starts_with("\\\\") {
        return None;
    }
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let root_w = wide(root);
    let mut serial: u32 = 0;
    let ok = unsafe {
        GetVolumeInformationW(
            root_w.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 {
        Some(format!("{serial:08X}"))
    } else {
        None
    }
}

#[cfg(not(windows))]
pub fn volume_serial(_root: &str) -> Option<String> {
    None
}

/// 現在マウント中のドライブルート("C:\" 等)一覧
#[cfg(windows)]
pub fn drive_roots() -> Vec<String> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    (0u32..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i as u8) as char))
        .collect()
}

#[cfg(not(windows))]
pub fn drive_roots() -> Vec<String> {
    Vec::new()
}

/// 現在の { ドライブルート → ボリュームシリアル } 対応表
pub fn drive_serial_map() -> HashMap<String, String> {
    drive_roots()
        .into_iter()
        .filter_map(|root| volume_serial(&root).map(|s| (root, s)))
        .collect()
}

/// 起動時・再スキャン前に呼ぶ。
/// 1) シリアル未記録の監視フォルダに現在値を記録(バックフィル)
/// 2) レター変動を検出したら watched_folders と videos の path を一括で書き換える
/// 戻り値は実行した再マッピング(空なら変動なし)
pub fn sync_drive_letters(conn: &Connection) -> Result<Vec<DriveRemap>> {
    let folders: Vec<(i64, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, path, volume_serial FROM watched_folders")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    if folders.is_empty() {
        return Ok(Vec::new());
    }

    let current = drive_serial_map();
    // 同一ドライブの複数フォルダで重複しないよう old_drive をキーに集約
    let mut remaps: HashMap<String, String> = HashMap::new();

    for (id, path, stored) in &folders {
        let root = offline::root_of(path);
        // 「英字ドライブレター + :」で始まる形だけを対象にする。**バイト単位で見る** ——
        // 長さだけの判定だと、先頭がマルチバイト文字の不正パスで下の root[..2] が
        // 文字境界パニックになり、スキャン全体が道連れになる
        let b = root.as_bytes();
        if root.starts_with("\\\\") || b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
            continue; // UNC・不正パスは対象外
        }
        let root_upper = format!("{}{}", root[..2].to_ascii_uppercase(), &root[2..]);
        match (stored, current.get(&root_upper)) {
            // 未記録 → バックフィル
            (None, Some(cur)) => {
                conn.execute(
                    "UPDATE watched_folders SET volume_serial=?1 WHERE id=?2",
                    params![cur, id],
                )?;
            }
            // 記録済みで一致 → 正常
            (Some(s), Some(cur)) if s == cur => {}
            // 不一致(レターがオフライン or 別ボリュームがそのレターを使用)→ 同シリアルの別レターを探す
            (Some(s), _) => {
                let Some(new_root) = current
                    .iter()
                    .find(|(r, serial)| *serial == s && **r != root_upper)
                    .map(|(r, _)| r.clone())
                else {
                    continue; // 単なる未接続。何もしない(missing 誤判定防止は offline 判定に任せる)
                };
                // SUBST 等でシリアルが重複する偽陽性への保険: 置換後のフォルダパスが実在するときだけ採用
                let new_path = format!("{}{}", &new_root[..2], &path[2..]);
                if Path::new(&new_path).is_dir() {
                    remaps
                        .entry(root_upper[..2].to_string())
                        .or_insert_with(|| new_root[..2].to_string());
                }
            }
            // 未記録かつ未接続 → 判定不能。次回オンライン時にバックフィルされる
            (None, None) => {}
        }
    }

    let mut applied = Vec::new();
    for (old_drive, new_drive) in remaps {
        // prefix 比較は LIKE ではなく substr で行う(パス中の % _ のエスケープ問題を回避)
        let tx = conn.unchecked_transaction()?;
        let res = tx
            .execute(
                "UPDATE watched_folders SET path = ?1 || substr(path, 3)
                 WHERE substr(upper(path), 1, 2) = ?2",
                params![new_drive, old_drive],
            )
            .and_then(|_| {
                // 旧パスが UNIQUE 衝突する場合は安全側(スキップ)に倒す
                tx.execute(
                    "UPDATE OR IGNORE videos SET path = ?1 || substr(path, 3)
                     WHERE substr(upper(path), 1, 2) = ?2",
                    params![new_drive, old_drive],
                )
            });
        match res {
            Ok(_) => {
                tx.commit()?;
                db::log_op(
                    conn,
                    "system",
                    "drive_remap",
                    &format!(r#"{{"old":"{old_drive}","new":"{new_drive}"}}"#),
                );
                applied.push(DriveRemap {
                    old_drive,
                    new_drive,
                });
            }
            Err(e) => {
                // ROLLBACK は tx の Drop がやる
                eprintln!("drive_remap {old_drive}->{new_drive} failed: {e}");
            }
        }
    }
    Ok(applied)
}
