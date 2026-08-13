import { describe, expect, it } from 'vitest';
import { EMPTY_ADVANCED } from '../types';
import type {
  FolderNode, LibraryEntry, Series, SmartFolder, Tag, TagGroup, VideoRow, WatchedFolder,
} from '../types';
import {
  buildFolderMenu, buildFolderTreeMenu, buildGridBlankMenu, buildLibraryMenu, buildPlayerMenu,
  buildSeriesMenu, buildSideSectionMenu, buildSmartFolderMenu, buildTagGroupMenu, buildTagMenu,
  buildVideoMenu, buildWatchedFolderMenu, isSeparator,
} from './contextMenu';
import type { GridBlankState, MenuEntry, MenuItem } from './contextMenu';
import { CURATED_SORTS, sortLabel } from './listColumns';
import { EMPTY_FILTER, type FilterState } from './query';
import { TAG_PALETTE } from './tagColors';

/** メニューの判定が見るフィールドだけ持つ最小の行を作る */
function row(patch: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 1, path: 'C:\\動画\\サンプル.mp4', filename: 'サンプル.mp4', title: null, size: 0,
    durationMs: null, width: null, height: null, rating: 0, viewCount: 0, lastViewedAt: null,
    resumeMs: 0, videoCodec: null, audioCodec: null, isMissing: false, isOffline: false,
    thumbState: 0, thumbPath: null, addedAt: '',
    fileCreatedAt: null, fileModifiedAt: null, fps: null, bitrate: null,
    watchedFolderId: null, ...patch,
  };
}

/** id で 1 項目を引く(区切り線は飛ばす) */
function item(entries: MenuEntry[], id: string): MenuItem {
  const found = entries.find((e): e is MenuItem => !isSeparator(e) && e.id === id);
  if (!found) throw new Error(`項目が見つかりません: ${id}`);
  return found;
}

const isDisabled = (entries: MenuEntry[], id: string) => item(entries, id).disabled === true;

/** 区切り線を除いたトップレベルの id 列 */
const ids = (entries: MenuEntry[]) =>
  entries.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.id);

/** サブメニューを引く(無ければ落とす) */
function sub(entries: MenuEntry[], id: string): MenuItem[] {
  const s = item(entries, id).submenu;
  if (!s) throw new Error(`サブメニューがありません: ${id}`);
  return s;
}

// --- v1.20 のビルダーが見るフィールドだけ持つ最小のデータ ---

const tagRow = (patch: Partial<Tag> = {}): Tag => ({
  id: 1, name: 'アニメ', color: null, groupId: null, groupName: null, videoCount: 3, ...patch,
});

const groupRow = (patch: Partial<TagGroup> = {}): TagGroup => ({
  id: 10, name: 'ジャンル', sortOrder: 0, tagCount: 2, ...patch,
});

const watchedRow = (patch: Partial<WatchedFolder> = {}): WatchedFolder => ({
  id: 1, path: 'D:\\動画', recursive: true, enabled: true, online: true, videoCount: 42, ...patch,
});

const smartRow = (patch: Partial<SmartFolder> = {}): SmartFolder => ({
  id: 1, name: 'お気に入り', queryJson: '{}', position: 0, ...patch,
});

const seriesRow = (patch: Partial<Series> = {}): Series => ({
  id: 1, name: '第 1 期', videoCount: 12, ...patch,
});

const nodeRow = (patch: Partial<FolderNode> = {}): FolderNode => ({
  path: 'D:\\動画\\2026', parent: 'D:\\動画', name: '2026', directCount: 5, totalCount: 9,
  watchedFolderId: null, online: true, ...patch,
});

const filters = (patch: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTER, ...patch });

const blank = (patch: Partial<GridBlankState> = {}): GridBlankState => ({
  total: 10, selectionCount: 0, viewMode: 'grid', parentPath: null, filters: filters(), ...patch,
});

