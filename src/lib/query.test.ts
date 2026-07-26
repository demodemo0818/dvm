import { describe, expect, it } from 'vitest';
import { EMPTY_ADVANCED } from '../types';
import { buildQuery, type FilterState } from './query';

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
