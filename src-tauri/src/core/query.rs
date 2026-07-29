use crate::core::offline::RootCache;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// ランダムソートの剰余に使う素数
const SHUFFLE_MOD: i64 = 1_000_003;
/// id を散らすための乗数(Knuth の 2^32 黄金比)
const SHUFFLE_MIX: i64 = 2_654_435_761;

/// UI と AI(MCP)が共有する構造化検索クエリ
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoQuery {
    /// 空白区切りで AND 検索する(全角スペースも区切りとして扱う)
    pub text: Option<String>,
    pub sort: Option<String>,
    pub folder_id: Option<i64>,
    /// 指定タグすべてが付いている動画に絞る(AND 条件)
    pub tag_ids: Option<Vec<i64>>,
    /// シリーズで絞る
    pub series_id: Option<i64>,
    /// true: missing のみ / false: missing 以外
    pub missing: Option<bool>,
    /// このレーティング以上に絞る(1〜5。0 / None は無条件)
    pub min_rating: Option<i64>,
    /// 尺の下限・上限(ミリ秒)。範囲指定時、duration_ms が NULL(プローブ未了・失敗)の動画は含まれない
    pub min_duration_ms: Option<i64>,
    pub max_duration_ms: Option<i64>,

    // --- v1.7 で追加した条件(すべて未指定なら従来と同じ SQL になること) ---
    /// text の検索対象にフルパスも含める
    pub search_path: Option<bool>,
    /// タグが 1 つも付いていない動画だけ
    pub untagged: Option<bool>,
    /// 一度も再生していない動画だけ
    pub unwatched: Option<bool>,
    /// 解像度の下限(ピクセル)。未取得の動画は含まれない
    pub min_width: Option<i64>,
    pub min_height: Option<i64>,
    /// 映像コーデックで絞る(小文字で比較。複数指定は OR)
    pub video_codecs: Option<Vec<String>>,
    /// ライブラリ追加日の範囲(YYYY-MM-DD。両端を含む)
    pub added_after: Option<String>,
    pub added_before: Option<String>,
    /// size + partial_hash が一致する仲間がいる動画だけ(重複検出)
    pub duplicates_only: Option<bool>,
    /// tag_ids に子孫タグも含めるか(未指定 = 含める)
    pub include_child_tags: Option<bool>,
    /// sort = "random" のときのシャッフル種。同じ種なら順序が変わらない(ページングのため必須)
    pub random_seed: Option<i64>,

    // --- v1.10 で追加した条件 ---
    /// このフォルダ**直下**にある動画だけ(サブフォルダは含まない)。
    /// Windows のパスは大文字小文字を区別せず、'/' と '\' の揺れも吸収する。
    /// folder_id(監視フォルダ配下すべて)とは別物で、併用もできる
    pub dir_path: Option<String>,
}

/// 一覧表示用の 1 行(UI・MCP 共通)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRow {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub title: Option<String>,
    pub size: i64,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub rating: i64,
    pub view_count: i64,
    pub last_viewed_at: Option<String>,
    /// アプリ内再生のレジューム位置(0 = 位置なし)
    pub resume_ms: i64,
    /// 再生方式(native/remux/transcode)の判定に使う(ffprobe 由来)
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub is_missing: bool,
    pub is_offline: bool,
    pub thumb_state: i64,
    pub thumb_path: Option<String>,
    pub added_at: String,
    // --- v1.16 でリストの列にするために足した(いずれも既存の DB 列) ---
    /// ファイルの作成時刻。**登録時に一度だけ**入り、以後更新されない。
    /// Windows ではコピーやダウンロードでリセットされるので「動画が作られた日」ではない
    pub file_created_at: Option<String>,
    /// ファイルの最終更新時刻(再スキャンで追従する)
    pub file_modified_at: Option<String>,
    pub fps: Option<f64>,
    pub bitrate: Option<i64>,
}

/// LIKE のワイルドカードを打ち消す(日本語の部分一致はこれで正しく動く)
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

