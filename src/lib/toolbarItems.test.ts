import { describe, expect, it } from 'vitest';
import {
  OVERFLOW_W, splitToolbar, TOOLBAR_GAP, TOOLBAR_ITEMS, TOOLBAR_ORDER, TOOLBAR_PADDING,
  toolbarKeys,
} from './toolbarItems';
import type { ToolbarItemKey } from './toolbarItems';

/** 畳めない(priority: 0)3 つ。どんな幅でもバーに残る */
const PINNED: ToolbarItemKey[] = ['sidebarToggle', 'search', 'advanced'];

/** グリッド表示の全 16 項目がちょうど収まる幅。定義から計算する(手で書くと定義とずれる) */
const FULL_W =
  TOOLBAR_ORDER.reduce((acc, k) => acc + TOOLBAR_ITEMS[k].width, 0)
  + TOOLBAR_GAP * (TOOLBAR_ORDER.length - 1)
  + TOOLBAR_PADDING;

describe('TOOLBAR_ITEMS / TOOLBAR_ORDER', () => {
  it('TOOLBAR_ORDER が TOOLBAR_ITEMS の全キーを過不足なく含む', () => {
    // 項目を足したとき TOOLBAR_ORDER への追加を忘れたら落ちる
    expect([...TOOLBAR_ORDER].sort()).toEqual(Object.keys(TOOLBAR_ITEMS).sort());
    expect(new Set(TOOLBAR_ORDER).size).toBe(TOOLBAR_ORDER.length);
  });

  it('各定義の key がレコードのキーと一致する', () => {
    for (const [key, def] of Object.entries(TOOLBAR_ITEMS)) expect(def.key).toBe(key);
  });

  it('畳める項目の priority は重複しない(畳む順が一意に決まる)', () => {
    const ps = TOOLBAR_ORDER.map((k) => TOOLBAR_ITEMS[k].priority).filter((p) => p > 0);
    expect(new Set(ps).size).toBe(ps.length);
  });

  it('畳まないのは検索・絞り込み・サイドバーの 3 つだけ', () => {
    const pinned = TOOLBAR_ORDER.filter((k) => TOOLBAR_ITEMS[k].priority === 0);
    expect(pinned).toEqual(PINNED);
  });

  it('定数が App.css と対応している(gap: 8px / padding: 8px 12px)', () => {
    // 片方だけ変えたらここで落ちる
    expect(TOOLBAR_GAP).toBe(8);
    expect(TOOLBAR_PADDING).toBe(24);
  });
});

describe('toolbarKeys', () => {
  it('グリッド表示ではサムネイルの大きさを含む', () => {
    expect(toolbarKeys('grid')).toEqual(TOOLBAR_ORDER);
  });

  it('リスト表示ではサムネイルの大きさが消える', () => {
    const keys = toolbarKeys('list');
    expect(keys).not.toContain('cardSize');
    expect(keys.length).toBe(TOOLBAR_ORDER.length - 1);
  });
});

describe('splitToolbar', () => {
  it('十分広ければ全項目がバーに出る(≫ の幅を足さない)', () => {
    const keys = toolbarKeys('grid');
    expect(splitToolbar(keys, 2000)).toEqual({ bar: keys, menu: [] });
    // ちょうど収まる幅でも畳まない
    expect(splitToolbar(keys, FULL_W)).toEqual({ bar: keys, menu: [] });
  });

  it('まだ測れていない(null)ときは全部出す', () => {
    const keys = toolbarKeys('grid');
    expect(splitToolbar(keys, null)).toEqual({ bar: keys, menu: [] });
  });

  it('1 項目ぶん足りないとき、≫ の場所も要るので 2 つ畳む', () => {
    // 32px の項目を 1 つ抜いても ≫(32) + gap(8) が入るので足りない
    const { menu } = splitToolbar(toolbarKeys('grid'), FULL_W - 1);
    expect(menu).toEqual(['saveQuery', 'history']);
  });

  it('極端に狭いときは畳めない 3 つだけが残る', () => {
    const { bar, menu } = splitToolbar(toolbarKeys('grid'), 200);
    expect(bar).toEqual(PINNED);
    expect(menu.length).toBe(toolbarKeys('grid').length - PINNED.length);
  });

  it('幅が 0・負数・NaN でも畳めない 3 つは残る', () => {
    for (const w of [0, -100, Number.NaN]) {
      expect(splitToolbar(toolbarKeys('grid'), w).bar).toEqual(PINNED);
    }
  });

  it('リスト表示ではサムネイルの大きさがどちらにも現れない', () => {
    const { bar, menu } = splitToolbar(toolbarKeys('list'), 700);
    expect(bar).not.toContain('cardSize');
    expect(menu).not.toContain('cardSize');
  });

  it('バーも ≫ も並びは TOOLBAR_ORDER のまま(priority 順に並べ替えない)', () => {
    // 押す位置が窓幅で動かないための性質
    const { bar, menu } = splitToolbar(toolbarKeys('grid'), 700);
    const rank = (k: ToolbarItemKey) => TOOLBAR_ORDER.indexOf(k);
    expect(bar).toEqual([...bar].sort((a, b) => rank(a) - rank(b)));
    expect(menu).toEqual([...menu].sort((a, b) => rank(a) - rank(b)));
    expect([...bar, ...menu].sort((a, b) => rank(a) - rank(b))).toEqual(toolbarKeys('grid'));
  });

  it('畳むのは priority の小さい順(途中を飛ばさない)', () => {
    const keys = toolbarKeys('grid');
    const byPriority = keys
      .filter((k) => TOOLBAR_ITEMS[k].priority > 0)
      .sort((a, b) => TOOLBAR_ITEMS[a].priority - TOOLBAR_ITEMS[b].priority);

    for (let w = 200; w <= FULL_W + 200; w += 10) {
      const { menu } = splitToolbar(keys, w);
      // 畳まれた集合は、必ず priority 順の先頭からの連続した並び
      const sorted = [...menu].sort((a, b) => TOOLBAR_ITEMS[a].priority - TOOLBAR_ITEMS[b].priority);
      expect(sorted).toEqual(byPriority.slice(0, menu.length));
    }
  });

  it('幅を広げるとバーの項目は必ず増える(狭めて戻したとき入れ替わらない)', () => {
    const keys = toolbarKeys('grid');
    let prev = new Set(splitToolbar(keys, 200).bar);
    for (let w = 210; w <= 2000; w += 10) {
      const cur = new Set(splitToolbar(keys, w).bar);
      for (const k of prev) expect(cur.has(k)).toBe(true);
      prev = cur;
    }
  });

  it('バーに出す項目は必ず実際に収まる', () => {
    const keys = toolbarKeys('grid');
    for (let w = 400; w <= FULL_W + 100; w += 10) {
      const { bar, menu } = splitToolbar(keys, w);
      const count = bar.length + (menu.length > 0 ? 1 : 0);
      const used =
        bar.reduce((acc, k) => acc + TOOLBAR_ITEMS[k].width, 0)
        + (menu.length > 0 ? OVERFLOW_W : 0)
        + TOOLBAR_GAP * (count - 1)
        + TOOLBAR_PADDING;
      // 畳みきってもなお入らない幅(畳めない 3 つ + ≫ で 324px)だけは例外
      if (menu.length < keys.length - PINNED.length) expect(used).toBeLessThanOrEqual(w);
    }
  });
});
