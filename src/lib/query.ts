import type { AdvancedFilter, DurationBucket, SortKey, VideoQuery } from '../types';

const MIN = 60_000; // 1 分 (ms)

/** 尺フィルタのプリセット → ミリ秒範囲 */
export const DURATION_RANGES: Record<DurationBucket, { min?: number; max?: number }> = {
  lt5: { max: 5 * MIN },
  '5to20': { min: 5 * MIN, max: 20 * MIN },
  '20to60': { min: 20 * MIN, max: 60 * MIN },
  gt60: { min: 60 * MIN },
};

/** 詳細検索の解像度プリセット(縦の下限) */
export const RESOLUTION_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '指定なし' },
  { value: 480, label: '480p 以上' },
  { value: 720, label: '720p 以上' },
  { value: 1080, label: '1080p 以上' },
  { value: 2160, label: '4K 以上' },
];

/** 詳細検索で選べる映像コーデック(ffprobe が返す名前) */
export const CODEC_OPTIONS = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video', 'wmv3'];

export interface FilterState {
  text: string;
  sort: SortKey;
  folderId: number | null;
  tagIds: number[];
  seriesId: number | null;
  missingOnly: boolean;
  minRating: number;
  durationBucket: DurationBucket | null;
  duplicatesOnly: boolean;
  advanced: AdvancedFilter;
  randomSeed: number;
}

/**
 * store のフィルタ状態から Tauri / MCP に渡す VideoQuery を組み立てる。
 * 効いていない条件は undefined にして落とす(Rust 側で「未指定なら従来どおり」になるため)。
 * グリッド・件数表示・スマートフォルダの保存がすべてこの 1 か所を通る
 */
export function buildQuery(s: FilterState): VideoQuery {
  const range = s.durationBucket ? DURATION_RANGES[s.durationBucket] : undefined;
  const a = s.advanced;
  return {
    text: s.text || undefined,
    sort: s.sort,
    folderId: s.folderId,
    tagIds: s.tagIds.length > 0 ? s.tagIds : undefined,
    seriesId: s.seriesId,
    missing: s.missingOnly ? true : undefined,
    minRating: s.minRating > 0 ? s.minRating : undefined,
    minDurationMs: range?.min,
    maxDurationMs: range?.max,
    duplicatesOnly: s.duplicatesOnly ? true : undefined,
    searchPath: a.searchPath ? true : undefined,
    untagged: a.untagged ? true : undefined,
    unwatched: a.unwatched ? true : undefined,
    minHeight: a.minHeight > 0 ? a.minHeight : undefined,
    videoCodecs: a.videoCodecs.length > 0 ? a.videoCodecs : undefined,
    addedAfter: a.addedAfter || undefined,
    addedBefore: a.addedBefore || undefined,
    // 種はランダム並びのときだけ意味を持つ。常に送ると保存した条件の差分が無駄に出る
    randomSeed: s.sort === 'random' ? s.randomSeed : undefined,
  };
}

/** 詳細検索で何か絞られているか(ツールバーのバッジ表示用) */
export function advancedCount(a: AdvancedFilter): number {
  return (
    (a.searchPath ? 1 : 0) +
    (a.untagged ? 1 : 0) +
    (a.unwatched ? 1 : 0) +
    (a.minHeight > 0 ? 1 : 0) +
    (a.videoCodecs.length > 0 ? 1 : 0) +
    (a.addedAfter ? 1 : 0) +
    (a.addedBefore ? 1 : 0)
  );
}
