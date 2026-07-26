# VideoShelf 設計ドキュメント

Windows 向け動画管理ソフト(仮称: VideoShelf)。
参考: ホワイトブラウザ / TMPGEnc KARMA / Eagle / XnView / foobar2000

## 決定事項(2026-07-23)

- **配布**: 当面は自分用。FFmpeg 同梱のライセンス対応は公開を決めた時点で見直す
- **データ置き場**: SQLite / サムネイルキャッシュは `%APPDATA%\VideoShelf` 配下。将来「場所の変更」機能を追加予定
- **UI 言語**: 日本語のみ(i18n 分離はしない)
- **外付け HDD / NAS 上の動画を管理対象とする**(オフライン検出を v0.1 から実装。下記参照)

## コンセプト

- **ファイルはコピーしない**。元のディレクトリに置いたまま、SQLite データベースで管理する(Eagle 方式の否定)
- タグ・シリーズ・メタデータで検索/絞り込み/編集ができる
- サクサク動くことを最優先。数万件のライブラリでも軽快に
- あらゆる動画フォーマットに対応(サムネイル生成・再生とも FFmpeg を軸にする)

## 技術スタック

| 層 | 技術 |
|---|---|
| UI | Tauri 2 + React + TypeScript (Vite) |
| バックエンド | Rust (Tauri コマンド + 非同期ワーカー) |
| DB | SQLite + FTS5(全文検索) |
| メタデータ / サムネイル | FFmpeg / ffprobe(サイドカーバイナリとして同梱) |
| 再生 (v1.5) | **libmpv 埋め込み**(ほぼ全フォーマットを変換なしで直接再生)。フォールバックは v1.4 の WebView2 + FFmpeg 変換。外部プレイヤー設定時は従来通り外部起動 |
| 再生 (将来) | (フォールバック側の)長尺動画の HLS 追いかけ再生 |

## データモデル(SQLite)

### videos — 動画ファイル本体
| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| path | TEXT UNIQUE | 絶対パス |
| filename | TEXT | 表示・検索用 |
| size | INTEGER | バイト数 |
| partial_hash | TEXT | 先頭 1MB + サイズの xxHash。移動・リネーム検出用 |
| duration_ms | INTEGER | |
| width / height | INTEGER | |
| video_codec / audio_codec / container | TEXT | ffprobe から取得 |
| fps / bitrate | REAL / INTEGER | |
| title | TEXT | ユーザー編集可(初期値はファイル名) |
| comment | TEXT | 自由記入メモ |
| rating | INTEGER | 0–5 |
| view_count | INTEGER | |
| last_viewed_at | TEXT | |
| resume_ms | INTEGER | アプリ内再生のレジューム位置(0 = 位置なし。v2 マイグレーション) |
| thumb_time_ms | INTEGER NULL | サムネイルのコマ位置。NULL = 自動選択(v3 マイグレーション) |
| file_created_at / file_modified_at | TEXT | ファイルシステム由来 |
| added_at | TEXT | ライブラリ登録日時 |
| is_missing | INTEGER | ファイルが見つからない状態のフラグ(即削除しない) |
| watched_folder_id | INTEGER NULL | 発見元の監視フォルダ。**NULL = 個別登録**(手動追加) |
| thumb_state | INTEGER | サムネイル生成状態 (0=未 / 1=済 / 2=失敗) |

### tags / video_tags — タグ(多対多)
- `tags(id, name UNIQUE, color, parent_id)` — parent_id で階層タグに対応
- `video_tags(video_id, tag_id)` — 複合 PK

### series / series_entries — シリーズ(順序つきグループ)
- `series(id, name, comment)`
- `series_entries(series_id, video_id, position)` — position で並び順を保持

### watched_folders — 監視対象フォルダ
- `watched_folders(id, path, recursive, enabled, volume_serial)`
- 起動時スキャン + notify クレートによるリアルタイム監視
- `volume_serial`: ドライブのボリュームシリアル(8 桁 hex)。ドライブレター変動の再マッピングに使う(UNC は NULL)

### スキーマ移行(v1.0 から)
- `PRAGMA user_version` による簡易マイグレーション(`db.rs` の `MIGRATIONS` に v(N)→v(N+1) の差分 SQL を追記していく)
- **上げるのは列追加のときだけ**。新テーブルは `SCHEMA` に `CREATE TABLE IF NOT EXISTS` を足せばよい
  (`migrate()` は既存 DB にも `SCHEMA` を流すため)。現行は v3(v1: volume_serial / v2: resume_ms / v3: thumb_time_ms)
- 新規 DB は最新スキーマを一括作成。既存 DB は差分を順次適用(ALTER と user_version 更新は同一トランザクション)
- 新規/既存の判定は `sqlite_master` の videos テーブル有無(user_version 導入前の DB は 0 のため)

## ライブラリへの登録経路(2 種類)

1. **監視フォルダ**: 登録したフォルダを自動スキャンし、新規ファイルを取り込む
2. **個別登録**: ファイル単位で手動追加する
   - ウィンドウへのドラッグ&ドロップ
   - ファイル選択ダイアログ(複数選択可)
   - 個別登録されたファイルは `watched_folder_id = NULL` で区別する

区別が効く場面: 監視フォルダを解除したとき、そのフォルダ由来の動画をまとめて外す(または残すか確認する)ことができる一方、個別登録したファイルは影響を受けない。missing 検出(起動時の存在チェック・移動検出)はどちらの経路でも同じように働く。

