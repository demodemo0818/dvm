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

### 所属(watched_folder_id)の決め方(v1.10 で整理)

- **常に「そのパスを含む最も深い監視フォルダ」に所属させる**(`library.rs` の `deepest_owner`)。
  スキャン中のフォルダの id を無条件に振らない。親フォルダを後から監視フォルダに追加しても、
  既に子フォルダに所属している動画を親が奪わない。
  watcher.rs のイベント振り分けと fileops.rs の `owning_folder` も同じ判定
- **既にパスが登録済みのレコードでも所属を張り直す**(`COALESCE(?, watched_folder_id)`)。
  監視フォルダを解除すると FK の `ON DELETE SET NULL` で `watched_folder_id` が NULL になるため、
  同じフォルダを登録し直したときにここで拾わないと**「動画はあるのに件数 0」**になる(v1.10 修正)。
  COALESCE なので個別登録(folder_id = None)経路では既存の所属を消さない
- 壊れている既存 DB は、起動時の `run_scan_all` か監視フォルダの再登録で自動的に直る

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
| dirPath | このフォルダ**直下**の動画だけ(v1.10。サブフォルダは含まない) |

- `where_clause()` は `(SQL, Vec<String>)` を返す。複数語 LIKE とコーデック・日付をバインドするため
  (i64 の条件は従来どおり直接埋め込む。文字列だけをパラメータにする)
- **ランダムソートは `RANDOM()` を使わない**。ページごとに順序が変わって仮想化と両立しないため、
  `id` と種から決定的に並べる: `t = (id * 2654435761) % 1000003` を作り `t * (t + seed) % 1000003` で並べる。
  掛け算と剰余だけだと id に対して線形になり件数が少ないとシャッフルされないので、二乗を混ぜて非線形にしている
- タグ階層は再帰 CTE(`WITH RECURSIVE`)を `IN` の中に置く。親タグを選ぶと子孫タグ付きの動画も出る
- 重複判定は `(size, partial_hash) IN (... GROUP BY ... HAVING COUNT(*) > 1)`。
  `partial_hash IS NULL`(未算出)は「不明」であって重複ではないので除く

### フォルダーツリー(v1.10)

サイドバーを **「ライブラリ」/「フォルダー」のタブ切り替え**にした。上部の全体行
(すべての動画 / ⚠ 見つからない / ⧉ 重複)はタブの外に残し、どちらのタブでも絞り込みを解除できる。
選択中のタブは settings の `sidebar_tab` に永続化する。

**フォルダで絞る手段は 2 系統あり、意図的に併存させている**:

| | 条件 | UI | 範囲 |
|---|---|---|---|
| 監視フォルダ | `folderId`(= `watched_folder_id`) | 「ライブラリ」タブの監視フォルダ一覧(従来どおり) | その監視フォルダ由来の動画**すべて**(サブフォルダ含む) |
| フォルダーツリー | `dirPath` | 「フォルダー」タブのツリー(v1.10) | そのフォルダ**直下**だけ(エクスプローラーと同じ) |

store 側では排他にしている(`setFolderId` / `toggleDirPath` が互いを null にする)。
AND で重ねると 0 件になりやすく、ユーザーの意図としても「どちらか一方」だから。

#### DB に階層を持たない

`videos` にはフルパス 1 本しか持たず、`dir_path` 列も `folders` テーブルも足していない。
列を足すと `upsert_file` / 移動 / 再リンク / `drive_remap` の全書き込み経路を更新することになり、
得られる速度に見合わないため。代わりに `core/folders.rs` の `folder_tree()` が
**`SELECT path FROM videos` を 1 回読んで Rust 側で畳み込む**(5 万件で数十 ms)。

- **ディスクを走査しない**。外付け HDD / NAS が未接続でもツリーは即座に出る
  (オフライン判定だけルート単位で `RootCache`)。動画が 1 本も無いフォルダは出ない
- ルートは監視フォルダ。どの監視フォルダにも属さないパスは、その動画の親ディレクトリ自体を
  ルートにして「その他の場所」にまとめる
- ルート判定に `videos.watched_folder_id` は使わず**パスだけ**を見る。
  D&D で個別登録したファイルも、監視フォルダ配下にあればそのツリーに出る
- **他の監視フォルダの中にある監視フォルダはルートにしない**(v1.10)。
  親フォルダを後から登録したときにトップレベルへ同じ階層が 2 つ並ぶのを防ぐため、
  入れ子の監視フォルダは親のツリーの中の 1 ノードとして出す(監視フォルダの印は残す)。
  こうすると親の `totalCount` に子の中身も乗るので件数の辻褄も合う