impl VideoQuery {
    /// WHERE 句と、その中の ?1..?N に順番で対応するバインド値を返す
    pub fn where_clause(&self) -> (String, Vec<String>) {
        let mut conds: Vec<String> = Vec::new();
        let mut params: Vec<String> = Vec::new();

        if let Some(text) = self.text.as_deref() {
            // 空白区切りで AND(「日本語 テスト」で両方を含むものだけ)。
            // split_whitespace は全角スペース(U+3000)も区切りとして扱う
            for term in text.split_whitespace() {
                params.push(format!("%{}%", escape_like(term)));
                let n = params.len();
                let mut ors = vec![
                    format!("filename LIKE ?{n} ESCAPE '\\'"),
                    format!("COALESCE(title,'') LIKE ?{n} ESCAPE '\\'"),
                ];
                if self.search_path == Some(true) {
                    ors.push(format!("path LIKE ?{n} ESCAPE '\\'"));
                }
                conds.push(format!("({})", ors.join(" OR ")));
            }
        }
        if let Some(fid) = self.folder_id {
            conds.push(format!("watched_folder_id = {fid}"));
        }
        if let Some(dir) = self.dir_path.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            // 末尾に区切りを 1 つ付けて「このフォルダの中」を表す。
            // LIKE は使わない(パス中の % や _ をエスケープする必要が出るため。core/volumes.rs と同じ方針)。
            // 大文字小文字は SQLite の lower() に合わせて **ASCII のみ**畳む
            // (SQLite の lower は ICU 無しだと ASCII しか変換しない。to_lowercase() だと非 ASCII で食い違う)
            let prefix = format!(
                "{}\\",
                dir.trim_end_matches(['\\', '/']).to_ascii_lowercase().replace('/', "\\")
            );
            let n = prefix.chars().count();
            params.push(prefix);
            let k = params.len();
            // 前半 = そのフォルダで始まる / 後半 = 残りに区切りが無い(= 直下のファイル)
            conds.push(format!(
                "(lower(replace(substr(path, 1, {n}), '/', '\\')) = ?{k}
                  AND instr(replace(substr(path, {n} + 1), '/', '\\'), '\\') = 0)"
            ));
        }
        if let Some(tag_ids) = &self.tag_ids {
            // i64 なので直接埋め込んでも安全。タグごとに IN 条件を重ねて AND にする
            let with_children = self.include_child_tags != Some(false);
            for tid in tag_ids {
                let tag_set = if with_children {
                    // 親タグを選んだら子孫タグが付いた動画も出す
                    format!(
                        "(WITH RECURSIVE sub(id) AS (
                            SELECT {tid} UNION SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id
                          ) SELECT id FROM sub)"
                    )
                } else {
                    format!("({tid})")
                };
                conds.push(format!(
                    "id IN (SELECT video_id FROM video_tags WHERE tag_id IN {tag_set})"
                ));
            }
        }
        if let Some(sid) = self.series_id {
            conds.push(format!(
                "id IN (SELECT video_id FROM series_entries WHERE series_id = {sid})"
            ));
        }
        if let Some(missing) = self.missing {
            conds.push(format!("is_missing = {}", if missing { 1 } else { 0 }));
        }
        if let Some(r) = self.min_rating {
            let r = r.clamp(0, 5);
            if r > 0 {
                conds.push(format!("rating >= {r}"));
            }
        }
        if let Some(ms) = self.min_duration_ms {
            conds.push(format!("duration_ms >= {}", ms.max(0)));
        }
        if let Some(ms) = self.max_duration_ms {
            conds.push(format!("duration_ms <= {}", ms.max(0)));
        }
        if self.untagged == Some(true) {
            conds.push("id NOT IN (SELECT video_id FROM video_tags)".into());
        }
        if self.unwatched == Some(true) {
            conds.push("view_count = 0".into());
        }
        if let Some(w) = self.min_width {
            conds.push(format!("width >= {}", w.max(0)));
        }
        if let Some(h) = self.min_height {
            conds.push(format!("height >= {}", h.max(0)));
        }
        if let Some(codecs) = &self.video_codecs {
            let mut placeholders: Vec<String> = Vec::new();
            for c in codecs.iter().filter(|c| !c.trim().is_empty()) {
                params.push(c.trim().to_lowercase());
                placeholders.push(format!("?{}", params.len()));
            }
            if !placeholders.is_empty() {
                conds.push(format!(
                    "LOWER(COALESCE(video_codec,'')) IN ({})",
                    placeholders.join(", ")
                ));
            }
        }
        // added_at は "YYYY-MM-DD HH:MM:SS" なので date() で日付だけ取り出して比較する
        if let Some(d) = self.added_after.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            params.push(d.to_string());
            conds.push(format!("date(added_at) >= ?{}", params.len()));
        }
        if let Some(d) = self.added_before.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            params.push(d.to_string());
            conds.push(format!("date(added_at) <= ?{}", params.len()));
        }
        if self.duplicates_only == Some(true) {
            // 同じ size + partial_hash を持つ仲間が 2 件以上いるものだけ。
            // partial_hash 未算出(NULL)は「不明」であって重複ではないので除く
            conds.push(
                "(partial_hash IS NOT NULL AND (size, partial_hash) IN (
                    SELECT size, partial_hash FROM videos WHERE partial_hash IS NOT NULL
                    GROUP BY size, partial_hash HAVING COUNT(*) > 1))"
                    .into(),
            );
        }

        let sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };
        (sql, params)
    }

    /// ORDER BY 句(ホワイトリスト方式。任意文字列を SQL に混ぜない)
    pub fn order_clause(&self) -> String {
        if self.sort.as_deref() == Some("series_asc") {
            if let Some(sid) = self.series_id {
                return format!(
                    "ORDER BY (SELECT se.position FROM series_entries se
                               WHERE se.video_id = videos.id AND se.series_id = {sid}), id"
                );
            }
        }
        if self.sort.as_deref() == Some("random") {
            // RANDOM() はページごとに順序が変わってページングと両立しないので、
            // id と種から決定的に並べる。種を変えるとシャッフルし直せる
            let seed = self.random_seed.unwrap_or(1).rem_euclid(SHUFFLE_MOD).max(1);
            // 掛け算と剰余だけだと id に対して線形なままで、件数が少ないと id 順が崩れない。
            // 一度散らした t を t*(t+種) と二乗混ぜして非線形にする。
            // t < 100 万なので積は 2×10^12 程度に収まり、i64 のまま(浮動小数に落ちない)
            let t = format!("((id * {SHUFFLE_MIX}) % {SHUFFLE_MOD})");
            return format!("ORDER BY ({t} * ({t} + {seed})) % {SHUFFLE_MOD}, id");
        }
        // 列ヘッダのソート(v1.16)。規則は 2 つ:
        //   * NULL は昇順・降順どちらでも**常に末尾**。SQLite は ASC の既定が NULLS FIRST なので、
        //     昇順側には必ず NULLS LAST を書く(書き忘れると未視聴や尺未取得が先頭を埋める)
        //   * すべて `, id` で終わる。同値の行が複数あるとき、これが無いとページを
        //     またいだ順序が安定せず、仮想化した一覧で行が入れ替わって見える
        let expr: &str = match self.sort.as_deref() {
            Some("name_asc") => "filename COLLATE NOCASE ASC",
            Some("name_desc") => "filename COLLATE NOCASE DESC",
            Some("size_asc") => "size ASC",
            Some("size_desc") => "size DESC",
            Some("duration_asc") => "duration_ms ASC NULLS LAST",
            Some("duration_desc") => "duration_ms DESC NULLS LAST",
            Some("added_asc") => "added_at ASC",
            Some("added_desc") => "added_at DESC",
            Some("rating_asc") => "rating ASC",
            Some("rating_desc") => "rating DESC, added_at DESC",
            Some("viewed_asc") => "last_viewed_at ASC NULLS LAST",
            Some("viewed_desc") => "last_viewed_at DESC NULLS LAST",
            Some("views_asc") => "view_count ASC",
            Some("views_desc") => "view_count DESC",
            // 解像度は縦横どちらかだけでは比べられないので画素数で並べる
            Some("res_asc") => "(width * height) ASC NULLS LAST",
            Some("res_desc") => "(width * height) DESC NULLS LAST",
            Some("ext_asc") => return format!("ORDER BY {} ASC, id ASC", ext_expr()),
            Some("ext_desc") => return format!("ORDER BY {} DESC, id DESC", ext_expr()),
            Some("codec_asc") => "video_codec COLLATE NOCASE ASC NULLS LAST",
            Some("codec_desc") => "video_codec COLLATE NOCASE DESC NULLS LAST",
            Some("acodec_asc") => "audio_codec COLLATE NOCASE ASC NULLS LAST",
            Some("acodec_desc") => "audio_codec COLLATE NOCASE DESC NULLS LAST",
            // フルパスで並べるとフォルダごとにまとまり、中はファイル名順になる
            Some("folder_asc") => "path COLLATE NOCASE ASC",
            Some("folder_desc") => "path COLLATE NOCASE DESC",
            Some("fmodified_asc") => "file_modified_at ASC NULLS LAST",
            Some("fmodified_desc") => "file_modified_at DESC NULLS LAST",
            Some("fcreated_asc") => "file_created_at ASC NULLS LAST",
            Some("fcreated_desc") => "file_created_at DESC NULLS LAST",
            Some("fps_asc") => "fps ASC NULLS LAST",
            Some("fps_desc") => "fps DESC NULLS LAST",
            Some("bitrate_asc") => "bitrate ASC NULLS LAST",
            Some("bitrate_desc") => "bitrate DESC NULLS LAST",
            // 重複の並び: 同じファイルが隣り合うように
            Some("dup") => return "ORDER BY size, partial_hash, id".to_string(),
            _ => "added_at DESC",
        };
        // 降順の並びは id も降順にしておくと、同値の塊の中も見た目の向きが揃う。
        // 向きはキー名の接尾辞で決める(未指定・未知のキーは既定の added_desc なので降順)
        let tie = match self.sort.as_deref() {
            Some(s) if s.ends_with("_asc") => "id ASC",
            _ => "id DESC",
        };
        format!("ORDER BY {expr}, {tie}")
    }
}

