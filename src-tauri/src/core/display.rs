//! ディスプレイの HDR 状態(v1.31)。
//!
//! **mpv からは取れない**。`target-colorspace-hint` は「こちらが出した希望」で、
//! `target-params`(実際の出力)は同梱 libmpv では `property not found` になる
//! (実機で確認済み)。なので Windows に直接聞く。
//!
//! 使うのは **CCD API**(`QueryDisplayConfig` + `DisplayConfigGetDeviceInfo`)。
//! これは「設定 > ディスプレイ > HDR」のトグルそのものを読む。DXGI
//! (`IDXGIOutput6::GetDesc1`)でも取れるが、あちらは COM なので windows-sys
//! (生の FFI)だと手書きの vtable 呼び出しになる。こちらは素の C API で済む。
//!
//! **ウィンドウが乗っているモニタだけを見る**。「どれか 1 枚でも HDR なら真」に
//! すると、HDR のモニタと SDR のモニタを併用している人に嘘をつく

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        QDC_ONLY_ACTIVE_PATHS,
    };
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HWND};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    };

    /// `_bitfield` のビット割り当て(DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO)。
    /// bit0 = advancedColorSupported、**bit1 = advancedColorEnabled**
    const ADVANCED_COLOR_ENABLED: u32 = 1 << 1;

    /// `[u16; 32]` の NUL 終端ワイド文字列を String に(GDI のデバイス名用)
    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// このウィンドウが乗っているモニタの GDI デバイス名(`\\.\DISPLAY1` など)
    fn monitor_device_name(hwnd: HWND) -> Option<String> {
        unsafe {
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if hmon.is_null() {
                return None;
            }
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            // MONITORINFOEXW は MONITORINFO の後ろに名前が続くだけなのでキャストして渡す
            if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut MONITORINFO) == 0 {
                return None;
            }
            Some(wide_to_string(&info.szDevice))
        }
    }

    /// 有効なパスを列挙する。モードは使わないが、API が両方要求するので受ける
    fn active_paths() -> Option<Vec<DISPLAYCONFIG_PATH_INFO>> {
        unsafe {
            let mut n_paths = 0u32;
            let mut n_modes = 0u32;
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes)
                != ERROR_SUCCESS
            {
                return None;
            }
            let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![std::mem::zeroed(); n_paths as usize];
            let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![std::mem::zeroed(); n_modes as usize];
            if QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut n_paths,
                paths.as_mut_ptr(),
                &mut n_modes,
                modes.as_mut_ptr(),
                std::ptr::null_mut(),
            ) != ERROR_SUCCESS
            {
                return None;
            }
            paths.truncate(n_paths as usize);
            Some(paths)
        }
    }

    /// パスの source 側に対応する GDI デバイス名
    fn source_device_name(path: &DISPLAYCONFIG_PATH_INFO) -> Option<String> {
        unsafe {
            let mut req: DISPLAYCONFIG_SOURCE_DEVICE_NAME = std::mem::zeroed();
            req.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut req.header) != 0 {
                return None;
            }
            Some(wide_to_string(&req.viewGdiDeviceName))
        }
    }

    /// パスの target 側(実際のモニタ)で HDR がオンになっているか
    fn target_hdr_enabled(path: &DISPLAYCONFIG_PATH_INFO) -> bool {
        unsafe {
            let mut req: DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO = std::mem::zeroed();
            req.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                size: std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut req.header) != 0 {
                return false;
            }
            req.Anonymous.Anonymous._bitfield & ADVANCED_COLOR_ENABLED != 0
        }
    }

    /// このウィンドウが乗っているモニタで HDR がオンか。
    /// **取れなかったときは false**(「分からない」を「HDR で出ている」に倒さない)
    pub fn hdr_enabled_for_window(hwnd: isize) -> bool {
        let Some(target) = monitor_device_name(hwnd as HWND) else {
            return false;
        };
        let Some(paths) = active_paths() else {
            return false;
        };
        paths
            .iter()
            .filter(|p| source_device_name(p).as_deref() == Some(target.as_str()))
            .any(target_hdr_enabled)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn hdr_enabled_for_window(_hwnd: isize) -> bool {
        false
    }
}

pub use imp::hdr_enabled_for_window;
