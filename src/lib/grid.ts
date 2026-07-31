/**
 * グリッド表示(サムネイル一覧)の寸法計算(v1.17)。
 * 列数・カードの実寸・行の高さはここだけで決める。
 */

/** 行の左右 padding とカード同士の隙間(px)。VideoGrid の行スタイルと対 */
export const GRID_PAD = 12;
export const GRID_GAP = 12;

/**
 * サムネイルの下に置く名前とサイズ、およびカード同士の縦の間隔(px)。
 * 名前は 1 行に省略するので(`.card-name` の nowrap + ellipsis)、
 * ファイル名が長くても増えない
 */
export const CARD_TEXT_H = 56;

/**
 * タグ行・シリーズ行 1 本ぶんの高さ(px、v1.23)。
 * `.card-chips { height: 18px }` + `.card { gap: 4px }` の合計。**片方だけ動かさないこと**。
 *
 * 行は「設定が ON なら中身が空でも必ず描く」。動画ごとに出し分けると
 * カードごとに高さが変わり、行単位で 1 つの高さしか持てない仮想化が破綻する
 */
export const CARD_CHIP_ROW_H = 22;

/** サムネイルの縦横比。`.thumb { aspect-ratio: 16 / 9 }` と対 */
const THUMB_RATIO = 9 / 16;

export interface GridMetrics {
  cols: number;
  /** カード 1 枚の実寸(px)。列数を切り捨てで決めるので cardWidth ちょうどにはならない */
  cardW: number;
  rowHeight: number;
}

/**
 * 列数・カードの実寸・行の高さを求める。
 *
 * **行の高さはカード幅の設定値ではなくカードの実寸から出すこと**。
 * 列数は floor で決めるので、割り切れなかったぶんは `1fr` で各カードに配られ、
 * 実寸は設定値と一致しない。サムネイルは `aspect-ratio: 16 / 9` なので
 * その差がそのまま高さの差になり、設定値から出すとカードが行より高くなって
 * 名前とサイズの行が次の行の裏に隠れる(v1.17 で踏んだ。
 * 既定 224px・一覧幅 900px あたりで 30px ほどはみ出していた)。
 *
 * `gridWidth` は `.grid-scroll` の clientWidth(縦スクロールバーを除いた内寸)。
 * `chipRows` はカード下に足すタグ行・シリーズ行の本数(0〜2、v1.23)
 */
export function gridMetrics(gridWidth: number, cardWidth: number, chipRows = 0): GridMetrics {
  const cols = Math.max(1, Math.floor(gridWidth / cardWidth));
  const inner = gridWidth - GRID_PAD * 2 - GRID_GAP * (cols - 1);
  // 極端に狭いと inner が負になりうる。高さを負にしない
  const cardW = Math.max(0, inner / cols);
  const textH = CARD_TEXT_H + chipRows * CARD_CHIP_ROW_H;
  return { cols, cardW, rowHeight: Math.round(cardW * THUMB_RATIO) + textH };
}

/**
 * カードの実寸に対して 1 行に並べるチップの数。溢れたぶんは `+N` にまとめる。
 * DOM を測らず幅から決め打ちする(仮想化の中で getBoundingClientRect を回さないため)
 */
export function chipBudget(cardW: number): number {
  if (cardW < 170) return 1;
  if (cardW < 250) return 2;
  return 3;
}
