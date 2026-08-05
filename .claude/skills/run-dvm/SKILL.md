---
name: run-dvm
description: DVM を実機で起動して画面と DOM で検証する(CDP + Playwright での UI 駆動、mpv 映像のデスクトップ実キャプチャ)。UI を変更したあと本当に動いているか確かめたいとき、「起動して」「動かして」「画面を見せて」と言われたときに使う。
---

# DVM を起動して実機で確かめる

Tauri アプリなので、テストや型チェックが通っても**画面が壊れていることはある**。
UI を触ったら実際に起動して確かめる。

**検証経路は 2 つあり、用途で使い分ける。**

| 見たいもの | 使うもの |
|---|---|
| DOM で表せるもの(ボタン・件数・モーダル・一覧・トースト) | **CDP + Playwright**(主経路) |
| mpv の映像そのもの(再生画面・矩形・リサイズ追従・重なり) | **`ui.ps1` のデスクトップ実キャプチャ** |
| ネイティブファイルダイアログ | `ui.ps1` の click / key |

理由は「落とし穴」節の **mpv 映像は CDP に写らない** を参照。

## 1. 前提(初回のみ)

`bundle.resources` に書いたファイルの実在をビルドスクリプトが確認するため、
これが揃っていないと `cargo` が「resource path ... doesn't exist」で止まる。

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
npx tauri-plugin-libmpv-api setup-lib
npm run build:mcp -- -Config debug
```

Playwright はスクラッチパッドに入れる(ブラウザバイナリ不要なので `playwright-core` だけ)。

```powershell
Set-Location $sp; npm install playwright-core
```

## 2. 起動(CDP 付き)

**バックグラウンドで**起動する(フォアグラウンドだとブロックして操作できない)。

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

- **既に DVM が動いていると 9222 は開かない。** WebView2 は起動中のプロセスがあると
  新しい引数を無視する。先に `dvm` / `cargo` / vite(port 1420 を持つ `node`)を止めること。
  他プロジェクトの `node` を巻き込まないよう、pid は
  `Get-NetTCPConnection -State Listen -LocalPort 1420` で特定してから落とす
- 準備完了の判定は**ログではなく 9222 で行う**(`Running target\debug\dvm.exe` が出ても
  WebView2 の起動には少し遅れがある)

```powershell
curl -s -m 2 http://127.0.0.1:9222/json/version   # 応答したら準備完了
```

初回コンパイルは 1〜2 分。ビルドエラーで永久に待たないよう、待機ループでは
ログの `^error[` / `error: could not compile` も見ること。

## 3. UI を駆動する(主経路)

```js
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap(c => c.pages())
  .find(p => p.url().includes("localhost:1420"));
// page.locator / getByTitle / screenshot / evaluate が全部使える
```

**DVM は `title` 属性が非常に充実しているので、セレクタは `title` で引くのが速い。**
`data-testid` は無い。ツールバーは `.toolbar [title="設定"]` のように取れる
(実在する title: `設定` / `AI アシスタント` / `詳細検索` / `並び順` /
`レーティングで絞り込み` / `長さで絞り込み` / `再スキャン` / `入りきらない操作`)。

**「押せた」ではなく「状態が変わった」を DOM で確かめる。** これが座標+目視に対する
最大の利点で、たとえば絞り込みの結果はテキストで検証できる:

```js
const n = await page.evaluate(() => document.body.innerText.match(/全\s*([\d,]+)\s*件/)?.[1]);
```

モーダルの中身も `innerText` で全部読めるので、設定項目の文言確認にスクリーンショットは要らない。

**Playwright はクリックが届かない理由まで教えてくれる。** 実際に、設定モーダルを
開いたままカードを dblclick して
`<div class="modal-overlay"> intercepts pointer events` で失敗した。
座標方式ならこれは「なぜか反応しない」で終わっていた。

## 4. モーダルの閉じ方(閉じ方が 2 種類ある)

- **設定モーダルは Escape で閉じない。** `.modal-overlay` をクリックして破棄する。
  設定は「保存」を押さない限り反映されないので、確認だけならこれでユーザーの設定を汚さない
- **プレイヤーオーバーレイは Escape で閉じる**

```js
await page.locator(".modal-overlay").first().click({ position: { x: 5, y: 5 } });
```

閉じ忘れると次の操作が全部 overlay に食われるので、**モーダルを開いたら必ず閉じてから次へ進む。**

## 5. mpv を直接叩く

libmpv の API は Vite の module graph 経由で `page.evaluate` から呼べる
(dev 時のみ。bare specifier は解決できないので**最適化済み deps のパスを使う**):

```js
const MPV = "/node_modules/.vite/deps/tauri-plugin-libmpv-api.js";
await page.evaluate(async (s) => {
  const m = await import(s);                       // command/getProperty/setProperty/…
  await m.command("seek", ["4", "absolute"]);
  return await m.getProperty("time-pos", "double");
}, MPV);
```

- **`getProperty` は format が必須**(`'string' | 'flag' | 'int64' | 'double' | 'node'`)。
  省略すると `missing required key format` で落ちる。`setProperty` は不要
- UI の表示と mpv の実状態が食い違っていないかの切り分けに使う
  (シークバーは動いたのに `time-pos` が変わらない、など)
- 検証中は `setProperty("mute", true)` で音を切る

## 6. 映像を見る(デスクトップ実キャプチャ)

`ui.ps1` を使う。**必ず `powershell`(5.1)から `-File` で呼ぶ**
(System.Drawing / SendKeys が確実に載っているのが 5.1 側)。

```powershell
$ui = '.claude\skills\run-dvm\ui.ps1'

# ウィンドウを撮る(座標はウィンドウ左上が原点)
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action shot -Out "$sp\01.png"

# ネイティブダイアログ用。クリック / スクロール(1 ノッチ=120、下は負) / キー
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action click  -X 1315 -Y 55
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action scroll -X 800 -Y 600 -Delta -120
powershell -NoProfile -ExecutionPolicy Bypass -File $ui -Action key    -Keys '{ESC}'
```

**撮った PNG は必ず Read して目で見る。** 撮っただけでは確認したことにならない。

`ui.ps1` で座標クリックを使うときだけ、従来の注意が生きる:
**状態が変わったら座標を使い回さない**(要素が動く)。**非アクティブだと 1 回目の
クリックはフォーカス取得に消える**(効かなかったら同じ座標をもう一度)。
**クリップボードは番兵を置いて中身まで確かめる**(`Set-Clipboard -Value '(sentinel)'`
→ クリック → `Get-Clipboard`。sentinel のままならクリックが外れている)。

## 7. 画面ごとの入口

| 見たいもの | 行き方 |
|---|---|
| 設定モーダル | `.toolbar [title="設定"]` |
| MCP 連携 / AI アシスタント設定 | 設定を開いて中身をスクロール |
| AI パネル | `.toolbar [title="AI アシスタント"]` |
| 視聴履歴 / 操作履歴 | ツールバーの 🕘(オーバーフローに入っていることがある) |
| プレイヤー | カードを dblclick |

## 8. 後始末

アプリはバックグラウンドで動き続ける。用が済んだら止めるかユーザーに確認する。
`npm run tauri dev` はソース変更を監視して再ビルドするので、
起動したままコードを直すとその場で反映される(UI の微調整はこれが速い)。

## 落とし穴

- **mpv 埋め込み再生中の映像は CDP スクリーンショットに写らない。** mpv は WebView2 と
  兄弟の別ウィンドウなので、DOM(タイトル・シークバー・コントロール)は写るが
  **映像領域は真っ白になる**。同じ 0:04 の瞬間を CDP と実キャプチャで撮り比べて確認済み。
  映像の確認・mpv 矩形の位置・モーダルとの重なりは `ui.ps1 -Action shot` でしか見られない
- **DVM は背面でも再生が進む。** 前面ウィンドウが別アプリ(実測時は `Demobar`)の状態で
  `time-pos` が 4.065 → 6.55 と進み `core-idle=false` を確認済み。
  近い構成の demodemoenc では「前面でないと mpv が present できず再生が止まる」が、
  **DVM ではこれは起きない**(vo が `gpu-next`)。同じ罠だと思って前面化しないこと
- **HMR に注意。** プレイヤー系コンポーネントを編集すると再マウントで mpv の状態が
  初期化される。編集直後の 1 回目の観測は疑う
- **`.ps1` は BOM 付き UTF-8 で保存する。** `npm run` から呼ばれる `powershell` は 5.1 で、
  BOM 無し UTF-8 を CP932 として読む。日本語コメント末尾の「。」(`E3 80 82`)は
  `82` が先行バイト扱いになって**直後の改行を食う**。`param()` の直前にあると
  パラメータブロックごとコメントに飲まれ、引数が黙って無視される
- **DPI スケーリング。** `ui.ps1` は `SetProcessDPIAware()` を呼んでいるので座標は物理ピクセル
- **ウィンドウは動く。** ユーザーが別モニタへ動かすと `rect=` が負の座標になることもある
  (実際に `rect=364,-1054,...` を確認済み)。スクリーン座標を覚えず、毎回 `shot` を撮り直す
- **`tauri dev` は `bundle.resources` を `target\debug\binaries\` にコピーする。**
  なので開発時もインストール後と同じ `exe\binaries\` 構成になり、
  `core/mcp.rs` や `core/ffmpeg.rs` のパス解決は dev で本番と同じ経路を通る

## 参考: 仮想化が効いていることの確認

グリッドは TanStack Virtual で仮想化されている(DESIGN.md のパフォーマンス原則)。
CDP なら実 DOM を数えて回帰を検出できる —— **全 5,210 件の表示で `<img>` は 24 個**、
仮想コンテナの `scrollHeight` は 472,464px だった。ここが件数に比例して増えていたら
仮想化が壊れている。

```js
await page.evaluate(() => document.querySelectorAll("img").length);
```