### 全文検索について
- テキスト検索は filename / title への LIKE 部分一致(日本語の部分一致はこれで正しく動く)。
  v1.7 から**空白区切りで AND**(全角スペースも区切り)。設定で path も対象に含められる
- FTS5 は日本語トークナイズの問題(標準トークナイザは CJK に弱い)があるため、導入するなら trigram トークナイザ等を検証してから(v0.2 で判断)

## 構造化クエリ `VideoQuery`(v1.7 で拡張)

UI・MCP・AI アシスタントが共有する唯一の検索条件型(`core/query.rs`)。
**新しい条件は必ず `Option` で足す**。未指定なら従来とまったく同じ SQL が出ること
(`where_clause` の回帰テストで担保している)。

| 条件 | 備考 |
|---|---|
| text / sort / folderId / tagIds / seriesId / missing | v0.1〜v0.4 |
| minRating / minDurationMs / maxDurationMs | v1.0 |
| searchPath | text の対象に path を含める |
| untagged / unwatched | タグなし / 未視聴 |
| minWidth / minHeight | 解像度下限 |
| videoCodecs | 映像コーデック(バインドパラメータ。小文字比較) |
| addedAfter / addedBefore | 追加日範囲(YYYY-MM-DD、両端を含む) |
| duplicatesOnly | size + partial_hash の重複のみ |
| includeChildTags | 親タグ選択時に子孫も含む(既定 true) |
| randomSeed | ランダムソートの種 |

- `where_clause()` は `(SQL, Vec<String>)` を返す。複数語 LIKE とコーデック・日付をバインドするため
  (i64 の条件は従来どおり直接埋め込む。文字列だけをパラメータにする)
- **ランダムソートは `RANDOM()` を使わない**。ページごとに順序が変わって仮想化と両立しないため、
  `id` と種から決定的に並べる: `t = (id * 2654435761) % 1000003` を作り `t * (t + seed) % 1000003` で並べる。
  掛け算と剰余だけだと id に対して線形になり件数が少ないとシャッフルされないので、二乗を混ぜて非線形にしている
- タグ階層は再帰 CTE(`WITH RECURSIVE`)を `IN` の中に置く。親タグを選ぶと子孫タグ付きの動画も出る
- 重複判定は `(size, partial_hash) IN (... GROUP BY ... HAVING COUNT(*) > 1)`。
  `partial_hash IS NULL`(未算出)は「不明」であって重複ではないので除く

### スマートフォルダ(v1.7)

- `smart_folders(id, name, query_json, position)`。`query_json` は **VideoQuery をそのまま JSON 化**したもの
- 保存前に `serde_json::from_str::<VideoQuery>` で検証する(壊れた条件を貯めない)
- 復元は store の `applyFilter` を使う(AI の `apply_filter` と同じ経路)
- **新テーブルの追加に `MIGRATIONS` は要らない**。`db.rs` の `migrate()` は既存 DB にも `SCHEMA`
  (すべて `CREATE TABLE IF NOT EXISTS`)を流すため。`LATEST_VERSION` を上げるのは**列追加のときだけ**

### 統計(v1.7)

`core/stats.rs` の `library_stats()` に集約し、アプリの 📊 画面と MCP の `library_stats` が同じ関数を呼ぶ
(AI に聞いた数字と画面の数字が食い違わないようにするため)。
グラフは CSS の幅指定だけで描く(グラフライブラリを足さない)。

## ファイル同一性の追跡

1. スキャン時、まず path で照合
2. 未知のパスは `size + partial_hash` が一致する既存レコードを探し、**その旧パスの実体が
   消えていれば**「移動 / リネーム」とみなして、タグ等のメタデータを引き継いで path を更新する
3. 見つからなければ新規登録。逆に、スキャン後もそのフォルダで見つからなかった既存レコードは
   `is_missing = 1`(ユーザーが明示的に整理するまで DB には残す)

全体ハッシュは使わない(動画は巨大で遅すぎる)。先頭 1MB で実用上十分。

移動元の候補を `is_missing = 1` で絞らないこと(v1.6 修正)。監視フォルダ A → B の移動では
スキャン順が「B が先」になることがあり、その時点では A のレコードがまだ `is_missing = 0` の
ままなので、フラグで絞ると移動を取りこぼして**二重登録**になる(タグ・レーティング・視聴履歴・
レジュームが旧レコード側に取り残される)。代わりに旧パスの実体の有無で判定する:

- 旧パスが**オフラインのドライブ上**にあるときは移動元とみなさない(未接続と消失を混同しない)
- 旧パスに実体が残っている場合も移動ではない(同じ内容のファイルが 2 箇所にあるだけ)
- 回帰テストは `core/library.rs` の `mod tests`(移動検出 / コピー / missing からの復帰)

## オフラインドライブの扱い(外付け HDD / NAS 前提)

- スキャンや存在チェックの前に、まず対象のルート(ドライブレター or UNC の `\\server\share`)に到達できるか確認する
- 到達できないルート配下の動画は **offline** 扱い。missing とは明確に区別する
  - offline は DB に保存せず、起動時・再スキャン時にルート到達性から動的に判定する(videos へのカラム追加は不要)
  - offline でもサムネイルとメタデータはキャッシュから表示し、検索にもヒットさせる。一覧にはオフラインバッジを表示
  - ドライブ再接続後のスキャンで自動復帰
