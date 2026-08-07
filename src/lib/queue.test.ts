import { describe, expect, it } from 'vitest';
import {
  addToQueue, clearQueue, composedQueue, EMPTY_QUEUE, loadedQueue, moveInQueue, needsSavePrompt,
  playingInQueue, queueIndex, queueStep, QUEUE_LIMIT, removeFromQueue, savedQueue,
  sourceRemoved, sourceRenamed, syncQueue,
} from './queue';
import type { QueueState, VideoRow } from '../types';

/** テスト用の最小の行。キューの判断は id と並びしか見ない */
const v = (id: number): VideoRow => ({ id, filename: `${id}.mp4` }) as VideoRow;

/** id の並びを見るためのヘルパ */
const ids = (q: QueueState) => q.items.map((i) => i.id);

const queueOf = (...n: number[]): QueueState => ({ ...EMPTY_QUEUE, items: n.map(v) });

describe('addToQueue', () => {
  it('末尾に足し、すでに入っているものは無視する(冪等)', () => {
    const a = addToQueue(EMPTY_QUEUE, [v(1), v(2)]);
    expect(ids(a.queue)).toEqual([1, 2]);
    expect(a.added).toBe(2);

    // 同じ選択をもう一度追加してもキューは倍にならない
    const b = addToQueue(a.queue, [v(1), v(2)]);
    expect(ids(b.queue)).toEqual([1, 2]);
    expect(b.added).toBe(0);
    expect(b.queue).toBe(a.queue);
  });

  it('渡された配列の中の重複も潰す', () => {
    const a = addToQueue(EMPTY_QUEUE, [v(1), v(1), v(2)]);
    expect(ids(a.queue)).toEqual([1, 2]);
    expect(a.added).toBe(2);
  });

  it('「次に再生」は再生中の直後に挿す', () => {
    const q = playingInQueue(queueOf(1, 2, 3), 2);
    const a = addToQueue(q, [v(9)], 'next');
    expect(ids(a.queue)).toEqual([1, 2, 9, 3]);
  });

  it('再生中のものがキューから外れていれば、外した位置に挿す', () => {
    // 1,2,3 の 2 を再生中に外す → orphanIndex = 1
    const removed = removeFromQueue(playingInQueue(queueOf(1, 2, 3), 2), 2);
    expect(ids(removed)).toEqual([1, 3]);
    expect(removed.orphanIndex).toBe(1);

    const a = addToQueue(removed, [v(9)], 'next');
    expect(ids(a.queue)).toEqual([1, 9, 3]);
  });

  it('「次に再生」でも、キューで再生していなければ末尾に足す', () => {
    const a = addToQueue(queueOf(1, 2), [v(9)], 'next');
    expect(ids(a.queue)).toEqual([1, 2, 9]);
  });

  it('上限を超えるときは部分的に入れず全部断る', () => {
    const full = queueOf(...Array.from({ length: QUEUE_LIMIT - 1 }, (_, i) => i + 1));
    // ちょうど収まる 1 件は入る
    const ok = addToQueue(full, [v(9001)]);
    expect(ok.added).toBe(1);
    expect(ok.overflow).toBe(false);

    // 2 件だと 1 件ぶんしか空きが無いが、1 件だけ入れたりはしない
    const ng = addToQueue(full, [v(9001), v(9002)]);
    expect(ng.added).toBe(0);
    expect(ng.overflow).toBe(true);
    expect(ng.queue).toBe(full);
  });

  it('追加すると「変更あり」が点く', () => {
    const loaded = loadedQueue([v(1)], 7, 'お気に入り');
    expect(loaded.dirty).toBe(false);
    expect(addToQueue(loaded, [v(2)]).queue.dirty).toBe(true);
    // 何も増えなかったときは点かない
    expect(addToQueue(loaded, [v(1)]).queue.dirty).toBe(false);
  });
});

