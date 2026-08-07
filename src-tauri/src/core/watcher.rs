use crate::core::library;
use crate::core::offline;
use crate::AppState;
use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 監視スレッドを起動し、最初のウォッチャーを構築する(起動時に 1 回呼ぶ)
pub fn init(app: &AppHandle) {
    let (tx, rx) = channel::<i64>();
    {
        let state = app.state::<AppState>();
        *state.watch_tx.lock().unwrap() = Some(tx);
    }
    let app2 = app.clone();
    std::thread::spawn(move || debounce_loop(app2, rx));
    rebuild(app);
}

/// 監視対象フォルダの変更(追加・削除)後に呼び、ウォッチャーを作り直す
pub fn rebuild(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (folders, excluded): (Vec<(i64, String, bool)>, Vec<String>) = {
        let conn = state.db.lock().unwrap();
        let folders = conn
            .prepare("SELECT id, path, recursive FROM watched_folders WHERE enabled=1")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0))
                })
                .map(|it| it.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        (folders, crate::core::excludes::list_normalized(&conn))
    };

    let tx = match state.watch_tx.lock().unwrap().clone() {
        Some(tx) => tx,
        None => return,
    };

    // イベントのパス → フォルダ id を引くための対応表。
    // 小文字化 + 区切りを \ に揃え、**末尾に \ を付けて境界込みで**比較する。
    // 区切りなしの前方一致だと C:\a\bc のイベントが C:\a\b に誤配され、
    // 実際にファイルが増えた場所がスキャンされない(library.rs の deepest_owner と同じ判定)
    let index: Vec<(i64, String)> = folders
        .iter()
        .map(|(id, path, _)| {
            let normalized = path.to_lowercase().replace('/', "\\");
            (*id, format!("{}\\", normalized.trim_end_matches('\\')))
        })
        .collect();

    let handler = move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let mut sent: HashSet<i64> = HashSet::new();
        for path in &event.paths {
            // 除外パスの中の変更でスキャンを起こさない(起こしても取り込まれないので無駄)
            if crate::core::excludes::is_excluded(&excluded, &path.to_string_lossy()) {
                continue;
            }
            let p = path.to_string_lossy().to_lowercase().replace('/', "\\");
            // 最も深くマッチする監視フォルダに割り当てる(境界込み。
            // フォルダ自身のイベントも p == prefix(末尾 \ なし)で拾う)
            let mut best: Option<(i64, usize)> = None;
            for (id, prefix) in &index {
                let hit = p.starts_with(prefix.as_str())
                    || p.as_str() == &prefix[..prefix.len() - 1];
                if hit && best.map(|(_, l)| prefix.len() > l).unwrap_or(true) {
                    best = Some((*id, prefix.len()));
                }
            }
            if let Some((id, _)) = best {
                if sent.insert(id) {
                    let _ = tx.send(id);
                }
            }
        }
    };

    let mut roots = offline::RootCache::default();
    let watcher = match notify::recommended_watcher(handler) {
        Ok(mut w) => {
            for (_, path, recursive) in &folders {
                if !roots.is_online(path) {
                    continue; // オフラインのドライブは監視しない(再接続時は再スキャンで拾う)
                }
                let mode = if *recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                };
                let _ = w.watch(std::path::Path::new(path), mode);
            }
            Some(w)
        }
        Err(e) => {
            eprintln!("watcher init failed: {e}");
            None
        }
    };

    *state.watcher.lock().unwrap() = watcher;
}

/// イベントを 1.5 秒デバウンスして、変化のあったフォルダだけ再スキャンする
fn debounce_loop(app: AppHandle, rx: Receiver<i64>) {
    let mut dirty: HashSet<i64> = HashSet::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(1500)) {
            Ok(id) => {
                dirty.insert(id);
            }
            Err(RecvTimeoutError::Timeout) => {
                if dirty.is_empty() {
                    continue;
                }
                let state = app.state::<AppState>();
                if state.scanning.load(std::sync::atomic::Ordering::SeqCst) {
                    continue; // スキャン中は持ち越して次の周期で再試行
                }
                for id in dirty.drain().collect::<Vec<_>>() {
                    library::run_scan_folder(&app, id);
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}
