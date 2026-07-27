import { describe, expect, it } from 'vitest';
import type { VideoRow } from '../types';
import { buildFolderMenu, buildVideoMenu, isSeparator } from './contextMenu';
import type { MenuEntry, MenuItem } from './contextMenu';

/** メニューの判定が見るフィールドだけ持つ最小の行を作る */
function row(patch: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 1, path: 'C:\\動画\\サンプル.mp4', filename: 'サンプル.mp4', title: null, size: 0,
    durationMs: null, width: null, height: null, rating: 0, viewCount: 0, lastViewedAt: null,
    resumeMs: 0, videoCodec: null, audioCodec: null, isMissing: false, isOffline: false,
    thumbState: 0, thumbPath: null, addedAt: '',
    fileCreatedAt: null, fileModifiedAt: null, fps: null, bitrate: null, ...patch,
  };
}

/** id で 1 項目を引く(区切り線は飛ばす) */
function item(entries: MenuEntry[], id: string): MenuItem {
  const found = entries.find((e): e is MenuItem => !isSeparator(e) && e.id === id);
  if (!found) throw new Error(`項目が見つかりません: ${id}`);
  return found;
}

const isDisabled = (entries: MenuEntry[], id: string) => item(entries, id).disabled === true;

describe('buildVideoMenu', () => {
  it('1 件・オンラインなら全項目が押せる', () => {
    const v = row();
    const menu = buildVideoMenu([v], v);
    const ids = menu.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.id);
    expect(ids).toEqual([
      'play', 'rating', 'openDefault', 'openWith', 'reveal', 'openFolder', 'copyPath',
      'rename', 'move', 'rethumb', 'removeFromLibrary', 'trash',
    ]);
    expect(menu.filter(isSeparator)).toHaveLength(5);
    for (const id of ids) expect(isDisabled(menu, id)).toBe(false);
  });

  it('複数選択では単一件専用の項目だけが無効になる', () => {
    const a = row({ id: 1 });
    const b = row({ id: 2 });
    const menu = buildVideoMenu([a, b], a);
    for (const id of ['openDefault', 'openWith', 'rename']) {
      expect(isDisabled(menu, id)).toBe(true);
    }
    // 右クリックした 1 件に対して働くもの・全件に働くものは押せたまま
    for (const id of ['play', 'reveal', 'openFolder', 'copyPath', 'move', 'rethumb', 'trash']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });

  it('オフラインの動画では実体を触る項目が無効になる', () => {
    const v = row({ isOffline: true });
    const menu = buildVideoMenu([v], v);
    for (const id of ['play', 'openDefault', 'openWith', 'reveal', 'rename', 'move', 'rethumb', 'trash']) {
      expect(isDisabled(menu, id)).toBe(true);
    }
    // パス由来の操作とライブラリ登録の削除は、オフラインでも使える必要がある
    for (const id of ['rating', 'openFolder', 'copyPath', 'removeFromLibrary']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
    expect(item(menu, 'play').hint).toBe('ドライブが未接続です');
  });

  it('見つからない動画も同じ扱いで、理由の文言だけ変わる', () => {
    const v = row({ isMissing: true });
    const menu = buildVideoMenu([v], v);
    expect(isDisabled(menu, 'play')).toBe(true);
    expect(item(menu, 'play').hint).toBe('ファイルが見つかりません');
    expect(isDisabled(menu, 'removeFromLibrary')).toBe(false);
  });

  // 1 件でも触れるものがあれば、まとめて実行する操作は通す(Rust 側が触れない行を弾く)
  it('オフラインが混ざっていても、まとめて実行する項目は押せる', () => {
    const ok = row({ id: 1 });
    const off = row({ id: 2, isOffline: true });
    const menu = buildVideoMenu([ok, off], ok);
    expect(isDisabled(menu, 'move')).toBe(false);
    expect(isDisabled(menu, 'trash')).toBe(false);
    expect(isDisabled(menu, 'rethumb')).toBe(false);
  });

  it('右クリックした動画がオフラインなら、他が生きていても再生は無効', () => {
    const ok = row({ id: 1 });
    const off = row({ id: 2, isOffline: true });
    const menu = buildVideoMenu([ok, off], off);
    expect(isDisabled(menu, 'play')).toBe(true);
    expect(isDisabled(menu, 'reveal')).toBe(true);
  });

  it('削除系のラベルに選択件数が入る', () => {
    const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    const menu = buildVideoMenu(rows, rows[0]);
    expect(item(menu, 'removeFromLibrary').label).toBe('3 件をライブラリから削除');
    expect(item(menu, 'trash').label).toBe('3 件をごみ箱へ');
    expect(item(menu, 'copyPath').label).toBe('3 件のフルパスをコピー');
    // 1 件のときは件数を出さない
    const one = buildVideoMenu([rows[0]], rows[0]);
    expect(item(one, 'trash').label).toBe('ごみ箱へ');
  });

  it('削除系には danger が立つ', () => {
    const v = row();
    const menu = buildVideoMenu([v], v);
    expect(item(menu, 'removeFromLibrary').danger).toBe(true);
    expect(item(menu, 'trash').danger).toBe(true);
    expect(item(menu, 'play').danger).toBeUndefined();
  });

  describe('レーティングのサブメニュー', () => {
    it('★5〜★1 と「評価なし」の 6 項目が出る', () => {
      const v = row();
      const sub = item(buildVideoMenu([v], v), 'rating').submenu!;
      expect(sub.map((s) => s.id)).toEqual([
        'rating:5', 'rating:4', 'rating:3', 'rating:2', 'rating:1', 'rating:0',
      ]);
      expect(sub[0].label).toBe('★★★★★');
      expect(sub[4].label).toBe('★☆☆☆☆');
    });

    it('選択全件が同じ星ならその項目にチェックが付く', () => {
      const rows = [row({ id: 1, rating: 3 }), row({ id: 2, rating: 3 })];
      const sub = item(buildVideoMenu(rows, rows[0]), 'rating').submenu!;
      expect(sub.filter((s) => s.checked).map((s) => s.id)).toEqual(['rating:3']);
    });

    it('星がバラバラならどれにもチェックを付けない', () => {
      const rows = [row({ id: 1, rating: 3 }), row({ id: 2, rating: 5 })];
      const sub = item(buildVideoMenu(rows, rows[0]), 'rating').submenu!;
      expect(sub.some((s) => s.checked)).toBe(false);
    });

    it('未評価のときは「評価なし」にチェックが付く', () => {
      const v = row({ rating: 0 });
      const sub = item(buildVideoMenu([v], v), 'rating').submenu!;
      expect(sub.filter((s) => s.checked).map((s) => s.id)).toEqual(['rating:0']);
    });
  });
});

describe('buildFolderMenu', () => {
  it('3 項目だけを返す', () => {
    const menu = buildFolderMenu();
    expect(menu.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.id)).toEqual([
      'folderOpen', 'folderReveal', 'folderCopyPath',
    ]);
  });
});
