import { describe, expect, it } from 'vitest';
import { parseSnapshot, restoredQueue, serializeQueue } from './queueStorage';
import { EMPTY_QUEUE } from './queue';
import type { QueueState, VideoRow } from '../types';

const row = (id: number): VideoRow =>
  ({ id, path: `C:\\動画\\${id}.mp4`, filename: `${id}.mp4` } as VideoRow);

describe('serializeQueue / parseSnapshot', () => {
  it('中身と出所と dirty を往復できる(currentId は保存しない)', () => {
    const q: QueueState = {
      items: [row(3), row(1)],
      currentId: 3,
      orphanIndex: null,
      sourceId: 7,
      sourceName: '週末に観る',
      dirty: true,
    };
    const snap = parseSnapshot(serializeQueue(q));
    expect(snap).toEqual({
      videoIds: [3, 1],
      sourceId: 7,
      sourceName: '週末に観る',
      dirty: true,
    });
  });

  it('空キューも往復できる', () => {
    const snap = parseSnapshot(serializeQueue(EMPTY_QUEUE));
    expect(snap).toEqual({ videoIds: [], sourceId: null, sourceName: '', dirty: false });
  });

  it('壊れた値は null に落とす(復元しないだけで、例外にしない)', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot('{')).toBeNull();
    expect(parseSnapshot('"queue"')).toBeNull();
    expect(parseSnapshot('{"videoIds":"1,2"}')).toBeNull();
    // 配列の中の数値でないものは黙って落とす
    expect(parseSnapshot('{"videoIds":[1,"x",2]}')?.videoIds).toEqual([1, 2]);
  });
});

describe('restoredQueue', () => {
  it('引き直した行で組み立て、再生位置は持ち越さない', () => {
    const snap = parseSnapshot(
      '{"videoIds":[3,9,1],"sourceId":7,"sourceName":"週末に観る","dirty":true}',
    )!;
    // 9 はライブラリから消えていて引き直しに入って来なかった、という状況
    const q = restoredQueue(snap, [row(3), row(1)]);
    expect(q.items.map((v) => v.id)).toEqual([3, 1]);
    expect(q.currentId).toBeNull();
    expect(q.orphanIndex).toBeNull();
    expect(q.sourceId).toBe(7);
    expect(q.sourceName).toBe('週末に観る');
    expect(q.dirty).toBe(true);
  });
});
