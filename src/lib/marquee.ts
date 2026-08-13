/*
 * 余白からのドラッグで一覧を矩形選択する(投げ縄、v1.42)の当たり判定。
 *
 * **DOM を測らない**。一覧は仮想化されていて DOM に載るのは可視分だけなので、
 * `getBoundingClientRect` で拾う実装は自動スクロールで流れていく「まだ描かれていない行」を
 * 取りこぼす。行の高さ・列数・カードの実寸はどれも `lib/grid.ts` が決めているので、
 * 矩形 → セル → 通し番号も同じ寸法から算術で出す。
 *
 * `grid.ts` に混ぜず別ファイルにしてあるのは、あちらを「カード 1 枚の寸法」に閉じた
 * モジュールのままにするため。**定数は必ず grid.ts から import する**(再宣言しないこと)。
 */

import { GRID_GAP, GRID_PAD } from './grid';

/** 仮想化コンテナ(高さ = getTotalSize() の div)の左上を原点とする内容座標(px) */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 2 点から矩形を作る。右下 → 左上に引いても同じものになる */
export function rectFrom(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

/** 当たり判定に要る一覧のかたち。`gridMetrics()` の結果 + 一覧の状態 */
export interface MarqueeLayout {
  /**
   * 詳細リストか。true なら**横方向を見ない** —— 行は `max(100%, 列幅の合計)` の
   * 全幅で、どの列に触れたかに選択上の意味が無い(エクスプローラーの詳細表示と同じ)。
   * 横スクロールした状態で x が可視域の外にあっても行選択が壊れないようにする狙いもある
   */
  list: boolean;
  cols: number;
  /** カードの実寸(`gridMetrics().cardW`)。list では使わない */
  cardW: number;
  rowHeight: number;
  /** 先頭に並ぶフォルダ行の数。フォルダは選択の対象外なので判定前に落とす */
  folderRows: number;
  /** 動画の総数。最終行の余ったセルを落とすのに使う */
  total: number;
}

/** 矩形が触れているセルの範囲(両端を含む)。行は画面上の通し行番号 */
export interface CellRange {
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
}

export interface MarqueeHit {
  range: CellRange;
  /** 上限に当たって下を切り捨てたか。トーストで断るのに使う */
  truncated: boolean;
}

/**
 * 矩形 → セル範囲。1 つも触れていなければ null。
 *
 * **上限は件数ではなくここ(セル範囲)で切る**。確定時に切ると
 * 「塗られていたのに選ばれない」ことになって見た目と結果が食い違う。
 * ここで `rowTo` を詰めておけば、塗られている枚数 = 選ばれる枚数になり、
 * `getRange` が触るページ数も自然に抑えられる
 */
export function marqueeCells(rect: Rect, l: MarqueeLayout, limit: number): MarqueeHit | null {
  if (l.total <= 0 || l.cols <= 0 || l.rowHeight <= 0) return null;

  // 高さ 0 / 幅 0 のドラッグは何も選ばない(クリックと同じ扱いにする)
  if (rect.bottom <= rect.top || (!l.list && rect.right <= rect.left)) return null;

  const lastRow = l.folderRows + Math.ceil(l.total / l.cols) - 1;
  // 行 r が占めるのは [r*rowHeight, (r+1)*rowHeight)。厳密不等号で交差を見る
  const rowFrom = Math.max(l.folderRows, Math.floor(rect.top / l.rowHeight));
  let rowTo = Math.min(lastRow, Math.ceil(rect.bottom / l.rowHeight) - 1);
  if (rowTo < rowFrom) return null;

  let colFrom = 0;
  let colTo = l.cols - 1;
  if (!l.list) {
    // 列 c は [GRID_PAD + c*(cardW+GRID_GAP), + cardW]。隙間だけをなぞったら何も選ばない
    const pitch = l.cardW + GRID_GAP;
    if (pitch <= 0) return null;
    colFrom = -1;
    for (let c = 0; c < l.cols; c++) {
      const left = GRID_PAD + c * pitch;
      if (left < rect.right && left + l.cardW > rect.left) {
        if (colFrom < 0) colFrom = c;
        colTo = c;
      }
    }
    if (colFrom < 0) return null;
  }

  // 上限に当たったら下から切る。切る方向を常に「上から数えて」に固定しておくと、
  // Ctrl+A の「先頭 N 件」と同じ説明で済む
  const perRow = colTo - colFrom + 1;
  const maxRows = Math.max(1, Math.floor(limit / perRow));
  const truncated = rowTo - rowFrom + 1 > maxRows;
  if (truncated) rowTo = rowFrom + maxRows - 1;

  const range = { rowFrom, rowTo, colFrom, colTo };
  // 末尾の欠けだけで 1 件も無いことがある(最終行の余ったセルしか囲めていない場合)
  if (!hasAny(range, l)) return null;
  return { range, truncated };
}

/** 同じセル範囲か。違うフレームでだけ再描画するために使う */
export function sameCells(a: CellRange | null, b: CellRange | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.rowFrom === b.rowFrom && a.rowTo === b.rowTo &&
    a.colFrom === b.colFrom && a.colTo === b.colTo
  );
}

/**
 * その通し番号が範囲に入っているか。
 * 描画のたびに可視セルぶん呼ぶので、Set を作らず算術だけで答える
 */
export function bandHas(range: CellRange, index: number, l: MarqueeLayout): boolean {
  if (index < 0 || index >= l.total) return false;
  const row = Math.floor(index / l.cols) + l.folderRows;
  const col = index % l.cols;
  return (
    row >= range.rowFrom && row <= range.rowTo &&
    col >= range.colFrom && col <= range.colTo
  );
}

/** セル範囲 → 動画の通し番号(昇順)。離した瞬間に 1 回だけ呼ぶ */
export function cellIndices(range: CellRange, l: MarqueeLayout): number[] {
  const out: number[] = [];
  for (let r = range.rowFrom; r <= range.rowTo; r++) {
    for (let c = range.colFrom; c <= range.colTo; c++) {
      const index = (r - l.folderRows) * l.cols + c;
      if (index >= 0 && index < l.total) out.push(index);
    }
  }
  return out;
}

/** 1 件でも入っているか(cellIndices を組み立てずに調べる) */
function hasAny(range: CellRange, l: MarqueeLayout): boolean {
  for (let r = range.rowFrom; r <= range.rowTo; r++) {
    const base = (r - l.folderRows) * l.cols;
    if (base + range.colFrom < l.total) return true;
  }
  return false;
}