describe('buildVideoMenu', () => {
  it('1 件・オンラインなら全項目が押せる', () => {
    const v = row();
    const menu = buildVideoMenu([v], v);
    const ids = menu.filter((e): e is MenuItem => !isSeparator(e)).map((e) => e.id);
    expect(ids).toEqual([
      'play', 'rating', 'queue', 'openWithApp', 'reveal', 'openFolder', 'copyPath',
      'rename', 'move', 'rethumb', 'removeFromLibrary', 'trash',
    ]);
    expect(menu.filter(isSeparator)).toHaveLength(5);
    for (const id of ids) expect(isDisabled(menu, id)).toBe(false);
  });

  it('キューはサブメニューに畳んである(トップレベルを 12 に収めるため)', () => {
    const v = row();
    const menu = buildVideoMenu([v], v);
    const queue = menu.find((e): e is MenuItem => !isSeparator(e) && e.id === 'queue');
    expect(queue?.submenu?.map((s) => s.id))
      .toEqual(['queue:add', 'queue:next', 'queue:replace']);
    // 「保存リストに追加」は載せない(どのリストかを選ぶ入力が要るので基準の外)
    expect(ids(menu).some((id) => id.startsWith('playlist'))).toBe(false);
  });

  it('複数選択では単一件専用の項目だけが無効になる', () => {
    const a = row({ id: 1 });
    const b = row({ id: 2 });
    const menu = buildVideoMenu([a, b], a);
    for (const id of ['openWithApp', 'rename']) {
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
    for (const id of ['play', 'openWithApp', 'reveal', 'rename', 'move', 'rethumb', 'trash']) {
      expect(isDisabled(menu, id)).toBe(true);
    }
    // パス由来の操作とライブラリ登録の削除は、オフラインでも使える必要がある。
    // キューは行を並べるだけなので、実体を触れなくても入れられる(再生時に飛ばす)
    for (const id of ['rating', 'queue', 'openFolder', 'copyPath', 'removeFromLibrary']) {
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

describe('buildTagMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildTagMenu(tagRow(), [groupRow()], []))).toEqual([
      'tag:filter', 'tag:filterOnly', 'tag:rename', 'tag:color', 'tag:group', 'tag:delete',
    ]);
  });

  it('絞り込み中かどうかでラベルとチェックが入れ替わる', () => {
    const off = buildTagMenu(tagRow(), [], []);
    expect(item(off, 'tag:filter').label).toBe('絞り込みに追加');
    expect(item(off, 'tag:filter').checked).toBe(false);

    const on = buildTagMenu(tagRow(), [], [1]);
    expect(item(on, 'tag:filter').label).toBe('絞り込みから外す');
    expect(item(on, 'tag:filter').checked).toBe(true);
  });

  it('「これだけで絞り込む」は結果が変わらないときだけ無効', () => {
    // 何も絞っていない = tag:filter と同じ結果になる
    expect(isDisabled(buildTagMenu(tagRow(), [], []), 'tag:filterOnly')).toBe(true);
    // すでにこれだけで絞っている
    expect(isDisabled(buildTagMenu(tagRow(), [], [1]), 'tag:filterOnly')).toBe(true);
    // 他のタグが混ざっていれば意味がある
    expect(isDisabled(buildTagMenu(tagRow(), [], [1, 2]), 'tag:filterOnly')).toBe(false);
    expect(isDisabled(buildTagMenu(tagRow(), [], [2]), 'tag:filterOnly')).toBe(false);
  });

  describe('色のサブメニュー', () => {
    it('パレットの 7 色 +「色なし」が並び、色にだけ swatch が付く', () => {
      expect(TAG_PALETTE).toHaveLength(7);
      const colors = sub(buildTagMenu(tagRow(), [], []), 'tag:color');
      expect(colors).toHaveLength(TAG_PALETTE.length + 1);
      expect(colors.map((c) => c.id)).toEqual([
        ...TAG_PALETTE.map((c) => `tag:color:${c.value}`), 'tag:color:none',
      ]);
      for (const c of colors.slice(0, -1)) expect(c.swatch).toBeTruthy();
      expect(colors[colors.length - 1].swatch).toBeUndefined();
    });

    it('現在の色にだけチェックが付く', () => {
      const c = TAG_PALETTE[2].value;
      const colors = sub(buildTagMenu(tagRow({ color: c }), [], []), 'tag:color');
      expect(colors.filter((x) => x.checked).map((x) => x.id)).toEqual([`tag:color:${c}`]);
    });

    it('色なしのタグは「色なし」にチェックが付く', () => {
      const colors = sub(buildTagMenu(tagRow({ color: null }), [], []), 'tag:color');
      expect(colors.filter((x) => x.checked).map((x) => x.id)).toEqual(['tag:color:none']);
    });
  });

  describe('グループのサブメニュー', () => {
    it('(未分類)+ 全グループが並び、現在の所属にチェックが付く', () => {
      const groups = [groupRow({ id: 10 }), groupRow({ id: 11, name: 'メディア種別' })];
      const groupSub = sub(buildTagMenu(tagRow({ groupId: 11 }), groups, []), 'tag:group');
      expect(groupSub.map((g) => g.id)).toEqual([
        'tag:group:none', 'tag:group:10', 'tag:group:11',
      ]);
      expect(groupSub.filter((g) => g.checked).map((g) => g.id)).toEqual(['tag:group:11']);
    });

    it('グループが 1 つも無ければ無効になる', () => {
      const menu = buildTagMenu(tagRow(), [], []);
      expect(isDisabled(menu, 'tag:group')).toBe(true);
      expect(item(menu, 'tag:group').hint).toBe('タググループがまだありません');
    });
  });

  it('削除は danger で、件数を添える', () => {
    const menu = buildTagMenu(tagRow({ videoCount: 7 }), [], []);
    expect(item(menu, 'tag:delete').danger).toBe(true);
    expect(item(menu, 'tag:delete').hint).toContain('7 件');
  });
});

describe('buildTagGroupMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildTagGroupMenu(groupRow(), 0, 2, 3, false, false))).toEqual([
      'group:filter', 'group:toggle', 'group:newTag', 'group:newGroup',
      'group:rename', 'group:moveUp', 'group:moveDown', 'group:delete',
    ]);
  });

  it('未分類ではグループそのものへの操作が全部無効になる', () => {
    const menu = buildTagGroupMenu(null, -1, 2, 3, false, false);
    for (const id of ['group:rename', 'group:moveUp', 'group:moveDown', 'group:delete']) {
      expect(isDisabled(menu, id)).toBe(true);
      expect(item(menu, id).hint).toBeTruthy();
    }
    // 絞り込みと開閉、作成は未分類でも押せる
    for (const id of ['group:filter', 'group:toggle', 'group:newTag', 'group:newGroup']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });

  it('端では動かせない方向だけが無効になる', () => {
    const first = buildTagGroupMenu(groupRow(), 0, 3, 1, false, false);
    expect(isDisabled(first, 'group:moveUp')).toBe(true);
    expect(item(first, 'group:moveUp').hint).toBe('すでに先頭です');
    expect(isDisabled(first, 'group:moveDown')).toBe(false);

    const last = buildTagGroupMenu(groupRow(), 2, 3, 1, false, false);
    expect(isDisabled(last, 'group:moveUp')).toBe(false);
    expect(isDisabled(last, 'group:moveDown')).toBe(true);
    expect(item(last, 'group:moveDown').hint).toBe('すでに末尾です');
  });

  it('タグが 0 個なら絞り込みと開閉が無効になる', () => {
    const menu = buildTagGroupMenu(groupRow(), 0, 1, 0, false, false);
    expect(isDisabled(menu, 'group:filter')).toBe(true);
    expect(isDisabled(menu, 'group:toggle')).toBe(true);
    expect(item(menu, 'group:toggle').hint).toBe('タグがまだありません');
  });

  it('畳んでいるかでラベルが入れ替わる', () => {
    expect(item(buildTagGroupMenu(groupRow(), 0, 1, 2, false, true), 'group:toggle').label)
      .toBe('タグを表示');
    expect(item(buildTagGroupMenu(groupRow(), 0, 1, 2, false, false), 'group:toggle').label)
      .toBe('タグを隠す');
  });

  it('配下タグが全部選ばれていれば絞り込みにチェックが付く', () => {
    const menu = buildTagGroupMenu(groupRow(), 0, 1, 2, true, false);
    expect(item(menu, 'group:filter').checked).toBe(true);
    expect(item(menu, 'group:filter').label).toBe('このグループの絞り込みを解除');
  });

  it('削除は danger で、未分類に移るタグの数を添える', () => {
    const menu = buildTagGroupMenu(groupRow({ tagCount: 4 }), 0, 1, 4, false, false);
    expect(item(menu, 'group:delete').danger).toBe(true);
    expect(item(menu, 'group:delete').hint).toContain('4 個');
  });
});

