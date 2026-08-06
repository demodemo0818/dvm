use crate::core::ffmpeg::{self, FfmpegPaths};
use crate::core::settings;
use crate::AppState;
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::Serialize;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// WebView2 で再生できない動画を FFmpeg で mp4 に変換(remux / transcode)する。
/// 変換結果は {app_data_dir}/transcode/{video_id}.mp4 にキャッシュし、
/// 元ファイルより新しい限り再利用する。同時に走る変換は常に 1 本。

/// 進行中の変換ジョブ。child は kill のために別スレッドと共有する
pub struct TranscodeJob {
    pub video_id: i64,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscodeProgress {
    video_id: i64,
    /// 0.0〜100.0。尺が不明なときは None(フロントはスピナー表示)
    percent: Option<f64>,
    message: String,
}

enum RunOutcome {
    Done,
    Cancelled,
    Failed(String),
}

pub fn cache_path(transcode_dir: &Path, video_id: i64) -> PathBuf {
    transcode_dir.join(format!("{video_id}.mp4"))
}

fn tmp_path(transcode_dir: &Path, video_id: i64) -> PathBuf {
    transcode_dir.join(format!("{video_id}.tmp.mp4"))
}

/// キャッシュが存在し、元ファイル以降に作られていれば再利用できる
fn is_cache_fresh(cache: &Path, src: &Path) -> bool {
    let (Ok(cm), Ok(sm)) = (
        cache.metadata().and_then(|m| m.modified()),
        src.metadata().and_then(|m| m.modified()),
    ) else {
        return false;
    };
    cm >= sm
}

/// 変換を実行してキャッシュ mp4 のパスを返す(完了までブロック)。
/// mode: "remux"(コンテナ詰め替え)| "transcode"(再エンコード)
pub fn prepare(app: &AppHandle, video_id: i64, mode: &str) -> Result<PathBuf> {
    let state = app.state::<AppState>();
    // 同時に呼ばれても 1 本ずつ実行する(2 本目はキャッシュ再利用で即返る)。
    // キャッシュ確認より前にロックを取ることが重要
    let _serial = state.prepare_lock.lock().unwrap();
    let (src, video_codec, audio_codec, duration_ms) = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT path, video_codec, audio_codec, duration_ms FROM videos WHERE id = ?1",
            params![video_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .context("動画がライブラリにありません")?
    };
    let src = PathBuf::from(src);
    if !src.exists() {
        bail!("元ファイルが見つかりません: {}", src.display());
    }

    let cache = cache_path(&state.transcode_dir, video_id);
    if is_cache_fresh(&cache, &src) {
        return Ok(cache);
    }

    // 同時実行は 1 本だけ: 進行中の変換があれば止めてから始める
    kill_current(&state);

    let encoder = if mode == "transcode" { detect_encoder(app) } else { String::new() };
    let tmp = tmp_path(&state.transcode_dir, video_id);

    let mut outcome = run_ffmpeg(
        app, video_id, mode, &encoder, &src, &tmp,
        video_codec.as_deref(), audio_codec.as_deref(), duration_ms,
    )?;

    // HW エンコーダの実変換が失敗したら記録を消してソフトウェアで 1 回だけ再試行
    if let RunOutcome::Failed(_) = &outcome {
        if mode == "transcode" && !encoder.is_empty() && encoder != "libx264" {
            {
                // HW エンコーダはマシンの能力なのでアプリ全体側(app.db)に記録する
                let conn = state.app_db.lock().unwrap();
                let _ = settings::set(&conn, "hw_encoder", "libx264");
            }
            outcome = run_ffmpeg(
                app, video_id, mode, "libx264", &src, &tmp,
                video_codec.as_deref(), audio_codec.as_deref(), duration_ms,
            )?;
        }
    }

    match outcome {
        RunOutcome::Done => {
            std::fs::rename(&tmp, &cache).context("キャッシュファイルを配置できません")?;
            purge_cache(app, Some(&cache));
            Ok(cache)
        }
        RunOutcome::Cancelled => {
            let _ = std::fs::remove_file(&tmp);
            bail!("変換をキャンセルしました");
        }
        RunOutcome::Failed(err) => {
            let _ = std::fs::remove_file(&tmp);
            bail!("変換に失敗しました: {err}");
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_ffmpeg(
    app: &AppHandle,
    video_id: i64,
    mode: &str,
    encoder: &str,
    src: &Path,
    tmp: &Path,
    video_codec: Option<&str>,
    audio_codec: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<RunOutcome> {
    let state = app.state::<AppState>();
    let args = build_args(mode, encoder, video_codec, audio_codec, src, tmp);

    let mut child = ffmpeg::command(&state.ffmpeg.ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("ffmpeg を起動できません")?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let cancelled = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(child));
    *state.transcode_job.lock().unwrap() = Some(TranscodeJob {
        video_id,
        child: child.clone(),
        cancelled: cancelled.clone(),
    });

    // stderr はパイプ詰まりを避けるため別スレッドで読み切る(-v error なので少量)
    let err_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf);
        buf
    });

    // stdout の -progress 出力(out_time_us=)から進捗を 500ms 間隔で通知
    let message = if mode == "remux" { "コンテナを変換中…" } else { "動画を変換中…" };
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
        if let Some(us) = line.strip_prefix("out_time_us=") {
            if last_emit.elapsed() >= Duration::from_millis(500) {
                last_emit = Instant::now();
                let percent = match (us.trim().parse::<i64>(), duration_ms) {
                    (Ok(us), Some(dur)) if dur > 0 => {
                        Some(((us as f64 / 1000.0) / dur as f64 * 100.0).clamp(0.0, 100.0))
                    }
                    _ => None,
                };
                let _ = app.emit(
                    "transcode:progress",
                    TranscodeProgress { video_id, percent, message: message.into() },
                );
            }
        }
    }

    // stdout が閉じた = 終了間際。取りこぼさないよう poll で待つ
    let status = loop {
        if let Some(st) = child.lock().unwrap().try_wait()? {
            break st;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let err_text = err_reader.join().unwrap_or_default();

    // 自分のジョブ登録を解除(kill_current が別ジョブを積んでいたら触らない)
    {
        let mut job = state.transcode_job.lock().unwrap();
        if job.as_ref().is_some_and(|j| Arc::ptr_eq(&j.child, &child)) {
            *job = None;
        }
    }

    if cancelled.load(Ordering::SeqCst) {
        return Ok(RunOutcome::Cancelled);
    }
    if status.success() {
        Ok(RunOutcome::Done)
    } else {
        // stderr の末尾だけあれば原因は分かる
        let tail: String = err_text.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
        Ok(RunOutcome::Failed(tail.trim().to_string()))
    }
}

fn build_args(
    mode: &str,
    encoder: &str,
    video_codec: Option<&str>,
    audio_codec: Option<&str>,
    src: &Path,
    tmp: &Path,
) -> Vec<OsString> {
    let mut a: Vec<OsString> = Vec::new();
    let push = |a: &mut Vec<OsString>, s: &str| a.push(OsString::from(s));

    for s in ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i"] {
        push(&mut a, s);
    }
    a.push(src.into());
    // 映像 1 本・音声 1 本に限定(mkv の字幕・複数音声による mp4 化エラーを避ける)
    for s in ["-map", "0:v:0", "-map", "0:a:0?"] {
        push(&mut a, s);
    }

    if mode == "remux" {
        for s in ["-c:v", "copy"] {
            push(&mut a, s);
        }
        if video_codec == Some("hevc") {
            // mp4 内の HEVC は hvc1 タグでないと再生できないプレイヤーが多い
            for s in ["-tag:v", "hvc1"] {
                push(&mut a, s);
            }
        }
    } else {
        push(&mut a, "-c:v");
        push(&mut a, encoder);
        match encoder {
            "h264_nvenc" => for s in ["-preset", "p4", "-cq", "23", "-b:v", "0"] { push(&mut a, s); },
            "h264_qsv" => for s in ["-global_quality", "23"] { push(&mut a, s); },
            "h264_amf" => for s in ["-quality", "balanced"] { push(&mut a, s); },
            _ => for s in ["-preset", "veryfast", "-crf", "23"] { push(&mut a, s); },
        }
        // 10bit ソース(HEVC 10bit 等)を 8bit に落とす。H.264 再生互換の必須条件
        for s in ["-pix_fmt", "yuv420p"] {
            push(&mut a, s);
        }
    }

    // 音声: mp4 で安全なコーデックはそのまま、それ以外(ac3/dts/flac/opus 等)は AAC 化
    let audio_copy = mode == "remux" && matches!(audio_codec, Some("aac") | Some("mp3"));
    if audio_copy {
        for s in ["-c:a", "copy"] {
            push(&mut a, s);
        }
    } else {
        for s in ["-c:a", "aac", "-b:a", "192k"] {
            push(&mut a, s);
        }
    }

    for s in ["-movflags", "+faststart", "-f", "mp4"] {
        push(&mut a, s);
    }
    a.push(tmp.into());
    a
}

/// 使える H.264 エンコーダを決める。初回は 1 フレームのテストエンコードで実証し、
/// 結果を settings("hw_encoder")に保存して次回以降は即答する
pub fn detect_encoder(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    {
        let conn = state.app_db.lock().unwrap();
        if let Ok(Some(enc)) = settings::get(&conn, "hw_encoder") {
            if !enc.is_empty() {
                return enc;
            }
        }
    }
    let found = ["h264_nvenc", "h264_qsv", "h264_amf"]
        .into_iter()
        .find(|enc| test_encoder(&state.ffmpeg, enc))
        .unwrap_or("libx264")
        .to_string();
    {
        let conn = state.app_db.lock().unwrap();
        let _ = settings::set(&conn, "hw_encoder", &found);
    }
    found
}

/// ドライバ無しでも -encoders には載るため、実際に 1 フレーム encode して確かめる
fn test_encoder(ff: &FfmpegPaths, encoder: &str) -> bool {
    ffmpeg::command(&ff.ffmpeg)
        .args([
            "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
            "-frames:v", "1", "-c:v", encoder, "-f", "null", "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 進行中の変換を止める(なければ何もしない)。プロセスの終了まで少しだけ待つ
pub fn kill_current(state: &AppState) {
    let child = {
        let mut job = state.transcode_job.lock().unwrap();
        match job.take() {
            Some(j) => {
                j.cancelled.store(true, Ordering::SeqCst);
                let _ = j.child.lock().unwrap().kill();
                Some(j.child)
            }
            None => None,
        }
    };
    // 出力ファイルのハンドルが解放されるのを待つ(同じ動画をすぐ変換し直す場合に必要)
    if let Some(child) = child {
        for _ in 0..30 {
            if child.lock().unwrap().try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// キャッシュ掃除。設定と現在のライブラリ一覧を読んで `purge_cache_in` に渡すだけの薄いラッパ
pub fn purge_cache(app: &AppHandle, keep: Option<&Path>) {
    let state = app.state::<AppState>();
    let (limit_gb, mut known) = {
        let conn = state.app_db.lock().unwrap();
        let limit: u64 = settings::get(&conn, "transcode_cache_limit_gb")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20);
        let ids = crate::core::libraries::list(&conn)
            .map(|v| v.into_iter().map(|e| e.id).collect::<Vec<String>>())
            .unwrap_or_default();
        (limit, ids)
    };
    known.push(crate::core::libraries::PLACEHOLDER_CACHE_KEY.to_string());
    purge_cache_in(
        &state.data_dir.join("transcode"),
        limit_gb.saturating_mul(1024 * 1024 * 1024),
        &known,
        keep,
    );
}

/// 書きかけの .tmp.mp4 を消し、上限超過分を古い順に削除する。
/// keep(直近生成分)は削除対象から除外する。
///
/// **上限はライブラリ横断で見る**(v1.27)。`root` の直下はライブラリ id ごとの
/// サブフォルダで、ライブラリ単位に上限をかけると「ライブラリ数 × 20GB」に化ける。
/// `known_ids` に無いサブフォルダは、一覧から外したライブラリの残骸なので丸ごと消す
pub fn purge_cache_in(root: &Path, limit_bytes: u64, known_ids: &[String], keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if path.is_dir() {
            if !known_ids.iter().any(|id| *id == name) {
                let _ = std::fs::remove_dir_all(&path);
                continue;
            }
            collect_cache_files(&path, &mut files);
        } else if name.ends_with(".mp4") {
            // v1.26 以前のフラット配置の残骸(移行で消しているが取りこぼしの保険)
            let _ = std::fs::remove_file(&path);
        }
    }

    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= limit_bytes {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime);
    for (path, size, _) in files {
        if total <= limit_bytes {
            break;
        }
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
}

/// 変換キャッシュの現在量を数える(件数, バイト数)。
///
/// **`collect_cache_files` を流用しない** —— あちらは走査ついでに `.tmp.mp4` を消すので、
/// 設定画面に数字を出すだけの読み取りから呼ぶと副作用が出る。ここは何も消さない
pub fn cache_size(root: &Path) -> (usize, u64) {
    let Ok(libs) = std::fs::read_dir(root) else { return (0, 0) };
    let mut count = 0usize;
    let mut total = 0u64;
    for lib in libs.flatten() {
        let Ok(entries) = std::fs::read_dir(lib.path()) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 書きかけの .tmp.mp4 は「貯まっているもの」ではないので数えない
            if !name.ends_with(".mp4") || name.ends_with(".tmp.mp4") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                count += 1;
                total += meta.len();
            }
        }
    }
    (count, total)
}

/// 1 ライブラリぶんのキャッシュを走査する。.tmp.mp4 はその場で消す
fn collect_cache_files(dir: &Path, out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.ends_with(".tmp.mp4") {
            // 変換は同時 1 本なので、ここに残る .tmp は書きかけの残骸
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if !name.ends_with(".mp4") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            out.push((path, meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
        }
    }
}

/// 動画をライブラリから削除したときに対応するキャッシュも消す
pub fn remove_cache_for(transcode_dir: &Path, video_id: i64) {
    let _ = std::fs::remove_file(cache_path(transcode_dir, video_id));
    let _ = std::fs::remove_file(tmp_path(transcode_dir, video_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dvm-test-cache-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// mtime を指定して 1MB のダミーキャッシュを置く(古い順の削除を確かめるため)
    fn put(dir: &Path, name: &str, age_secs: u64) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, vec![0u8; 1024 * 1024]).unwrap();
        let when = std::time::SystemTime::now() - Duration::from_secs(age_secs);
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(when).unwrap();
        path
    }

    /// **上限はライブラリ横断で見る**。ライブラリごとに掛けると
    /// 実効の上限が「ライブラリ数 × 20GB」に化ける
    #[test]
    fn purge_enforces_the_limit_across_libraries() {
        let root = workspace("across");
        let a = root.join("aaa");
        let b = root.join("bbb");
        let known = vec!["aaa".to_string(), "bbb".to_string()];

        let oldest = put(&a, "1.mp4", 300);
        let middle = put(&b, "2.mp4", 200);
        let newest = put(&a, "3.mp4", 100);
        let tmp = put(&b, "9.tmp.mp4", 50);

        // 3MB あるところに上限 2MB。古いものから 1 つだけ落ちる
        purge_cache_in(&root, 2 * 1024 * 1024, &known, None);

        assert!(!oldest.exists(), "いちばん古いものから消すこと");
        assert!(middle.exists());
        assert!(newest.exists());
        assert!(!tmp.exists(), "書きかけの .tmp はどのサブフォルダでも消すこと");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 直近に作ったものは、いちばん古くても消さない(再生しようとしている本人なので)
    #[test]
    fn purge_never_removes_the_file_we_just_made() {
        let root = workspace("keep");
        let a = root.join("aaa");
        let known = vec!["aaa".to_string()];
        let oldest = put(&a, "1.mp4", 300);
        let newer = put(&a, "2.mp4", 100);

        purge_cache_in(&root, 1024, &known, Some(&oldest));

        assert!(oldest.exists(), "keep は上限を割っても残すこと");
        assert!(!newer.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 一覧から外したライブラリのキャッシュを永久に残さない
    #[test]
    fn purge_removes_unknown_library_folders() {
        let root = workspace("unknown");
        let known_dir = root.join("aaa");
        let gone_dir = root.join("deleted-library");
        let kept = put(&known_dir, "1.mp4", 10);
        put(&gone_dir, "1.mp4", 10);
        // v1.26 以前のフラット配置の残骸
        let legacy = put(&root, "7.mp4", 10);

        purge_cache_in(&root, 100 * 1024 * 1024, &["aaa".to_string()], None);

        assert!(kept.exists());
        assert!(!gone_dir.exists(), "登録に無いサブフォルダは丸ごと消すこと");
        assert!(!legacy.exists(), "ルート直下の旧キャッシュも掃除すること");

        let _ = std::fs::remove_dir_all(&root);
    }
}
