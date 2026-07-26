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

/**
 * 連続再生設定のトグル(v1.12)。プレイヤーのボタンと A キーで共用する。
 * 押した瞬間に settings へ書くので、次に設定モーダルを開いてもチェックが一致する
 * (モーダルは開くたびに getSetting でロードする)
 */
export function useAutoplayToggle() {
  const autoplayNext = useLibrary((s) => s.autoplayNext);
  const setAutoplayNext = useLibrary((s) => s.setAutoplayNext);

  // 参照が毎回変わるとショートカットの effect が張り替わるので値は getState() から読む
  const toggle = useCallback(() => {
    const next = !useLibrary.getState().autoplayNext;
    setAutoplayNext(next);
    void api.setSetting('autoplay_next', next ? '1' : '0');
  }, [setAutoplayNext]);

  return { autoplayNext, toggle };
}

/**
 * リピート再生(1 本を繰り返す)のトグル(v1.13)。ボタンと R キーで共用する。
 * 実際のループは engine 側が持つ(mpv は loop-file、WebView2 は <video loop>)。
 * 状態は store にだけ置き、settings には保存しない(理由は store の宣言部)。
 * リピート中は EOF が来ないので連続再生は自然に発動しない — 排他制御は書かなくてよい
 */
export function useRepeatToggle() {
  const repeatOne = useLibrary((s) => s.repeatOne);
  const setRepeatOne = useLibrary((s) => s.setRepeatOne);

  // 参照が毎回変わるとショートカットの effect が張り替わるので値は getState() から読む
  const toggle = useCallback(() => {
    setRepeatOne(!useLibrary.getState().repeatOne);
  }, [setRepeatOne]);

  return { repeatOne, toggle };
}