describe('removeFromQueue', () => {
  it('再生中のものを外しても currentId は残る(再生は止めない)', () => {
    const q = playingInQueue(queueOf(1, 2, 3), 2);
    const after = removeFromQueue(q, 2);
    expect(after.currentId).toBe(2);
    expect(ids(after)).toEqual([1, 3]);
    // 次へ進むと、外した位置に居た 3 が来る
    expect(queueStep(after, 1)?.id).toBe(3);
    expect(queueStep(after, -1)?.id).toBe(1);
  });

  it('外れている間に前の要素が消えたら、覚えている位置も詰まる', () => {
    const after = removeFromQueue(playingInQueue(queueOf(1, 2, 3, 4), 3), 3);
    expect(after.orphanIndex).toBe(2);
    // 先頭を消すと、次の行き先は 1 つ前へずれる
    const then = removeFromQueue(after, 1);
    expect(ids(then)).toEqual([2, 4]);
    expect(then.orphanIndex).toBe(1);
    expect(queueStep(then, 1)?.id).toBe(4);
  });

  it('居ない id は何もしない', () => {
    const q = queueOf(1, 2);
    expect(removeFromQueue(q, 99)).toBe(q);
  });
});

describe('moveInQueue', () => {
  it('並べ替えても再生中は追随する', () => {
    const q = playingInQueue(queueOf(1, 2, 3), 2);
    expect(queueIndex(q)).toBe(1);

    const moved = moveInQueue(q, 1, 0);
    expect(ids(moved)).toEqual([2, 1, 3]);
    // index ではなく video_id で指しているので、再生中は 2 のまま
    expect(moved.currentId).toBe(2);
    expect(queueIndex(moved)).toBe(0);
    expect(queueStep(moved, 1)?.id).toBe(1);
  });

  it('末尾へ動かす / 範囲外は丸める', () => {
    expect(ids(moveInQueue(queueOf(1, 2, 3), 0, 2))).toEqual([2, 3, 1]);
    expect(ids(moveInQueue(queueOf(1, 2, 3), 0, 99))).toEqual([2, 3, 1]);
    const q = queueOf(1, 2, 3);
    expect(moveInQueue(q, 1, 1)).toBe(q);
    expect(moveInQueue(q, 5, 0)).toBe(q);
  });

  it('再生中を外した状態で並べ替えても「次へ」の行き先が保たれる', () => {
    // 1,2,3,4 の 3 を再生中に外す → [1,2,4]、次は 4
    const q = removeFromQueue(playingInQueue(queueOf(1, 2, 3, 4), 3), 3);
    expect(q.orphanIndex).toBe(2);
    // 隙間より手前の 1 を末尾へ → [2,4,1]。次は変わらず 4
    const moved = moveInQueue(q, 0, 2);
    expect(ids(moved)).toEqual([2, 4, 1]);
    expect(queueStep(moved, 1)?.id).toBe(4);
  });

  it('隙間より手前に挿し込まれたら、覚えている位置は押し下げられる', () => {
    const q = removeFromQueue(playingInQueue(queueOf(1, 2, 3, 4), 3), 3);
    // 隙間の直後に居た 4 を先頭へ → [4,1,2]。隙間は「2 の後ろ」に付いて動く
    const moved = moveInQueue(q, 2, 0);
    expect(ids(moved)).toEqual([4, 1, 2]);
    expect(queueStep(moved, 1)).toBeNull();
    expect(queueStep(moved, -1)?.id).toBe(2);
  });
});

describe('queueStep', () => {
  it('端では null を返す(勝手に先頭へ戻らない)', () => {
    const q = playingInQueue(queueOf(1, 2, 3), 3);
    expect(queueStep(q, 1)).toBeNull();
    expect(queueStep(playingInQueue(q, 1), -1)).toBeNull();
  });

  it('キューで再生していなければ先頭が「次」になる', () => {
    expect(queueStep(queueOf(1, 2), 1)?.id).toBe(1);
  });
});

