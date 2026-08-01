use crate::core::ffmpeg::{command, FfmpegPaths};
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// ファイル名に残す動画名の最大文字数。
/// 日本語のファイル名は長くなりがちで、保存先が深い階層だと MAX_PATH(260)に触れる。
/// うしろにタイムコード(13 文字)・衝突時の連番・拡張子が付くぶんの余裕も見てこの長さ。
/// Rust の `std::fs` は `\\?\` を前置しないので MAX_PATH がそのまま効く
const STEM_MAX_CHARS: usize = 80;

/// Windows のファイル名に使えない文字
const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 連番を何番まで試すか(これを超えるのは実質的に無限ループなので諦める)
const MAX_SEQ: u32 = 999;

/// ffmpeg に渡す引数列を組み立てる(v1.26)。
///
/// **実行できないぶんテストで列そのものを固定する**ための純関数。
/// サムネイル生成(`thumbs::run_ffmpeg`)とは狙いが違うので、引数もそれぞれ意味がある:
///
/// - **`-ss` は `-i` より前**(入力シーク)。ffmpeg は入力シークでも accurate_seek が既定 ON で、
///   直前のキーフレームから目的の時刻までデコードしてから出すので位置はずれない。
///   `-i` の後ろに置くと先頭から全部デコードするので、長い動画の後半が実用的な速度で撮れない
/// - **`-map 0:V:0`** の大文字 `V` は「`attached_pic` ではない映像ストリーム」。
///   このライブラリの動画はほとんどが埋め込みカバーを持つ(DESIGN.md「埋め込みカバー画像を使う」)。
///   実測では **`-map` を省いても ffmpeg は本編を選んだ**(カバーの方が高解像度でも、
///   カバーが先頭でも)が、既定のストリーム選択は「最高解像度」としか約束されていないので、
///   本編が欲しいことを明示しておく
/// - **`-vf` を付けない**。ユーザーが持ち出す画像なので原寸のまま出す
/// - **`-q:v` を付けない**。あれは MJPEG 用の指定で、PNG では無視される(警告も出ないので紛らわしい)
/// - **`-pix_fmt rgb24`(8 bit)に揃える**。付けないと 10bit ソース(このライブラリの 4K は
///   `yuv420p10le`)が **16bit PNG** になり、実測で 1 枚 **19MB**・保存 4.4 秒まで膨らんだ。
///   8bit なら **3.5MB・3.0 秒**。PNG の圧縮は可逆のままなので「JPEG のように劣化しない」性質は
///   保たれるし、階調も画面で見ているものと同じ。メモ・共有・素材という用途に 16bit は過大
pub fn frame_args(video_path: &str, at_ms: i64, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-nostdin".into()];
    let sec = (at_ms.max(0) as f64) / 1000.0;
    if sec > 0.0 {
        args.push("-ss".into());
        args.push(format!("{sec:.3}"));
    }
    args.push("-i".into());
    args.push(video_path.into());
    args.push("-map".into());
    args.push("0:V:0".into());
    args.push("-pix_fmt".into());
    args.push("rgb24".into());
    args.push("-frames:v".into());
    args.push("1".into());
    args.push("-y".into());
    args.push(out.to_string_lossy().into_owned());
    args
}

/// 指定位置のコマを **原寸の PNG** で書き出す(v1.26)。
///
/// **失敗しても先頭フレームで再試行しない**。`thumbs::generate` はサムネイルを空にしないための
/// 保険としてそうしているが、こちらでやると「指定したのと違うコマが黙って保存される」ことになる
pub fn save_frame(ff: &FfmpegPaths, video_path: &str, at_ms: i64, out: &Path) -> Result<()> {
    let output = command(&ff.ffmpeg)
        .args(frame_args(video_path, at_ms, out))
        .output()
        .map_err(|e| anyhow!("ffmpeg を起動できませんでした: {e}"))?;

    // 尺を超えた位置を指定すると 0 フレーム出力で正常終了することがあるので、
    // 終了コードだけでなく中身のあるファイルができたかどうかまで見る
    let written = out.metadata().map(|m| m.len() > 0).unwrap_or(false);
    if output.status.success() && written {
        return Ok(());
    }

    // stderr は `-v error` で絞ってあるので、出ていればそれが原因そのもの。
    // このメッセージはトーストでユーザーの目に入る(api.ts の call() が出す)
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    let _ = std::fs::remove_file(out); // 0 バイトのファイルを残さない
    Err(if detail.is_empty() {
        anyhow!("コマを取り出せませんでした(再生位置が動画の終わりを超えているかもしれません)")
    } else {
        anyhow!("コマを取り出せませんでした: {}", tail(detail, 200))
    })
}

/// 長い stderr の末尾だけを残す(原因は最後の行に出ることが多い)
fn tail(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().skip(count - max_chars).collect()
}

