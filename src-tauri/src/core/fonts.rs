//! システムにインストールされたフォントの一覧(v1.24)。
//!
//! 字幕の見た目設定でフォント名を選ばせるためだけに使う。
//! **失敗しても Result にしない** —— UI 側は `<input list>`(datalist)なので、
//! 一覧が空でも手入力でフォントを指定でき、機能そのものは成立する。
//! 「候補が出ない」以上の意味を持たない失敗にトーストを出したくない。

use std::sync::OnceLock;

static CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// フォントファミリ名の一覧(表示順)。プロセス中 1 回だけ列挙してキャッシュする。
/// 起動後にインストールしたフォントは次回起動から出る
pub fn list_families() -> Vec<String> {
    CACHE
        .get_or_init(|| clean_families(enumerate_raw()))
        .clone()
}

/// 列挙結果を UI に出せる形に整える(純関数。ここだけテストする)
fn clean_families(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in raw {
        let name = name.trim();
        // 先頭 @ は縦書き用のエイリアス(@MS ゴシック 等)。mpv では実質使えず一覧が倍に膨らむ
        if name.is_empty() || name.starts_with('@') {
            continue;
        }
        // EnumFontFamiliesEx は同じファミリを字体ごとに何度も呼ぶ
        if seen.insert(name.to_lowercase()) {
            out.push(name.to_string());
        }
    }
    out.sort_by_key(|s| s.to_lowercase());
    out
}

#[cfg(windows)]
fn enumerate_raw() -> Vec<String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn cb(
        lf: *const LOGFONTW,
        _tm: *const TEXTMETRICW,
        _kind: u32,
        lparam: LPARAM,
    ) -> i32 {
        // lparam は下の呼び出しで渡した Vec<String> への可変参照
        let out = unsafe { &mut *(lparam as *mut Vec<String>) };
        let face = unsafe { (*lf).lfFaceName };
        let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        out.push(String::from_utf16_lossy(&face[..len]));
        1 // 列挙を続ける
    }

    let hdc = unsafe { GetDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    // lfFaceName を空にすると「全ファミリを 1 つずつ」列挙される
    let lf = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        lfFaceName: [0; 32],
        ..unsafe { std::mem::zeroed() }
    };
    unsafe {
        EnumFontFamiliesExW(hdc, &lf, Some(cb), &mut out as *mut _ as LPARAM, 0);
        ReleaseDC(std::ptr::null_mut(), hdc);
    }
    out
}

#[cfg(not(windows))]
fn enumerate_raw() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::clean_families;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn drops_vertical_aliases_and_blanks() {
        assert_eq!(
            clean_families(v(&["Meiryo", "@Meiryo", "", "  ", "@MS ゴシック"])),
            v(&["Meiryo"])
        );
    }

    #[test]
    fn dedupes_ignoring_case() {
        // EnumFontFamiliesEx は同じファミリを字体ごとに何度も返す
        assert_eq!(
            clean_families(v(&["Arial", "arial", "ARIAL"])),
            v(&["Arial"])
        );
    }

    #[test]
    fn sorts_case_insensitively() {
        assert_eq!(
            clean_families(v(&["consolas", "Arial", "Verdana"])),
            v(&["Arial", "consolas", "Verdana"])
        );
    }

    #[test]
    fn keeps_japanese_names() {
        let out = clean_families(v(&["メイリオ", "  游ゴシック  ", "MS Pゴシック"]));
        assert!(out.contains(&"メイリオ".to_string()));
        assert!(out.contains(&"游ゴシック".to_string()));
        assert!(out.contains(&"MS Pゴシック".to_string()));
    }
}
