import { describe, expect, it } from 'vitest';
import { EMPTY_ADVANCED, type Series, type Tag, type WatchedFolder } from '../types';
import {
  describeFilter, hasActiveFilter, NO_MASTERS,
  type ClearAction, type FilterMasters,
} from './filterChips';
import type { FilterState } from './query';

const base: FilterState = {
  text: '',
  sort: 'added_desc',
  folderId: null,
  dirPath: null,
  tagIds: [],
  seriesId: null,
  missingOnly: false,
  minRating: 0,
  durationBucket: null,
  duplicatesOnly: false,
  advanced: EMPTY_ADVANCED,
  randomSeed: 42,
};

const tag = (id: number, name: string, groupId: number | null, groupName: string | null): Tag =>
  ({ id, name, color: null, groupId, groupName, videoCount: 0 });

const masters: FilterMasters = {
  // ジャンル(1): ファンタジー / SF、メディア(2): アニメ、未分類: 実写 / 高画質
  tags: [
    tag(10, 'ファンタジー', 1, 'ジャンル'),
    tag(11, 'SF', 1, 'ジャンル'),
    tag(20, 'アニメ', 2, 'メディア'),
    tag(30, '実写', null, null),
    tag(31, '高画質', null, null),
  ],
  folders: [{ id: 5, path: 'D:\\動画\\アニメ', recursive: true, enabled: true, online: true, videoCount: 3 }] as WatchedFolder[],
  series: [{ id: 7, name: '名作劇場', videoCount: 12 }] as Series[],
};

describe('describeFilter の基本', () => {
  it('条件が無ければ箱は 0 個', () => {
    expect(describeFilter(base, masters)).toEqual([]);
    expect(hasActiveFilter(base)).toBe(false);
  });

  // 並べ替えは「絞り込み」ではない。ここを数えると帯に消せないチップが出てしまう
  it('並び順は条件に数えない', () => {
    expect(describeFilter({ ...base, sort: 'name_asc' }, masters)).toEqual([]);
    expect(hasActiveFilter({ ...base, sort: 'random' })).toBe(false);
  });
});

describe('タグの箱分け(OR / AND の見せ方)', () => {
  it('同じグループのタグ 2 個は 1 つの箱にまとまる(= または)', () => {
    const terms = describeFilter({ ...base, tagIds: [10, 11] }, masters);
    expect(terms).toHaveLength(1);
    expect(terms[0].caption).toBe('ジャンル');
    expect(terms[0].chips.map((c) => c.label)).toEqual(['ファンタジー', 'SF']);
    // 2 個以上のときだけ「箱ごと外す」が出る
    expect(terms[0].clearAll).toEqual({ type: 'tagAxis', tagIds: [10, 11] });
  });

  it('グループが違うタグは別の箱になる(= かつ)', () => {
    const terms = describeFilter({ ...base, tagIds: [10, 20] }, masters);
    expect(terms).toHaveLength(2);
    expect(terms.map((t) => t.caption)).toEqual(['ジャンル', 'メディア']);
    for (const t of terms) expect(t.chips).toHaveLength(1);
  });

  // Rust 側で未分類タグは 1 つずつ独立した軸(= AND)。ここでまとめてはいけない
  it('未分類タグ 2 個はまとめない', () => {
    const terms = describeFilter({ ...base, tagIds: [30, 31] }, masters);
    expect(terms).toHaveLength(2);
    expect(terms.map((t) => t.caption)).toEqual([null, null]);
    expect(terms.map((t) => t.chips[0].label)).toEqual(['実写', '高画質']);
    expect(terms.every((t) => t.clearAll === null)).toBe(true);
  });

  it('グループ付き 2 個 + 未分類 1 個は箱 2 つ、順番は選んだ順', () => {
    const terms = describeFilter({ ...base, tagIds: [30, 10, 11] }, masters);
    expect(terms).toHaveLength(2);
    expect(terms[0].chips.map((c) => c.label)).toEqual(['実写']);
    expect(terms[1].chips.map((c) => c.label)).toEqual(['ファンタジー', 'SF']);
  });

  // core/query.rs の COALESCE('g'||group_id, 't'||id) と 1 対 1。片方だけ変えると
  // 「画面では または と書いてあるのに結果は AND」という食い違いになる
  it('軸キーは g<groupId> / t<id> の形になっている', () => {
    expect(describeFilter({ ...base, tagIds: [10] }, masters)[0].key).toBe('tags:g1');
    expect(describeFilter({ ...base, tagIds: [30] }, masters)[0].key).toBe('tags:t30');
  });

  it('マスタがまだ無いタグは単独の箱 + unresolved', () => {
    const terms = describeFilter({ ...base, tagIds: [10, 11] }, NO_MASTERS);
    expect(terms).toHaveLength(2);
    expect(terms.every((t) => t.chips[0].unresolved)).toBe(true);
    expect(terms.every((t) => t.chips[0].label === '…')).toBe(true);
  });

  it('タグの色はチップに乗る', () => {
    const colored: FilterMasters = {
      ...masters,
      tags: [{ ...tag(10, 'ファンタジー', 1, 'ジャンル'), color: '#c04040' }],
    };
    expect(describeFilter({ ...base, tagIds: [10] }, colored)[0].chips[0].color).toBe('#c04040');
  });
});