/// ファイル名から拡張子を取り出す SQL 式(小文字)。
///
/// SQLite に「右から探す」関数が無いので既知のイディオムを使う。
/// `rtrim(filename, <ドットを除いた文字集合>)` が最後のドットまでの前置部分を残すので、
/// それを空に置換すると拡張子だけが残る("a.b.mp4" → "mp4")。
/// ドットが無いと前置部分が空文字になり、SQLite の replace は空文字を探すと
/// 元の文字列をそのまま返すため、名前が丸ごと拡張子として出てしまう。instr でガードする
fn ext_expr() -> &'static str {
    "CASE WHEN instr(filename, '.') = 0 THEN ''
          ELSE lower(replace(filename, rtrim(filename, replace(filename, '.', '')), ''))
     END"
}

pub fn count(conn: &Connection, query: &VideoQuery) -> Result<i64> {
    let (where_sql, params) = query.where_clause();
    let sql = format!("SELECT COUNT(*) FROM videos {where_sql}");
    let count = conn.query_row(&sql, rusqlite::params_from_iter(params), |r| r.get(0))?;
    Ok(count)
}

/// SELECT の列と `map_row` の添字はここで 1 対 1 に対応する。片方だけ触らないこと
const SELECT_COLUMNS: &str = "id, path, filename, title, size, duration_ms, width, height,
     rating, view_count, last_viewed_at, resume_ms, video_codec, audio_codec,
     is_missing, thumb_state, added_at, file_created_at, file_modified_at, fps, bitrate";

