use crate::core::ffmpeg::{command, FfmpegPaths};
use crate::core::offline;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
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

/// ffprobe を 1 回だけ起動して JSON を受け取る(probe / media_info の共通部)
fn run_ffprobe(ff: &FfmpegPaths, path: &str, extra: &[&str]) -> Result<Value> {
    let output = command(&ff.ffprobe)
        .args(["-v", "error", "-print_format", "json"])
        .args(extra)
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

/// 取り込み時に videos テーブルへ書く基本情報を取る(スキャンのホットパス)
pub fn probe(ff: &FfmpegPaths, path: &str) -> Result<Probed> {
    let v = run_ffprobe(ff, path, &["-show_format", "-show_streams"])?;
    Ok(parse_probed(&v))
}

/// probe() の解釈部分。I/O をしない純関数なので cargo test で検証できる
pub fn parse_probed(v: &Value) -> Probed {
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
    probed
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

// ---------------------------------------------------------------------------
// 詳細ペインの「メディア情報」(v1.15)
//
// ここの型は ffprobe の出力を**ほぼ生のまま**運ぶ。単位変換・日本語ラベル・
// レベル表記はフロント(src/lib/mediaInfo.ts)の仕事にしてある。
// 変換テーブルを Rust に持つと陳腐化するし、生の識別子(h264 / yuv420p / bt709)は
// そのままのほうがユーザーの役に立つため
// ---------------------------------------------------------------------------

/// ffprobe の tags 1 件。エンコーダ名・作成日時・mkv の BPS などが入る。
/// serde_json は preserve_order 無効なのでキー昇順で安定して並ぶ
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct MediaTag {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub format: MediaFormat,
    pub streams: Vec<MediaStream>,
    /// -show_chapters の結果(無ければ空)
    pub chapters: Vec<MediaChapter>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormat {
    pub format_name: Option<String>,
    pub format_long_name: Option<String>,
    pub duration_ms: Option<i64>,
    pub size: Option<i64>,
    pub bitrate: Option<i64>,
    pub stream_count: Option<i64>,
    pub tags: Vec<MediaTag>,
}

/// ffprobe の 1 ストリーム。映像 / 音声 / 字幕 / 添付を同じ型で運ぶ
/// (種別ごとに使うフィールドが違うだけなので enum に分けない。フロントも 1 型で済む)
#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStream {
    pub index: i64,
    /// "video" / "audio" / "subtitle" / "attachment" / "data"
    pub kind: String,
    pub codec_name: Option<String>,
    pub codec_long_name: Option<String>,
    pub codec_tag: Option<String>,
    pub profile: Option<String>,
    /// codec 依存の生値(h264 の 40 が L4.0)。表示用の変換はフロントでやる
    pub level: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
    pub is_forced: bool,
    /// 埋め込みのカバー画像(YouTube 由来の mp4 によく入っている)。
    /// codec_type は video だが本編ではないので、表示側で分けて数える
    pub is_attached_pic: bool,
    pub tags: Vec<MediaTag>,

    // --- 映像 ---
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub display_aspect_ratio: Option<String>,
    pub sample_aspect_ratio: Option<String>,
    pub pix_fmt: Option<String>,
    pub bit_depth: Option<i64>,
    pub color_space: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub color_range: Option<String>,
    pub field_order: Option<String>,
    pub avg_frame_rate: Option<f64>,
    pub r_frame_rate: Option<f64>,
    pub frame_count: Option<i64>,
    /// Display Matrix side_data の回転角(-90 など)
    pub rotation: Option<f64>,
    /// 色特性と side_data から分かる範囲の HDR 方式
    pub hdr: Option<String>,

    // --- 音声 ---
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub channel_layout: Option<String>,
    pub sample_fmt: Option<String>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaChapter {
    pub start_ms: i64,
    pub end_ms: i64,
    pub title: Option<String>,
}

/// ffprobe は数値を文字列で返すことがある(duration / bit_rate / nb_frames / sample_rate …)
fn num(v: &Value, key: &str) -> Option<i64> {
    let f = v.get(key)?;
    f.as_i64()
        .or_else(|| f.as_str()?.trim().parse::<i64>().ok())
}

/// 空文字と ffprobe が「不明」に使う値は落とす(画面に unknown を並べない)
fn text(v: &Value, key: &str) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    match s {
        "" | "unknown" | "N/A" => None,
        other => Some(other.to_string()),
    }
}

fn secs_to_ms(v: &Value, key: &str) -> Option<i64> {
    let raw = v.get(key)?;
    let secs = raw
        .as_f64()
        .or_else(|| raw.as_str()?.trim().parse::<f64>().ok())?;
    if !secs.is_finite() {
        return None;
    }
    Some((secs * 1000.0) as i64)
}

fn tags_of(v: &Value) -> Vec<MediaTag> {
    v.get("tags")
        .and_then(|t| t.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, val)| MediaTag {
                    key: k.clone(),
                    value: match val {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    },
                })
                .collect()
        })
        .unwrap_or_default()
}