- **missing 判定はルートがオンラインのときにのみ行う**。ドライブ未接続を「ファイルが消えた」と誤判定しないこと
- 外付けドライブのレター変動(E: が F: になる等)対策(v1.0 実装済み・`core/volumes.rs`):
  - 監視フォルダ登録時・起動時にボリュームシリアル番号を `watched_folders.volume_serial` に記録(バックフィルあり)
  - 起動時・再スキャン時、記録シリアルと現在のレターが食い違ったら、同シリアルの別レターを探して watched_folders / videos の path を一括書き換え(operations_log に `drive_remap` を記録)
  - SUBST 等によるシリアル重複の偽陽性対策として、置換後のフォルダパスが実在する場合のみ再マッピングする。見つからなければ単なる未接続として何もしない

## サムネイル戦略

- 取り込み時にバックグラウンドで生成し、**アプリデータフォルダにディスクキャッシュ**(JPEG。WebP は FFmpeg のビルドによってエンコーダが無いことがあるため確実な JPEG を採用)
- ファイル名は `{video_id}.jpg`
- グリッド表示では動画に一切触らない。キャッシュ画像を読むだけ
- ホバー用の複数枚生成は**不要になった**(v1.6)。下記「ホバープレビュー」参照

### コマ選び(v1.8)

- 自動: 10% 地点から **10 秒ぶんを ffmpeg の `thumbnail` フィルタに評価させて代表フレームを選ばせる**。
  10% ちょうどの 1 枚だと暗転・フェードを引きやすかったため。`-t` で読む範囲を区切らないと
  長尺で延々デコードし続けるので必ず付ける。依存の追加はなし
- 手動: `videos.thumb_time_ms`(v2→v3 マイグレーション)。再生中に 🖼 / T キーで現在位置を保存し、
  `thumb_state` を 0 に戻して既存の生成ワーカー(`process_pending`)に作り直させる。
  **手動指定では `thumbnail` フィルタを使わない** — 数秒ずれると位置を指定した意味がなくなるため
- 孤児サムネイルの掃除: `thumbs::purge_orphans`。`{id}.jpg` の id が videos に無いものを消す。
  想定外の名前のファイルには触らない

## ホバープレビュー(v1.6 実装)

カードにカーソルを 400ms 載せると、**元の動画ファイルをそのまま `<video>` で再生**する。
マウスを左右に動かすとその位置のシーンへ送れる(Eagle と同じ体験)。

### 生成キャッシュを持たない理由

当初はタイルシートや短いプレビュー動画の事前生成を検討したが、**実測の結果すべて不要と判明した**:

- WebView2 は Chromium なので **mkv も HEVC もそのまま再生できる**(mkv + HEVC で実測確認)。
  WebM が Matroska のサブセットである以上、Chromium には Matroska パーサがある
- 参考にした Eagle も同じ仕組みだった。アイテムフォルダには元動画と静止画サムネイル 1 枚しか
  無く、`ffmpeg.dll` は Electron/Chromium 標準のもの。Eagle の「ビデオサムネイル拡張機能」は
  **静止画サムネイルの生成**用で、再生とは無関係(公式説明の「将来の計画」に統合プレーヤーが
  挙がっていることからも、Eagle 本体に専用プレーヤーが無いことが分かる)
- 生成方式ならライブラリ 1 万件で 0.6〜1.2GB のキャッシュが必要になるが、直接再生ならゼロ

### 実装(`components/HoverPreview.tsx` / `VideoCard.tsx`)

- ホバー **400ms 継続**で開始(グリッドを撫でただけでは再生しない)
- `<video autoPlay muted loop>` に `convertFileSrc(video.path)` を渡すだけ。音声は常にミュート
- スクラブは `currentTime` を直接動かす。**シーク中は最後の 1 要求だけ覚えて `seeked` で反映**する
  (マウス移動のたびに叩くと外付け HDD / NAS で詰まるため)
- サムネイル下端に再生位置バー(`.preview-bar`)と「現在位置 / 尺」表示(`.preview-time`)。
  **どちらも state を通さず ref で直接書き換える**(マウス移動のたびに再レンダーしない)。
  実際のシーク完了を待たずに先に描画を進めてマウスへの追従を優先する。
  プレビュー中はレジューム位置のバーと尺バッジを隠す(同じ場所で二重に出さない)
- 時刻整形は `lib/format.ts` の `fmtTime` に集約(プレイヤー / カード / プレビューで共用)
- 再生できない形式は `onError` で静かに諦め、下のサムネイルを見せたままにする(変換はしない)
- **offline / missing の動画では発動しない**(ファイルに到達できないため)
- 仮想化で同じカードが別の動画に使い回されたときは `video.id` の変化でプレビューを解除する
- 設定「カードにカーソルを合わせるとプレビュー再生する」(`preview_on_hover`、既定 ON)で無効化できる。
  外付け HDD / NAS へのアクセスを抑えたい場合向け

### 表示経路の原則(v1.6 で文言を修正)

旧: 「表示経路で動画のデコードを絶対にしない」
新: **「自動的に起きる表示(グリッド描画・スクロール)では元動画に触らない。
ユーザーの明示的な操作(ホバー継続・ダブルクリック)なら触ってよい」**

グリッドに数十枚並ぶサムネイルを描くのにデコードが走るのは論外だが、ホバーは常に 1 本だけで、
ダブルクリック再生が既に元動画を直接開いていることとも一貫する。

## テスト(v1.7 で整備)