/// 1 行を VideoRow に写す。オフライン判定とサムネイルパスだけは
/// 行をまたぐ状態(RootCache)と設定が要るので、呼び出し側で後から埋める
fn map_row(r: &rusqlite::Row) -> rusqlite::Result<VideoRow> {
    Ok(VideoRow {
        id: r.get(0)?,
        path: r.get(1)?,
        filename: r.get(2)?,
        title: r.get(3)?,
        size: r.get(4)?,
        duration_ms: r.get(5)?,
        width: r.get(6)?,
        height: r.get(7)?,
        rating: r.get(8)?,
        view_count: r.get(9)?,
        last_viewed_at: r.get(10)?,
        resume_ms: r.get(11)?,
        video_codec: r.get(12)?,
        audio_codec: r.get(13)?,
        is_missing: r.get::<_, i64>(14)? != 0,
        thumb_state: r.get(15)?,
        added_at: r.get(16)?,
        file_created_at: r.get(17)?,
        file_modified_at: r.get(18)?,
        fps: r.get(19)?,
        bitrate: r.get(20)?,
        // 後段で埋める
        is_offline: false,
        thumb_path: None,
    })
}

/// id 1 件を一覧と同じ形で引く(v1.18。視聴履歴からその動画を再生するため)。
/// 見つからなければ None。整形は query_rows と同じ経路を通す
pub fn video_by_id(conn: &Connection, thumbs_dir: Option<&Path>, id: i64) -> Result<Option<VideoRow>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM videos WHERE id = ?1");
    let mut row = match conn.query_row(&sql, [id], map_row) {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    row.is_offline = !RootCache::default().is_online(&row.path);
    row.thumb_path = thumbs_dir
        .filter(|_| row.thumb_state == 1)
        .map(|dir| dir.join(format!("{}.jpg", row.id)).to_string_lossy().to_string());
    Ok(Some(row))
}