fn tag_value(tags: &[MediaTag], key: &str) -> Option<String> {
    tags.iter()
        .find(|t| t.key.eq_ignore_ascii_case(key))
        .map(|t| t.value.clone())
}

fn disposition(v: &Value, key: &str) -> bool {
    v.get("disposition")
        .and_then(|d| d.get(key))
        .and_then(|f| f.as_i64())
        == Some(1)
}

/// フレームを読まずに分かる範囲の HDR 方式。
/// HDR10+ のダイナミックメタデータはフレーム側にあり -show_frames が要るので判定しない
fn hdr_label(v: &Value) -> Option<String> {
    let dovi = v
        .get("side_data_list")
        .and_then(|l| l.as_array())
        .map(|a| {
            a.iter().any(|s| {
                s.get("side_data_type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t.contains("DOVI") || t.contains("Dolby Vision"))
            })
        })
        .unwrap_or(false);
    if dovi {
        return Some("Dolby Vision".into());
    }
    match v.get("color_transfer").and_then(|t| t.as_str()) {
        Some("smpte2084") => Some("HDR10 (PQ)".into()),
        Some("arib-std-b67") => Some("HLG".into()),
        _ => None,
    }
}

fn rotation_of(v: &Value, tags: &[MediaTag]) -> Option<f64> {
    v.get("side_data_list")
        .and_then(|l| l.as_array())
        .and_then(|a| a.iter().find_map(|s| s.get("rotation")?.as_f64()))
        // 古い mp4 は side_data ではなくタグに入っている
        .or_else(|| tag_value(tags, "rotate")?.parse().ok())
}

/// ffprobe の JSON を詳細ペイン向けの構造体に写す。
/// I/O をしない純関数なので cargo test で検証できる
pub fn parse_media_info(v: &Value) -> MediaInfo {
    MediaInfo {
        format: v.get("format").map(parse_format).unwrap_or_default(),
        streams: v
            .get("streams")
            .and_then(|s| s.as_array())
            .map(|a| a.iter().map(parse_stream).collect())
            .unwrap_or_default(),
        chapters: v
            .get("chapters")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().map(parse_chapter).collect())
            .unwrap_or_default(),
    }
}

fn parse_format(f: &Value) -> MediaFormat {
    MediaFormat {
        format_name: text(f, "format_name"),
        format_long_name: text(f, "format_long_name"),
        duration_ms: secs_to_ms(f, "duration"),
        size: num(f, "size"),
        bitrate: num(f, "bit_rate"),
        stream_count: num(f, "nb_streams"),
        tags: tags_of(f),
    }
}

