import { describe, expect, it } from 'vitest';
import {
  EMPTY_ADVANCED, type AdvancedFilter, type Series, type Tag, type WatchedFolder,
} from '../types';
import {
  describeFilter, hasActiveFilter, NO_MASTERS,
  type ClearAction, type FilterMasters,
} from './filterChips';
import { advancedCount, EMPTY_FILTER, type FilterState } from './query';

// 条件が増えても土台は 1 か所(lib/query.ts)から取る
const base: FilterState = EMPTY_FILTER;

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
  playlists: [
    { id: 3, name: '週末に観る', videoCount: 8, position: 0, durationMs: 0, thumbPath: null },
  ],
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

  /** 詳細検索の 1 項目だけを立てる */
  const adv = (patch: Partial<AdvancedFilter>) =>
    label({ advanced: { ...EMPTY_ADVANCED, ...patch } });

  it.each([
    ['テキスト', { text: 'アニメ' }, '「アニメ」を含む'],
    ['フォルダー', { folderId: 5 }, 'フォルダー: アニメ'],
    ['フォルダー直下', { dirPath: 'D:\\動画\\2026\\' }, '2026 の直下'],
    ['シリーズ', { seriesId: 7 }, 'シリーズ: 名作劇場'],
    ['見つからない', { missingOnly: true }, '見つからないファイル'],
    ['重複', { duplicatesOnly: true }, '重複のみ'],
  ])('%s', (_name, patch, expected) => {
    expect(label(patch)).toEqual([expected]);
  });

  // 配下モードは文言を変える。ここが変わらないと「件数が急に増えた理由」が読めない
  it('サブフォルダも含めるときは「配下すべて」と出る', () => {
    expect(label({ dirPath: 'D:\\動画\\2026', dirPathRecursive: true }))
      .toEqual(['2026 の配下すべて']);
    // フォルダで絞っていなければトグルは何も出さない
    expect(label({ dirPathRecursive: true })).toEqual([]);
  });

  it.each([
    ['パスも検索', { searchPath: true }, 'パスも検索'],
    ['メモも検索', { searchComment: true }, 'メモも検索'],
    ['レーティング', { minRating: 3 }, '★3 以上'],
    ['★なし', { unrated: true }, '★なし'],
    ['長さ(プリセット)', { maxDurationMs: 300_000 }, '5 分未満'],
    // プリセットに無い範囲でもチップになる(自由入力・MCP・保存した条件で起きる)
    ['長さ(カスタム)', { minDurationMs: 120_000, maxDurationMs: 480_000 }, '2〜8 分'],
    ['サイズ(GB)', { minSizeBytes: 2 * 1024 ** 3 }, '2 GB 以上'],
    ['サイズ(MB)', { maxSizeBytes: 500 * 1024 ** 2 }, '500 MB 未満'],
    ['サイズ(範囲)', { minSizeBytes: 100 * 1024 ** 2, maxSizeBytes: 500 * 1024 ** 2 }, '100〜500 MB'],
    ['タグなし', { untagged: true }, 'タグなし'],
    ['未視聴', { unwatched: true }, '未視聴'],
    ['途中まで観た', { resumedOnly: true }, '途中まで観た'],
    ['再生回数(下限)', { minViewCount: 3 }, '3 回以上'],
    ['再生回数(0 回)', { maxViewCount: 0 }, '未視聴'],
    ['解像度(下限)', { minHeight: 1080 }, '1080p 以上'],
    ['解像度(上限)', { maxHeight: 720 }, '720p 未満'],
    ['向き', { orientation: 'portrait' as const }, '縦長'],
    ['追加日(以降)', { addedAfter: '2026-01-01' }, '2026-01-01 以降に追加'],
    ['追加日(以前)', { addedBefore: '2026-06-30' }, '2026-06-30 以前に追加'],
    ['追加日(範囲)', { addedAfter: '2026-01-01', addedBefore: '2026-06-30' }, '2026-01-01〜2026-06-30 に追加'],
    ['追加(相対)', { addedWithinDays: 7 }, '過去 7 日に追加'],
    ['更新(相対)', { modifiedWithinDays: 30 }, '過去 30 日に更新'],
    ['更新日(範囲)', { modifiedAfter: '2025-01-01', modifiedBefore: '2025-12-31' }, '2025-01-01〜2025-12-31 に更新'],
  ])('詳細検索: %s', (_name, patch, expected) => {
    expect(adv(patch)).toEqual([expected]);
  });

  it('プリセットに無い解像度でもラベルになる', () => {
    expect(adv({ minHeight: 900 })).toEqual(['900p 以上']);
    expect(adv({ maxHeight: 900 })).toEqual(['900p 未満']);
  });

  // コーデック・拡張子の複数指定も OR。タグと同じ「箱」で見せる
  it.each([
    ['コーデック', 'videoCodecs', ['h264', 'hevc']],
    ['拡張子', 'extensions', ['mp4', 'mkv']],
  ] as const)('%s の複数指定は 1 つの箱(= または)', (caption, key, values) => {
    const terms = describeFilter(
      { ...base, advanced: { ...EMPTY_ADVANCED, [key]: values } },
      masters,
    );
    expect(terms).toHaveLength(1);
    expect(terms[0].caption).toBe(caption);
    expect(terms[0].chips.map((c) => c.label)).toEqual(values);
    expect(terms[0].clearAll).toEqual({ type: 'advanced', key });
    // 1 つずつ外す × は listItem
    expect(terms[0].chips[0].clear).toEqual({ type: 'listItem', key, value: values[0] });
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
      dirPathRecursive: true,
      tagIds: [10, 11, 30],
      seriesId: 7,
      missingOnly: true,
      duplicatesOnly: true,
      advanced: {
        searchPath: true,
        searchComment: true,
        minRating: 3,
        unrated: true,
        minDurationMs: 60_000,
        maxDurationMs: 300_000,
        minSizeBytes: 1024 ** 2,
        maxSizeBytes: 1024 ** 3,
        extensions: ['mp4', 'mkv'],
        minHeight: 720,
        maxHeight: 2160,
        orientation: 'landscape',
        videoCodecs: ['h264', 'hevc'],
        untagged: true,
        unwatched: true,
        resumedOnly: true,
        minViewCount: 1,
        maxViewCount: 9,
        addedAfter: '2026-01-01',
        addedBefore: '2026-06-30',
        addedWithinDays: 7,
        modifiedAfter: '2025-01-01',
        modifiedBefore: '2025-12-31',
        modifiedWithinDays: 30,
      },
    };
    const terms = describeFilter(all, masters);
    const types = new Set<ClearAction['type']>();
    for (const t of terms) {
      if (t.clearAll) types.add(t.clearAll.type);
      for (const c of t.chips) types.add(c.clear.type);
    }
    expect([...types].sort()).toEqual([
      'advanced', 'advancedRange', 'dirPath', 'duplicates', 'folder',
      'listItem', 'missing', 'series', 'tag', 'tagAxis', 'text',
    ]);
    expect(hasActiveFilter(all)).toBe(true);

    // 詳細検索の条件が 1 つも取りこぼされていないこと。
    // advancedCount は「軸ごとに 1 件」なので、帯の箱のうち詳細検索由来の数と一致する
    const fromAdvanced = terms.filter(
      (t) => !t.key.startsWith('tags:')
        && !['text', 'folder', 'dirPath', 'series', 'missing', 'duplicates'].includes(t.key),
    );
    expect(fromAdvanced).toHaveLength(advancedCount(all.advanced));
  });
});