describe('buildWatchedFolderMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildWatchedFolderMenu(watchedRow(), false))).toEqual([
      'wf:open', 'wf:openDirect', 'wf:reveal', 'wf:copyPath', 'wf:remove',
    ]);
  });

  it('オフラインでもドライブに触らない項目は押せる', () => {
    const menu = buildWatchedFolderMenu(watchedRow({ online: false }), false);
    expect(isDisabled(menu, 'wf:reveal')).toBe(true);
    expect(item(menu, 'wf:reveal').hint).toBe('ドライブが未接続です');
    for (const id of ['wf:open', 'wf:openDirect', 'wf:copyPath', 'wf:remove']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });

  it('表示中のフォルダにはチェックが付き、解除は danger', () => {
    const menu = buildWatchedFolderMenu(watchedRow(), true);
    expect(item(menu, 'wf:open').checked).toBe(true);
    expect(item(menu, 'wf:remove').danger).toBe(true);
  });
});

describe('buildSmartFolderMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildSmartFolderMenu(smartRow(), 0, 3, false))).toEqual([
      'sf:open', 'sf:load', 'sf:rename', 'sf:overwrite', 'sf:moveUp', 'sf:moveDown', 'sf:delete',
    ]);
  });

  it('端では動かせない方向だけが無効になる', () => {
    const first = buildSmartFolderMenu(smartRow(), 0, 3, false);
    expect(isDisabled(first, 'sf:moveUp')).toBe(true);
    expect(isDisabled(first, 'sf:moveDown')).toBe(false);

    const last = buildSmartFolderMenu(smartRow(), 2, 3, false);
    expect(isDisabled(last, 'sf:moveUp')).toBe(false);
    expect(isDisabled(last, 'sf:moveDown')).toBe(true);
  });

  it('1 件しかなければ上下とも無効', () => {
    const menu = buildSmartFolderMenu(smartRow(), 0, 1, false);
    expect(isDisabled(menu, 'sf:moveUp')).toBe(true);
    expect(isDisabled(menu, 'sf:moveDown')).toBe(true);
  });

  // 見えている行の index で動かすと、隠れている行を飛び越して並びが壊れる
  it('サイドバーを絞り込んでいる間は並べ替えを止める', () => {
    const menu = buildSmartFolderMenu(smartRow(), 1, 3, true);
    expect(isDisabled(menu, 'sf:moveUp')).toBe(true);
    expect(isDisabled(menu, 'sf:moveDown')).toBe(true);
    expect(item(menu, 'sf:moveUp').hint).toBe('絞り込み中は並べ替えられません');
    // 並べ替え以外は絞り込み中でも押せる
    for (const id of ['sf:open', 'sf:rename', 'sf:overwrite', 'sf:delete']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });
});