- **Rust**: `cargo test`。`core/query.rs`(検索条件・ランダムソートの安定性・LIKE エスケープ)、
  `core/tags.rs`(タグ階層の循環拒否・色の形式)、`core/smart_folders.rs`、`core/stats.rs`、
  `core/library.rs`(移動検出)、`db.rs`(読み書きコネクション分離)。
  SQL は文字列比較ではなく**インメモリ DB に本物のスキーマを流して実行結果で検証する**
  (`db::apply_schema` をテストから呼べるように公開している)
- **フロント**: `npm run test`(vitest + jsdom)。純関数のみを対象にする —
  `decidePlayback` / `resumeValueMs` / `fmtTime`
- **既存 DB でのマイグレーション確認**: `cargo run --example dbtool -- <db> check`。
  本番と同じ `db::init` を通して user_version・テーブル一覧・統計を出す(DB をコピーして試すこと)

## アプリ内再生(v1.2 実装、v1.4 で強化)

### 再生方式の 3 段判定(`src/lib/playback.ts` の `decidePlayback`)

外部プレイヤー設定(player_path)があれば従来通り常に外部起動。無ければダブルクリックで必ずアプリ内オーバーレイを開き、DB のコーデック情報(ffprobe 由来)で方式を決める:

| 方式 | 条件 | 動作 |
|---|---|---|
| native | mp4/m4v/mov/webm/**mkv** かつ映像 h264/av1/vp8/vp9(HEVC は拡張検出時)かつ音声 aac/mp3/opus/vorbis/flac | asset protocol でそのまま再生 |
| remux | 映像はそのまま使えるがコンテナ/音声だけ非対応(avi の h264、mkv + ac3 等) | ffmpeg `-c:v copy` で mp4 詰め替え(数秒〜数十秒) |
| transcode | 上記以外(HEVC 拡張なし・非対応映像コーデック・コーデック未取得の非対応拡張子等) | H.264 + AAC へ再エンコード |

**mkv を native に含めるのは v1.6 の変更**。WebM が Matroska のサブセットである以上 Chromium は
mkv を扱えるという読みを実測で確認したため(それまでは無条件で remux 送りにしていた)。
判定を外しても native の onError で transcode に落ちるので、**楽観側に倒してよい**。
音声の ac3 / dts / truehd は Chromium が非対応なので remux で AAC 化する

- Windows の「HEVC ビデオ拡張機能」は `canPlayType('video/mp4; codecs="hvc1..."')` で検出(WebView2 は OS デコーダを反映)。検出は不確実なため、**native の onError は外部ではなく transcode への切り替え**にしてアプリ内で完結させる。変換キャッシュの再生でも失敗したときだけ OS 既定プレイヤーへ(2 段フォールバック)。remux 失敗も transcode で再試行する
- 視聴カウントは再生成功時(onPlaying)にのみ +1 するため二重カウントしない

### 事前変換キャッシュ(`core/playback.rs`)

- キャッシュ: `%APPDATA%\com.taiki.videoshelf\transcode\{video_id}.mp4`(ASCII 名なので日本語パスの影響なし)。書き込み中は `{id}.tmp.mp4` → 成功時 rename(部分ファイルを配信しない)。キャッシュの mtime ≥ 元ファイルの mtime なら再利用(再視聴は待ちゼロ)
- ffmpeg 引数: `-map 0:v:0 -map 0:a:0?` で映像・音声 1 本に限定(字幕・複数音声の mp4 化エラー回避)、`-movflags +faststart`。remux は `-c:v copy`(hevc は `-tag:v hvc1`)+ 音声 aac/mp3 なら copy それ以外 AAC 化。transcode は `-pix_fmt yuv420p`(10bit 対応)+ AAC 192k
- HW エンコーダ: 初回に 1 フレームのテストエンコードで nvenc → qsv → amf の順に実証し、settings `hw_encoder` に保存。実変換で失敗したら libx264 に書き換えて 1 回だけ再試行
- 進捗: `-progress pipe:1` の `out_time_us` ÷ duration_ms を 500ms 間隔で `transcode:progress` イベント通知(尺不明時はスピナー)
- プロセス管理: 同時変換は 1 本(AppState.transcode_job)。準備中にプレイヤーを閉じると `cancel_prepare` で kill、アプリ終了時(RunEvent::Exit)も kill。書きかけ `.tmp.mp4` は次回起動の purge で掃除
- キャッシュ上限: settings `transcode_cache_limit_gb`(既定 20)。起動時と変換完了後に mtime の古い順に削除(直近生成分は除外)。動画のライブラリ削除時は対応キャッシュも削除
- assetProtocol の scope は `"**"`(全パス許可)。動画は任意ドライブに置かれる前提のため。トレードオフ: 万一 webview で XSS が起きると任意ファイルを読まれ得る(ローカル個人用アプリとして許容。csp は元々 null)
- Tauri 2 の asset protocol は HTTP Range 対応でシークも動く(キャッシュ mp4 も同じ経路)

### プレイヤー UI(v1.4、`src/components/player/`)

- 自前コントロール(素の React。外部プレイヤーライブラリ依存なし): シークバー(バッファ表示付き)・再生/停止・時刻・再生速度(0.5〜2x)・音量/ミュート(localStorage に記憶)・フルスクリーン(Web Fullscreen API)
- ショートカット: Space/K=再生⇄停止、←→=±10 秒、↑↓=音量、M=ミュート、F=フルスクリーン、< >=速度、
  N/P=次/前の動画(v1.8)、T=現在位置をサムネイルに(v1.8)、Esc=閉じる(フルスクリーン中は解除のみ)
- コントロールはマウス静止 2.5 秒で自動非表示(一時停止中は常時表示)
- **視聴カウントは尺の 5% 以上 or 30 秒以上まで観たときだけ +1**(v1.8。`shouldCountView`)。
  それまでは「開いてすぐ閉じた」扱いで数えない。短い動画が永久にカウントされないよう 5% も見る。
  外部プレイヤー起動は再生位置が分からないので従来どおり即時カウント

### 一覧の操作(v1.8)

- **選択**: クリック = 単独 / Ctrl+クリック = トグル / Shift+クリック = anchor からの範囲。
  範囲はページ境界をまたぐので `useVideos.getRange(from, to)` で**足りないページの取得を待ってから**選ぶ
  (同期の `getVideo` はページ未取得だと undefined を返すため、選択に穴が空く)
- **Ctrl+A** は先頭 1000 件まで(`SELECT_ALL_LIMIT`)。数万件を state に載せると Inspector が固まる。
  切り詰めたときは黙って捨てずトーストで知らせる
- キーボード: 矢印(±1 / ±列数)・Home / End・Enter で再生・Esc で解除。
  ハンドラは window に付け、**プレイヤー表示中と input/textarea/select にフォーカスがある間は素通し**する
- 絞り込みが変わったら選択・anchor・focus をまとめて捨てる(store の `CLEARED`)。
  選択だけ消して anchor が残ると次の Shift+クリックが的外れな範囲を選ぶ

### 表示モード(v1.8)

- `viewMode`(grid / list)と `cardWidth` を settings に永続化(`view_mode` / `card_width`)
- **仮想化は共通**。`useVirtualizer` の `estimateSize` と列数を切り替えるだけで両モードに載る
  - grid: 列数 = 幅 ÷ cardWidth、行高 = cardWidth × 0.5625 + 56
  - list: 1 列・行高 44px 固定。サムネ 64px / 名前 / 尺 / サイズ / 解像度 / ★ / 追加日
- **リスト行にホバープレビューは付けない**。行が細く、マウスが横切るだけで次々に元動画を
  開くことになるため(カードは面積が大きいので誤爆しにくい)

### 連続再生(v1.8)

- store の `playQueue = { query, index, total }`。**プレイヤーはクエリと位置だけを持ち、
  次の 1 件は `query_videos(query, 1, index+1)` で Rust から都度引く**。
  グリッドのページキャッシュに依存しないので、再生中にソートを変えても次は新しい並びで来る
- ⏮ ⏭ ボタンと `N` / `P` キー。終了時の自動送りは設定 `autoplay_next`(既定 OFF)
  - mpv は `keep-open=yes` で EOF でも pause 状態で止まるだけなので、
    「終端 1 秒以内 + paused」を最後まで観たとみなす(手動の一時停止と区別する)
  - WebView2 経路は `onEnded`
- 外部プレイヤー設定時は従来通り外部起動で、連続再生の対象にしない

### 音声・字幕トラックの切替(v1.8、mpv のみ)

- `MPV_OBSERVED` に `track-list` を追加して購読し、`aid` / `sid` を setProperty で切り替える
  (無効化は `'no'`)
- `VideoPlayer` インターフェイスの `tracks` / `setTrack` は **optional**。
  WebView2 側は実装しないので UI にも出ない
- 音声は 2 本以上あるときだけ出す。字幕は「オフ」に切り替えたいので 1 本でも出す

### レジューム(v1.4)

- `videos.resume_ms` に保存。再生中 5 秒ごと + 一時停止・終了・閉じる時に更新
- 位置が尺の 90% 以上または残り 30 秒未満になったら 0 にリセット(最後まで観た扱い)
- 次回再生時は `loadedmetadata` で復元(終端 5 秒以内は最初から)。remux/transcode キャッシュでも尺は同じなのでそのまま効く
- グリッドのカードにサムネイル下端の進捗バー(3px)で表示

## アプリ内再生 v1.5: libmpv 埋め込み

### エンジン 2 系統と選択フロー

```
ダブルクリック
  ├─ 外部プレイヤー設定あり → 従来通り外部起動
  └─ なし → アプリ内プレイヤー
       ├─ mpv(優先): ensureMpv() 成功 → ほぼ全フォーマットを変換なしで直接再生
       │    └─ ファイル再生エラー(end-file reason=error)→ その動画だけ WebView2 経路へ
       └─ WebView2(フォールバック): mpv init 失敗(dll 欠落等)時。
            v1.4 の 3 段判定(native / remux / transcode)+ FFmpeg 変換パイプラインがそのまま生きる
```

- mpv 経路では `decidePlayback` / `prepare_video`(変換)は一切通らない
- mpv 利用可否は settings に永続化しない。dll を置けば次回起動で自動復活(自己修復)

### 透過ウィンドウ方式

- `tauri-plugin-libmpv` は **呼び出し元ウィンドウの全面**(WebView の背後)に映像を描画する
- メインウィンドウは常時 `transparent: true`。ただし body の背景が不透明(#16181d)なので普段の見た目は不変
- 再生中だけ `html.mpv-active` クラスを付け、html/body を透過 + `.app` を display:none → 背後の mpv が見える。
  HTML のコントロール(PlayerControls)はその上に重なる
- CSS ロード前の素通し防止に index.html へインライン背景 style を記述

### mpv のライフサイクル(StrictMode 対策)

- **アプリ生涯で 1 回だけ init するシングルトン**(`player/mpv.ts` の `ensureMpv`、Promise メモ化)。
  destroy は呼ばず、再生開始/終了は loadfile / stop コマンドで行う(`idle=yes` で待機)
- React StrictMode の effect 二重実行でも init の実体は 1 つ、loadfile/stop は mpv 側で直列処理されるため
  競合しない(v1.4 の prepare_lock と同じ思想)

### UI・機能の対応(`src/components/player/`)

- `types.ts` の `VideoPlayer` インターフェイスを両エンジン(`useVideoPlayer` = WebView2 / `useMpvPlayer` = mpv)が
  実装し、`PlayerControls` とショートカット(`usePlayerShortcuts`)を完全共用する
- mpv の状態は `observeProperties`(pause / time-pos / duration / volume / mute / speed / demuxer-cache-time)で購読
- レジューム: 復元は duration 初回観測時に 1 回 seek(loadfile の start オプションは mpv バージョン差があるため不使用)。
  保存は time-pos 5 秒毎 + pause 遷移時(keep-open の EOF 停止もここで拾う)+ 閉じる時。閾値は共通関数 `resumeValueMs`
- 視聴カウント: time-pos > 0 の初回観測で +1(実際にデコードが進んだときだけ)
- フルスクリーン: **Tauri の `window.setFullscreen`**(capability `core:window:allow-set-fullscreen`)。
  Web Fullscreen API は HTML しか全画面にできず背後の mpv に効かないため。閉じる時と unmount で必ず解除
- 音量・ミュートは localStorage を両エンジンで共用(mpv は 0-100 ↔ 0-1 変換)

### セットアップとライセンス

- dll は `npx tauri-plugin-libmpv-api setup-lib` で `src-tauri/lib/` に取得
  (`libmpv-wrapper.dll` + `libmpv-2.dll`、zhongfly/mpv-winbuild の LGPL ビルド)。**gitignore 対象**(ffmpeg と同方針)
- 配布バンドルには tauri.conf.json の `bundle.resources: ["lib/**/*"]` で同梱
- libmpv-2.dll は LGPLv2.1+(動的リンクなので同梱可)。公開配布時はライセンス表記とソース入手先
  (github.com/zhongfly/mpv-winbuild)の明記が必要(FFmpeg 同梱と合わせて公開決定時に見直し)
