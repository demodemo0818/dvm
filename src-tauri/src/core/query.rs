use serde::Deserialize;

/// UI と将来の AI(MCP)が共有する構造化検索クエリ
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoQuery {
    pub text: Option<String>,
    pub sort: Option<String>,
    pub folder_id: Option<i64>,
}

impl VideoQuery {
    /// WHERE 句と LIKE パラメータを返す
    pub fn where_clause(&self) -> (String, Option<String>) {
        let mut conds: Vec<String> = Vec::new();
        let mut like: Option<String> = None;

        if let Some(text) = self.text.as_deref() {
            let t = text.trim();
            if !t.is_empty() {
                let escaped = t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                like = Some(format!("%{escaped}%"));
                conds.push("(filename LIKE ?1 ESCAPE '\\' OR COALESCE(title,'') LIKE ?1 ESCAPE '\\')".into());
            }
        }
        if let Some(fid) = self.folder_id {
            conds.push(format!("watched_folder_id = {fid}"));
        }

        let sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        (sql, like)
    }

    /// ORDER BY 句(ホワイトリスト方式。任意文字列を SQL に混ぜない)
    pub fn order_clause(&self) -> &'static str {
        match self.sort.as_deref() {
            Some("name_asc") => "ORDER BY filename COLLATE NOCASE ASC",
            Some("name_desc") => "ORDER BY filename COLLATE NOCASE DESC",
            Some("size_asc") => "ORDER BY size ASC",
            Some("size_desc") => "ORDER BY size DESC",
            Some("duration_asc") => "ORDER BY duration_ms ASC NULLS FIRST",
            Some("duration_desc") => "ORDER BY duration_ms DESC NULLS LAST",
            Some("added_asc") => "ORDER BY added_at ASC, id ASC",
            _ => "ORDER BY added_at DESC, id DESC",
        }
    }
}
