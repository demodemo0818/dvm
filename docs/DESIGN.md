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
| 再生 (v1.2) | WebView2 ネイティブ再生(mp4/m4v/mov/webm、下記)。外部プレイヤー設定時は従来通り外部起動 |
| 再生 (将来) | FFmpeg remux → トランスコード → libmpv 埋め込み |

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
- v0.1 のテキスト検索は filename / title への LIKE 部分一致(日本語の部分一致はこれで正しく動く)
- FTS5 は日本語トークナイズの問題(標準トークナイザは CJK に弱い)があるため、導入するなら trigram トークナイザ等を検証してから(v0.2 で判断)

## ファイル同一性の追跡

1. スキャン時、まず path で照合
2. path が消えたファイルは `size + partial_hash` が一致する新規ファイルを探す
   → 一致すれば「移動 / リネーム」とみなし、タグ等のメタデータを引き継いで path を更新
3. 見つからなければ `is_missing = 1`(ユーザーが明示的に整理するまで DB には残す)

全体ハッシュは使わない(動画は巨大で遅すぎる)。先頭 1MB で実用上十分。

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
- ファイル名は `{video_id}.jpg`(将来のホバー用複数枚は `{video_id}_{index}.jpg`)
- グリッド用 1 枚 + ホバー/詳細用の複数枚(等間隔 N 枚、ホワイトブラウザ方式)を段階的に生成
- 表示時は動画に一切触らない。キャッシュ画像を読むだけ

## アプリ内再生(v1.2 実装済み)

- ダブルクリック時の分岐:
  1. 外部プレイヤー設定(player_path)あり → 従来通り外部起動
  2. 拡張子が mp4 / m4v / mov / webm → アプリ内オーバーレイ(`<video>` + asset protocol)
  3. それ以外 → OS 既定プレイヤー
- WebView2 が実際にデコードできない場合(HEVC 収録の mp4 等)は `<video>` の onError で OS 既定へ自動フォールバック。視聴カウントは再生成功時(onPlaying)にのみ +1 するため二重カウントしない
- assetProtocol の scope は `"**"`(全パス許可)。動画は任意ドライブに置かれる前提のため。トレードオフ: 万一 webview で XSS が起きると任意ファイルを読まれ得る(ローカル個人用アプリとして許容。csp は元々 null)
- Tauri 2 の asset protocol は HTTP Range 対応でシークも動く

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
- 読み取りツール: `search_videos`(構造化クエリ。text / tag / series / missing / min_rating / min_duration_sec / max_duration_sec / sort / limit)/ `get_video` / `list_tags` / `list_series` / `library_stats`
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

## ロードマップ

- **v0.1** ✅(2026-07-24 実装済み): フォルダ登録 → スキャン → ffprobe メタデータ取得 → サムネイル生成 → 仮想化グリッド表示。ファイルの個別登録(D&D / ダイアログ)。オフラインドライブ検出。検索・ソートも実装済み
- **v0.2** ✅(2026-07-24 実装済み): タグ付け(選択+インスペクタパネル)・タグ絞り込み(複数 AND)・タグ削除。FTS5 は見送り LIKE で対応(前述)
- **v0.3** ✅(2026-07-24 実装済み): シリーズ管理(登録順の並び保持)、星レーティング、外部プレイヤー設定(settings テーブル)、視聴履歴表示、レーティング/視聴日時ソート
- **v0.4** ✅(2026-07-24 実装済み): ファイル監視(notify、1.5 秒デバウンスで自動取り込み)、missing 絞り込みとライブラリからの削除 UI、読み取り専用 MCP サーバー
- **v1.0** ✅(2026-07-24 実装済み): 設定画面(外部プレイヤー・データ保存場所の表示・サムネイル一括再生成・バックアップ管理)、DB バックアップ(下記)、ドライブレター変動対策(ボリュームシリアル記録、v0.4 繰り越し分)、検索強化(レーティング下限・尺範囲フィルタを UI と MCP の両方に追加)、user_version による簡易マイグレーション機構
- **v1.1** ✅(2026-07-26 実装済み): 書き込み系 MCP(`VIDEOSHELF_ALLOW_WRITE=1` でオプトイン。タグ・シリーズ・レーティング・情報編集、登録削除、dry-run 付きごみ箱送り。actor='ai' で監査ログ)、data_version 監視による外部変更の UI 自動反映
- **v1.2** ✅(2026-07-26 実装済み): アプリ内再生(WebView2 ネイティブ、非対応形式は onError で外部フォールバック、視聴カウントは再生成功時のみ)
- **v1.3** ✅(2026-07-26 実装済み): アプリ内 AI アシスタント(✨ パネル。自然言語検索 → apply_filter でグリッド反映、タグ提案・付与、actor='ai' 監査ログ)
- **将来**: アプリ内再生の高度化(remux → トランスコード → libmpv)、mac/Linux 対応
