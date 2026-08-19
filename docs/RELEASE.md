# リリース手順

新しい版を配布するときの手順です。この通りにやれば漏れません。

**ビルドと Release 作成は GitHub Actions がやります**([.github/workflows/release.yml](../.github/workflows/release.yml))。
手元でやるのは 1〜4 と、最後の公開ボタンだけです。

## 1. バージョン番号を上げる

**3 か所すべて**を同じ番号にします。

| ファイル | 場所 |
|---|---|
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package]` の `version` |
| `src-tauri/tauri.conf.json` | 先頭の `"version"` |

上げ忘れると `cargo test` の `version_consistency` が落ちます(実際に 1.31.0 のまま
v1.43 まで進んでいたことがあるので、テストで縛ってあります)。`src-tauri/Cargo.lock` は
`cargo check` を一度流せば自動で追従します。

## 2. 変更履歴を書く

[CHANGELOG.md](../CHANGELOG.md) の先頭に新しい節を足します。設計上の判断を伴う変更なら
[DESIGN.md](DESIGN.md) のロードマップにも記録します。

## 3. テストを通す

```powershell
npm run test
cd src-tauri; cargo test; cd ..
```

## 4. タグを push する

```powershell
git add -A
git commit -m "v1.44 をリリースする"
git tag v1.44.0
git push origin master --tags
```

これで Actions が動きます。**タグ名は `v` 始まり**にしてください(`on.push.tags` が `v*`)。

## 5. できたものを確認して公開する

Actions は **Release の下書き**まで作ります(勝手に公開はしません)。

1. [Actions のページ](https://github.com/demodemo0818/dvm/actions)でビルドの成功を確認する
2. [Releases のページ](https://github.com/demodemo0818/dvm/releases)の下書きを開く
3. **インストーラをダウンロードして、自分の PC で実際に入れて動かす**(下記)
4. 問題なければ「Publish release」を押す
5. 公式サイト([demo2-site](https://demo2.jp/dvm/))のダウンロードリンクを新しい版に向ける

### 公開前に必ず見る動作確認

- 起動して一覧が出る
- 動画がアプリ内再生できる(= 同梱した `libmpv-2.dll` が読めている)
- サムネイル生成が動く(= 同梱した `ffmpeg.exe` が読めている)
- インストール先に `LICENSE` と `THIRD-PARTY-NOTICES.md` がある
  (`C:\Program Files\DVM\resources\` 配下。**GPL の要件なので必ず確認する**)

## 手元でビルドしたいとき

Actions を使わず自分でビルドする場合(動作確認や、CI が壊れたとき)。

```powershell
npm run tauri build
```

| 成果物 | 場所 |
|---|---|
| インストーラ(推奨) | `src-tauri/target/release/bundle/nsis/DVM_x.y.z_x64-setup.exe` |
| MSI | `src-tauri/target/release/bundle/msi/DVM_x.y.z_x64_en-US.msi` |

> **ビルドが `os error 32`(別のプロセスが使用中)で止まったら**
> DVM 本体か `dvm-mcp.exe` が起動したままです。AI クライアント(Claude Desktop など)を
> 終了してから再実行してください。

## ライセンス上の注意(GPL)

配布物には次が必要です。手順 5 の動作確認で必ず見てください。

- インストール先に GPL 全文(`LICENSE`)があること
- `THIRD-PARTY-NOTICES.md` に FFmpeg / libmpv のソース入手先が載っていること
- **同梱する FFmpeg のバージョンを上げたら**、`THIRD-PARTY-NOTICES.md` のバージョン表記も
  直すこと(`ffmpeg.exe -version` の出力に `--enable-gpl` があるかも毎回確認する。
  もし将来 LGPL ビルドに変えるなら、本体のライセンスも見直せる)

ルートの `LICENSE` / `THIRD-PARTY-NOTICES.md` と `src-tauri/resources/` のコピーは
`cargo test` の `bundled_legal_docs` が一致を見張っています(片方だけ直すと落ちます)。