/// 保存するファイル名(拡張子なし)を組み立てる。
/// `マンダロリアン S02E03.mp4` の 12 分 34.567 秒 → `マンダロリアン S02E03_00-12-34.567`
///
/// 動画のファイル名をそのまま使うので、Windows で作れない名前にならないよう均す。
/// **予約名(CON / PRN / AUX ...)の対策は要らない** — うしろに必ずタイムコードが付くので、
/// `CON.mp4` からできるのは `CON_00-00-00.000` であって `CON` にはならない。
/// タイムコードを外す設定を将来足すなら、そのときは予約名を考えること
pub fn frame_file_stem(video_filename: &str, at_ms: i64) -> String {
    let base = Path::new(video_filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // 均す → 切り詰める → もう一度末尾を落とす(切った位置に空白やドットが来ることがある)
    let base = trim_tail(&truncate_chars(&sanitize(&base), STEM_MAX_CHARS));
    let base = if base.is_empty() { "frame".to_string() } else { base };
    format!("{base}_{}", timecode(at_ms))
}

/// `HH-MM-SS.mmm`。コロンは Windows で使えないのでハイフンにする。
/// ゼロ埋めするのは、保存先フォルダを名前順に並べたとき再生位置の順に並ぶようにするため
fn timecode(at_ms: i64) -> String {
    let ms = at_ms.max(0);
    format!(
        "{:02}-{:02}-{:02}.{:03}",
        ms / 3_600_000,
        (ms % 3_600_000) / 60_000,
        (ms % 60_000) / 1000,
        ms % 1000,
    )
}

fn sanitize(name: &str) -> String {
    trim_tail(
        &name
            .chars()
            .map(|c| {
                if FORBIDDEN.contains(&c) || (c as u32) < 0x20 {
                    '_'
                } else {
                    c
                }
            })
            .collect::<String>(),
    )
}

/// Windows は末尾がドットや空白のファイル名を扱えない(作れても開けなくなる)
fn trim_tail(s: &str) -> String {
    s.trim_end_matches(['.', ' ']).to_string()
}

/// **文字境界で切る**。バイト境界で切ると日本語が壊れる
fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// 空いているパスを返す。埋まっていれば ` (2)`, ` (3)` … を付ける。
///
/// **上書きしないことがこの機能の要点**。一時停止中に 2 回撮ったときと、
/// 別のフォルダにある同名の動画から撮ったときの両方がここに来る
/// (動画 id は名前に入れない —— 内部の id をユーザーに見えるファイル名へ漏らさないため)
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf> {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..=MAX_SEQ {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(anyhow!("同じ名前の画像が多すぎます: {stem}"))
}

/// 既定の保存先(v1.26)。「ピクチャ\DVM」。
///
/// **ピクチャ直下には置かない** — 連射する機能なので、ユーザーのピクチャに PNG を撒かず
/// サブフォルダにまとめる。ピクチャが取れない環境(リダイレクト先が壊れている等)は
/// アプリのデータフォルダに逃がす —— 保存先が無いせいで機能ごと使えなくなるより、
/// どこかに残るほうがよい。
///
/// **AppHandle をここに持ち込まない**(CLAUDE.md アーキテクチャ原則 1)。
/// ピクチャの場所を解決するのは呼び出し側(`lib.rs` の setup)の仕事
pub fn default_dir(picture_dir: Option<&Path>, data_dir: &Path) -> PathBuf {
    match picture_dir {
        Some(p) => p.join("DVM"),
        None => data_dir.join("frames"),
    }
}

/// 設定 `frame_save_dir` が空なら既定(`AppState.frames_dir`)を使う。
/// 空白だけの設定も「未設定」として扱う(`player_path` と同じ作法)
pub fn resolve_dir(configured: Option<&str>, default_dir: &Path) -> PathBuf {
    if let Some(c) = configured {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    default_dir.to_path_buf()
}

/// 保存の直前にフォルダを用意する。**起動時ではなくここで作る** —
/// 保存先は外付け HDD / NAS にも設定できるので、未接続で起動が失敗してはいけない。
///
/// 未接続と書き込み不可はメッセージを分ける(DESIGN.md「オフラインドライブの扱い」。
/// ドライブを繋げば直る話を「書き込めません」と言わない)
pub fn prepare_dir(dir: &Path) -> Result<()> {
    let root = crate::core::offline::root_of(&dir.to_string_lossy());
    if !Path::new(&root).exists() {
        return Err(anyhow!("保存先のドライブに接続できません: {root}"));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| anyhow!("保存先フォルダを作れません: {}({e})", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 引数列を固定する() {
        let out = Path::new(r"C:\shots\a.png");
        assert_eq!(
            frame_args(r"Q:\video\a.mp4", 754_567, out),
            vec![
                "-v", "error", "-nostdin",
                "-ss", "754.567",
                "-i", r"Q:\video\a.mp4",
                // 大文字 V(attached_pic を除く映像ストリーム)。小文字にすると
                // 埋め込みカバーを掴みうるので、ここは取り違えてはいけない
                "-map", "0:V:0",
                // 外すと 10bit ソースが 16bit PNG(1 枚 19MB)になる
                "-pix_fmt", "rgb24",
                "-frames:v", "1",
                "-y", r"C:\shots\a.png",
            ]
        );
    }

    #[test]
    fn 先頭を指定したときは_ss_を付けない() {
        let args = frame_args("a.mp4", 0, Path::new("out.png"));
        assert!(!args.contains(&"-ss".to_string()));
        // 縮小も品質指定もしない(原寸・無劣化)
        assert!(!args.contains(&"-vf".to_string()));
        assert!(!args.contains(&"-q:v".to_string()));
        // キーフレーム丸めになるので絶対に付けない
        assert!(!args.contains(&"-noaccurate_seek".to_string()));
    }

    #[test]
    fn 時刻はゼロ埋めして桁を揃える() {
        assert_eq!(timecode(0), "00-00-00.000");
        assert_eq!(timecode(754_567), "00-12-34.567");
        assert_eq!(timecode(3_723_456), "01-02-03.456");
        // 負の値(念のため)は 0 に丸める
        assert_eq!(timecode(-5), "00-00-00.000");
    }

    #[test]
    fn 日本語のファイル名はそのまま残す() {
        assert_eq!(
            frame_file_stem("マンダロリアン S02E03.mp4", 754_567),
            "マンダロリアン S02E03_00-12-34.567"
        );
    }

    #[test]
    fn 使えない文字はアンダースコアにする() {
        // パスを渡してもファイル名部分だけを見る(区切りは file_stem が落とす)
        assert_eq!(
            frame_file_stem(r"C:\video\a:b*c?d.mkv", 0),
            "a_b_c_d_00-00-00.000"
        );
        assert_eq!(frame_file_stem("a<b>c|d\"e.mp4", 0), "a_b_c_d_e_00-00-00.000");
    }

    #[test]
    fn 末尾のドットと空白は落とす() {
        assert_eq!(frame_file_stem("なまえ...mp4", 0), "なまえ_00-00-00.000");
        assert_eq!(frame_file_stem("なまえ .mp4", 0), "なまえ_00-00-00.000");
    }

    #[test]
    fn 長い名前は文字境界で切り詰める() {
        let long = "あ".repeat(300);
        let stem = frame_file_stem(&format!("{long}.mp4"), 0);
        // 全角だけの名前なので、バイト境界で切っていればここに来る前に panic する
        let head: String = stem.chars().take_while(|c| *c == 'あ').collect();
        assert_eq!(head.chars().count(), STEM_MAX_CHARS);
        assert!(stem.ends_with("_00-00-00.000"));
    }

    #[test]
    fn 名前が空になっても拡張子だけのファイル名にしない() {
        assert_eq!(frame_file_stem("...", 0), "frame_00-00-00.000");
        assert_eq!(frame_file_stem("", 0), "frame_00-00-00.000");
    }

    #[test]
    fn 予約デバイス名にはならない() {
        // タイムコードが必ず付くので CON / NUL などと一致しない
        for name in ["CON.mp4", "NUL.mkv", "COM1.avi", "aux.mp4"] {
            let stem = frame_file_stem(name, 0);
            assert!(stem.contains('_'), "{stem}");
            assert!(stem.len() > 4, "{stem}");
        }
    }

    #[test]
    fn 既定の保存先はピクチャの下() {
        let pics = PathBuf::from(r"C:\Users\me\Pictures");
        let data = PathBuf::from(r"C:\data");
        assert_eq!(default_dir(Some(&pics), &data), pics.join("DVM"));
        // ピクチャが取れない環境ではデータフォルダに逃がす
        assert_eq!(default_dir(None, &data), data.join("frames"));
    }

    #[test]
    fn 保存先は設定を優先する() {
        let default = PathBuf::from(r"C:\Users\me\Pictures\DVM");
        assert_eq!(
            resolve_dir(Some(r"D:\shots"), &default),
            PathBuf::from(r"D:\shots")
        );
        // 空文字・空白だけの設定は「未設定」として扱う
        assert_eq!(resolve_dir(Some("   "), &default), default);
        assert_eq!(resolve_dir(Some(""), &default), default);
        assert_eq!(resolve_dir(None, &default), default);
    }

    #[test]
    fn 未接続のドライブは書き込み不可と区別する() {
        // 空いているドライブレターを実際に探す(環境によって割り当てが違うため決め打ちしない)
        let free = ('D'..='Z').rev().find(|d| !Path::new(&format!("{d}:\\")).exists());
        let Some(d) = free else { return }; // 全部埋まっている環境では確かめようがない
        let err = prepare_dir(Path::new(&format!(r"{d}:\dvm-frames-test")))
            .unwrap_err()
            .to_string();
        // 「繋げば直る話」だと分かる文言になっていること
        assert!(err.contains("接続できません"), "{err}");
    }

    #[test]
    fn 埋まっていたら連番を付ける() {
        let dir = std::env::temp_dir().join(format!("dvm-frames-test-{}", std::process::id()));
        // 前回の残骸があると結果が変わるので必ず空から始める
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let first = unique_path(&dir, "shot", "png").unwrap();
        assert_eq!(first, dir.join("shot.png"));

        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "shot", "png").unwrap();
        assert_eq!(second, dir.join("shot (2).png"));

        std::fs::write(&second, b"x").unwrap();
        assert_eq!(
            unique_path(&dir, "shot", "png").unwrap(),
            dir.join("shot (3).png")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