describe('buildSeriesMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildSeriesMenu(seriesRow(), false))).toEqual([
      'series:filter', 'series:rename', 'series:delete',
    ]);
  });

  it('絞り込み中かどうかでラベルとチェックが入れ替わる', () => {
    expect(item(buildSeriesMenu(seriesRow(), false), 'series:filter').label)
      .toBe('このシリーズで絞り込む');
    const on = buildSeriesMenu(seriesRow(), true);
    expect(item(on, 'series:filter').label).toBe('絞り込みを解除');
    expect(item(on, 'series:filter').checked).toBe(true);
  });

  it('削除は danger で、件数を添える', () => {
    const menu = buildSeriesMenu(seriesRow({ videoCount: 9 }), false);
    expect(item(menu, 'series:delete').danger).toBe(true);
    expect(item(menu, 'series:delete').hint).toContain('9 件');
  });
});

describe('buildFolderTreeMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildFolderTreeMenu(nodeRow(), true, false, false))).toEqual([
      'tree:open', 'tree:expand', 'tree:reveal', 'tree:copyPath', 'tree:watch',
      'tree:dedupe', 'tree:exclude',
    ]);
  });

  it('サブフォルダが無ければ開閉できない', () => {
    const menu = buildFolderTreeMenu(nodeRow(), false, false, false);
    expect(isDisabled(menu, 'tree:expand')).toBe(true);
    expect(item(menu, 'tree:expand').hint).toBe('サブフォルダーはありません');
  });

  it('展開しているかでラベルが入れ替わる', () => {
    expect(item(buildFolderTreeMenu(nodeRow(), true, true, false), 'tree:expand').label)
      .toBe('サブフォルダーを隠す');
    expect(item(buildFolderTreeMenu(nodeRow(), true, false, false), 'tree:expand').label)
      .toBe('サブフォルダーを表示');
  });

  it('すでに監視フォルダなら追加は無効', () => {
    const menu = buildFolderTreeMenu(nodeRow({ watchedFolderId: 3 }), true, false, false);
    expect(isDisabled(menu, 'tree:watch')).toBe(true);
    expect(item(menu, 'tree:watch').hint).toBe('すでに監視フォルダです');
  });

  it('オフラインで無効になるのはエクスプローラー表示だけ', () => {
    const menu = buildFolderTreeMenu(nodeRow({ online: false }), true, false, false);
    expect(isDisabled(menu, 'tree:reveal')).toBe(true);
    for (const id of [
      'tree:open', 'tree:expand', 'tree:copyPath', 'tree:watch', 'tree:dedupe', 'tree:exclude',
    ]) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });

  it('表示中のフォルダにはチェックが付く', () => {
    expect(item(buildFolderTreeMenu(nodeRow(), true, false, true), 'tree:open').checked).toBe(true);
  });
});

