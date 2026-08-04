import { useEffect, useState } from 'react';
import { api } from '../api';
import { NO_MASTERS, type FilterMasters } from '../lib/filterChips';

/**
 * 絞り込み帯(v1.28)がチップのラベルを引くためのマスタ。
 *
 * `enabled` は「**名前を引かないと表示できない条件が効いているか**」。
 * 何も絞っていない既定の状態では IPC を 1 本も投げない(帯は「全 N 件」だけで足りる)。
 *
 * 取得に失敗しても空のまま続ける —— 中身は `call()` がトースト済みで、
 * チップが薄い `…` になるだけで帯そのものは成立するため。
 *
 * Sidebar / Inspector も同じ一覧を自前で取っているが、あちらは
 * スマートフォルダや選択中の動画と同じ effect にぶら下がっていて取得のきっかけが違うので、
 * ここでは共有せずに独立した 1 本にしてある
 */
export function useFilterMasters(enabled: boolean, version: number): FilterMasters {
  const [masters, setMasters] = useState<FilterMasters>(NO_MASTERS);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all([
      api.listTags().catch(() => []),
      api.listWatchedFolders().catch(() => []),
      api.listSeries().catch(() => []),
    ]).then(([tags, folders, series]) => {
      if (alive) setMasters({ tags, folders, series });
    });
    return () => {
      alive = false;
    };
  }, [enabled, version]);

  return masters;
}
