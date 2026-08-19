# サードパーティ ソフトウェア表記

DVM(Demodemo Video Manager)は次のソフトウェアを利用・同梱しています。
各ソフトウェアの著作権は、それぞれの権利者に帰属します。

DVM 本体は GNU General Public License version 3 以降(GPL-3.0-or-later)で配布しています
([LICENSE](LICENSE))。

---

## 同梱バイナリ

インストーラに実行ファイル / DLL の形でそのまま含まれているものです。

### FFmpeg / ffprobe

| | |
|---|---|
| バージョン | 8.1.2 (`essentials_build`) |
| ライセンス | **GPL version 3 以降**(`--enable-gpl --enable-version3` でビルドされているため) |
| 公式サイト | https://ffmpeg.org/ |
| ソースコード | https://ffmpeg.org/download.html#get-sources |
| 同梱している Windows ビルド | gyan.dev release-essentials — https://www.gyan.dev/ffmpeg/builds/ |
| ビルドスクリプトのソース | https://github.com/GyanD/codexffmpeg |

このビルドは libx264 / libx265 / libvidstab / librubberband など GPL のライブラリを
有効にしているため、FFmpeg 全体が GPLv3 として配布されています。**DVM が GPLv3 を
採用しているのはこれに合わせるため**です。

DVM は FFmpeg を改変していません。同梱しているのは上記の配布元から取得した
バイナリそのままです(取得手順は [scripts/fetch-ffmpeg.ps1](scripts/fetch-ffmpeg.ps1))。

FFmpeg の対応するソースコードは上記 URL から入手できます。URL が利用できなくなった
場合は、本リポジトリの Issue でご連絡ください。

### libmpv (mpv)

| | |
|---|---|
| ファイル | `libmpv-2.dll` |
| ライセンス | **LGPL version 2.1 以降**(LGPL ビルド) |
| 公式サイト | https://mpv.io/ |
| ソースコード | https://github.com/mpv-player/mpv |
| 同梱している Windows ビルド | https://github.com/zhongfly/mpv-winbuild(`mpv-dev-lgpl-x86_64` アセット) |

DVM は libmpv を**動的リンク**で利用しており、改変していません。LGPL の定めるとおり、
利用者は `libmpv-2.dll` を同じ ABI を持つ別のビルドに差し替えることができます
(インストール先の DLL を置き換えてください)。

### libmpv-wrapper

| | |
|---|---|
| ファイル | `libmpv-wrapper.dll` |
| ライセンス | **LGPL version 2.1** |
| ソースコード | https://github.com/nini22P/libmpv-wrapper |

こちらも動的リンクで利用しており、改変していません。

### dvm-mcp.exe

DVM 本体と同じソースツリーからビルドされる MCP サーバーです。DVM 本体と同じく
GPL-3.0-or-later で配布しています。

---

## Rust クレート(主要な直接依存)

いずれも GPLv3 と両立するライセンスです。推移的な依存を含めた 538 クレートの内訳は
`cargo metadata` で確認できます(MIT / Apache-2.0 系が大半で、GPL と衝突するものは
ありません)。

| クレート | ライセンス | 用途 |
|---|---|---|
| tauri, tauri-plugin-opener, tauri-plugin-dialog, tauri-plugin-window-state | Apache-2.0 OR MIT | アプリの土台 |
| tauri-plugin-libmpv | **MPL-2.0** | libmpv の埋め込み |
| rusqlite (bundled SQLite) | MIT / SQLite 本体は**パブリックドメイン** | データベース |
| serde, serde_json | MIT OR Apache-2.0 | シリアライズ |
| reqwest, futures-util | MIT OR Apache-2.0 | AI プロバイダへの HTTP |
| rayon | MIT OR Apache-2.0 | 並列処理 |
| walkdir | Unlicense OR MIT | フォルダ走査 |
| notify | CC0-1.0 | フォルダ監視 |
| trash | MIT | ごみ箱への削除 |
| xxhash-rust | BSL-1.0 | ファイルハッシュ |
| anyhow | MIT OR Apache-2.0 | エラー処理 |
| windows-sys | MIT OR Apache-2.0 | Windows API |

MPL-2.0 は GPL 互換(MPL 2.0 §3.3 の secondary license 条項)です。

## npm パッケージ(直接依存)

| パッケージ | ライセンス |
|---|---|
| react, react-dom | MIT |
| @tanstack/react-virtual | MIT |
| zustand | MIT |
| @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-opener, @tauri-apps/cli | MIT OR Apache-2.0 |
| tauri-plugin-libmpv-api | MPL-2.0 |
| lucide-react | ISC |
| vite, @vitejs/plugin-react, vitest, jsdom | MIT |
| typescript | Apache-2.0 |

---

## ライセンス全文の入手先

- GPL-3.0 — [LICENSE](LICENSE) / https://www.gnu.org/licenses/gpl-3.0.txt
- LGPL-2.1 — https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt
- Apache-2.0 — https://www.apache.org/licenses/LICENSE-2.0.txt
- MPL-2.0 — https://www.mozilla.org/MPL/2.0/
- MIT / ISC / BSL-1.0 / CC0-1.0 — 各パッケージの配布物に含まれています