- 既知の癖: DevTools をドックすると mpv がドック領域の背後に見えることがある(デバッグ時はデタッチ推奨)

## AI 連携を見据えたアーキテクチャ(必守)

将来、外部 AI(MCP 経由)やアプリ内アシスタントからライブラリの検索・編集・ファイル操作を行えるようにする。そのための構造を最初から守る:

```
React UI ──→ Tauri コマンド ──┐
                              ├──→ コアサービス層 ──→ SQLite / ファイルシステム
AI (MCP) ──→ MCP ツール ──────┘      (src-tauri/src/core/)
```

1. **コアサービス層**: 検索・登録・タグ・シリーズ・ファイル操作などの本体ロジックは、UI に依存しない純粋な Rust 関数(型付き入出力)として `core/` に実装する。Tauri コマンドはその薄いラッパーに徹する。将来の MCP ツールも同じ関数を包むだけにする
2. **構造化クエリ**: 検索条件は構造化オブジェクト(テキスト / タグ / レーティング / 期間 / 尺 / 視聴状態 などの組み合わせ)で表現する。UI のフィルタも AI の検索も同じクエリ型を使う
3. **破壊的操作の安全装置**: ファイル削除は必ずごみ箱経由(trash クレート)。ファイル移動・リネーム系の操作は dry-run(実行内容のプレビュー)を返せる形で設計する
4. **操作ログ**: `operations_log(id, timestamp, actor, action, payload)` にメタデータ変更・ファイル操作を記録する(actor = user / ai)。AI に操作を許すときの監査・巻き戻しの土台

