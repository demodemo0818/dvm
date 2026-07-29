---
name: run-dvm
description: DVM を実機で起動して画面を目視確認する(起動・スクリーンショット・クリック・スクロール・クリップボード検証)。UI を変更したあと本当に見えているか確かめたいとき、「起動して」「動かして」「画面を見せて」と言われたときに使う。
---

# DVM を起動して画面で確かめる

Tauri アプリなので、テストや型チェックが通っても**画面が壊れていることはある**。
UI を触ったら実際に起動して目で見る。

## 1. 前提(初回のみ)

`bundle.resources` に書いたファイルの実在をビルドスクリプトが確認するため、
これが揃っていないと `cargo` が「resource path ... doesn't exist」で止まる。

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
npx tauri-plugin-libmpv-api setup-lib
npm run build:mcp -- -Config debug
```

## 2. 起動

**バックグラウンドで**起動する(フォアグラウンドだとブロックして操作できない)。

```powershell
npm run tauri dev
```

出力ログに次が出たら準備完了。初回コンパイルは 1〜2 分かかる。

```
Finished `dev` profile [unoptimized + debuginfo] target(s)
     Running `target\debug\dvm.exe`
```

`Running` が出る前にスクリーンショットを撮ると `window 'DVM' not found` になる。
その場合はログを読み直して待つ。

## 3. 操作する

`ui.ps1` を使う。**必ず `powershell`(5.1)から `-File` で呼ぶ**
(System.Drawing / SendKeys が確実に載っているのが 5.1 側)。

```powershell
$ui = '.claude\skills\run-dvm\ui.ps1'
$sp = 'スクラッチパッドのパス'

# 画面を撮る(座標はウィンドウ左上が原点。撮った画像の座標がそのまま使える)
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action shot -Out "$sp\01.png"

# クリック
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action click -X 1315 -Y 55

# スクロール(1 ノッチ = 120、下方向は負。モーダル内なら中央あたりにカーソルを置く)
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action scroll -X 800 -Y 600 -Delta -120

# キー送信(SendKeys 形式。Esc なら {ESC})
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action key -Keys '{ESC}'
```

**撮った PNG は必ず Read して目で見る。** 撮っただけでは確認したことにならない。

## 4. 座標の見つけ方

1. まず `shot` を撮る
2. 画像を Read して、押したい要素の座標を読む
3. その座標で `click`

**状態が変わったら座標を使い回さない。** チェックボックスやタブの切り替えで
下の要素が動く。実際に、書き込み許可をオンにして JSON が 3 行伸びた結果、
コピーボタンが 50px 下がってクリックが外れた。**変化のあとは撮り直す。**

クリックが効いたか分からないときは、効果が観測できるものを見る
(クリップボード・トースト・モーダルの開閉)。

**ウィンドウが非アクティブだと 1 回目のクリックはフォーカス取得に消える。**
他のアプリを触ったあとの最初の 1 回は反応しないことがあるので、
効かなかったらもう一度同じ座標を押す(座標が違うのではない)。

## 5. 目視以外の検証

**コピーボタンはクリップボードを読んで中身まで確かめる。**
「押せた」ではなく「正しい文字列が入った」まで見ないと意味がない。

```powershell
Set-Clipboard -Value '(sentinel)'
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action click -X 570 -Y 832
Start-Sleep -Milliseconds 400
Get-Clipboard | Out-String
```

`(sentinel)` のままなら**クリックが外れている**(コピー処理の失敗ではない)。撮り直して座標を直す。

## 6. 画面ごとの入口

| 見たいもの | 行き方 |
|---|---|
| 設定モーダル | ツールバー右端の ⚙(1600×950 のとき およそ X=1315, Y=55) |
| MCP 連携 / AI アシスタント | 設定を開いて中身を 5 ノッチほど下スクロール |
| AI パネル | ツールバーの ✨ |
| 視聴履歴 / 操作履歴 | ツールバーの 🕘 |

モーダルは**外側(オーバーレイ)をクリックすると閉じる**。
設定モーダルは「保存」を押さない限り変更が入らないので、
確認だけならオーバーレイを押して破棄する(ユーザーの設定を勝手に変えない)。

## 7. 後始末

アプリはバックグラウンドで動き続ける。用が済んだら止めるかユーザーに確認する。
`npm run tauri dev` はソース変更を監視して再ビルドするので、
起動したままコードを直すとその場で反映される(UI の微調整はこれが速い)。

## 落とし穴

- **`.ps1` は BOM 付き UTF-8 で保存する。** `npm run` から呼ばれる `powershell` は 5.1 で、
  BOM 無し UTF-8 を CP932 として読む。日本語コメント末尾の「。」(`E3 80 82`)は
  `82` が先行バイト扱いになって**直後の改行を食う**。`param()` の直前にあると
  パラメータブロックごとコメントに飲まれ、引数が黙って無視される
- **DPI スケーリング。** `ui.ps1` は `SetProcessDPIAware()` を呼んでいるので座標は物理ピクセル。
  自前でスクリーン座標を計算するときも同じ前提に揃えること
- **ウィンドウは動く。** ユーザーが別モニタへ動かすと `rect=` が負の座標になることもある
  (実際に `rect=364,-1054,...` を確認済み。取得自体は問題なくできる)。
  スクリーン座標を覚えず、毎回 `shot` の出す相対座標で操作すること
- **`tauri dev` は `bundle.resources` を `target\debug\binaries\` にコピーする。**
  なので開発時もインストール後と同じ `exe\binaries\` 構成になり、
  `core/mcp.rs` や `core/ffmpeg.rs` のパス解決は dev で本番と同じ経路を通る
