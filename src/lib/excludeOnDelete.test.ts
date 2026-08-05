import { describe, expect, it } from 'vitest';
import { collateralCount, excludeTargets } from './excludeOnDelete';
import type { VideoRow } from '../types';

function row(patch: Partial<VideoRow>): VideoRow {
  return {
    id: 1, path: 'N:\\動画\\a.mp4', filename: 'a.mp4', title: null, size: 0,
    durationMs: null, width: null, height: null, videoCodec: null, audioCodec: null,
    bitrate: null, fps: null, rating: 0, viewCount: 0, lastViewedAt: null, addedAt: '',
    fileModifiedAt: null, fileCreatedAt: null, isMissing: false, isOffline: false,
    thumbPath: null, thumbState: 0, resumeMs: 0, watchedFolderId: 1,
    ...patch,
  } as VideoRow;
}

describe('excludeTargets', () => {
  it('区切りの違うパスも同じフォルダに畳む(lib/paths の正規化に乗る)', () => {
    const t = excludeTargets([
      row({ id: 1, path: 'N:\\動画\\a.mp4' }),
      row({ id: 2, path: 'N:/動画/b.mp4' }),
    ]);
    expect(t.folders).toEqual(['N:\\動画']);
  });

  it('監視フォルダ由来のものだけを対象にする', () => {
    const t = excludeTargets([
      row({ id: 1, path: 'N:\\動画\\a.mp4', watchedFolderId: 1 }),
      // 個別登録は消しても再登録されないので勧めない
      row({ id: 2, path: 'C:\\個別\\b.mp4', watchedFolderId: null }),
    ]);
    expect(t.files).toEqual(['N:\\動画\\a.mp4']);
    expect(t.folders).toEqual(['N:\\動画']);
  });

  it('親フォルダは重複を畳んで並べる', () => {
    const t = excludeTargets([
      row({ id: 1, path: 'N:\\b\\x.mp4' }),
      row({ id: 2, path: 'N:\\a\\y.mp4' }),
      row({ id: 3, path: 'N:\\b\\z.mp4' }),
    ]);
    expect(t.folders).toEqual(['N:\\a', 'N:\\b']);
    expect(t.files).toHaveLength(3);
  });

  it('監視フォルダ由来が無ければ空(= 尋ねない)', () => {
    const t = excludeTargets([row({ watchedFolderId: null })]);
    expect(t.files).toEqual([]);
    expect(t.folders).toEqual([]);
  });
});

describe('collateralCount', () => {
  it('選択していない動画の数を数える', () => {
    const t = excludeTargets([
      row({ id: 1, path: 'N:\\動画\\a.mp4' }),
      row({ id: 2, path: 'N:\\動画\\b.mp4' }),
    ]);
    // フォルダには 10 件あり、そのうち 2 件を選んでいる → 巻き込みは 8 件
    expect(collateralCount(t, { 'n:\\動画': 10 })).toBe(8);
  });

  it('全部選んでいれば巻き込みは無い', () => {
    const t = excludeTargets([row({ id: 1, path: 'N:\\動画\\a.mp4' })]);
    expect(collateralCount(t, { 'n:\\動画': 1 })).toBe(0);
  });

  it('件数が分からないフォルダは 0 として扱う', () => {
    const t = excludeTargets([row({ id: 1, path: 'N:\\動画\\a.mp4' })]);
    expect(collateralCount(t, {})).toBe(0);
  });

  it('複数フォルダぶんを合計する', () => {
    const t = excludeTargets([
      row({ id: 1, path: 'N:\\a\\x.mp4' }),
      row({ id: 2, path: 'N:\\b\\y.mp4' }),
    ]);
    expect(collateralCount(t, { 'n:\\a': 5, 'n:\\b': 3 })).toBe(6);
  });
});