describe('buildGridBlankMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildGridBlankMenu(blank()))).toEqual([
      'blank:selectAll', 'blank:clearSelection', 'blank:loadQueue', 'blank:view', 'blank:sort',
      'blank:up', 'blank:reveal', 'blank:clearFilters', 'blank:refresh',
    ]);
  });

  it('一覧が空なら全選択できない', () => {
    expect(isDisabled(buildGridBlankMenu(blank({ total: 0 })), 'blank:selectAll')).toBe(true);
    expect(isDisabled(buildGridBlankMenu(blank({ total: 1 })), 'blank:selectAll')).toBe(false);
  });

  // v1.41(C-4)
  it('一覧が空ならキューに読み込めない', () => {
    expect(isDisabled(buildGridBlankMenu(blank({ total: 0 })), 'blank:loadQueue')).toBe(true);
    expect(isDisabled(buildGridBlankMenu(blank({ total: 1 })), 'blank:loadQueue')).toBe(false);
  });

  it('選択が無ければ解除できない', () => {
    expect(isDisabled(buildGridBlankMenu(blank()), 'blank:clearSelection')).toBe(true);
    expect(isDisabled(buildGridBlankMenu(blank({ selectionCount: 2 })), 'blank:clearSelection'))
      .toBe(false);
  });

  it('フォルダーで絞っていなければ「上へ」と「エクスプローラーで表示」が無効', () => {
    const menu = buildGridBlankMenu(blank());
    expect(isDisabled(menu, 'blank:up')).toBe(true);
    expect(isDisabled(menu, 'blank:reveal')).toBe(true);
    expect(item(menu, 'blank:up').hint).toBe('フォルダーで絞り込んでいるときに使えます');
  });

  it('フォルダーの一番上では「上へ」だけが無効', () => {
    const s = blank({ filters: filters({ dirPath: 'D:\\動画' }), parentPath: null });
    const menu = buildGridBlankMenu(s);
    expect(isDisabled(menu, 'blank:reveal')).toBe(false);
    expect(isDisabled(menu, 'blank:up')).toBe(true);
    expect(item(menu, 'blank:up').hint).toBe('これ以上、上のフォルダーはありません');
  });

  it('表示モードの現在値にチェックが付く', () => {
    const grid = sub(buildGridBlankMenu(blank({ viewMode: 'grid' })), 'blank:view');
    expect(grid.filter((v) => v.checked).map((v) => v.id)).toEqual(['blank:view:grid']);
    const list = sub(buildGridBlankMenu(blank({ viewMode: 'list' })), 'blank:view');
    expect(list.filter((v) => v.checked).map((v) => v.id)).toEqual(['blank:view:list']);
  });

  it('並べ替えはツールバーと同じ選択肢を同じ順で出す', () => {
    const s = sub(buildGridBlankMenu(blank()), 'blank:sort');
    expect(s.map((x) => x.id)).toEqual(CURATED_SORTS.map((k) => `blank:sort:${k}`));
    expect(s[0].label).toBe(sortLabel(CURATED_SORTS[0]));
    expect(s.filter((x) => x.checked).map((x) => x.id)).toEqual(['blank:sort:added_desc']);
  });

  it('列ヘッダから選んだ並びは、選ばれている間だけ末尾に足される', () => {
    const s = sub(buildGridBlankMenu(blank({ filters: filters({ sort: 'fps_desc' }) })), 'blank:sort');
    expect(s).toHaveLength(CURATED_SORTS.length + 1);
    expect(s[s.length - 1].id).toBe('blank:sort:fps_desc');
    expect(s[s.length - 1].checked).toBe(true);
  });

  describe('絞り込みの解除', () => {
    it('何も絞っていなければ無効', () => {
      const menu = buildGridBlankMenu(blank());
      expect(isDisabled(menu, 'blank:clearFilters')).toBe(true);
      expect(item(menu, 'blank:clearFilters').hint).toBe('いま絞り込んでいる条件はありません');
    });

    // 1 つでも効いていれば押せる。条件を足したらここにも足すこと
    const cases: [string, Partial<FilterState>][] = [
      ['検索文字列', { text: 'アニメ' }],
      ['タグ', { tagIds: [1] }],
      ['シリーズ', { seriesId: 1 }],
      ['監視フォルダ', { folderId: 1 }],
      ['フォルダー直下', { dirPath: 'D:\\動画' }],
      ['レーティング', { advanced: { ...EMPTY_ADVANCED, minRating: 3 } }],
      ['長さ', { advanced: { ...EMPTY_ADVANCED, maxDurationMs: 300_000 } }],
      ['見つからない', { missingOnly: true }],
      ['重複', { duplicatesOnly: true }],
      ['詳細検索', { advanced: { ...EMPTY_ADVANCED, untagged: true } }],
    ];
    for (const [name, patch] of cases) {
      it(`${name}で絞っていれば押せる`, () => {
        const menu = buildGridBlankMenu(blank({ filters: filters(patch) }));
        expect(isDisabled(menu, 'blank:clearFilters')).toBe(false);
      });
    }

    it('並び順は絞り込みに数えない', () => {
      const menu = buildGridBlankMenu(blank({ filters: filters({ sort: 'name_asc' }) }));
      expect(isDisabled(menu, 'blank:clearFilters')).toBe(true);
    });
  });
});