/// 検索を実行して一覧行を返す。thumbs_dir が None のときはサムネイルパスを解決しない(MCP 用)
pub fn query_rows(
    conn: &Connection,
    thumbs_dir: Option<&Path>,
    query: &VideoQuery,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoRow>> {
    let (where_sql, params) = query.where_clause();
    let order = query.order_clause();
    let limit = limit.clamp(1, 1000);
    let offset = offset.max(0);
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM videos {where_sql} {order} LIMIT {limit} OFFSET {offset}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut rows: Vec<VideoRow> = stmt
        .query_map(rusqlite::params_from_iter(params), map_row)?
        .filter_map(|r| r.ok())
        .collect();

    let mut roots = RootCache::default();
    for row in &mut rows {
        row.is_offline = !roots.is_online(&row.path);
        // 実在確認(exists)はしない。1 ページぶんで数百回のファイル I/O になるうえ、
        // thumb_state=1 なら生成済みのはず。万一読めなかったときはフロント側の
        // img onError でプレースホルダに落とす
        row.thumb_path = thumbs_dir
            .filter(|_| row.thumb_state == 1)
            .map(|dir| dir.join(format!("{}.jpg", row.id)).to_string_lossy().to_string());
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SQL が実際に SQLite で通って正しい行を返すかを見たいので、
    /// 文字列比較ではなくインメモリ DB に本物のスキーマを流して検証する
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO videos (id, path, filename, title, size, partial_hash, duration_ms,
                                width, height, video_codec, rating, view_count, added_at)
            VALUES
              (1, 'C:\v\旅行 2024.mp4', '旅行 2024.mp4', NULL, 100, 'aaa', 60000, 1920, 1080, 'h264', 5, 3, '2026-01-10 10:00:00'),
              (2, 'C:\v\旅行 2025.mkv', '旅行 2025.mkv', NULL, 100, 'aaa', 60000, 1280, 720,  'hevc', 0, 0, '2026-02-10 10:00:00'),
              (3, 'D:\backup\旅行 2024.mp4', '旅行 2024.mp4', NULL, 200, 'bbb', 60000, 3840, 2160, 'av1', 0, 0, '2026-03-10 10:00:00'),
              (4, 'C:\v\料理.avi', '料理.avi', 'カレーの作り方', 300, NULL, 60000, 640, 480, 'mpeg4', 2, 1, '2026-04-10 10:00:00');

            INSERT INTO tags (id, name, parent_id) VALUES (1, '家族', NULL), (2, '旅行', 1), (3, '料理', NULL);
            INSERT INTO video_tags (video_id, tag_id) VALUES (1, 2), (2, 2), (4, 3);
            "#,
        )
        .unwrap();
        conn
    }

    fn ids(conn: &Connection, q: &VideoQuery) -> Vec<i64> {
        query_rows(conn, None, q, 1000, 0)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect()
    }

    #[test]
    fn empty_query_returns_everything() {
        let conn = setup();
        let q = VideoQuery::default();
        assert_eq!(q.where_clause().0, "", "条件なしのときに WHERE を出してはいけない");
        assert_eq!(count(&conn, &q).unwrap(), 4);
    }

    #[test]
    fn text_terms_are_anded() {
        let conn = setup();
        // 「旅行」だけなら 3 件、「旅行 2024」なら両方を含む 2 件
        let one = VideoQuery { text: Some("旅行".into()), ..Default::default() };
        assert_eq!(ids(&conn, &one).len(), 3);

        let two = VideoQuery { text: Some("旅行 2024".into()), ..Default::default() };
        assert_eq!(ids(&conn, &two), vec![3, 1]);

        // 全角スペースも区切りとして扱う
        let full = VideoQuery { text: Some("旅行　2024".into()), ..Default::default() };
        assert_eq!(ids(&conn, &full).len(), 2);
    }

    #[test]
    fn text_matches_title_and_optionally_path() {
        let conn = setup();
        let by_title = VideoQuery { text: Some("カレー".into()), ..Default::default() };
        assert_eq!(ids(&conn, &by_title), vec![4], "title も検索対象のはず");

        // パス検索を切っていれば backup はヒットしない
        let off = VideoQuery { text: Some("backup".into()), ..Default::default() };
        assert!(ids(&conn, &off).is_empty());

        let on = VideoQuery {
            text: Some("backup".into()),
            search_path: Some(true),
            ..Default::default()
        };
        assert_eq!(ids(&conn, &on), vec![3]);
    }

    #[test]
    fn like_wildcards_are_escaped() {
        let conn = setup();
        // "%" がワイルドカードとして効いてしまうと全件ヒットになる
        let q = VideoQuery { text: Some("%".into()), ..Default::default() };
        assert!(ids(&conn, &q).is_empty());
    }

    #[test]
    fn parent_tag_includes_descendants() {
        let conn = setup();
        // 「家族」(親) を選ぶと子の「旅行」が付いた動画も出る
        let with_children = VideoQuery { tag_ids: Some(vec![1]), ..Default::default() };
        assert_eq!(ids(&conn, &with_children).len(), 2);

        // 明示的に切れば親タグ直付けのものだけ(このデータでは 0 件)
        let strict = VideoQuery {
            tag_ids: Some(vec![1]),
            include_child_tags: Some(false),
            ..Default::default()
        };
        assert!(ids(&conn, &strict).is_empty());
    }

    #[test]
    fn untagged_and_unwatched() {
        let conn = setup();
        let untagged = VideoQuery { untagged: Some(true), ..Default::default() };
        assert_eq!(ids(&conn, &untagged), vec![3]);

        let unwatched = VideoQuery { unwatched: Some(true), ..Default::default() };
        assert_eq!(ids(&conn, &unwatched).len(), 2);
    }

    #[test]
    fn resolution_and_codec_filters() {
        let conn = setup();
        let hd = VideoQuery { min_height: Some(1080), ..Default::default() };
        assert_eq!(ids(&conn, &hd).len(), 2, "1080 と 2160 が残るはず");

        let codec = VideoQuery {
            // 大文字・前後の空白を渡しても効くこと
            video_codecs: Some(vec![" H264 ".into(), "av1".into()]),
            ..Default::default()
        };
        assert_eq!(ids(&conn, &codec), vec![3, 1]);

        // 空文字だけを渡したときに条件ごと消える(全件になる)こと
        let blank = VideoQuery { video_codecs: Some(vec!["".into()]), ..Default::default() };
        assert_eq!(ids(&conn, &blank).len(), 4);
    }

    #[test]
    fn added_date_range_is_inclusive() {
        let conn = setup();
        let q = VideoQuery {
            added_after: Some("2026-02-10".into()),
            added_before: Some("2026-03-10".into()),
            ..Default::default()
        };
        assert_eq!(ids(&conn, &q).len(), 2, "両端の日を含むはず");
    }

    #[test]
    fn duplicates_only_pairs_same_size_and_hash() {
        let conn = setup();
        let q = VideoQuery {
            duplicates_only: Some(true),
            sort: Some("dup".into()),
            ..Default::default()
        };
        // size=100 + hash='aaa' の 2 件だけ。hash が NULL の 4 は重複ではない
        assert_eq!(ids(&conn, &q), vec![1, 2]);
    }

    #[test]
    fn random_sort_is_stable_across_pages() {
        let conn = setup();
        let q = VideoQuery { sort: Some("random".into()), random_seed: Some(12345), ..Default::default() };

        let all = ids(&conn, &q);
        assert_eq!(all.len(), 4);
        assert_ne!(all, vec![1, 2, 3, 4], "id 順のままならシャッフルできていない");

        // ページングしても同じ並びになること(RANDOM() だとここが崩れる)
        let page1: Vec<i64> = query_rows(&conn, None, &q, 2, 0).unwrap().iter().map(|r| r.id).collect();
        let page2: Vec<i64> = query_rows(&conn, None, &q, 2, 2).unwrap().iter().map(|r| r.id).collect();
        assert_eq!([page1, page2].concat(), all);

        // 種を変えれば並びが変わること
        let other = VideoQuery { random_seed: Some(999), ..q.clone() };
        assert_ne!(ids(&conn, &other), all);
    }

    #[test]
    fn filters_combine_with_and() {
        let conn = setup();
        let q = VideoQuery {
            text: Some("旅行".into()),
            min_rating: Some(1),
            unwatched: Some(false), // false は条件にしない
            ..Default::default()
        };
        assert_eq!(ids(&conn, &q), vec![1]);
    }

    /// dir_path 用の別データ。サブフォルダ・区切りの揺れ・LIKE で誤爆する名前を混ぜてある
    fn setup_dirs() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO videos (id, path, filename, size, added_at) VALUES
              (10, 'C:\動画\a.mp4',                'a.mp4', 1, '2026-01-01 00:00:00'),
              (11, 'C:\動画\アニメ\b.mp4',          'b.mp4', 1, '2026-01-01 00:00:00'),
              (12, 'C:\動画\アニメ\2024\c.mp4',     'c.mp4', 1, '2026-01-01 00:00:00'),
              (13, 'c:\動画\d.mp4',                'd.mp4', 1, '2026-01-01 00:00:00'),
              (14, 'C:/動画/e.mp4',                'e.mp4', 1, '2026-01-01 00:00:00'),
              (15, 'C:\動画\100%_test\f.mp4',      'f.mp4', 1, '2026-01-01 00:00:00'),
              (16, 'C:\動画\100XX-test\g.mp4',     'g.mp4', 1, '2026-01-01 00:00:00');
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn dir_path_matches_direct_children_only() {
        let conn = setup_dirs();
        let q = VideoQuery { dir_path: Some(r"C:\動画".into()), ..Default::default() };
        // 直下の 3 件だけ。サブフォルダ(11/12/15/16)は入らない
        let mut got = ids(&conn, &q);
        got.sort();
        assert_eq!(got, vec![10, 13, 14]);

        let sub = VideoQuery { dir_path: Some(r"C:\動画\アニメ".into()), ..Default::default() };
        assert_eq!(ids(&conn, &sub), vec![11], "孫(2024\\c.mp4)を含めてはいけない");
    }

    #[test]
    fn dir_path_ignores_case_and_separator_style() {
        let conn = setup_dirs();
        // 小文字 + '/' 区切り + 末尾の区切りあり、でも同じ結果になること
        let q = VideoQuery { dir_path: Some("c:/動画/".into()), ..Default::default() };
        let mut got = ids(&conn, &q);
        got.sort();
        assert_eq!(got, vec![10, 13, 14]);
    }

    #[test]
    fn dir_path_does_not_treat_wildcards_as_patterns() {
        let conn = setup_dirs();
        // LIKE で組むと '100%_test' が '100XX-test' にもマッチしてしまう
        let q = VideoQuery { dir_path: Some(r"C:\動画\100%_test".into()), ..Default::default() };
        assert_eq!(ids(&conn, &q), vec![15]);
    }

    #[test]
    fn blank_dir_path_is_ignored() {
        let conn = setup_dirs();
        let q = VideoQuery { dir_path: Some("   ".into()), ..Default::default() };
        assert_eq!(q.where_clause().0, "", "空文字は条件にしない");
        assert_eq!(count(&conn, &q).unwrap(), 7);
    }

    /// v1.16 の列ヘッダソート用。NULL・同値・拡張子の揺れを混ぜてある
    fn setup_sorts() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::apply_schema(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO videos (id, path, filename, size, duration_ms, width, height,
                                video_codec, audio_codec, fps, bitrate, rating, view_count,
                                last_viewed_at, file_created_at, file_modified_at, added_at)
            VALUES
              (1, 'C:\a\x.MKV',      'x.MKV',      10, 1000, 1920, 1080, 'h264', 'aac',  30.0, 500, 3, 7,
               '2026-05-01 10:00:00', '2026-01-01 10:00:00', '2026-02-01 10:00:00', '2026-01-10 10:00:00'),
              (2, 'C:\b\y.mp4',      'y.mp4',      10, NULL, NULL, NULL, NULL,   NULL,   NULL, NULL, 0, 0,
               NULL,                  NULL,                  NULL,                  '2026-01-10 10:00:00'),
              (3, 'C:\a\z.tar.gz.mp4','z.tar.gz.mp4',30, 3000, 3840, 2160, 'hevc', 'eac3', 60.0, 900, 5, 2,
               '2026-04-01 10:00:00', '2026-03-01 10:00:00', '2026-04-01 10:00:00', '2026-02-10 10:00:00'),
              (4, 'C:\a\noext',      'noext',      20, 2000, 1280, 720,  'av1',  'opus', 24.0, 700, 1, 5,
               '2026-06-01 10:00:00', '2026-02-01 10:00:00', '2026-03-01 10:00:00', '2026-03-10 10:00:00');
            "#,
        )
        .unwrap();
        conn
    }

    /// フロントの listColumns.ts が投げうるキーを全部並べたもの。
    /// SQL の構文ミスは 1 個ずつ目視するより、まとめて実行して落ちないことで見る
    const ALL_SORTS: &[&str] = &[
        "name_asc", "name_desc", "size_asc", "size_desc", "duration_asc", "duration_desc",
        "added_asc", "added_desc", "rating_asc", "rating_desc", "viewed_asc", "viewed_desc",
        "views_asc", "views_desc", "res_asc", "res_desc", "ext_asc", "ext_desc",
        "codec_asc", "codec_desc", "acodec_asc", "acodec_desc", "folder_asc", "folder_desc",
        "fmodified_asc", "fmodified_desc", "fcreated_asc", "fcreated_desc",
        "fps_asc", "fps_desc", "bitrate_asc", "bitrate_desc",
        "dup", "random", "series_asc",
    ];

    #[test]
    fn every_sort_key_produces_valid_sql() {
        let conn = setup_sorts();
        for key in ALL_SORTS {
            let q = VideoQuery { sort: Some((*key).into()), ..Default::default() };
            let got = query_rows(&conn, None, &q, 100, 0);
            assert!(got.is_ok(), "{key} の SQL が実行できない: {:?}", got.err());
            assert_eq!(got.unwrap().len(), 4, "{key} で件数が変わってはいけない");
        }
    }

    /// SQLite は ASC の既定が NULLS FIRST。書き忘れると未視聴や尺未取得が先頭を埋める
    #[test]
    fn nulls_always_sort_last() {
        let conn = setup_sorts();
        // id=2 だけが duration / last_viewed_at / fps / 解像度 を持たない
        for key in ["duration_asc", "duration_desc", "viewed_asc", "viewed_desc",
                    "fps_asc", "fps_desc", "res_asc", "res_desc",
                    "fcreated_asc", "fmodified_desc", "codec_asc", "bitrate_asc"] {
            let q = VideoQuery { sort: Some(key.into()), ..Default::default() };
            let got = ids(&conn, &q);
            assert_eq!(*got.last().unwrap(), 2, "{key}: NULL の行は末尾に来るはず(実際 {got:?})");
        }
    }

    #[test]
    fn extension_sort_uses_the_last_dot() {
        let conn = setup_sorts();
        let asc = ids(&conn, &VideoQuery { sort: Some("ext_asc".into()), ..Default::default() });
        // 拡張子なし('')→ mkv(大文字でも小文字として比較)→ mp4 × 2(id 昇順)
        // z.tar.gz.mp4 は最後のドットだけを見るので mp4
        assert_eq!(asc, vec![4, 1, 2, 3]);

        let desc = ids(&conn, &VideoQuery { sort: Some("ext_desc".into()), ..Default::default() });
        assert_eq!(*desc.last().unwrap(), 4, "拡張子なしは降順では末尾");
    }

    #[test]
    fn resolution_sort_compares_pixel_count() {
        let conn = setup_sorts();
        let desc = ids(&conn, &VideoQuery { sort: Some("res_desc".into()), ..Default::default() });
        // 3840×2160 > 1920×1080 > 1280×720 > 未取得
        assert_eq!(desc, vec![3, 1, 4, 2]);
    }

    #[test]
    fn folder_sort_groups_by_directory() {
        let conn = setup_sorts();
        let asc = ids(&conn, &VideoQuery { sort: Some("folder_asc".into()), ..Default::default() });
        // C:\a\ の 3 件が先に固まり、その中はファイル名順。C:\b\ が最後
        assert_eq!(asc, vec![4, 1, 3, 2]);
    }

    /// 同値の行が複数あるとき、`, id` が無いとページをまたいだ順序が保証されない
    #[test]
    fn sort_is_stable_across_pages() {
        let conn = setup_sorts();
        // size は id=1 と id=2 が同値(10)
        for key in ["size_asc", "size_desc", "added_asc", "added_desc", "duration_asc"] {
            let q = VideoQuery { sort: Some(key.into()), ..Default::default() };
            let all = ids(&conn, &q);
            let mut paged: Vec<i64> = Vec::new();
            for offset in [0, 2] {
                paged.extend(
                    query_rows(&conn, None, &q, 2, offset).unwrap().iter().map(|r| r.id),
                );
            }
            assert_eq!(paged, all, "{key}: ページングで順序が崩れている");
        }
    }

    #[test]
    fn ascending_and_descending_are_mirrored() {
        let conn = setup_sorts();
        for (asc, desc) in [
            ("rating_asc", "rating_desc"), ("views_asc", "views_desc"),
            ("size_asc", "size_desc"), ("name_asc", "name_desc"),
        ] {
            let a = ids(&conn, &VideoQuery { sort: Some(asc.into()), ..Default::default() });
            let mut d = ids(&conn, &VideoQuery { sort: Some(desc.into()), ..Default::default() });
            d.reverse();
            assert_eq!(a, d, "{asc} と {desc} が逆順になっていない");
        }
    }

    #[test]
    fn dir_path_combines_with_other_conditions() {
        let conn = setup_dirs();
        let q = VideoQuery {
            dir_path: Some(r"C:\動画".into()),
            text: Some("a.mp4".into()),
            ..Default::default()
        };
        assert_eq!(ids(&conn, &q), vec![10]);
    }
}
