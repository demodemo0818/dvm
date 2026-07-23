use std::collections::HashMap;
use std::path::Path;

/// パスのルート("C:\" や "\\server\share")を返す
pub fn root_of(path: &str) -> String {
    let p = path.replace('/', "\\");
    if let Some(stripped) = p.strip_prefix("\\\\") {
        let mut parts = stripped.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        format!("\\\\{server}\\{share}")
    } else if p.len() >= 2 && p.as_bytes()[1] == b':' {
        format!("{}\\", &p[..2])
    } else {
        p
    }
}

/// ルート到達性の判定結果をまとめてキャッシュする(1 回の処理単位で使い捨て)
#[derive(Default)]
pub struct RootCache {
    cache: HashMap<String, bool>,
}

impl RootCache {
    pub fn is_online(&mut self, path: &str) -> bool {
        let root = root_of(path);
        *self
            .cache
            .entry(root.clone())
            .or_insert_with(|| Path::new(&root).exists())
    }
}
