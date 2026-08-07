import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api';
import type { VideoLabels, VideoQuery, VideoRow } from '../types';

const PAGE_SIZE = 200;
/** 同じページの取得に連続で失敗したら諦める回数(スクロールのたびに投げ続けないため) */
const MAX_RETRY = 2;
/**
 * version 更新(ライブラリ変更)のとき裏で取り直すページ数の上限。
 * 最近アクセスした順にこの枚数だけ残す。5 枚 = 1,000 行で、可視範囲 + overscan には十分。
 * 深くスクロールした後に全ページを取り直すと、取り込み中(version が 300ms おきに上がる)に
 * 「数十ページ × 200 件」の query_videos が投げ続けられて IPC と読み取りコネクションを圧迫する
 */
const KEEP_ON_VERSION = 5;

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
  /*
   * 一度でも数え終わったか。total の初期値 0 は「まだ数えていない」と「0 件」の区別が
   * つかず、起動直後に「0 件」が出て空ライブラリに見えるため(v1.28 の絞り込み帯用)。
   * **一度 true にしたら false に戻さない** —— クエリを変えるたびに「集計中…」へ
   * 落ちると数字がチラつく。数十 ms 古い数字が残るほうが目に優しい
   */
  const [counted, setCounted] = useState(false);
  const pages = useRef<Map<number, VideoRow[]>>(new Map());
  const inflight = useRef<Set<number>>(new Set());
  const failures = useRef<Map<number, number>>(new Map());
  /** video_id → タグ・シリーズ。行のキャッシュとは別に持つ(取得タイミングが違う) */
  const labels = useRef<Map<number, VideoLabels>>(new Map());
  /** ラベルを取り終えた(または取得中の)ページ。同じページに何度も投げないため */
  const labelPages = useRef<Set<number>>(new Set());
  /** 世代番号。上げると進行中リクエストの結果は破棄される */
  const generation = useRef(0);
  /** ページ → 最終アクセス順(連番)。version 更新時に「見えているページ」を選ぶのに使う */
  const pageAccess = useRef<Map<number, number>>(new Map());
  const accessSeq = useRef(0);
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
    pageAccess.current.clear();
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
        if (generation.current !== gen) return;
        setTotal(c);
        setCounted(true);
      })
      .catch(() => {});
    /*
     * 保持中のページを全部取り直さない。最近アクセスした順に KEEP_ON_VERSION 枚だけ
     * 裏で差し替え(見えている範囲はちらつかない)、それ以外は捨てて、
     * また見えたときに普通の遅延取得で引き直す
     */
    const keep = new Set(
      Array.from(pageAccess.current.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEEP_ON_VERSION)
        .map(([p]) => p),
    );
    for (const page of Array.from(pages.current.keys())) {
      if (keep.has(page)) {
        fetchPage(page);
      } else {
        pages.current.delete(page);
        labelPages.current.delete(page);
        pageAccess.current.delete(page);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, version, fetchPage]);

  const getVideo = useCallback(
    (index: number): VideoRow | undefined => {
      const page = Math.floor(index / PAGE_SIZE);
      pageAccess.current.set(page, ++accessSeq.current);
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
        pageAccess.current.set(p, ++accessSeq.current);
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

  return { total, counted, getVideo, getRange, getLabels };
}