describe('タグ以外の条件', () => {
  const label = (f: Partial<FilterState>) =>
    describeFilter({ ...base, ...f }, masters).map((t) => t.chips.map((c) => c.label).join('/'));

  it.each([
    ['テキスト', { text: 'アニメ' }, '「アニメ」を含む'],
    ['フォルダー', { folderId: 5 }, 'フォルダー: アニメ'],
    ['フォルダー直下', { dirPath: 'D:\\動画\\2026\\' }, '2026 の直下'],
    ['シリーズ', { seriesId: 7 }, 'シリーズ: 名作劇場'],
    ['レーティング', { minRating: 3 }, '★3 以上'],
    ['長さ', { durationBucket: 'lt5' as const }, '5 分未満'],
    ['見つからない', { missingOnly: true }, '見つからないファイル'],
    ['重複', { duplicatesOnly: true }, '重複のみ'],
  ])('%s', (_name, patch, expected) => {
    expect(label(patch)).toEqual([expected]);
  });

  it.each([
    ['パスも検索', { searchPath: true }, 'パスも検索'],
    ['タグなし', { untagged: true }, 'タグなし'],
    ['未視聴', { unwatched: true }, '未視聴'],
    ['解像度', { minHeight: 1080 }, '1080p 以上'],
    ['追加日(以降)', { addedAfter: '2026-01-01' }, '2026-01-01 以降に追加'],
    ['追加日(以前)', { addedBefore: '2026-06-30' }, '2026-06-30 以前に追加'],
  ])('詳細検索: %s', (_name, patch, expected) => {
    expect(label({ advanced: { ...EMPTY_ADVANCED, ...patch } })).toEqual([expected]);
  });

  it('プリセットに無い解像度でもラベルになる', () => {
    expect(label({ advanced: { ...EMPTY_ADVANCED, minHeight: 900 } })).toEqual(['900p 以上']);
  });

  // コーデックの複数指定も OR。タグと同じ「箱」で見せる
  it('コーデック複数は 1 つの箱(= または)', () => {
    const terms = describeFilter(
      { ...base, advanced: { ...EMPTY_ADVANCED, videoCodecs: ['h264', 'hevc'] } },
      masters,
    );
    expect(terms).toHaveLength(1);
    expect(terms[0].caption).toBe('コーデック');
    expect(terms[0].chips.map((c) => c.label)).toEqual(['h264', 'hevc']);
    expect(terms[0].clearAll).toEqual({ type: 'advanced', key: 'videoCodecs' });
  });

  it('消えたフォルダ・シリーズは unresolved', () => {
    const terms = describeFilter({ ...base, folderId: 999, seriesId: 999 }, masters);
    expect(terms.map((t) => t.chips[0].unresolved)).toEqual([true, true]);
  });
});

describe('× の割り当て', () => {
  // FilterBar の switch に抜けがあると解除できないチップが生まれる。
  // 全条件を同時に立てて、ClearAction の全種類が出てくることを確かめる
  it('全条件を立てると ClearAction が出揃う', () => {
    const all: FilterState = {
      ...base,
      text: 'アニメ',
      folderId: 5,
      dirPath: 'D:\\動画',
      tagIds: [10, 11, 30],
      seriesId: 7,
      minRating: 3,
      durationBucket: 'lt5',
      missingOnly: true,
      duplicatesOnly: true,
      advanced: {
        searchPath: true,
        untagged: true,
        unwatched: true,
        minHeight: 1080,
        videoCodecs: ['h264', 'hevc'],
        addedAfter: '2026-01-01',
        addedBefore: '2026-06-30',
      },
    };
    const terms = describeFilter(all, masters);
    const types = new Set<ClearAction['type']>();
    for (const t of terms) {
      if (t.clearAll) types.add(t.clearAll.type);
      for (const c of t.chips) types.add(c.clear.type);
    }
    expect([...types].sort()).toEqual([
      'advanced', 'codec', 'dirPath', 'duplicates', 'duration', 'folder',
      'minRating', 'missing', 'searchPath', 'series', 'tag', 'tagAxis', 'text',
    ]);
    expect(hasActiveFilter(all)).toBe(true);
  });
});
