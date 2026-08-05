/**
 * 再生中の映像が HDR かどうか(v1.31、mpv のみ)。
 *
 * mpv の `video-params` を読むだけで、**ffprobe は叩かない** ——
 * 詳細ペインのメディア情報(`core/metadata.rs` の `hdr_label`)は同じことを
 * ファイル側から調べているが、こちらは「今デコードしている映像」が出所なので
 * 追加のファイル I/O がゼロで済む(チャプターと同じ考え方)。
 *
 * **「実際に HDR で出ているか」は mpv からは取れない**。`target-colorspace-hint` は
 * こちらが出した希望で、実際の出力を返す `target-params` は同梱 libmpv では
 * property not found になる(実機で確認済み)。そちらは Windows に直接聞く
 * (`core/display.rs` / `is_hdr_display`)。
 *
 * **Dolby Vision は判定しない**。mpv の `video-params` には DV かどうかが出ず、
 * DV の多くは PQ ベースなので `HDR10` として出る。ファイル側の正確な種別は
 * 詳細ペインのメディア情報を見ること
 */
export interface HdrInfo {
  /** コントロールバーに出す短い名前 */
  short: string;
  /** ツールチップに出す正式な名前(メディア情報の言い方に合わせる) */
  full: string;
}

/**
 * mpv の `video-params`(node)から HDR 方式を読む。HDR でなければ null。
 *
 * 見るのは**転送特性(gamma)だけ**。色域(primaries)が bt.2020 でも
 * 転送特性が SDR なら HDR ではない(広色域 SDR というものが実在する)
 */
export function hdrFromParams(data: unknown): HdrInfo | null {
  const gamma = (data as { gamma?: unknown } | null)?.gamma;
  if (typeof gamma !== 'string') return null;
  switch (gamma.toLowerCase()) {
    // mpv は 'pq' / 'hlg' で返す。ffprobe 側の綴り(smpte2084 / arib-std-b67)も
    // 受けておく —— libmpv のバージョンで名前が変わっても静かに壊れないように
    case 'pq':
    case 'st2084':
    case 'smpte2084':
      return { short: 'HDR10', full: 'HDR10 (PQ)' };
    case 'hlg':
    case 'arib-std-b67':
      return { short: 'HLG', full: 'HLG' };
    default:
      return null;
  }
}

/**
 * バッジのツールチップ。
 *
 * **設定ではなく実際の出力で言い分ける**。パススルーは `auto` なので、設定を
 * オンにしても Windows 側が HDR モードでなければ mpv はトーンマップする ——
 * そこを「オンだから HDR で出ている」と書くと嘘になる。
 * SDR で出ているときは**なぜそうなっているか**まで出す
 */
export function hdrTooltip(info: HdrInfo, hdrOutput: boolean, passthrough: boolean): string {
  if (hdrOutput) {
    return `${info.full} の映像を HDR のまま出力しています`;
  }
  return passthrough
    ? `${info.full} の映像です。SDR に変換して表示しています`
      + '(HDR パススルーはオンですが、ディスプレイが HDR モードではありません)'
    : `${info.full} の映像です。SDR に変換して表示しています(HDR パススルー: オフ)`;
}
