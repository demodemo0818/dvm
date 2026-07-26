import { useCallback, useMemo } from 'react';
import { api } from '../../api';
import { useLibrary } from '../../store';

/**
 * 連続再生(v1.8)。
 * プレイヤーは「クエリ + 一覧内の位置」だけを持ち、次の 1 件は Rust から都度引く。
 * グリッドのページキャッシュに依存しないので、再生中にソートを変えても
 * 次に進んだ時点の並びで正しく次が来る。
 */
export function usePlayQueue() {
  const playQueue = useLibrary((s) => s.playQueue);
  const playFromList = useLibrary((s) => s.playFromList);
  const pushToast = useLibrary((s) => s.pushToast);

  const hasPrev = playQueue != null && playQueue.index > 0;
  const hasNext = playQueue != null && playQueue.index + 1 < playQueue.total;

  const go = useCallback(
    async (delta: 1 | -1) => {
      const q = useLibrary.getState().playQueue;
      if (!q) return;
      const next = q.index + delta;
      if (next < 0 || next >= q.total) return;
      try {
        const rows = await api.queryVideos(q.query, 1, next);
        if (rows.length === 0) {
          // 再生中に絞り込み対象から外れた(タグを消した等)。端に着いたのと同じ扱い
          pushToast('次の動画が見つかりませんでした', 'info');
          return;
        }
        playFromList(rows[0], { ...q, index: next });
      } catch {
        // 失敗は api 側でトースト済み
      }
    },
    [playFromList, pushToast],
  );

  return useMemo(
    () => ({
      hasPrev,
      hasNext,
      next: () => go(1),
      prev: () => go(-1),
      /** 「3 / 128」のような位置表示。単発再生なら null */
      position: playQueue ? `${playQueue.index + 1} / ${playQueue.total}` : null,
    }),
    [hasPrev, hasNext, go, playQueue],
  );
}

export type PlayQueueControls = ReturnType<typeof usePlayQueue>;