導入時期: 設計規律は v0.1 から。読み取り専用 MCP は v0.4、書き込み系 MCP は v1.1、アプリ内アシスタントは v1.3 で実装済み。

### MCP サーバー(実装済み)

- 別バイナリ `videoshelf-mcp.exe`(stdio トランスポート)。アプリが起動していなくても動く
- **既定は読み取り専用**: DB を読み取り専用フラグで開くため、AI からライブラリを変更することは構造的に不可能
- 読み取りツール: `search_videos`(構造化クエリ。text / search_path / tag / series / missing / untagged / unwatched / duplicates_only / min_rating / min_duration_sec / max_duration_sec / min_width / min_height / video_codecs / added_after / added_before / sort / limit)/ `get_video` / `list_tags` / `list_series` / `library_stats`
- **書き込みモード(v1.1)**: 環境変数 `VIDEOSHELF_ALLOW_WRITE=1` を付けて起動したときだけ、DB を読み書きで開き(`foreign_keys=ON`・`busy_timeout 5s`)、次のツールを追加公開する:
  - `tag_videos` / `untag_videos` / `add_to_series` / `remove_from_series` / `set_rating` / `set_video_info`(タイトル・コメント)
  - `remove_from_library`(登録削除。ファイルは残す)
  - `trash_video_files`(**dry_run 必須引数**。true でプレビュー、false でごみ箱送り。実行後は missing 状態で DB に残し、ごみ箱から戻せば再スキャンで復帰できる)
  - すべて operations_log に **actor='ai'** で記録される