describe('buildPlayerMenu', () => {
  it('項目の並びは固定', () => {
    expect(ids(buildPlayerMenu(row()))).toEqual([
      'player:rating', 'player:setThumb', 'player:saveFrame',
      'player:reveal', 'player:copyPath', 'player:close',
    ]);
  });

  // ヘルパを共有しているので、片方だけ星の数が変わることがない
  it('レーティングのサブメニューは動画メニューと同じものを使う', () => {
    const v = row({ rating: 4 });
    expect(sub(buildPlayerMenu(v), 'player:rating')).toEqual(sub(buildVideoMenu([v], v), 'rating'));
  });

  // 実体のファイルを読む項目だけが無効になる。レーティングやパスのコピーは
  // DB の情報だけで完結するので、ドライブが無くても押せてよい
  it('オフラインで無効になるのは実体に触る項目だけ', () => {
    const menu = buildPlayerMenu(row({ isOffline: true }));
    for (const id of ['player:reveal', 'player:saveFrame']) {
      expect(isDisabled(menu, id)).toBe(true);
      expect(item(menu, id).hint).toBe('ドライブが未接続です');
    }
    for (const id of ['player:rating', 'player:setThumb', 'player:copyPath', 'player:close']) {
      expect(isDisabled(menu, id)).toBe(false);
    }
  });

  it('見失ったファイルでは理由が変わる', () => {
    const menu = buildPlayerMenu(row({ isMissing: true }));
    for (const id of ['player:reveal', 'player:saveFrame']) {
      expect(isDisabled(menu, id)).toBe(true);
      expect(item(menu, id).hint).toBe('ファイルが見つかりません');
    }
  });
});

const libRow = (patch: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'aaaa1111', name: 'メイン', root: 'C:\\DVM\\メイン', sortOrder: 0,
  lastOpenedAt: null, online: true, ...patch,
});

