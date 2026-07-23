import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VideoQuery, VideoRow } from '../types';

const PAGE_SIZE = 200;

/**
 * 仮想化グリッド用のスパースなページキャッシュ。
 * 全件を一括で持たず、表示に必要なページだけ遅延取得する。
 */
export function useVideos(query: VideoQuery, version: number) {
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState<Map<number, VideoRow[]>>(new Map());
  const inflight = useRef<Set<number>>(new Set());
  const generation = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    inflight.current.clear();
    setPages(new Map());
    api.countVideos(query).then((c) => {
      if (generation.current === gen) setTotal(c);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, version]);

  const requestPage = useCallback(
    (page: number) => {
      if (inflight.current.has(page)) return;
      inflight.current.add(page);
      const gen = generation.current;
      api
        .queryVideos(query, PAGE_SIZE, page * PAGE_SIZE)
        .then((rows) => {
          if (generation.current !== gen) return;
          setPages((prev) => {
            const next = new Map(prev);
            next.set(page, rows);
            return next;
          });
        })
        .catch(() => inflight.current.delete(page));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [queryKey, version],
  );

  const getVideo = useCallback(
    (index: number): VideoRow | undefined => {
      const page = Math.floor(index / PAGE_SIZE);
      const rows = pages.get(page);
      if (!rows) {
        requestPage(page);
        return undefined;
      }
      return rows[index % PAGE_SIZE];
    },
    [pages, requestPage],
  );

  return { total, getVideo };
}