- アプリ側は `PRAGMA data_version` を 2 秒毎に監視し、MCP など外部プロセスのコミットを検知したら `library:changed` を emit して UI に自動反映する

### アプリ内 AI アシスタント(v1.3 実装済み)

- フロント TypeScript から `@anthropic-ai/sdk`(`dangerouslyAllowBrowser: true`)で Claude API を直接呼ぶ。Rust 側に HTTP クライアントは持たない
- API キー・モデル名は settings テーブル(`anthropic_api_key` / `anthropic_model`、既定 `claude-opus-4-8`)。設定画面の「AI アシスタント」セクションで入力。**キーは library.db に平文保存され、バックアップにも含まれる**(ローカル個人用アプリとして許容)
- UI: ツールバーの ✨ で右ドックパネル(`AiPanel.tsx`)をトグル。会話履歴はパネル内 state のみ(永続化しない)。API 履歴はテキストのみ持ち回す(thinking / tool ブロックの再送問題を回避)
- ツールループ: `client.beta.messages.toolRunner` + `betaTool`(raw JSON Schema)。`thinking: adaptive`・`stream: true` でテキストをストリーミング表示
- ツール(`src/lib/aiTools.ts`。既存 Tauri コマンドの薄いラッパ):
  - 読み取り: `search_videos` / `list_tags` / `list_series`
  - 表示: `apply_filter` — Zustand の `applyFilter` でグリッドを直接絞り込み、件数を返す(自然言語検索の中核)
  - 書き込み: `tag_videos` / `set_rating` / `add_to_series` — actor="ai" で operations_log に記録。すべて可逆なメタデータ操作のため確認なしで実行し、チャット内カードで結果を必ず表示する。破壊的操作(ごみ箱送り等)はツールに含めない
- システムプロンプトに選択中の動画(ファイル名・尺・タグ等)と現在のフィルタ状態を毎回注入 →「この動画にタグを提案して」が成立する
- ビルド: `cd src-tauri && cargo build --bin videoshelf-mcp`
- Claude Code への登録例:
  `claude mcp add videoshelf -- <repo>\src-tauri\target\debug\videoshelf-mcp.exe`
  (書き込みを許可する場合は `claude mcp add videoshelf -e VIDEOSHELF_ALLOW_WRITE=1 -- ...`)
- DB の場所は既定(%APPDATA%\com.taiki.videoshelf\library.db)。環境変数 `VIDEOSHELF_DB` で上書き可

## DB バックアップ(v1.0 実装済み)

