use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
pub struct FfmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl FfmpegPaths {
    /// 探索順: exe と同じ場所の binaries/(配布時)→ src-tauri/binaries/(開発時)→ PATH
    pub fn resolve() -> Self {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("binaries"));
                candidates.push(dir.to_path_buf());
            }
        }
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));

        for dir in &candidates {
            let ffmpeg = dir.join("ffmpeg.exe");
            let ffprobe = dir.join("ffprobe.exe");
            if ffmpeg.exists() && ffprobe.exists() {
                return Self { ffmpeg, ffprobe };
            }
        }
        Self {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
        }
    }
}

/// コンソールウィンドウを出さずに外部コマンドを組み立てる
pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // **stdin は必ず閉じる**。ffmpeg は端末が無くても標準入力を読みにいくことがあり、
    // 親から継承した stdin につながったままだと戻ってこない。
    // 実際、5,211 本の一括再生成で 1 本だけ 36 分ハングした(CPU は 0.3 秒しか使っていない)。
    // 同じコマンドを手で叩くと 1.5 秒で終わるので、違いは stdin の状態だけだった。
    // トランスコード(playback.rs)では前から個別に閉じていたのを、起点に寄せた
    cmd.stdin(Stdio::null());
    cmd
}