- ノードのキーは小文字化した正規パス。大文字小文字や `/` `\` の揺れでノードを割らない
- 呼ぶのは「フォルダー」タブを開いているときの `version` 変化時だけ
- 件数は**直下の件数**(= クリックすると出る件数)を出す。0 のときは数字を出さない
  (中継ぎのフォルダが「0」だらけになるため)。配下の合計はツールチップに出す

#### メインビューのフォルダカード

`dirPath` で絞っているときだけ、**一覧の先頭にサブフォルダをカードとして並べる**
(`FolderCard.tsx`。ダブルクリックで開く = その `dirPath` に切り替える)。
先頭には「↰ 上のフォルダ」を置く。ライブラリの外(監視フォルダより上)へは登らせない。

- データは `core/folders::subfolders()` /コマンド `list_subfolders`。
  **ツリー全体は組み直さず、そのフォルダ配下の動画だけを読む**ので、潜るたびに呼んでも軽い
- 返すパスは `canonical_dir()` で **DB に入っている表記に直してから**返す。
  そのまま次の絞り込み条件になるので、呼び出し側の大文字小文字に引きずられないようにする
- **フォルダは動画とは別の行に置く**(1 行の中で混ざらない)。
  こうしておけば選択・範囲選択・キーボード移動は従来どおり動画の通し番号だけで考えられる
  (`scrollToIndex` にフォルダ行数を足すだけで済む)。フォルダは選択の対象にしない
- グリッド / 詳細リストのどちらでも同じ仮想化に乗る(行高は動画カードと同じ)
- 一覧側で潜ったときはサイドバーのツリーも祖先を自動展開して追従する

#### `dirPath` の SQL に LIKE を使わない

パスには `%` `_` が普通に含まれる(`100%_test` のようなフォルダ名)ので、LIKE だと
エスケープ漏れで無関係なフォルダを巻き込む。`core/volumes.rs` と同じく `substr` 比較にした:

```sql
lower(replace(substr(path, 1, N), '/', '\')) = ?k       -- そのフォルダで始まる
AND instr(replace(substr(path, N + 1), '/', '\'), '\') = 0  -- 残りに区切りが無い = 直下
```

大文字小文字の畳み方は **ASCII のみ**にして SQLite の `lower()` に合わせる
(Rust の `to_lowercase()` は非 ASCII も畳むので、ICU 無しの SQLite と食い違う)。

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

- **Rust**: `cargo test`。`core/query.rs`(検索条件・ランダムソートの安定性・LIKE エスケープ・
  dirPath の直下判定)、`core/folders.rs`(フォルダーツリーの構築)、
  `core/tags.rs`(タグ階層の循環拒否・色の形式)、`core/smart_folders.rs`、`core/stats.rs`、
  `core/library.rs`(移動検出)、`db.rs`(読み書きコネクション分離)。
  SQL は文字列比較ではなく**インメモリ DB に本物のスキーマを流して実行結果で検証する**
  (`db::apply_schema` をテストから呼べるように公開している)
- **フロント**: `npm run test`(vitest + jsdom)。純関数のみを対象にする —
  `decidePlayback` / `resumeValueMs` / `fmtTime` / `buildQuery`
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

- 自前コントロール(素の React。外部プレイヤーライブラリ依存なし): シークバー(バッファ表示付き)・再生/停止・時刻・再生速度(0.5〜2x)・音量/ミュート(localStorage に記憶)・フルスクリーン(Web Fullscreen API)・連続再生トグル(v1.12)・リピート再生トグル(v1.13)・表示サイズトグル(v1.12、mpv のみ)
- ショートカット: Space/K=再生⇄停止、←→=±10 秒、↑↓=音量、M=ミュート、F=フルスクリーン、< >=速度、
  N/P=次/前の動画(v1.8)、T=現在位置をサムネイルに(v1.8)、A=連続再生の切替(v1.12)、
  R=リピート再生の切替(v1.13)、U=表示サイズ 等倍⇄フィット(v1.12、mpv のみ)、
  Esc=閉じる(フルスクリーン中は解除のみ)
  - **A / R / U は修飾キー付きを弾く**。Ctrl+A(全選択)や Ctrl+R(再読み込み)は手が
    覚えているので、うっかり設定を書き換えないようにする
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
- キーボード: 矢印(±1 / ±列数)・Home / End・Enter で再生・Esc で解除・**Delete で削除**(v1.14)。
  ハンドラは window に付け、**プレイヤー表示中と input/textarea/select にフォーカスがある間は素通し**する
- 絞り込みが変わったら選択・anchor・focus をまとめて捨てる(store の `CLEARED`)。
  選択だけ消して anchor が残ると次の Shift+クリックが的外れな範囲を選ぶ

### 右クリックメニュー(v1.14)

一覧のカード / 行を右クリックするとメニューを出す。OS ネイティブのメニューではなく
**React の自前コンポーネント**(`components/ContextMenu.tsx`)。Lucide アイコンと暗いテーマを
そのまま使えること、レーティングのような動的な項目を TS だけで組めることを優先した
(ネイティブだとアイコンが出せず、Windows がライトテーマだと真っ白なメニューが浮く)。

- **項目の中身と有効・無効は `lib/contextMenu.ts` の純関数が決める**
  (`buildVideoMenu(selection, target)` / `buildFolderMenu()`)。コンポーネントは
  受け取った配列を描画するだけ。「複数選択 × オフライン × 見つからない」の組み合わせは
  目視で確認しきれないので、判定はテストできる場所に閉じ込める(`contextMenu.test.ts`)
- **選択の扱いはエクスプローラー準拠**。選択の外を右クリックしたらそこへ選択を移し、
  選択済みを右クリックしたら選択を保ったまま全件を対象にする。
  メニューを見る前に「何が対象か」が見た目で分かるのが要点
- **使えない項目は消さずに disabled で残す**。選択件数やオフラインかどうかで項目の位置が
  動くと、「いつもの位置をクリックしたら別のものが実行された」が起きる。
  押せない理由は `title` で見せるため、無効項目は `<button disabled>` ではなく
  `<div aria-disabled>` で描く(Chromium は disabled な button のホバーを拾わない)
- **メニュー中はグリッドのキー操作を止める**。store の `contextMenuOpen` を
  `VideoGrid` の keydown と `App` の Esc(選択解除)が見る。止めるだけだと矢印が
  無反応になるので、代わりにメニュー側で ↑↓ 移動・Enter 実行・→ サブメニュー・← 戻るを処理する
- **メニューは仮想化スクロール領域の外に描く**。中に置くと virtualizer の `transform` が
  `position: fixed` の基準になり、スクロールに引きずられる。
  スクロールしたら閉じる(対象のカードが DOM から消えて、何に対するメニューか分からなくなるため)
- 項目を実行する前に**閉じてから 1 拍おく**。「名前を変更」の `window.prompt` は同期で
  スレッドを止めるので、すぐ呼ぶとメニューが画面に残ったままダイアログが出る
- サブフォルダカードには「開く / エクスプローラーで表示 / パスをコピー」の 3 項目だけ出す。
  グリッドの余白は従来どおり選択解除のみで、メニューは出さない

**Delete キーと削除の入口の一本化(v1.14)**:

- Delete を押すと `DeleteDialog` が開き、「ライブラリから削除」か「ファイルをごみ箱へ」かを
  選ばせる。**キーを押した時点ではどちらの意図か分からないので、ここで必ず一度止める**。
  Shift+Delete のような修飾キーでの出し分けにはしていない —
  押し間違いで実ファイルが消える方向に倒れるのを避けたいため
  (右クリックメニューはどちらの削除かを指定して選ぶので、このダイアログは通らない)
- ダイアログ自体が確認なので「ライブラリから削除」を選んだら `ask()` で二重に尋ねない。
  「ごみ箱へ」は従来どおり `FileOpDialog` の dry-run プレビューを挟む
- 選択が空になったらダイアログを閉じる。Esc は App 側で選択解除に割り当てられているので、
  結果として「Esc でダイアログも閉じる」になる
- **詳細ペインからファイル操作を外した**(名前を変更 / 移動 / ライブラリから削除)。
  同じ操作の入口が 2 か所にあると片方だけ直して挙動がずれる。
  詳細ペインはレーティング・タグ・シリーズの編集に専念させる

**項目を足すかどうかの基準**(機能を追加したときはここを見て判断する):

- 載せる: 選択中の動画そのものに対する操作で、ダイアログ 1 枚までで完了するもの
- 載せない: アプリ全体の設定・一括処理(設定画面・統計・再スキャン)。
  候補一覧から選ぶ入力が要るもの(タグ・シリーズは詳細ペインの担当)
- 目安 12 項目を超えたら、新項目はサブメニューに畳むか既存項目を見直す

**依存とコマンド**:

- 「エクスプローラーで表示」は `plugin-opener` の `revealItemInDir`。
  `opener:default` に `allow-reveal-item-in-dir` が含まれるので capability の変更は要らない
- 「フルパスをコピー」は `navigator.clipboard`(WebView2 は localhost 扱いで secure context)。
  clipboard プラグインは入れない
- 「既定のアプリで開く」は `open_with_default`。**外部プレイヤー設定を無視して**常に
  Windows の関連付けで開く(`open_video` は設定に従うので別コマンドにした)。
  「他のプログラムから開く」は `open_with_dialog` = `rundll32 shell32.dll,OpenAs_RunDLL`
- 「ごみ箱へ」は `plan_trash` / `apply_trash`。コアの `videos::plan_trash` / `trash_files` は
  MCP と共有しているのでそのまま使い、コマンド側で `PlanItem` / `OpResult` に詰め替える。
  **コアは is_missing=1 にして DB レコードを残すが、UI から実行したときは続けて
  `remove_videos` も呼ぶ** — 「捨てたのに一覧に残っている」は不具合にしか見えないため。
  代償として、ごみ箱から戻してもタグ・レーティング・視聴回数は復元されない
  (`FileOpDialog` の説明文で明示している)
  - 既知の制限: `trash_files` は進捗コールバックを持たないので、ごみ箱送りの進捗バーは出ない。
    数百件をまとめて捨てると「実行中...」のまま待つことになる

### 表示モード(v1.8)

- `viewMode`(grid / list)と `cardWidth` を settings に永続化(`view_mode` / `card_width`)
- **仮想化は共通**。`useVirtualizer` の `estimateSize` と列数を切り替えるだけで両モードに載る
  - grid: 列数 = 幅 ÷ cardWidth、行高 = cardWidth × 0.5625 + 56
  - list: 1 列・行高 44px 固定。サムネ 64px / 名前 / 尺 / サイズ / 解像度 / ★ / 追加日
- **リスト行にホバープレビューは付けない**。行が細く、マウスが横切るだけで次々に元動画を
  開くことになるため(カードは面積が大きいので誤爆しにくい)

### アイコン(v1.13)

UI のアイコンは **Lucide(`lucide-react`、ISC)に統一**する。**絵文字は使わない** —
フォントによって字幅・線の太さ・カラー/白黒がばらつき、Windows では Segoe UI Emoji の
カラー絵文字で描かれて暗いテーマから浮いていた(v1.11 で `▶`/`▼` をやめたのと同じ問題が
アプリ全体で起きていた)。

- **既定の大きさ(16px)と線の太さ(1.75)は `main.tsx` の `LucideProvider` で 1 回だけ
  決める**。呼び出し側では指定しない。枠に合わせて大きく出す場所(フォルダカードの
  34px など)だけ `size` を明示する
- 色は指定しない。Lucide は `stroke="currentColor"` なので、既存の `:hover` や
  `.active` の `color` がそのまま効く。行頭の控えめなアイコンは `.tag-mark`(灰)を付ける
- CSS 側は配置だけを見る(`svg.lucide { flex: none; display: block }`)。
  `display: block` は、inline の SVG が baseline に乗って行が 1〜2px ずれるのを防ぐため
- **外部フォントや CDN は使わない**。npm パッケージからビルド時に埋め込むので
  オフラインで動く(アイコン 25 個で bundle +約 10 kB。`sideEffects: false` で
  使っていないアイコンは落ちる)
- **残している記号**: レーティングの `★`/`☆`(星以外に代えようがない慣例)と、
  タグ色・接続状態の丸(`.tag-dot` / `.dot`。文字ではなく CSS の円)
- Lucide v1 では一部が改名されている(`BarChart3` → `ChartColumn`、
  `History` → `RotateCcwClock`)。アイコン名は使う前に実物で確認すること

### シークバーのコマ出し(v1.14)

シークバーにカーソルを合わせると、その位置の時刻とコマを出す(`player/SeekPreview.tsx`)。

- **見えない `<video>` をもう 1 本持ち、`currentTime` を動かしてそのコマを見せる**。
  スプライトシートの事前生成はしない — ホバープレビューと同じ判断で、
  ライブラリ 1 万件ぶんのキャッシュを持たずに済ませる(前述「生成キャッシュを持たない理由」)
- 使う src はエンジンで変える。**WebView2 経路は再生中と同じ src**(変換経路なら
  キャッシュ mp4 なので確実に読める)、**mpv 経路は元動画そのもの**。
  mpv でしか再生できない形式では WebView2 が読めないので、`onError` で静かに諦めて
  時刻表示だけを残す
- シーク中に次の要求が来たら最後の 1 つだけ覚えて `seeked` で反映する
  (移動のたびに `currentTime` を叩くと外付け HDD / NAS で詰まる。HoverPreview と同じ手当て)
- **バーに乗ってから 80ms 待ってから読みに行く**(`PREVIEW_DELAY_MS`)。
  ボタンへ向かう途中でバーを横切っただけで外付け HDD を起こさないため。
  時刻表示は待たずに即出す
- コマは `pointer-events: none`。バーの上に重なるので、拾うと自分自身で
  `pointerleave` を起こしてちらつく
- 画面端では回り込ませる(`PREVIEW_W` の半分でクランプ)。
  **この定数は CSS の `.seek-preview-video` の幅と一致させること**
- 設定「再生中、シークバーにカーソルを合わせるとその位置のコマを表示する」
  (`seek_preview`、既定 ON)で切れる。**カードのホバープレビューとは別設定**にしている —
  こちらは mpv で再生している最中に WebView2 が同じファイルをもう 1 本デコードするので、
  重いファイルで本編がカクつくなら単独で切りたい

### スライダー(v1.13)

サムネイルの大きさ(`.card-size`)と音量(`.player-volume`)の 2 か所。

- 既定の見た目は `accent-color` しか触れず、track の細さも つまみの大きさも詰められないので
  `::-webkit-slider-*` で自前に組む(WebView2 は Chromium なので前提にしてよい)
- **左側の塗りは JS から `--fill`(%)を渡してグラデーションで描く**。ネイティブの range には
  「ここまで塗る」を CSS だけで表す手段が無いため。値を持っているのは React 側なので、
  `style` にカスタムプロパティを載せるのが一番素直
- 当たり判定は track(4px)ではなく input の高さ(14px)で稼ぐ。つまみは hover / drag 中だけ
  少し大きくする
- 枠は `:focus-visible` だけに出す(クリックでは出さない)
- カード幅は 140〜400px を 4px 刻みで動かすので、track を 90px から 110px に伸ばした
  (90px では 1 段が 1.4px しか動かず合わせづらかった)

### 画面まわりの調整(v1.11)

実際に使ってみて引っかかった細かい操作性をまとめて直した。DB とコアロジックは触っていない。

- **ツリーの開閉三角は 1 種類のアイコン**にして、閉じているときだけ CSS で `rotate(-90deg)`
  する。形を差し替えると大きさが違って見えるため。当たり判定も 20×20px に広げた
  (`.tree-toggle`。v1.11 では `▼` の字、v1.13 から `ChevronDown`)
- **詳細ペインの固定表示**: `inspectorPinned`(ツールバーのボタン / 設定 `inspector_pinned`)。
  固定中に選択が空なら見出しと案内文だけを出す — レーティングやタグは選択が無いと操作できないため。
  表示判定(`inspectorPinned || selection.length > 0`)は幅を変える帯と共有するので App.tsx に置く
- **ペイン幅の伸縮**: `components/PaneResizer.tsx`。`.app` の flex 直下に兄弟として挟む。
  幅は `sidebarWidth` / `inspectorWidth`(設定 `sidebar_width` / `inspector_width`)で、
  **保存はドラッグを離したときだけ**(カード幅スライダーと同じ)。
  丸めたあとの値を保存したいので `onCommit` は `useLibrary.getState()` から読み直す。
  ダブルクリックで既定幅に戻る。AI パネルは対象外(必要なら同じ部品で足せる)
- **スクロールバー**: `:root { color-scheme: dark }` でネイティブ部品を暗く描かせたうえで、
  `::-webkit-scrollbar` 系で細い暗色バーにする。
  **標準の `scrollbar-width` / `scrollbar-color` は書かない** —
  新しい Chromium では標準側が指定されていると `::-webkit-scrollbar` が無視されるため
- **「この位置をサムネイルにする」を下のコントロールバーへ移動**。
  上のバーで閉じるボタンの隣にあり誤爆していた。`PlayerControls` の
  optional prop `onSetThumbnail` にしたので、mpv / WebView2 の 2 か所にあった重複も消えた
  (アイコンは v1.13 で `Camera` に置き換え。絵文字のときは異体字セレクタが無いと
  Windows で白黒グリフに落ちるという別の問題を抱えていた)

### 連続再生(v1.8)

- store の `playQueue = { query, index, total }`。**プレイヤーはクエリと位置だけを持ち、
  次の 1 件は `query_videos(query, 1, index+1)` で Rust から都度引く**。
  グリッドのページキャッシュに依存しないので、再生中にソートを変えても次は新しい並びで来る
- ⏮ ⏭ ボタンと `N` / `P` キー。終了時の自動送りは設定 `autoplay_next`(既定 OFF)
  - mpv は `keep-open=yes` で EOF でも pause 状態で止まるだけなので、
    「終端 1 秒以内 + paused」を最後まで観たとみなす(手動の一時停止と区別する)
  - WebView2 経路は `onEnded`
- **コントロールバーの 🔁 と `A` キーからも即時切り替えできる(v1.12)**。
  ハンドラは `usePlayQueue.ts` の `useAutoplayToggle`(store と `api.setSetting` を同時に更新。
  ツールバーの `inspector_pinned` と同じパターン)。設定モーダルは開くたびに `getSetting` するので値は自然に一致する
  - ボタンは **engine 非依存なので両エンジンに出す**(mpv の判定 effect / WebView2 の `onEnded` の
    どちらも `autoplayNext` を見ている)。単発再生でも隠さない — ⏮⏭ と違って永続設定なので、
    消えると設定の在り処が分からなくなる
  - mpv 側の判定 effect は `autoplayNext` を **ref 経由で読み deps に入れない**(v1.12)。
    終端で止まったまま ON にした瞬間に effect が再実行され、設定を変えただけで次の動画へ
    飛んでしまうため。`advanced` ラッチを立てる対処は「シークして観直しても自動送りが効かない」
    副作用があるので採らない。結果として WebView2 の `onEnded`(イベント駆動なので後から
    設定を変えても発火しない)と同じ意味論になる
- 外部プレイヤー設定時は従来通り外部起動で、連続再生の対象にしない

### 音声・字幕トラックの切替(v1.8、mpv のみ)

- `MPV_OBSERVED` に `track-list` を追加して購読し、`aid` / `sid` を setProperty で切り替える
  (無効化は `'no'`)
- `VideoPlayer` インターフェイスの `tracks` / `setTrack` は **optional**。
  WebView2 側は実装しないので UI にも出ない
- 音声は 2 本以上あるときだけ出す。字幕は「オフ」に切り替えたいので 1 本でも出す

### リピート再生(v1.13)

今見ている 1 本を繰り返す。全体リピートは作っていない(連続再生と意味が重なるため)。

- 状態は store の `repeatOne` だけ。**settings には保存しない** — 短い動画をループさせた
  まま次のセッションに持ち越すと、連続再生が壊れたように見えるため。アプリを再起動すれば戻る
- ループそのものは engine 側が持つ。**mpv は `loop-file`(`'inf'` / `'no'`)**、
  **WebView2 は `<video loop>`**。どちらも「リピート中は EOF に到達しない」ので、
  連続再生の判定は自然に発動しない — **排他制御のコードは書かなくてよい**
- `loop-file` も loadfile を跨いで残るグローバルなプロパティなので、`useMpvPlayer` の
  effect で `repeatOne` が変わるたびに押し込むだけでよい(mount 時にも走る)
- アイコンは `Repeat1`(ループに 1 が入った形)。連続再生は `ListVideo`(プレイリスト)。
  v1.12 では連続再生にループ記号を使っていて、リピートと見分けが付かなかった

### 表示サイズ(等倍表示)(v1.12、mpv のみ)

解像度がウィンドウより小さい動画が無条件に拡大されてぼやけるのを避けるためのトグル
(`1:1` ボタン / `U` キー)。

- mpv の `video-unscaled` を切り替える。**フィット = `no` / 等倍 = `downscale-big`**
  - `yes` は「ウィンドウより大きい動画を**切り取る**」挙動なので使わない(4K を開くと画面外が切れる)。
    `downscale-big` なら小さい動画は等倍、大きい動画は従来どおり縮小して収まる
- 状態は `VideoPlayer` の optional メンバ `unscaled` / `toggleUnscaled`(`tracks` / `setTrack` と
  同じ扱い。WebView2 側は実装しないので UI にも出ない)。永続化は localStorage(`player_unscaled`)
- **`MPV_OBSERVED` には追加しない**。`input-default-bindings: 'no'` なので mpv 側から値が変わる
  経路が無く、手元の state が唯一の真実になる。購読すると押した瞬間にボタンが光らない
  (`setTrack` が手元を先行更新しているのと同じ問題)。起動時の `getProperty` 照会も不要
- 適用は `useMpvPlayer` の mount effect で `run()`(握りつぶし)。
  **MpvPlayerView の再生開始 effect に `await` で混ぜない** — あの chain の失敗は `onFail()` に
  繋がっており、古い libmpv で値が通らなかっただけでファイルが WebView2 の再エンコード経路へ
  落ちてしまう。ファイルに依存しないオプションなので loadfile の前後は問わない
- フルスクリーンでもモードは保たれる(VO がウィンドウサイズから表示矩形を再計算するのでコード不要)。
  大画面で小さい動画が中央に等倍で出るのは仕様どおりで、自動でフィットに戻す特別扱いはしない
- 等倍は**物理ピクセル基準**なので、高 DPI(150% スケーリング等)では CSS ピクセル換算より
  小さく見える。mpv の挙動として正しい

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
- 音量・ミュートは localStorage を両エンジンで共用(mpv は 0-100 ↔ 0-1 変換)。
  表示サイズ(`video-unscaled`)も localStorage に記憶するが mpv 専用(`player_unscaled`、v1.12)

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
4. **操作ログ**: `operations_log(id, timestamp, actor, action, payload, undone_at)` にメタデータ変更・ファイル操作を記録する(actor = user / ai)。**payload は構造化 JSON で、逆操作に必要な変更前の値を持たせる**(v1.9。詳細は「操作履歴と取り消し」)

導入時期: 設計規律は v0.1 から。読み取り専用 MCP は v0.4、書き込み系 MCP は v1.1、アプリ内アシスタントは v1.3 で実装済み。

### MCP サーバー(実装済み)

- 別バイナリ `videoshelf-mcp.exe`(stdio トランスポート)。アプリが起動していなくても動く
- **既定は読み取り専用**: DB を読み取り専用フラグで開くため、AI からライブラリを変更することは構造的に不可能
- **ファイル操作系(リネーム・移動・再リンク)は MCP に公開していない**。dry-run のプレビューを
  人が承認する前提の機能なので、AI から直接呼べる形にはしない(v1.9)
- 読み取りツール: `search_videos`(構造化クエリ。text / search_path / dir_path / tag / series / missing / untagged / unwatched / duplicates_only / min_rating / min_duration_sec / max_duration_sec / min_width / min_height / video_codecs / added_after / added_before / sort / limit)/ `get_video` / `list_tags` / `list_series` / `library_stats`
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

## ファイル操作(v1.9)

**実行前に必ず dry-run の結果を表で見せ、ユーザーが承認して初めて実行する。**
プレビューを飛ばして実行できる導線は作らない。`core/fileops.rs` に集約し、
既存の `videos::plan_trash` / `trash_files` と同じ二段構えにしている。

| 状態 | 意味 |
|---|---|
| `Ok` | 実行できる(これだけが実行対象) |
| `Conflict` | 変更後の場所に別のファイルがある(上書きしない) |
| `SourceMissing` | 変更前のファイルが無い / 移動先フォルダが無い |
| `Offline` | ドライブ未接続(消えたのか未接続なのか区別できないので触らない) |
| `Unchanged` | 変更前後が同じ |

### 再リンク(#5)

- **DB の path を書き換えるだけでファイルには触らない**(最も安全なので先に実装した)
- 対象は「指定プレフィックスで始まる path」。Windows のパスは大文字小文字を区別せず、
  `/` と `\` の揺れも吸収する。無関係なパスを巻き込まないよう境界(`\`)まで見る
- 変更後の場所に実体があるものだけ `Ok`。適用後は実在確認で `is_missing` を張り直す
- 導線: サイドバーの「⚠ 見つからない」を開くと「パスを再リンク...」が出る

### リネーム / 移動(#6)

- 同一ボリュームなら `std::fs::rename`、別ボリュームなら copy + remove。
  コピー後に元が消せなかったらコピーを取り消して「失敗」に倒す(2 か所に残さない)
- **1 件ずつコミットする**。全体を 1 トランザクションにすると途中失敗で実ファイルと DB がずれる。
  失敗は個別に報告して残りは続ける
- 実行の直前にもう一度衝突を確認する(プレビューを見ている間に状況が変わりうる)
- 移動先が監視フォルダ配下なら `watched_folder_id` を張り替える。
  notify が同時に発火しても `library.rs` の移動検出が冪等なので二重登録にはならない
- 進捗は `fileop:progress` イベント(大きいファイルの別ドライブ移動は時間がかかる)

## 操作履歴と取り消し(v1.9)

- `operations_log.payload` を **構造化 JSON に統一**した。逆操作に必要な変更前の値を持たせるため
  (v1.9 より前の自由文字列は「古い形式」として取り消し不可にする)
- `operations_log.undone_at`(v3→v4 マイグレーション)で取り消し済みを記録。二重取り消しを拒否する
- **取り消せるのは可逆なメタデータ操作だけ**:
  `tag_videos` / `untag_videos` / `add_to_series` / `remove_from_series` / `set_rating` /
  `set_video_info` / `rename_tag` / `relink`
  - タグ・シリーズ追加は**実際に変化した組だけ**を payload に記録する。
    元から付いていたものまで記録すると、取り消しでそれも外れてしまう
  - `set_rating` は動画ごとの変更前の値を対応表で持つ(一律の値にする操作なので「1 つ前」では戻せない)
  - `remove_from_series` は position ごと控えて並び順まで戻す
- **取り消せない**(UI に理由を出す): `trash_file`(ごみ箱から手動で戻す)/ `remove_videos` /
  `move_file` / `rename_file`(逆向きの操作を実行してもらう)/ `drive_remap` / スキャン系
- UI はツールバーの 🕘(`HistoryModal.tsx`)。actor(user / ai / system)バッジ付き

## DB バックアップ(v1.0 実装済み)

- 方式: `VACUUM INTO`(WAL 非依存の単一ファイルを出力。断片化も解消される)
- 保存先: `%APPDATA%\com.taiki.videoshelf\backups\`
- 起動時自動バックアップ: 前回から 24 時間以上経過していたら `auto-YYYYMMDD-HHMMSS.db` を作成し、auto は新しい順 5 世代だけ残す(manual は削除しない)
- 手動バックアップ: 設定画面から `manual-...db` を作成。一覧表示・フォルダを開くも設定画面から

### アプリ内復元(v1.9)— 次回起動時に適用する方式

起動中に `library.db` を差し替えると、開いているコネクション(書き込み用・読み取り用・
`data_version` 監視スレッド)と競合して壊れる。そこで**予約 → 次回起動時に適用**にした:

1. `restore_backup`: バックアップを読み取り専用で開いて検証(SQLite として開けるか +
   videos テーブルがあるか)。壊れたファイルを予約すると次回起動できなくなるため必須
2. 現行 DB を `pre-restore-YYYYMMDD-HHMMSS.db` として退避(取り違えても戻せる。
   `prune_auto` は `auto-` だけを消すのでこれと manual は残る)
3. データディレクトリに `restore.pending`(適用したいパス)を書いて再起動を促す
4. 次回起動時、`lib.rs` の setup が **`db::init` より前**に `apply_pending_restore` を呼んで
   差し替える。予約は成否にかかわらず消す(失敗したまま毎回試し続けないため)。
   古い `-wal` / `-shm` も消す(新しい本体と食い違うため)

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
- **v1.9** ✅(2026-07-26 実装済み): ファイル操作と履歴。dry-run 必須の確認ダイアログを共通基盤に、
  missing の再リンク(DB のパス一括置換)とファイルのリネーム / 移動、操作履歴 UI と取り消し
  (payload を構造化 JSON に統一)、バックアップのアプリ内復元(次回起動時に適用)、
  D&D でフォルダを落としたときに監視フォルダか個別登録かを尋ねる
- **v1.10** ✅(2026-07-26 実装済み): フォルダーツリーによる絞り込み。サイドバーを
  「ライブラリ」/「フォルダー」のタブ切り替えにし、`videos.path` から組み立てたフォルダ階層で
  **直下だけ**に絞れるようにした(`VideoQuery.dirPath`)。一覧の先頭にサブフォルダのカードを出し、
  ダブルクリックでエクスプローラーのように潜れる。従来の「監視フォルダ = 配下すべて」は
  そのまま併存。DB スキーマは変更なし(前述「フォルダーツリー」節)
- **v1.11** ✅(2026-07-26 実装済み): 画面まわりの調整。ツリーの開閉三角のサイズ統一、
  詳細ペインの固定表示、サイドバー / 詳細ペインの幅をドラッグで伸縮、暗いテーマに合わせた
  スクロールバー、サムネイル設定ボタンを下のコントロールバーへ移動(前述「画面まわりの調整」節)
- **v1.12** ✅(2026-07-26 実装済み): プレイヤーの表示・再生トグル。表示サイズ(等倍⇄フィット。
  mpv の `video-unscaled` を `downscale-big` / `no` で切り替え)と連続再生を、コントロールバーの
  ボタンと `U` / `A` キーから切り替えられるようにした。DB・Rust・capability は変更なし
  (前述「表示サイズ(等倍表示)」「連続再生」節)
- **v1.13** ✅(2026-07-26 実装済み): アイコンの統一とリピート再生。UI の絵文字を全面的に
  Lucide の SVG アイコンへ置き換え(既定サイズ・線の太さは `LucideProvider` で一元管理)、
  紛らわしかった連続再生のループ記号を `ListVideo` に変更したうえで、本来のリピート再生
  (`Repeat1` / `R` キー)を追加した。あわせてスライダーを自前のスタイルにし、
  サムネイル設定ボタンのアイコンを `GalleryThumbnails` にした(`Camera` は「撮影」に
  見えて紛らわしかった)。DB・Rust は変更なし
  (前述「アイコン」「スライダー」「リピート再生」節)
- **v1.14** ✅(2026-07-27 実装済み): 右クリックメニュー。一覧のカード / 行に 12 項目の
  メニューを出し、再生・レーティング・OS 連携(既定のアプリ / プログラムから開く /
  エクスプローラーで表示 / フルパスをコピー)・フォルダー絞り込み・リネーム / 移動・
  サムネイル再生成・ライブラリからの削除・**ファイルのごみ箱送り**(フロントからは初対応)を
  そろえた。項目の組み立ては純関数に切り出してテスト。サブフォルダカードにも 3 項目の
  小メニューを出す。あわせて **Delete キーでの削除**(削除先を選ばせるダイアログ)を足し、
  **詳細ペインからファイル操作を撤去**して削除・リネーム・移動の入口を一本化した。
  さらに**シークバーのコマ出し**(見えない `<video>` の `currentTime` を動かす方式)を追加。
  バージョン番号も実態(1.14.0)に揃えた
  (前述「右クリックメニュー」「シークバーのコマ出し」節)
- **将来**: フォールバック側の HLS 追いかけ再生、mac/Linux 対応

## 今後のタスク

当初の backlog(v1.6 時点の 11 件 + 細かい改善)は v1.7〜v1.9 ですべて消化した。
残っているのは次の 2 件:

- **API キーの暗号化** — 現状は `library.db` に平文。Windows DPAPI で保護する
  (ローカル個人用アプリとして許容中。バックアップにも平文で含まれる点に注意)
- **右クリックメニューの適用範囲を広げる** — v1.14 で対応したのは一覧の動画カード / リスト行と
  サブフォルダカードだけ。未対応はサイドバーのタグツリー・フォルダーツリー・監視フォルダ・
  スマートフォルダ・シリーズ、プレイヤー画面、グリッドの余白。
  `ContextMenu.tsx` と `buildXxxMenu()` の形はそのまま使い回せるので、
  足すのは対象ごとの純関数と右クリックハンドラだけで済む