- 方式: `VACUUM INTO`(WAL 非依存の単一ファイルを出力。断片化も解消される)
- 保存先: `%APPDATA%\com.taiki.videoshelf\backups\`
- 起動時自動バックアップ: 前回から 24 時間以上経過していたら `auto-YYYYMMDD-HHMMSS.db` を作成し、auto は新しい順 5 世代だけ残す(manual は削除しない)
- 手動バックアップ: 設定画面から `manual-...db` を作成。一覧表示・フォルダを開くも設定画面から
- 復元: アプリ終了後に `library.db` をバックアップファイルで置き換える(アプリ内復元は将来検討)

## パフォーマンス原則(必守)

1. サムネイルグリッドは**必ず仮想化**(TanStack Virtual)。DOM に載せるのは可視分のみ
2. 走査・ハッシュ・ffprobe・サムネイル生成はすべて Rust 側の非同期ワーカーで。UI スレッドをブロックしない
3. 一覧クエリはページング or 仮想化前提。全件を一括で JS 側に渡さない
4. DB には適切なインデックス(path, partial_hash, video_tags の両方向, added_at 等)
5. **DB コネクションは読み書きで分ける**(v1.6)。`AppState.db` = 書き込み用、
   `AppState.db_read` = 読み取り用(`PRAGMA query_only`。`db.rs` の `open_read`)。
   一覧・件数・タグ/シリーズ一覧・設定読み出しは db_read を使い、取り込み中の UPDATE 連発で
   UI クエリがロック待ちにならないようにする(WAL なので読みと書きは並行できる)。
   **`PRAGMA data_version` の監視だけは db(書き込み用)を使うこと** —
   db_read で見ると自プロセスの書き込みコネクションのコミットにも反応し、常時 emit になる
6. 一覧クエリの行ごとにファイル I/O をしない。サムネイルの実在確認は `thumb_state` で代用し、
   読めなかったときは表示側の `img onError` でプレースホルダに落とす
7. 進捗イベント(`scan:state`)と再取得を誘発するイベント(`library:changed`)を分ける。
   後者は秒単位で間引く(`process_pending` は 2 秒に 1 回 + 完了時)

## フロントの共通ルール(v1.6)

- **Tauri コマンドは必ず `src/api.ts` の `call()` 経由で呼ぶ**。失敗を握り潰さず、右下のトースト
  (`components/Toast.tsx` / store の `pushToast`)で必ず可視化してから再スローする。
  それまで catch が無く、ffmpeg 欠落・権限エラー・外部プレイヤー起動失敗が「何も起きない」になっていた
  - 例外は `prepareVideo` / `cancelPrepare`(`call` の第 3 引数 `silent`)。
    失敗が transcode や外部プレイヤーへのフォールバックという**正常経路**であり、
    準備中に閉じたときのキャンセルでも必ず失敗するため
  - トーストは同一メッセージを重複表示しない(リトライでの連投対策)。最大 4 件、8 秒で自動消滅
- 一覧のページキャッシュ(`hooks/useVideos.ts`)は **クエリ変更では捨てるが、ライブラリ更新
  (version)では捨てない**。version で捨てると取り込み中に一覧が毎回「…」へ戻ってちらつくため、
  表示は保ったまま裏で取り直して差し替える(世代番号で古い応答を破棄)
- 同じページの取得に 2 回続けて失敗したらそのページは諦める。スクロールのたびに再要求して
  無限リトライになるのを防ぐ

## ロードマップ

- **v0.1** ✅(2026-07-24 実装済み): フォルダ登録 → スキャン → ffprobe メタデータ取得 → サムネイル生成 → 仮想化グリッド表示。ファイルの個別登録(D&D / ダイアログ)。オフラインドライブ検出。検索・ソートも実装済み
- **v0.2** ✅(2026-07-24 実装済み): タグ付け(選択+インスペクタパネル)・タグ絞り込み(複数 AND)・タグ削除。FTS5 は見送り LIKE で対応(前述)
- **v0.3** ✅(2026-07-24 実装済み): シリーズ管理(登録順の並び保持)、星レーティング、外部プレイヤー設定(settings テーブル)、視聴履歴表示、レーティング/視聴日時ソート
- **v0.4** ✅(2026-07-24 実装済み): ファイル監視(notify、1.5 秒デバウンスで自動取り込み)、missing 絞り込みとライブラリからの削除 UI、読み取り専用 MCP サーバー
- **v1.0** ✅(2026-07-24 実装済み): 設定画面(外部プレイヤー・データ保存場所の表示・サムネイル一括再生成・バックアップ管理)、DB バックアップ(下記)、ドライブレター変動対策(ボリュームシリアル記録、v0.4 繰り越し分)、検索強化(レーティング下限・尺範囲フィルタを UI と MCP の両方に追加)、user_version による簡易マイグレーション機構
- **v1.1** ✅(2026-07-26 実装済み): 書き込み系 MCP(`VIDEOSHELF_ALLOW_WRITE=1` でオプトイン。タグ・シリーズ・レーティング・情報編集、登録削除、dry-run 付きごみ箱送り。actor='ai' で監査ログ)、data_version 監視による外部変更の UI 自動反映
- **v1.2** ✅(2026-07-26 実装済み): アプリ内再生(WebView2 ネイティブ、非対応形式は onError で外部フォールバック、視聴カウントは再生成功時のみ)
- **v1.3** ✅(2026-07-26 実装済み): アプリ内 AI アシスタント(✨ パネル。自然言語検索 → apply_filter でグリッド反映、タグ提案・付与、actor='ai' 監査ログ)
- **v1.4** ✅(2026-07-26 実装済み): アプリ内再生の強化(3 段判定 + FFmpeg 事前変換キャッシュで mkv/HEVC 対応、自前プレイヤー UI + ショートカット、レジューム + カード進捗バー)
- **v1.5** ✅(2026-07-26 実装済み): libmpv 埋め込み(tauri-plugin-libmpv、透過ウィンドウ方式でメインウィンドウに全面描画。ほぼ全フォーマット直接再生、v1.4 経路はフォールバックに)
- **v1.6** ✅(2026-07-26 実装済み): 不具合修正と基盤改善。フォルダをまたぐ移動での二重登録を修正
  (回帰テスト付き)、読み書き DB コネクションの分離、一覧クエリの I/O 削減、取り込み中の
  `library:changed` 間引き、API 失敗のトースト表示、ページキャッシュのちらつき解消とリトライ上限。
  あわせて**ホバープレビュー**(元動画の直接再生 + マウス位置でシーン送り、生成キャッシュなし)と、
  実測に基づく `decidePlayback` の楽観化(mkv を native に。remux 待ちが減る)
- **v1.7** ✅(2026-07-26 実装済み): 検索・分類の刷新。`VideoQuery` の拡張(空白区切り AND / パス検索 /
  タグなし / 未視聴 / 解像度 / コーデック / 追加日範囲)、決定的シャッフルによるランダムソート、
  タグの階層と色(再帰 CTE で親タグに子孫を含める)、スマートフォルダ、重複ファイル検出、
  統計ダッシュボード(`core/stats.rs` に集約して MCP と共有)。あわせて vitest / cargo test の
  テスト基盤とプロジェクト名・バージョンの整理
- **v1.8** ✅(2026-07-26 実装済み): 一覧操作と再生。範囲選択(Shift+クリック)・Ctrl+A・矢印移動・
  Enter 再生、サムネイルサイズ変更と詳細リスト表示(同じ仮想化に載せる)、連続再生とプレイリスト
  (⏭ / N・自動送り設定)、mpv の音声・字幕トラック切替、サムネイルのコマ選び
  (`thumbnail` フィルタで暗転回避 + 再生位置からの手動指定)、視聴カウント条件の見直し、
  孤児サムネイルの掃除
- **将来**: フォールバック側の HLS 追いかけ再生、mac/Linux 対応

## 今後のタスク(未着手・優先度順)

1. **missing の再リンク** — フォルダ単位のパス一括置換(dry-run 付き)。今は「削除」しか出口がない
2. **ファイルのリネーム / 移動** — dry-run 設計は宣言済みだが機能自体が未実装

その他(細かい改善):

- 操作履歴 UI と取り消し(`operations_log` に貯めているのに閲覧手段がない)
- バックアップのアプリ内復元
- API キーの暗号化(現状は `library.db` に平文。Windows DPAPI)
- D&D でフォルダを落としたとき、監視フォルダにするか個別登録かを尋ねる
