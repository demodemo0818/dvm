import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { queueIndex, queueStep } from '../../lib/queue';
import { useLibrary } from '../../store';

/**
 * 連続再生(v1.8)と再生キュー(v1.40)。**プレイヤーの送りはこの 1 か所に集める**。
 *
 * モードは 2 つあり、**排他**:
 *
 * - **クエリモード**(v1.8)。`playQueue = { query, index, total }` を持ち、
 *   次の 1 件は `query_videos(query, 1, index+1)` で Rust から都度引く。
 *   グリッドのページキャッシュに依存しないので、再生中にソートを変えても
 *   次は新しい並びで来る。10 万件の絞り込みでもオブジェクト 1 個で済む
 * - **キューモード**(v1.40)。手で並べた `queue.items` の中を進む。
 *   `playQueue === null` かつ `queue.currentId !== null` がその印
 *
 * **キューモードは `autoplayNext` を見ない**(`autoAdvance` を参照)。
 */
export function usePlayQueue() {
  const playQueue = useLibrary((s) => s.playQueue);
  const queue = useLibrary((s) => s.queue);
  const autoplayNext = useLibrary((s) => s.autoplayNext);
  const playFromList = useLibrary((s) => s.playFromList);
  const pushToast = useLibrary((s) => s.pushToast);

  // playQueue が非 null ならクエリモード。両方 null なら単発再生
  const inQueue = playQueue === null && queue.currentId !== null;

  const hasPrev = inQueue
    ? queueStep(queue, -1) !== null
    : playQueue != null && playQueue.index > 0;
  const hasNext = inQueue
    ? queueStep(queue, 1) !== null
    : playQueue != null && playQueue.index + 1 < playQueue.total;

  // 状態は毎回 getState() から読む(キューは編集で頻繁に変わるので、
  // 参照を deps に入れるとハンドラが張り替わり続ける)
  /*
   * ⏭ のツールチップに出す「次の 1 件」(v1.40)。
   *
   * クエリモードは**リストの実体を持たない**(次は押した瞬間に引く)ので、
   * 出すには 1 行だけ先読みするしかない。DB を 1 行読むだけで元動画には触らないため、
   * 原則 2(自動的に起きる表示では元動画に触らない)には抵触しない。
   *
   * **silent で引く** —— 失敗してもツールチップが出ないだけなのに、
   * 全画面で観ている最中にトーストが浮くほうが害が大きい。
   * キューモードは行が手元にあるので先読みは要らない(下の useMemo で同期に求める)
   */
  const [prefetched, setPrefetched] = useState<string | null>(null);
  useEffect(() => {
    if (inQueue || playQueue === null) return;
    const at = playQueue.index + 1;
    if (at >= playQueue.total) return;
    let alive = true;
    void api
      .queryVideos(playQueue.query, 1, at, true)
      .then((rows) => {
        // 素早く送ったときに古い応答が新しい位置の名前として残らないようにする
        if (alive) setPrefetched(rows[0] ? rows[0].title || rows[0].filename : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
      setPrefetched(null);
    };
  }, [inQueue, playQueue]);

  const go = useCallback(
    async function step(delta: 1 | -1): Promise<void> {
      const s = useLibrary.getState();
      // キューモード。行はすでに手元にあるので Rust には聞かない
      if (s.playQueue === null && s.queue.currentId !== null) {
        const next = queueStep(s.queue, delta);
        if (next === null) return;
        if (next.isMissing || next.isOffline) {
          /*
           * 見つからない / オフラインは**飛ばして先へ進む**(v1.40)。キューは
           * 「並べて放っておく」ための道具なので、1 本の欠損で列が止まると目的を果たさない。
           * 飛ばしたことは黙らず断る
           */
          pushToast(`${next.filename} は見つからないため飛ばしました`, 'info');
          s.playFromQueue(next);
          // 飛ばした先からさらに進む。端に着けば queueStep が null を返して止まる
          await step(delta);
          return;
        }
        s.playFromQueue(next);
        return;
      }

      const q = s.playQueue;
      if (!q) return;
      const nextIndex = q.index + delta;
      if (nextIndex < 0 || nextIndex >= q.total) return;
      try {
        const rows = await api.queryVideos(q.query, 1, nextIndex);
        if (rows.length === 0) {
          // 再生中に絞り込み対象から外れた(タグを消した等)。端に着いたのと同じ扱い
          pushToast('次の動画が見つかりませんでした', 'info');
          return;
        }
        playFromList(rows[0], { ...q, index: nextIndex });
      } catch {
        // 失敗は api 側でトースト済み
      }
    },
    [playFromList, pushToast],
  );

  return useMemo(() => {
    const at = queueIndex(queue);
    const upNext = inQueue ? queueStep(queue, 1) : null;
    return {
      hasPrev,
      hasNext,
      next: () => go(1),
      prev: () => go(-1),
      /**
       * 次に再生される動画の名前。分からなければ null(端・単発再生・先読み前)。
       * ⏭ のツールチップに出す —— 位置(`3 / 128`)だけでは
       * 「あと何本あるか」は分かっても「次が何か」が分からない
       */
      nextTitle: inQueue ? (upNext ? upNext.title || upNext.filename : null) : prefetched,
      /** キューの中を進んでいるか。位置表示にアイコンを添える判断に使う */
      inQueue,
      /**
       * 終端に着いたとき自動で次へ送るか。
       *
       * **キューモードでは設定を見ない**(v1.40) —— `autoplay_next` は
       * 「絞り込み結果を延々流し続けるか」への答えで既定 OFF。手で 10 本選んで
       * 並べた人が「次に進まないでほしい」と思うことはまずない
       */
      autoAdvance: inQueue || autoplayNext,
      /** 「3 / 128」のような位置表示。単発再生なら null */
      position: inQueue
        ? at >= 0
          ? `${at + 1} / ${queue.items.length}`
          : // 再生中の 1 件をキューから外した状態。位置は無いが総数は出す
            `- / ${queue.items.length}`
        : playQueue
          ? `${playQueue.index + 1} / ${playQueue.total}`
          : null,
    };
  }, [hasPrev, hasNext, go, playQueue, queue, inQueue, autoplayNext, prefetched]);
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
