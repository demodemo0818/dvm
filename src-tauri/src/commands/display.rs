use crate::core::display;

/// ウィンドウが乗っているモニタで Windows の HDR がオンか(v1.31)。
///
/// HDR バッジの色をこれで決める。**mpv の設定値では決められない** ——
/// `target-colorspace-hint=auto` は「HDR モードのディスプレイなら HDR で出す」
/// なので、設定がオンでもここが false なら実際は SDR に変換されている。
///
/// DB も AppState も触らない。取れなければ false(「分からない」を
/// 「HDR で出ている」に倒さない)
#[tauri::command]
pub fn is_hdr_display(window: tauri::Window) -> bool {
    // hwnd() は Windows 以外や生成前に失敗しうる。その場合は SDR 扱い
    match window.hwnd() {
        Ok(h) => display::hdr_enabled_for_window(h.0 as isize),
        Err(_) => false,
    }
}
