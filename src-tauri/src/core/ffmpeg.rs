use std::path::{Path, PathBuf};
use std::process::Command;

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
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}
