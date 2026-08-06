import { describe, expect, it } from 'vitest';
import type { VideoQuery } from '../types';
import {
  buildQuery, durationLabel, durationPreset, EMPTY_FILTER, toFilterState, type FilterState,
} from './query';

const base: FilterState = EMPTY_FILTER;

describe('buildQuery の dirPath', () => {
  // Rust 側は「未指定なら従来とまったく同じ SQL」を前提にしているので、
  // 絞っていないときに null をそのまま送らないこと
  it('未選択なら送らない', () => {
    expect(buildQuery(base).dirPath).toBeUndefined();
  });

  it('選択中はそのまま渡す', () => {
    expect(buildQuery({ ...base, dirPath: 'C:\\動画\\アニメ' }).dirPath).toBe('C:\\動画\\アニメ');
  });

  // フォルダーツリー(直下のみ)と監視フォルダ(配下すべて)は別条件。
  // store 側で排他にしているが、buildQuery は受け取ったものをそのまま両方通す
  it('folderId とは別のフィールドとして通る', () => {
    const q = buildQuery({ ...base, folderId: 3, dirPath: 'D:\\dl' });
    expect(q.folderId).toBe(3);
    expect(q.dirPath).toBe('D:\\dl');
  });
});

describe('尺の範囲', () => {
  it('プリセットと一致すればそのキーを返す', () => {
    expect(durationPreset(null, 300_000)).toBe('lt5');
    expect(durationPreset(300_000, 1_200_000)).toBe('5to20');
    expect(durationPreset(3_600_000, null)).toBe('gt60');
  });

  it('プリセットに無い範囲は null(= カスタム)', () => {
    expect(durationPreset(90_000, 480_000)).toBeNull();
    // 片側だけ一致してもプリセット扱いにしない
    expect(durationPreset(300_000, null)).toBeNull();
  });

  it('指定なしはプリセットではない', () => {
    expect(durationPreset(null, null)).toBeNull();
  });

  // 帯のチップとツールバーの「カスタム」項目が同じ文言を使う
  it('文言はプリセット名を優先し、外れたら範囲から組み立てる', () => {
    expect(durationLabel(null, 300_000)).toBe('5 分未満');
    expect(durationLabel(3_600_000, null)).toBe('60 分以上');
    expect(durationLabel(120_000, 480_000)).toBe('2〜8 分');
    expect(durationLabel(120_000, null)).toBe('2 分以上');
    expect(durationLabel(null, 120_000)).toBe('2 分未満');
  });

  it('絞っていなければ VideoQuery に出さない', () => {
    const q = buildQuery(base);
    expect(q.minDurationMs).toBeUndefined();
    expect(q.maxDurationMs).toBeUndefined();
  });
});

/**
 * **保存したスマートフォルダと AI の apply_filter が通る唯一の経路**。
 * ここが崩れると「保存して開き直すと条件が一部消える」が起きる
 * (v1.34 まで実際に尺の範囲が消えていた)。
 *
 * 条件を足すときは、まず ALL_CONDITIONS に 1 行足すこと。
 * buildQuery か toFilterState のどちらかを直し忘れれば、この 1 本が落ちる
 */
describe('VideoQuery ⇄ FilterState の往復', () => {
  /**
   * FilterState が表現できる条件を全部立てた VideoQuery。
   * **`minWidth` は入れない** —— UI が持っておらず buildQuery も出さないので、
   * 画面から保存した条件には入らない(MCP 専用の条件)
   */
  const ALL_CONDITIONS: VideoQuery = {
    text: '旅行 2024',
    sort: 'name_asc',
    folderId: 3,
    dirPath: 'D:\\動画\\アニメ',
    dirPathRecursive: true,
    tagIds: [1, 5, 9],
    seriesId: 7,
    missing: true,
    duplicatesOnly: true,
    // --- 詳細検索(AdvancedFilter)に入るもの ---
    searchPath: true,
    searchComment: true,
    minRating: 3,
    unrated: true,
    minDurationMs: 90_000,
    maxDurationMs: 480_000,
    minSizeBytes: 104_857_600,
    maxSizeBytes: 2_147_483_648,
    extensions: ['mp4', 'mkv'],
    minHeight: 720,
    maxHeight: 2160,
    orientation: 'portrait',
    videoCodecs: ['h264', 'hevc'],
    untagged: true,
    unwatched: true,
    resumedOnly: true,
    minViewCount: 1,
    maxViewCount: 10,
    addedAfter: '2026-01-01',
    addedBefore: '2026-06-30',
    addedWithinDays: 30,
    modifiedAfter: '2025-01-01',
    modifiedBefore: '2025-12-31',
    modifiedWithinDays: 90,
  };

  it('全条件が欠けずに戻る', () => {
    expect(buildQuery(toFilterState(ALL_CONDITIONS))).toEqual(ALL_CONDITIONS);
  });

  // 保存されているのは「効いている条件だけ」なので、空の JSON も通ること
  it('空のクエリは何も絞っていない状態になる', () => {
    const state = toFilterState({});
    expect(state).toEqual(EMPTY_FILTER);
    // 効いている条件が 1 つも無いので、値を持つのは sort と null 2 つだけ
    const q = buildQuery(state);
    const set = Object.entries(q).filter(([, v]) => v !== undefined);
    expect(Object.fromEntries(set)).toEqual({
      sort: 'added_desc',
      folderId: null,
      seriesId: null,
    });
  });

  // 種はランダム並びのときだけ意味を持つ(buildQuery が sort を見て落とす)
  it('ランダム並びの種も往復する', () => {
    const q: VideoQuery = { sort: 'random', randomSeed: 12_345 };
    expect(buildQuery(toFilterState(q))).toMatchObject({ sort: 'random', randomSeed: 12_345 });
  });

  it('ランダム以外の並びでは種を送らない', () => {
    expect(buildQuery(toFilterState({ sort: 'name_asc' })).randomSeed).toBeUndefined();
  });

  // 尺が bucket だった頃はここが落ちていた(VideoQuery から bucket に戻す手段が無かった)
  it('プリセットに無い尺の範囲も戻る', () => {
    const q: VideoQuery = { sort: 'added_desc', minDurationMs: 42_000, maxDurationMs: 43_000 };
    const state = toFilterState(q);
    expect(state.advanced.minDurationMs).toBe(42_000);
    expect(state.advanced.maxDurationMs).toBe(43_000);
    expect(buildQuery(state)).toEqual(expect.objectContaining(q));
  });
});
