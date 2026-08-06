import { describe, expect, it } from 'vitest';
// ソースを文字列として読む(Vite の ?raw)。node:fs を使わないのは、この構成が
// @types/node を入れていないため —— vite.config.ts の @ts-expect-error と同じ事情
import gridSource from '../components/VideoGrid.tsx?raw';
import playerSource from '../components/player/usePlayerShortcuts.ts?raw';
import { chordLabel, keyLabel, SHORTCUTS } from './shortcuts';
import type { ShortcutGroupKey } from './shortcuts';

/*
 * 一覧(lib/shortcuts.ts)がキー処理の実装とずれていないかを見張るテスト(v1.39)。
 *
 * この機能の価値は「書いてあるとおりに動くこと」だけなので、**ハンドラにキーを足して
 * 一覧に書き忘れたら落ちる**ようにしておく。ソースを読んで `case '…'` と
 * `e.key === '…'` を抜き出し、表に載っているかを突き合わせる。
 *
 * 突き合わせは **ソース ⊆ 表** の一方向だけ。逆(表にあるものが必ずソースにある)は
 * 見ない —— 一覧の Escape のように、別のファイル(App.tsx)が処理しているものが
 * 表には正しく載るため
 */

/** 行コメントとブロックコメントを落とす。この後の波かっこ数えを狂わせないため */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * `switch (e.key) { … }` の中身だけを取り出す。
 *
 * ファイル全体から `case '…'` を拾うと、VideoGrid.tsx にある**右クリックメニューの
 * switch (id)**(`case 'play':` `case 'blank:refresh':` など)まで混ざる。
 * 波かっこを数えて対象の switch だけに絞る
 */
function keySwitchBody(src: string): string {
  const clean = stripComments(src);
  const at = clean.indexOf('switch (e.key)');
  if (at < 0) throw new Error('switch (e.key) が見つからない。抽出のしかたを見直すこと');
  const open = clean.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}' && --depth === 0) return clean.slice(open, i);
  }
  throw new Error('switch (e.key) の波かっこが閉じていない');
}

/** ハンドラが実際に見ているキー。英字は小文字に寄せる(表は小文字だけを持つ) */
function keysInSource(src: string): Set<string> {
  const found = new Set<string>();
  const add = (k: string) => found.add(/^[A-Za-z]$/.test(k) ? k.toLowerCase() : k);
  for (const m of keySwitchBody(src).matchAll(/case\s+'([^']*)'\s*:/g)) add(m[1]);
  // switch に入る前の分岐(プレイヤーの Escape、一覧の Ctrl+A)も拾う
  for (const m of stripComments(src).matchAll(/e\.key\s*===\s*'([^']*)'/g)) add(m[1]);
  return found;
}

/** 表がその系統で説明しているキー */
function keysInTable(group: ShortcutGroupKey): Set<string> {
  const g = SHORTCUTS.find((s) => s.key === group);
  if (!g) throw new Error(`グループ ${group} が無い`);
  return new Set(g.items.flatMap((i) => i.keys));
}

describe('SHORTCUTS', () => {
  it('グループの key が重複しない', () => {
    const keys = SHORTCUTS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('全項目に説明と表記がある', () => {
    for (const g of SHORTCUTS) {
      for (const i of g.items) {
        expect(i.label, `${g.key}: label が空`).toBeTruthy();
        // keys が空なら display が要る(マウスと組み合わせる操作)
        if (i.keys.length === 0) expect(i.display, `${g.key}: ${i.label}`).toBeTruthy();
        expect(chordLabel(i).length, `${g.key}: ${i.label}`).toBeGreaterThan(0);
      }
    }
  });

  it('英字キーは小文字で持つ(大文字の case と二重に書かない)', () => {
    for (const g of SHORTCUTS) {
      for (const key of g.items.flatMap((i) => i.keys)) {
        expect(/^[A-Z]$/.test(key), `${g.key}: ${key}`).toBe(false);
      }
    }
  });

  it('同じ系統の中で表記が重複しない(同じキーを 2 行に書かない)', () => {
    for (const g of SHORTCUTS) {
      const labels = g.items.map((i) => chordLabel(i).join('+'));
      expect(new Set(labels).size, `${g.key}: ${labels.join(' / ')}`).toBe(labels.length);
    }
  });
});

describe('keyLabel / chordLabel', () => {
  it('矢印と Space は読みやすい表記にする', () => {
    expect(keyLabel(' ')).toBe('Space');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Escape')).toBe('Esc');
  });

  it('英字は大文字で見せる', () => {
    expect(keyLabel('k')).toBe('K');
  });

  it('知らないキーはそのまま出す', () => {
    expect(keyLabel('PageUp')).toBe('PageUp');
    expect(keyLabel('<')).toBe('<');
  });

  it('修飾キーを前に並べる', () => {
    expect(chordLabel({ mods: ['Ctrl'], keys: ['ArrowLeft', 'ArrowRight'], label: '' }))
      .toEqual(['Ctrl', '←', '→']);
  });

  it('keys が空なら display を使う', () => {
    expect(chordLabel({ mods: ['Shift'], keys: [], display: 'クリック', label: '' }))
      .toEqual(['Shift', 'クリック']);
  });
});

describe('実装とのつき合わせ', () => {
  it('プレイヤーが見ているキーはすべて一覧に載っている', () => {
    const table = keysInTable('player');
    const missing = [...keysInSource(playerSource)].filter((k) => !table.has(k));
    // 落ちたら usePlayerShortcuts.ts に足したキーを SHORTCUTS の 'player' にも足す
    expect(missing).toEqual([]);
  });

  it('一覧が見ているキーはすべて一覧に載っている', () => {
    const table = keysInTable('grid');
    const missing = [...keysInSource(gridSource)].filter((k) => !table.has(k));
    // 落ちたら VideoGrid.tsx に足したキーを SHORTCUTS の 'grid' にも足す
    expect(missing).toEqual([]);
  });
});
