import { describe, expect, it } from 'vitest';
import { bandHas, cellIndices, marqueeCells, rectFrom, sameCells } from './marquee';
import type { MarqueeLayout } from './marquee';
import { GRID_GAP, GRID_PAD, gridMetrics } from './grid';
import { CARD_WIDTH_DEFAULT } from '../store';

/** 4 列・カード 200px・行高 170px の素直な一覧 */
const grid = (patch: Partial<MarqueeLayout> = {}): MarqueeLayout => ({
  list: false, cols: 4, cardW: 200, rowHeight: 170, folderRows: 0, total: 100, ...patch,
});

/** 列 c の中心 x(GRID_PAD + c*(cardW+GRID_GAP) + cardW/2) */
const colCenter = (l: MarqueeLayout, c: number) =>
  GRID_PAD + c * (l.cardW + GRID_GAP) + l.cardW / 2;
const rowCenter = (l: MarqueeLayout, r: number) => r * l.rowHeight + l.rowHeight / 2;

/** 上限は十分大きく。切り詰めそのものは専用のテストで見る */
const cells = (l: MarqueeLayout, rect: Parameters<typeof marqueeCells>[0], limit = 100000) =>
  marqueeCells(rect, l, limit);

const indices = (l: MarqueeLayout, rect: Parameters<typeof marqueeCells>[0], limit = 100000) => {
  const hit = cells(l, rect, limit);
  return hit ? cellIndices(hit.range, l) : [];
};

describe('marqueeCells', () => {
  it('1 枚のカードの中心を含む極小の矩形はその 1 件だけ', () => {
    const l = grid();
    const x = colCenter(l, 2);
    const y = rowCenter(l, 1);
    expect(indices(l, rectFrom(x - 1, y - 1, x + 1, y + 1))).toEqual([6]);
  });

  it('2 行 × 2 列にまたがる矩形は 4 件', () => {
    const l = grid();
    expect(indices(l, rectFrom(
      colCenter(l, 1), rowCenter(l, 0), colCenter(l, 2), rowCenter(l, 1),
    ))).toEqual([1, 2, 5, 6]);
  });

  it('カード同士の隙間だけをなぞったら 0 件', () => {
    const l = grid();
    // 列 0 の右端 と 列 1 の左端 のあいだ(GRID_GAP = 12px)
    const gapLeft = GRID_PAD + l.cardW;
    expect(cells(l, rectFrom(gapLeft + 1, 0, gapLeft + GRID_GAP - 1, 1000))).toBeNull();
  });

  it('左右の padding(12px)からも始められる —— ここが投げ縄の入口', () => {
    const l = grid();
    // 行の左端の帯を縦になぞる。列 0 に触れないので 0 件だが、null にはならず…
    expect(cells(l, rectFrom(0, 0, GRID_PAD - 1, 1000))).toBeNull();
    // …列 0 に少しでも入れば拾える
    expect(indices(l, rectFrom(0, 0, GRID_PAD + 1, 1))).toEqual([0]);
  });

  it('逆向き(右下 → 左上)に引いても同じ結果', () => {
    const l = grid();
    const a = [colCenter(l, 1), rowCenter(l, 0)] as const;
    const b = [colCenter(l, 2), rowCenter(l, 1)] as const;
    expect(indices(l, rectFrom(...a, ...b))).toEqual(indices(l, rectFrom(...b, ...a)));
  });

  it('高さ 0 / 幅 0 の矩形は何も選ばない(クリックと衝突させない)', () => {
    const l = grid();
    const x = colCenter(l, 0);
    const y = rowCenter(l, 0);
    expect(cells(l, rectFrom(x, y, x + 10, y))).toBeNull();
    expect(cells(l, rectFrom(x, y, x, y + 10))).toBeNull();
  });

  it('total を超えるセル(最終行の余り)は返らない', () => {
    const l = grid({ total: 6 });
    // 行 1 は index 4,5 までしか無い
    expect(indices(l, rectFrom(0, rowCenter(l, 1) - 1, 10000, rowCenter(l, 1) + 1)))
      .toEqual([4, 5]);
  });

  it('最終行の余ったセルしか囲めていなければ null', () => {
    const l = grid({ total: 5 });
    // 行 1 の列 2〜3(index 6,7)は存在しない
    expect(cells(l, rectFrom(
      colCenter(l, 2), rowCenter(l, 1), colCenter(l, 3), rowCenter(l, 1) + 1,
    ))).toBeNull();
  });

  it('先頭のフォルダ行は選ばれず、通し番号もずれない', () => {
    const l = grid({ folderRows: 2 });
    // 行 0〜1 はフォルダ。丸ごと囲んでも 0 件
    expect(cells(l, rectFrom(0, 0, 10000, l.rowHeight * 2 - 1))).toBeNull();
    // 行 2 の先頭が index 0
    expect(indices(l, rectFrom(0, rowCenter(l, 2) - 1, 10000, rowCenter(l, 2) + 1)))
      .toEqual([0, 1, 2, 3]);
  });

  it('詳細リストは x を無視して行だけで決まる', () => {
    const l = grid({ list: true, cols: 1, rowHeight: 44 });
    // 行の右外(横スクロール域)から縦に引いても行が選ばれる
    expect(indices(l, rectFrom(9000, rowCenter(l, 1), 9001, rowCenter(l, 3)))).toEqual([1, 2, 3]);
    // 幅 0 でも(リストは横を見ないので)拾える
    expect(indices(l, rectFrom(5, rowCenter(l, 0), 5, rowCenter(l, 1)))).toEqual([0, 1]);
  });

  it('退化した入力でも落ちない', () => {
    for (const l of [
      grid({ total: 0 }), grid({ cols: 0 }), grid({ rowHeight: 0 }), grid({ cardW: 0 }),
      grid({ cols: 1, cardW: 0 }),
    ]) {
      expect(() => cells(l, rectFrom(0, 0, 500, 500))).not.toThrow();
    }
  });
});

