use crate::core::ffmpeg::{command, FfmpegPaths};
use anyhow::{anyhow, Result};

#[derive(Debug, Default)]
pub struct Probed {
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub container: Option<String>,
    pub fps: Option<f64>,
    pub bitrate: Option<i64>,
}

pub fn probe(ff: &FfmpegPaths, path: &str) -> Result<Probed> {
    let output = command(&ff.ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let mut probed = Probed::default();

    if let Some(format) = v.get("format") {
        probed.duration_ms = format
            .get("duration")
            .and_then(|d| d.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .map(|s| (s * 1000.0) as i64);
        probed.bitrate = format
            .get("bit_rate")
            .and_then(|b| b.as_str())
            .and_then(|s| s.parse::<i64>().ok());
        probed.container = format
            .get("format_name")
            .and_then(|f| f.as_str())
            .map(String::from);
    }
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            match s.get("codec_type").and_then(|t| t.as_str()) {
                Some("video") if probed.video_codec.is_none() => {
                    probed.video_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
                    probed.width = s.get("width").and_then(|w| w.as_i64());
                    probed.height = s.get("height").and_then(|h| h.as_i64());
                    probed.fps = s
                        .get("avg_frame_rate")
                        .and_then(|r| r.as_str())
                        .and_then(parse_fraction);
                }
                Some("audio") if probed.audio_codec.is_none() => {
                    probed.audio_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
                }
                _ => {}
            }
        }
    }
    Ok(probed)
}

fn parse_fraction(s: &str) -> Option<f64> {
    let mut parts = s.splitn(2, '/');
    let num: f64 = parts.next()?.parse().ok()?;
    match parts.next() {
        Some(den) => {
            let den: f64 = den.parse().ok()?;
            if den == 0.0 {
                None
            } else {
                Some(num / den)
            }
        }
        None => Some(num),
    }
}
