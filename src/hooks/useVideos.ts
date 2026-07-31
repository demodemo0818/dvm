import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api';
import type { VideoLabels, VideoQuery, VideoRow } from '../types';

const PAGE_SIZE = 200;
/** 同じページの取得に連続で失敗したら諦める回数(スクロールのたびに投げ続けないため) */
const MAX_RETRY = 2;

/**
 * 仮想化グリッド用のスパースなページキャッシュ。
 * 全件を一括で持たず、表示に必要なページだけ遅延取得する。
 *
 * ページは state ではなく ref で持ち、更新時に rerender する。
 * クエリ変更(= 中身が別物)ではキャッシュを捨てるが、
 * ライブラリ更新(version)では捨てずに裏で取り直して差し替える。
 * 捨ててしまうと取り込み中に一覧が毎回「…」へ戻ってちらつくため
 *
 * `withLabels` が true のときだけ、取得済みページの動画にタグ・シリーズを
 * 後追いで足す(v1.23)。表示しない設定なら問い合わせ自体を投げない
 */
export function useVideos(query: VideoQuery, version: number, withLabels = false) {
  const [total, setTotal] = useState(0);
  const pages = useRef<Map<number, VideoRow[]>>(new Map());
  const inflight = useRef<Set<number>>(new Set());
  const failures = useRef<Map<number, number>>(new Map());
  /** video_id → タグ・シリーズ。行のキャッシュとは別に持つ(取得タイミングが違う) */
  const labels = useRef<Map<number, VideoLabels>>(new Map());
  /** ラベルを取り終えた(または取得中の)ページ。同じページに何度も投げないため */
  const labelPages = useRef<Set<number>>(new Set());
  /** 世代番号。上げると進行中リクエストの結果は破棄される */
  const generation = useRef(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const queryKey = JSON.stringify(query);

  const fetchPage = useCallback(
    (page: number) => {
      if (inflight.current.has(page)) return;
      if ((failures.current.get(page) ?? 0) >= MAX_RETRY) return;
      inflight.current.add(page);
      const gen = generation.current;
      api
        .queryVideos(query, PAGE_SIZE, page * PAGE_SIZE)
        .then((rows) => {
          inflight.current.delete(page);
          if (generation.current !== gen) return;
          failures.current.delete(page);
          pages.current.set(page, rows);
          rerender();
        })
        .catch(() => {
          // 失敗の中身は api 側でトースト表示済み。ここでは回数だけ数える
          inflight.current.delete(page);
          if (generation.current === gen) {
            failures.current.set(page, (failures.current.get(page) ?? 0) + 1);
          }
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [queryKey],
  );

  /**
   * ページ 1 枚ぶんのタグ・シリーズを引く。
   * 失敗しても握り潰す(call() がトースト済み。チップは飾りなので一覧は成立する)
   */
  const fetchLabels = useCallback((page: number, rows: VideoRow[]) => {
    if (labelPages.current.has(page)) return;
    labelPages.current.add(page);
    const gen = generation.current;
    api
      .videoLabels(rows.map((r) => r.id))
      .then((list) => {
        if (generation.current !== gen) return;
        for (const l of list) labels.current.set(l.videoId, l);
        rerender();
      })
      .catch(() => {
        // 次のレンダーで取り直せるように印を戻す
        if (generation.current === gen) labelPages.current.delete(page);
      });
  }, []);

  /**
   * 取得済みなのにラベルがまだのページを埋める。
   *
   * `fetchPage` の中ではなくここに置くこと — 範囲選択(getRange)で入ったページも
   * 拾えるようにするため。二重発行は labelPages が防ぐので、毎レンダーの空ループで済む
   */
  useEffect(() => {
    if (!withLabels) return;
    for (const [page, rows] of pages.current) fetchLabels(page, rows);
  });

  // クエリが変わった: 中身が別物になるのでキャッシュごと作り直す
  useEffect(() => {
    generation.current += 1;
    pages.current = new Map();
    inflight.current.clear();
    failures.current.clear();
    labels.current.clear();
    labelPages.current.clear();
    rerender();
  }, [queryKey]);

  // クエリ変更 + ライブラリ更新: 件数を取り直し、保持中のページは裏で差し替える
  useEffect(() => {
    generation.current += 1;
    inflight.current.clear();
    failures.current.clear();
    // タグの付け外しも version を上げるので、ラベルは取り直す。
    // labels 自体は消さない(消すとチップが一瞬空になってちらつく。届いた順に上書きする)
    labelPages.current.clear();
    const gen = generation.current;
    api
      .countVideos(query)
      .then((c) => {
        if (generation.current === gen) setTotal(c);
      })
      .catch(() => {});
    for (const page of Array.from(pages.current.keys())) fetchPage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, version, fetchPage]);

  const getVideo = useCallback(
    (index: number): VideoRow | undefined => {
      const page = Math.floor(index / PAGE_SIZE);
      const rows = pages.current.get(page);
      if (!rows) {
        fetchPage(page);
        return undefined;
      }
      return rows[index % PAGE_SIZE];
    },
    [fetchPage],
  );

  /**
   * 範囲内の行を返す(足りないページは取得を待つ)。
   * 範囲選択・全選択はページ境界をまたぐので、同期の getVideo では穴が空いてしまう。
   * クエリが変わっていたら(世代不一致)空を返す
   */
  const getRange = useCallback(
    async (from: number, to: number): Promise<VideoRow[]> => {
      const lo = Math.max(0, Math.min(from, to));
      const hi = Math.max(from, to);
      const gen = generation.current;

      const needed: number[] = [];
      for (let p = Math.floor(lo / PAGE_SIZE); p <= Math.floor(hi / PAGE_SIZE); p++) {
        if (!pages.current.has(p)) needed.push(p);
      }
      if (needed.length > 0) {
        try {
          const fetched = await Promise.all(
            needed.map((p) =>
              api.queryVideos(query, PAGE_SIZE, p * PAGE_SIZE).then((rows) => [p, rows] as const),
            ),
          );
          if (generation.current !== gen) return [];
          for (const [p, rows] of fetched) pages.current.set(p, rows);
          rerender();
        } catch {
          // 失敗は api 側でトースト済み。取れているぶんだけで続ける
          if (generation.current !== gen) return [];
        }
      }

      const out: VideoRow[] = [];
      for (let i = lo; i <= hi; i++) {
        const row = pages.current.get(Math.floor(i / PAGE_SIZE))?.[i % PAGE_SIZE];
        if (row) out.push(row);
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey],
  );

  /**
   * その動画のタグ・シリーズ。まだ取れていなければ undefined(セルは `—`)、
   * 取れていて 1 つも付いていなければ空配列を持つオブジェクト(セルは空欄)
   */
  const getLabels = useCallback(
    (videoId: number): VideoLabels | undefined => labels.current.get(videoId),
    [],
  );

  return { total, getVideo, getRange, getLabels };
}
