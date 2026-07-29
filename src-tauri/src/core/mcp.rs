//! MCP サーバー(dvm-mcp.exe)の場所を解決する。
//!
//! 設定画面が「外部 AI クライアントに貼り付ける設定」を組み立てるために使う。
//! バイナリは配布物に同梱される(tauri.conf.json の bundle.resources)が、
//! 開発中やビルド前は存在しないこともあるので Option で返す。

use std::path::{Path, PathBuf};

#[cfg(windows)]
const EXE: &str = "dvm-mcp.exe";
#[cfg(not(windows))]
const EXE: &str = "dvm-mcp";

/// 探索順: exe と同じ場所の binaries/(配布時)→ exe と同じ場所(cargo の出力先。
/// dev 実行だと dvm.exe と dvm-mcp.exe が並ぶ)→ src-tauri/binaries/(手元でビルドした場合)
pub fn server_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("binaries").join(EXE));
            candidates.push(dir.join(EXE));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(EXE));
    candidates.into_iter().find(|p| p.is_file())
}
