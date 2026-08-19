# DVM(Demodemo Video Manager)

Windows 向け動画管理ソフト(Tauri 2 + React + TypeScript + Rust)。
設計の全体像・データモデル・ロードマップは [docs/DESIGN.md](docs/DESIGN.md) を必ず参照すること。

## コア方針

- 動画ファイルは**コピーしない**。元の場所に置いたまま SQLite で管理する
- フォーマット対応は FFmpeg(サイドカー)に一本化する
- 再生は libmpv 埋め込みが主経路(v1.5)。フォールバックは WebView2 + FFmpeg 変換(v1.4)。
  外部プレイヤーを設定したときだけ従来どおり外部起動する

## パフォーマンス原則(コードを書くとき必ず守る)

1. **サムネイルグリッドは必ず仮想化する**(TanStack Virtual)。全件を DOM に並べない
2. **自動的に起きる表示(グリッド描画・スクロール)では元動画に触らない**。サムネイルはディスクキャッシュを読むだけ。ユーザーの明示的な操作(ホバー継続・ダブルクリック)なら元動画を開いてよい
3. **重い処理(走査・ハッシュ・ffprobe・サムネイル生成)は Rust 側の非同期ワーカー**で行い、進捗はイベントで UI に通知する
4. フロントに全件データを一括で渡さない。クエリはページング/仮想化前提で設計する
5. SQLite の書き込みはトランザクションでまとめる。1 件ずつ commit しない
6. 読み取りだけの Tauri コマンドは `AppState.db_read`(読み取り専用コネクション)を使う。書き込みロックで UI を待たせない。ただし `PRAGMA data_version` の監視だけは `AppState.db` を使うこと(理由は DESIGN.md)
7. 一覧クエリの行ごとにファイル I/O をしない(サムネイルの存在確認など)

## アーキテクチャ原則(AI 連携を見据えて必ず守る)

1. **本体ロジックは `src-tauri/src/core/` に UI 非依存の関数として書く**。Tauri コマンドは薄いラッパーに徹する。将来 MCP ツールから同じ関数を呼べるようにするため
2. 検索条件は**構造化クエリオブジェクト**で表現する。UI のフィルタと将来の AI 検索で同じ型を使う
3. ファイル削除は必ずごみ箱経由(trash クレート)。ファイル移動系は dry-run を返せる形で設計する
4. メタデータ変更・ファイル操作は operations_log に記録する
5. 動画・タグ・フォルダ・シリーズに対する操作を追加したら、**右クリックメニューに載せるかを必ず検討する**(判断基準は DESIGN.md「右クリックメニュー」節)

## 技術メモ

- DB アクセス: Rust 側から(sqlx または rusqlite)。フロントから直接 SQL を触らない
- **DB は 2 本ある**(v1.27)。`library.db` = ライブラリの中身(動画・タグ・シリーズ・監視フォルダ)。
  `app.db` = アプリ全体(ライブラリ一覧と、切り替えても変わるべきでない設定)。
  `get_setting` / `set_setting` は常に `app_db` を使う。ライブラリごとの記録は
  `core/backup.rs` のように conn を直接受け取る形で書く
- フロントから Tauri コマンドを呼ぶときは必ず `src/api.ts` の `call()` を経由する(失敗をトーストで可視化するため)。`invoke` を直接呼ばない
- Tauri コマンドは `src-tauri/src/commands/` に機能別に分ける
- フロントの状態管理は軽く始める(Zustand)。過剰な抽象化をしない
- パスは常に絶対パスで扱う。Windows のパス(`\`、ドライブレター、UNC、長いパス)を意識する
- 外付け HDD / NAS 前提: ドライブ未接続を missing と誤判定しない(DESIGN.md「オフラインドライブの扱い」参照)
- 日本語ファイル名・パスが普通に存在する前提でテストする
- **`scripts/*.ps1` は BOM 付き UTF-8 で保存する**。これらを起動するのは `powershell`
  (= Windows PowerShell 5.1)で、**BOM が無いと日本語コメントを ANSI として読み、
  パースエラーで落ちる**。手元の `pwsh`(7)は BOM 無しでも読めてしまい再現しないので、
  書き換えたら必ず `powershell -ExecutionPolicy Bypass -File <script>` で確かめること
  (これで CI を 1 回落とした)

## 開発コマンド

- `npm run tauri dev` — 開発起動(フロント HMR + Rust 自動再ビルド)
- `npm run tauri build` — 配布ビルド
- Rust のみの型チェック: `cd src-tauri && cargo check`
- テスト: `cd src-tauri && cargo test`(コアロジック)/ `npm run test`(フロントの純関数)
- 既存 DB でマイグレーションを試す: `cd src-tauri && cargo run --example dbtool -- <db のコピー> check`

## 会話・ドキュメント

- ユーザーへの説明は日本語で行う
- git コミットメッセージはタイトル・本文とも日本語で書く
- 設計変更をしたら docs/DESIGN.md も更新する