describe('buildLibraryMenu', () => {
  const libs = [
    libRow(),
    libRow({ id: 'bbbb2222', name: 'アーカイブ', root: 'E:\\DVM', online: false }),
  ];

  it('登録順に並べ、開いているものにチェックを付ける', () => {
    const m = buildLibraryMenu(libs, 'aaaa1111');
    expect(ids(m)).toEqual([
      'lib:switch:aaaa1111',
      'lib:switch:bbbb2222',
      'lib:create',
      'lib:add',
    ]);
    expect(item(m, 'lib:switch:aaaa1111').checked).toBe(true);
    expect(item(m, 'lib:switch:bbbb2222').checked).toBe(false);
  });

  /**
   * 未接続でも選べるままにする。無効にすると「なぜ出ているのか」だけが残って
   * 何も起きないので、選んだときにドライブを繋ぐよう案内するほうが先に進める
   */
  it('未接続のライブラリも選べる(ラベルと hint で理由を見せる)', () => {
    const m = buildLibraryMenu(libs, 'aaaa1111');
    const offline = item(m, 'lib:switch:bbbb2222');
    expect(offline.disabled).toBeUndefined();
    expect(offline.label).toContain('未接続');
    expect(offline.hint).toContain('E:\\');
  });

  it('1 つも無くても新規作成と既存を開くは出す', () => {
    expect(ids(buildLibraryMenu([], ''))).toEqual(['lib:create', 'lib:add']);
  });
});

/**
 * 全ビルダーに共通で守らせる約束。
 * 新しいメニューを足したらここの配列にも足す(足し忘れても既存は守られる)
 */
describe('メニュー共通の約束', () => {
  const v = row();
  const menus: [string, MenuEntry[], string | null][] = [
    // 第 3 要素は id の接頭辞。v1.14 からある 2 本は接頭辞なしのまま据え置き
    ['buildVideoMenu', buildVideoMenu([v], v), null],
    ['buildFolderMenu', buildFolderMenu(), null],
    ['buildTagMenu', buildTagMenu(tagRow(), [groupRow()], []), 'tag:'],
    ['buildTagGroupMenu', buildTagGroupMenu(groupRow(), 0, 2, 3, false, false), 'group:'],
    ['buildTagGroupMenu(未分類)', buildTagGroupMenu(null, -1, 2, 0, false, true), 'group:'],
    ['buildWatchedFolderMenu', buildWatchedFolderMenu(watchedRow({ online: false }), true), 'wf:'],
    ['buildSmartFolderMenu', buildSmartFolderMenu(smartRow(), 0, 1, true), 'sf:'],
    ['buildSeriesMenu', buildSeriesMenu(seriesRow(), true), 'series:'],
    ['buildFolderTreeMenu', buildFolderTreeMenu(nodeRow({ online: false }), false, false, true), 'tree:'],
    ['buildSideSectionMenu', buildSideSectionMenu('タグ', true), 'section:'],
    ['buildGridBlankMenu', buildGridBlankMenu(blank({ total: 0 })), 'blank:'],
    ['buildPlayerMenu', buildPlayerMenu(row({ isMissing: true })), 'player:'],
    ['buildLibraryMenu', buildLibraryMenu([libRow({ online: false })], 'zzz'), 'lib:'],
  ];

  for (const [name, menu, prefix] of menus) {
    describe(name, () => {
      // 「目安 12 項目を超えたらサブメニューに畳むか既存を見直す」を機械的に守らせる
      it('トップレベルは 12 項目以内', () => {
        expect(ids(menu).length).toBeLessThanOrEqual(12);
      });

      it('id が重複しない', () => {
        const all = ids(menu);
        expect(new Set(all).size).toBe(all.length);
        for (const e of menu) {
          if (isSeparator(e) || !e.submenu) continue;
          const subIds = e.submenu.map((s) => s.id);
          expect(new Set(subIds).size).toBe(subIds.length);
        }
      });

      // 押せない項目は消さずに残す代わりに、必ず理由を見せる(v1.14 の約束)
      it('無効な項目には必ず理由が付く', () => {
        for (const e of menu) {
          if (isSeparator(e)) continue;
          if (e.disabled) expect(e.hint, `${e.id} に hint がありません`).toBeTruthy();
        }
      });

      if (prefix) {
        it(`id が ${prefix} で始まる`, () => {
          for (const id of ids(menu)) expect(id.startsWith(prefix)).toBe(true);
        });
      }
    });
  }
});