fn parse_stream(s: &Value) -> MediaStream {
    let tags = tags_of(s);
    MediaStream {
        index: s.get("index").and_then(|i| i.as_i64()).unwrap_or(-1),
        kind: text(s, "codec_type").unwrap_or_else(|| "data".into()),
        codec_name: text(s, "codec_name"),
        codec_long_name: text(s, "codec_long_name"),
        // 中身が無いときは [0][0][0][0] というプレースホルダが入る
        codec_tag: text(s, "codec_tag_string").filter(|t| t != "[0][0][0][0]"),
        profile: text(s, "profile"),
        // -99 は「不明」。負値はまとめて落とす
        level: num(s, "level").filter(|l| *l >= 0),
        duration_ms: secs_to_ms(s, "duration")
            .or_else(|| tag_value(&tags, "DURATION").as_deref().and_then(parse_hhmmss)),
        // mkv は bit_rate を持たず、タグの BPS に入っていることがある
        bitrate: num(s, "bit_rate").or_else(|| tag_value(&tags, "BPS")?.trim().parse().ok()),
        language: tag_value(&tags, "language"),
        title: tag_value(&tags, "title"),
        is_default: disposition(s, "default"),
        is_forced: disposition(s, "forced"),
        is_attached_pic: disposition(s, "attached_pic"),

        width: num(s, "width"),
        height: num(s, "height"),
        display_aspect_ratio: text(s, "display_aspect_ratio").filter(|r| r != "0:1"),
        sample_aspect_ratio: text(s, "sample_aspect_ratio").filter(|r| r != "0:1"),
        pix_fmt: text(s, "pix_fmt"),
        // 映像は bits_per_raw_sample、音声は bits_per_sample(どちらも 0 は不明)
        bit_depth: num(s, "bits_per_raw_sample")
            .or_else(|| num(s, "bits_per_sample"))
            .filter(|d| *d > 0),
        color_space: text(s, "color_space"),
        color_primaries: text(s, "color_primaries"),
        color_transfer: text(s, "color_transfer"),
        color_range: text(s, "color_range"),
        field_order: text(s, "field_order"),
        avg_frame_rate: s
            .get("avg_frame_rate")
            .and_then(|r| r.as_str())
            .and_then(parse_fraction),
        r_frame_rate: s
            .get("r_frame_rate")
            .and_then(|r| r.as_str())
            .and_then(parse_fraction),
        frame_count: num(s, "nb_frames")
            .or_else(|| tag_value(&tags, "NUMBER_OF_FRAMES")?.trim().parse().ok()),
        rotation: rotation_of(s, &tags),
        hdr: hdr_label(s),

        sample_rate: num(s, "sample_rate"),
        channels: num(s, "channels"),
        channel_layout: text(s, "channel_layout"),
        sample_fmt: text(s, "sample_fmt"),

        tags,
    }
}

fn parse_chapter(c: &Value) -> MediaChapter {
    MediaChapter {
        start_ms: secs_to_ms(c, "start_time").unwrap_or(0),
        end_ms: secs_to_ms(c, "end_time").unwrap_or(0),
        title: c.get("tags").and_then(|t| text(t, "title")),
    }
}

/// mkv のストリームタグ DURATION は "00:23:40.123000000" 形式
fn parse_hhmmss(s: &str) -> Option<i64> {
    let mut parts = s.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    Some(((h * 3600.0 + m * 60.0 + sec) * 1000.0) as i64)
}

