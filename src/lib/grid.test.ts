import { describe, expect, it } from 'vitest';
import { CARD_TEXT_H, GRID_GAP, GRID_PAD, gridMetrics } from './grid';
import { CARD_WIDTH_DEFAULT, CARD_WIDTH_MAX, CARD_WIDTH_MIN } from '../store';

describe('gridMetrics', () => {
  it('定数が App.css / VideoGrid の行スタイルと対応している', () => {
    // 片方だけ変えたらここで落ちる
    expect(GRID_PAD).toBe(12);
    expect(GRID_GAP).toBe(12);
  });

  it('カードの実寸は左右 padding と隙間を引いた残りを等分したもの', () => {
    // 一覧幅 935px・設定 224px → 4 列。(935 - 24 - 36) / 4
    const m = gridMetrics(935, 224);
    expect(m.cols).toBe(4);
    expect(m.cardW).toBeCloseTo(218.75);
  });

  it('列数は設定値の切り捨て。幅が足りなくても 1 列は出す', () => {
    expect(gridMetrics(900, 224).cols).toBe(4);
    expect(gridMetrics(224, 224).cols).toBe(1);
    expect(gridMetrics(100, 224).cols).toBe(1);
    expect(gridMetrics(0, 224).cols).toBe(1);
  });

  it('幅が 0 でも高さが負にならない', () => {
    const m = gridMetrics(0, 224);
    expect(m.cardW).toBe(0);
    expect(m.rowHeight).toBe(CARD_TEXT_H);
  });

  /*
   * v1.17 で踏んだ不具合の再発防止。行の高さを設定値から出していたころは、
   * 列数の切り捨てで余った幅がカードに配られるぶんだけカードが行より高くなり、
   * 名前とサイズが次の行の裏に隠れていた
   */
  it('どの幅でも、名前とサイズに使える高さが一定に残る', () => {
    for (let cardWidth = CARD_WIDTH_MIN; cardWidth <= CARD_WIDTH_MAX; cardWidth += 4) {
      for (let gridWidth = 200; gridWidth <= 2400; gridWidth += 10) {
        const { cardW, rowHeight } = gridMetrics(gridWidth, cardWidth);
        // 行の高さ − サムネイルの高さ = 文字に使える高さ。幅によらず一定であること
        expect(rowHeight - Math.round(cardW * (9 / 16))).toBe(CARD_TEXT_H);
      }
    }
  });

  it('設定値から出す旧計算より高くなる幅がある(直っていることの確認)', () => {
    const old = (cardWidth: number) => Math.round(cardWidth * (9 / 16)) + CARD_TEXT_H;
    // 窓 900px でサイドバーを開いた状態の一覧幅。2 列になり、カードは 309px まで広がる
    const m = gridMetrics(655, CARD_WIDTH_DEFAULT);
    expect(m.cols).toBe(2);
    expect(m.cardW).toBeGreaterThan(CARD_WIDTH_DEFAULT);
    // 旧計算だと 182px。実測でカードが 213px あり、31px はみ出していた
    expect(old(CARD_WIDTH_DEFAULT)).toBe(182);
    expect(m.rowHeight).toBeGreaterThan(old(CARD_WIDTH_DEFAULT));
  });

  it('カードが並んだ総幅は一覧幅を超えない', () => {
    for (let gridWidth = 200; gridWidth <= 2400; gridWidth += 7) {
      const { cols, cardW } = gridMetrics(gridWidth, 224);
      const used = GRID_PAD * 2 + cardW * cols + GRID_GAP * (cols - 1);
      // 1 列に満たない幅のときだけ、カードが 0 に潰れて padding だけが残る
      if (cardW > 0) expect(used).toBeLessThanOrEqual(gridWidth + 0.001);
    }
  });
});