describe('marqueeCells の上限', () => {
  it('上限を超えたら下から切り、truncated が立つ', () => {
    const l = grid({ total: 100000 });
    const hit = cells(l, rectFrom(0, 0, 10000, 10000 * l.rowHeight), 1000);
    expect(hit?.truncated).toBe(true);
    expect(cellIndices(hit!.range, l)).toHaveLength(1000);
    // 切るのは常に下(先頭から数えた 1000 件)
    expect(cellIndices(hit!.range, l)[0]).toBe(0);
  });

  it('上限内なら truncated は立たない', () => {
    const l = grid({ total: 100000 });
    const hit = cells(l, rectFrom(0, 0, 10000, l.rowHeight * 10), 1000);
    expect(hit?.truncated).toBe(false);
    expect(cellIndices(hit!.range, l)).toHaveLength(40);
  });

  /*
   * 細い帯を何万行もなぞったときに `getRange(最初, 最後)` が触るページ数が
   * 爆発しないことを固定する。件数だけで切ると、1 列ぶんの帯で通し番号が
   * 上限 × 列数ぶんに散らばる —— それでもページ数は Ctrl+A と同じ規模に収まる
   */
  it('どんな形でも、拾う通し番号の幅は上限 × 列数を超えない', () => {
    const limit = 1000;
    for (const l of [grid({ total: 500000 }), grid({ total: 500000, cols: 8, cardW: 100 })]) {
      for (let c = 0; c < l.cols; c++) {
        const x = colCenter(l, c);
        const idx = indices(l, rectFrom(x, 0, x + 1, 100000 * l.rowHeight), limit);
        expect(idx.length).toBeLessThanOrEqual(limit);
        expect(idx[idx.length - 1] - idx[0] + 1).toBeLessThanOrEqual(limit * l.cols);
      }
    }
  });

  it('リストでも上限どおりに切れる', () => {
    const l = grid({ list: true, cols: 1, rowHeight: 44, total: 100000 });
    const idx = indices(l, rectFrom(0, 0, 10, 100000 * l.rowHeight), 1000);
    expect(idx).toHaveLength(1000);
    expect(idx[999]).toBe(999);
  });
});

describe('bandHas / cellIndices / sameCells', () => {
  it('bandHas と cellIndices が食い違わない', () => {
    const l = grid({ folderRows: 1, total: 37 });
    const hit = cells(l, rectFrom(
      colCenter(l, 1), rowCenter(l, 2), colCenter(l, 2), rowCenter(l, 5),
    ))!;
    const inside = new Set(cellIndices(hit.range, l));
    for (let i = -2; i < l.total + 2; i++) {
      expect(bandHas(hit.range, i, l)).toBe(inside.has(i));
    }
  });

  it('sameCells は null 同士も等しいと見る', () => {
    const r = { rowFrom: 1, rowTo: 2, colFrom: 0, colTo: 3 };
    expect(sameCells(null, null)).toBe(true);
    expect(sameCells(r, null)).toBe(false);
    expect(sameCells(r, { ...r })).toBe(true);
    expect(sameCells(r, { ...r, rowTo: 3 })).toBe(false);
  });
});

/*
 * `gridMetrics` との整合。GRID_PAD / GRID_GAP / VideoGrid の行スタイルのどれかを
 * 片方だけ動かしたらここで落ちる(grid.test.ts の「定数が対応している」と同じ狙い)
 */
describe('gridMetrics との整合', () => {
  it('どの一覧幅でも、セルの中心を突くとその列だけが返る', () => {
    for (let gridWidth = 300; gridWidth <= 2400; gridWidth += 37) {
      const m = gridMetrics(gridWidth, CARD_WIDTH_DEFAULT);
      const l = grid({ cols: m.cols, cardW: m.cardW, rowHeight: m.rowHeight, total: 1000 });
      for (let c = 0; c < m.cols; c++) {
        const x = colCenter(l, c);
        const y = rowCenter(l, 3);
        expect(indices(l, rectFrom(x - 0.5, y - 0.5, x + 0.5, y + 0.5))).toEqual([3 * m.cols + c]);
      }
    }
  });

  it('一覧の全幅を横断すると必ず 1 行ぶん(= 列数)が返る', () => {
    for (let gridWidth = 300; gridWidth <= 2400; gridWidth += 37) {
      const m = gridMetrics(gridWidth, CARD_WIDTH_DEFAULT);
      const l = grid({ cols: m.cols, cardW: m.cardW, rowHeight: m.rowHeight, total: 1000 });
      const y = rowCenter(l, 2);
      expect(indices(l, rectFrom(0, y - 0.5, gridWidth, y + 0.5))).toHaveLength(m.cols);
    }
  });
});