describe('syncQueue', () => {
  it('ライブラリから消えた動画は落ちるが、変更ありは点かない', () => {
    const loaded = loadedQueue([v(1), v(2), v(3)], 7, 'お気に入り');
    const after = syncQueue(loaded, [v(1), v(3)]);
    expect(ids(after)).toEqual([1, 3]);
    // ユーザーが触っていないのに上書き保存を促さない
    expect(after.dirty).toBe(false);
  });

  it('中身が変わらなければ同じ参照を返す(無駄な再描画を出さない)', () => {
    const q = queueOf(1, 2);
    expect(syncQueue(q, q.items)).toBe(q);
  });

  it('引き直した行で中身が差し替わる(リネームが反映される)', () => {
    const q = queueOf(1);
    const renamed = { ...v(1), filename: '新しい名前.mp4' } as VideoRow;
    expect(syncQueue(q, [renamed]).items[0].filename).toBe('新しい名前.mp4');
  });

  it('再生中の行がライブラリから消えたら、居た位置を隙間として覚える', () => {
    const q = playingInQueue(queueOf(1, 2, 3, 4, 5), 4);
    const after = syncQueue(q, [v(1), v(2), v(3), v(5)]);
    expect(ids(after)).toEqual([1, 2, 3, 5]);
    expect(after.orphanIndex).toBe(3);
    // 「次へ」が先頭へ飛ばず、消えた位置の次(5)へ進む
    expect(queueStep(after, 1)?.id).toBe(5);
    expect(queueStep(after, -1)?.id).toBe(3);
  });

  it('外れている間の同期でも、手前の行が消えたら覚えている位置が詰まる', () => {
    const q = removeFromQueue(playingInQueue(queueOf(1, 2, 3), 2), 2);
    const after = syncQueue(q, [v(3)]);
    expect(after.orphanIndex).toBe(0);
    expect(queueStep(after, 1)?.id).toBe(3);
  });
});

describe('保存の状態', () => {
  it('読み込み直後は「変更なし」、編集で点き、保存で消える', () => {
    const loaded = loadedQueue([v(1), v(2)], 7, 'お気に入り');
    expect(needsSavePrompt(loaded)).toBe(false);

    const edited = removeFromQueue(loaded, 1);
    expect(edited.dirty).toBe(true);
    expect(needsSavePrompt(edited)).toBe(true);

    const saved = savedQueue(edited, 7, 'お気に入り');
    expect(saved.dirty).toBe(false);
    expect(needsSavePrompt(saved)).toBe(false);
    expect(ids(saved)).toEqual([2]);
  });

  it('空のキューでは尋ねない(開発中に stop.ps1 が止まらないため)', () => {
    expect(needsSavePrompt(EMPTY_QUEUE)).toBe(false);
    expect(needsSavePrompt(clearQueue(queueOf(1, 2)))).toBe(false);
  });

  // v1.41(C-4)。スマートフォルダ・絞り込み結果から組んだキュー
  it('組み立てたキューは出所を持たず「変更あり」が点く', () => {
    const q = composedQueue([v(1), v(2)]);
    expect(ids(q)).toEqual([1, 2]);
    expect(q.sourceId).toBeNull();
    expect(q.currentId).toBeNull();
    expect(q.dirty).toBe(true);
    expect(needsSavePrompt(q)).toBe(true);
    // 空の結果で組んだときは dirty も点かない(確認を出す意味がない)
    expect(composedQueue([]).dirty).toBe(false);
  });

  it('すべて外しても再生は続く(currentId を消さない)', () => {
    const q = playingInQueue(queueOf(1, 2), 1);
    const cleared = clearQueue(q);
    expect(cleared.items).toEqual([]);
    expect(cleared.currentId).toBe(1);
    expect(queueStep(cleared, 1)).toBeNull();
  });

  it('読み込み元が削除されたら出所を外す(中身と dirty は触らない)', () => {
    const loaded = loadedQueue([v(1)], 7, 'お気に入り');
    const after = sourceRemoved(loaded, 7);
    expect(after.sourceId).toBeNull();
    expect(after.sourceName).toBe('');
    expect(ids(after)).toEqual([1]);
    expect(after.dirty).toBe(false);
    // 別のリストの削除では何もしない
    expect(sourceRemoved(loaded, 8)).toBe(loaded);
  });

  it('読み込み元の改名にタイトルが追随する', () => {
    const loaded = loadedQueue([v(1)], 7, 'お気に入り');
    expect(sourceRenamed(loaded, 7, '殿堂入り').sourceName).toBe('殿堂入り');
    expect(sourceRenamed(loaded, 8, '殿堂入り')).toBe(loaded);
  });
});
