use crate::core::ffmpeg::{command, FfmpegPaths};
use anyhow::{anyhow, Result};
use std::path::Path;

/// 動画の 10% 地点から 1 枚サムネイルを生成する(JPEG, 幅 480px)
pub fn generate(ff: &FfmpegPaths, video_path: &str, duration_ms: Option<i64>, out: &Path) -> Result<()> {
    let ss = duration_ms
        .map(|d| (d as f64 / 1000.0) * 0.10)
        .unwrap_or(0.0)
        .max(0.0);

    let ok = run_ffmpeg(ff, video_path, Some(ss), out)?;
    if ok {
        return Ok(());
    }
    // 10% 地点で失敗したら先頭から再試行(極端に短い・壊れかけのファイル対策)
    let retry_ok = run_ffmpeg(ff, video_path, None, out)?;
    if retry_ok {
        Ok(())
    } else {
        Err(anyhow!("thumbnail generation failed: {video_path}"))
    }
}

fn run_ffmpeg(ff: &FfmpegPaths, video_path: &str, ss: Option<f64>, out: &Path) -> Result<bool> {
    let mut cmd = command(&ff.ffmpeg);
    cmd.args(["-v", "error"]);
    if let Some(ss) = ss {
        if ss > 0.0 {
            cmd.args(["-ss", &format!("{ss:.3}")]);
        }
    }
    cmd.args(["-i", video_path])
        .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-y"])
        .arg(out);
    let output = cmd.output()?;
    Ok(output.status.success() && out.exists())
}