/// 詳細ペインの「メディア情報」用。
/// **ユーザーがセクションを展開したときだけ**呼ぶこと — 元動画を読むため
/// (CLAUDE.md パフォーマンス原則 2)。
/// フレームはデコードしないのでヘッダ解析だけで済み、外付け HDD でも短時間で返る
pub fn media_info(ff: &FfmpegPaths, path: &str) -> Result<MediaInfo> {
    // ドライブ未接続とファイル欠落は、ffprobe の英語エラーより先に日本語で返す
    let root = offline::root_of(path);
    if !Path::new(&root).exists() {
        return Err(anyhow!("ドライブ({root})が接続されていません"));
    }
    if !Path::new(path).exists() {
        return Err(anyhow!("ファイルが見つかりません"));
    }
    let v = run_ffprobe(
        ff,
        path,
        &["-show_format", "-show_streams", "-show_chapters"],
    )?;
    Ok(parse_media_info(&v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(s: &str) -> Value {
        serde_json::from_str(s).expect("テスト用 JSON が壊れている")
    }

    /// 映像 + 音声 + 字幕 + 添付。字幕と添付は既存 probe() が捨てていた分
    fn sample_mkv() -> Value {
        json(r#"{
          "streams": [
            {
              "index": 0, "codec_type": "video", "codec_name": "h264",
              "codec_long_name": "H.264 / AVC", "profile": "High", "level": 40,
              "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
              "bits_per_raw_sample": "8", "color_space": "bt709",
              "display_aspect_ratio": "16:9", "sample_aspect_ratio": "1:1",
              "field_order": "progressive",
              "avg_frame_rate": "24000/1001", "r_frame_rate": "24000/1001",
              "disposition": { "default": 1, "forced": 0 },
              "tags": { "language": "jpn", "BPS": "8551234", "NUMBER_OF_FRAMES": "34000",
                        "_STATISTICS_WRITING_APP": "mkvmerge" }
            },
            {
              "index": 1, "codec_type": "audio", "codec_name": "aac", "profile": "LC",
              "sample_rate": "48000", "channels": 2, "channel_layout": "stereo",
              "sample_fmt": "fltp", "bits_per_sample": 0,
              "disposition": { "default": 1, "forced": 0 },
              "tags": { "language": "jpn", "title": "本編" }
            },
            {
              "index": 2, "codec_type": "subtitle", "codec_name": "subrip",
              "disposition": { "default": 0, "forced": 1 },
              "tags": { "language": "eng" }
            },
            {
              "index": 3, "codec_type": "attachment", "codec_name": "ttf",
              "tags": { "filename": "Gothic.ttf" }
            }
          ],
          "format": {
            "filename": "D:\\動画\\おそ松さん 第01話.mkv",
            "nb_streams": 4, "format_name": "matroska,webm",
            "format_long_name": "Matroska / WebM", "duration": "1420.500000",
            "size": "1524000000", "bit_rate": "8580000",
            "tags": { "encoder": "libebml v1.3.1" }
          }
        }"#)
    }

    /// 既存 probe() が捨てていた字幕・添付まで拾えていること
    #[test]
    fn lists_every_stream() {
        let info = parse_media_info(&sample_mkv());
        let kinds: Vec<&str> = info.streams.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, ["video", "audio", "subtitle", "attachment"]);
        // 日本語ファイル名が UTF-8 で往復する
        assert_eq!(info.format.format_long_name.as_deref(), Some("Matroska / WebM"));
        assert_eq!(info.format.duration_ms, Some(1_420_500));
        assert_eq!(info.format.size, Some(1_524_000_000));
        assert_eq!(info.format.stream_count, Some(4));
    }

    /// ffprobe は同じ JSON の中で数値を文字列と数値の両方で返す
    #[test]
    fn reads_numbers_given_as_strings() {
        let info = parse_media_info(&sample_mkv());
        // sample_rate は文字列、channels は数値で来る
        assert_eq!(info.streams[1].sample_rate, Some(48_000));
        assert_eq!(info.streams[1].channels, Some(2));
        assert_eq!(info.format.bitrate, Some(8_580_000));
    }

    #[test]
    fn falls_back_to_mkv_tags() {
        let info = parse_media_info(&sample_mkv());
        let video = &info.streams[0];
        // bit_rate / nb_frames を持たない mkv でも BPS / NUMBER_OF_FRAMES で埋まる
        assert_eq!(video.bitrate, Some(8_551_234));
        assert_eq!(video.frame_count, Some(34_000));
        assert_eq!(video.language.as_deref(), Some("jpn"));
        assert_eq!(info.streams[1].title.as_deref(), Some("本編"));
    }

    #[test]
    fn reads_default_and_forced_flags() {
        let info = parse_media_info(&sample_mkv());
        assert!(info.streams[0].is_default);
        assert!(!info.streams[0].is_forced);
        assert!(!info.streams[2].is_default);
        assert!(info.streams[2].is_forced);
    }

    /// YouTube 由来の mp4 に入っているカバー画像。codec_type は video だが本編ではない
    #[test]
    fn flags_attached_cover_art() {
        let v = json(r#"{"streams":[
          {"index":0,"codec_type":"video","codec_name":"h264",
           "disposition":{"default":1,"attached_pic":0}},
          {"index":1,"codec_type":"video","codec_name":"png",
           "disposition":{"default":0,"attached_pic":1}}
        ]}"#);
        let streams = parse_media_info(&v).streams;
        assert!(!streams[0].is_attached_pic);
        assert!(streams[1].is_attached_pic);
    }

    #[test]
    fn bit_depth_differs_between_video_and_audio() {
        let info = parse_media_info(&sample_mkv());
        // 映像は bits_per_raw_sample(文字列)
        assert_eq!(info.streams[0].bit_depth, Some(8));
        // 音声の bits_per_sample: 0 は「不明」なので落とす
        assert_eq!(info.streams[1].bit_depth, None);
    }

    #[test]
    fn drops_placeholder_values() {
        let v = json(r#"{"streams":[{
          "index": 0, "codec_type": "video", "codec_name": "hevc",
          "color_space": "unknown", "color_range": "", "pix_fmt": "N/A",
          "level": -99, "display_aspect_ratio": "0:1", "sample_aspect_ratio": "0:1",
          "codec_tag_string": "[0][0][0][0]"
        }]}"#);
        let s = &parse_media_info(&v).streams[0];
        assert_eq!(s.color_space, None);
        assert_eq!(s.color_range, None);
        assert_eq!(s.pix_fmt, None);
        assert_eq!(s.level, None);
        assert_eq!(s.display_aspect_ratio, None);
        assert_eq!(s.sample_aspect_ratio, None);
        assert_eq!(s.codec_tag, None);
    }

    #[test]
    fn survives_empty_json() {
        // 壊れたファイルで ffprobe が中身の無い JSON を返すことがある
        let info = parse_media_info(&json("{}"));
        assert_eq!(info, MediaInfo::default());
        assert!(info.streams.is_empty());
        assert!(info.chapters.is_empty());
    }

    #[test]
    fn detects_hdr_from_transfer_and_side_data() {
        let pq = json(r#"{"streams":[{"index":0,"codec_type":"video","color_transfer":"smpte2084"}]}"#);
        assert_eq!(parse_media_info(&pq).streams[0].hdr.as_deref(), Some("HDR10 (PQ)"));

        let hlg = json(r#"{"streams":[{"index":0,"codec_type":"video","color_transfer":"arib-std-b67"}]}"#);
        assert_eq!(parse_media_info(&hlg).streams[0].hdr.as_deref(), Some("HLG"));

        // Dolby Vision は色特性より優先する(PQ と併記されることがあるため)
        let dovi = json(r#"{"streams":[{"index":0,"codec_type":"video","color_transfer":"smpte2084",
          "side_data_list":[{"side_data_type":"DOVI configuration record"}]}]}"#);
        assert_eq!(parse_media_info(&dovi).streams[0].hdr.as_deref(), Some("Dolby Vision"));

        let sdr = json(r#"{"streams":[{"index":0,"codec_type":"video","color_transfer":"bt709"}]}"#);
        assert_eq!(parse_media_info(&sdr).streams[0].hdr, None);
    }

    #[test]
    fn reads_rotation_from_side_data_or_tag() {
        let matrix = json(r#"{"streams":[{"index":0,"codec_type":"video",
          "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90.0}]}]}"#);
        assert_eq!(parse_media_info(&matrix).streams[0].rotation, Some(-90.0));

        let tag = json(r#"{"streams":[{"index":0,"codec_type":"video","tags":{"rotate":"180"}}]}"#);
        assert_eq!(parse_media_info(&tag).streams[0].rotation, Some(180.0));
    }

    #[test]
    fn reads_chapters() {
        let v = json(r#"{"chapters":[
          {"start_time":"0.000000","end_time":"90.000000","tags":{"title":"オープニング"}},
          {"start_time":"90.000000","end_time":"1420.500000"}
        ]}"#);
        let chapters = parse_media_info(&v).chapters;
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].start_ms, 0);
        assert_eq!(chapters[0].end_ms, 90_000);
        assert_eq!(chapters[0].title.as_deref(), Some("オープニング"));
        assert_eq!(chapters[1].title, None);
    }

    #[test]
    fn reads_stream_duration_from_mkv_tag() {
        let v = json(r#"{"streams":[{"index":0,"codec_type":"video",
          "tags":{"DURATION":"00:23:40.500000000"}}]}"#);
        assert_eq!(parse_media_info(&v).streams[0].duration_ms, Some(1_420_500));
    }

    /// probe() を run_ffprobe + parse_probed に割ったときの回帰。
    /// 「先頭の映像 / 音声だけを見る」という従来の挙動を変えていないこと
    #[test]
    fn parse_probed_keeps_looking_at_first_streams_only() {
        let v = json(r#"{
          "streams": [
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
             "avg_frame_rate":"30000/1001"},
            {"codec_type":"video","codec_name":"mjpeg","width":320,"height":240,
             "avg_frame_rate":"1/1"},
            {"codec_type":"audio","codec_name":"aac"},
            {"codec_type":"audio","codec_name":"ac3"},
            {"codec_type":"subtitle","codec_name":"subrip"}
          ],
          "format": {"format_name":"mov,mp4,m4a","duration":"120.000000","bit_rate":"5000000"}
        }"#);
        let p = parse_probed(&v);
        assert_eq!(p.video_codec.as_deref(), Some("h264"));
        assert_eq!(p.audio_codec.as_deref(), Some("aac"));
        assert_eq!(p.width, Some(1920));
        assert_eq!(p.height, Some(1080));
        assert_eq!(p.duration_ms, Some(120_000));
        assert_eq!(p.bitrate, Some(5_000_000));
        assert_eq!(p.container.as_deref(), Some("mov,mp4,m4a"));
        assert!((p.fps.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn parse_fraction_guards_bad_input() {
        assert!((parse_fraction("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_fraction("25"), Some(25.0));
        // 尺ゼロの静止画などで 0/0 が来る
        assert_eq!(parse_fraction("0/0"), None);
        assert_eq!(parse_fraction(""), None);
    }
}
