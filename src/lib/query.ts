import { EMPTY_ADVANCED } from '../types';
import type { AdvancedFilter, DurationBucket, Orientation, SortKey, VideoQuery } from '../types';

const MIN = 60_000; // 1 分 (ms)
/** サイズの単位。表示(fmtSize)が 1024 系なので入力もそれに合わせる */
export const MB = 1024 ** 2;
export const GB = 1024 ** 3;

/** 尺フィルタのプリセット → ミリ秒範囲 */
export const DURATION_RANGES: Record<DurationBucket, { min?: number; max?: number }> = {
  lt5: { max: 5 * MIN },
  '5to20': { min: 5 * MIN, max: 20 * MIN },
  '20to60': { min: 20 * MIN, max: 60 * MIN },
  gt60: { min: 60 * MIN },
};

/**
 * 尺プリセットの表示名。詳細検索のプリセットボタンと絞り込み帯のチップが同じ文言を使う
 * (片方だけ言い回しが変わるのを防ぐ)
 */
export const DURATION_LABELS: Record<DurationBucket, string> = {
  lt5: '5 分未満',
  '5to20': '5〜20 分',
  '20to60': '20〜60 分',
  gt60: '60 分以上',
};

/** 解像度の下限プリセット */
export const RESOLUTION_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '指定なし' },
  { value: 480, label: '480p 以上' },
  { value: 720, label: '720p 以上' },
  { value: 1080, label: '1080p 以上' },
  { value: 2160, label: '4K 以上' },
];

/** 解像度の上限プリセット。**「未満」**なので下限と隙間なく組み合わせられる */
export const RESOLUTION_MAX_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '指定なし' },
  { value: 480, label: '480p 未満' },
  { value: 720, label: '720p 未満' },
  { value: 1080, label: '1080p 未満' },
  { value: 2160, label: '4K 未満' },
];

export const ORIENTATION_OPTIONS: { value: Orientation; label: string }[] = [
  { value: '', label: '指定なし' },
  { value: 'landscape', label: '横長' },
  { value: 'portrait', label: '縦長' },
];

/** 相対日数のプリセット。**絶対日付と違って保存しても腐らない** */
export const WITHIN_DAYS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '指定なし' },
  { value: 1, label: '今日' },
  { value: 7, label: '過去 7 日' },
  { value: 30, label: '過去 30 日' },
  { value: 90, label: '過去 90 日' },
  { value: 365, label: '過去 1 年' },
];

/** 詳細検索で選べる映像コーデック(ffprobe が返す名前) */
export const CODEC_OPTIONS = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video', 'wmv3'];

export interface FilterState {
  text: string;
  sort: SortKey;
  folderId: number | null;
  dirPath: string | null;
  /** dirPath をサブフォルダ込みで見る(絞り込み帯のトグル) */
  dirPathRecursive: boolean;
  tagIds: number[];
  seriesId: number | null;
  missingOnly: boolean;
  duplicatesOnly: boolean;
  /** 詳細検索ポップオーバーの中身ぜんぶ(types.ts の AdvancedFilter) */
  advanced: AdvancedFilter;
  randomSeed: number;
}

/**
 * 何も絞っていない状態。**store の初期値・`applyFilter` の既定・テストの土台が
 * すべてここを見る**。条件を足したときに片方だけ初期値を書き忘れる事故を防ぐため
 */
export const EMPTY_FILTER: FilterState = {
  text: '',
  sort: 'added_desc',
  folderId: null,
  dirPath: null,
  dirPathRecursive: false,
  tagIds: [],
  seriesId: null,
  missingOnly: false,
  duplicatesOnly: false,
  advanced: EMPTY_ADVANCED,
  // 実際の種は store が起動時に引き直す。ここは「種を持たない」を表す当たり障りのない値
  randomSeed: 1,
};

/** 尺の範囲がプリセットのどれかとちょうど一致すればそのキー。しなければ null */
export function durationPreset(min: number | null, max: number | null): DurationBucket | null {
  for (const key of Object.keys(DURATION_RANGES) as DurationBucket[]) {
    const r = DURATION_RANGES[key];
    if ((r.min ?? null) === min && (r.max ?? null) === max) return key;
  }
  return null;
}

/**
 * 尺の範囲の表示名。プリセットに一致すればその名前、しなければ範囲から組み立てる。
 * プリセットの言い回し(「5 分未満」「60 分以上」)に合わせてあるので、
 * 自由入力の値でも帯のチップが浮かない
 */
export function durationLabel(min: number | null, max: number | null): string {
  const preset = durationPreset(min, max);
  if (preset !== null) return DURATION_LABELS[preset];
  const m = (ms: number) => Math.round(ms / MIN);
  if (min !== null && max !== null) return `${m(min)}〜${m(max)} 分`;
  if (min !== null) return `${m(min)} 分以上`;
  if (max !== null) return `${m(max)} 分未満`;
  return '長さ指定なし';
}

/**
 * 入力欄に出す単位を、いま入っているバイト数から決める。
 * **単位そのものは保存しない** —— 条件として意味を持つのはバイト数だけなので、
 * 1GB 以上なら GB、それ未満なら MB と機械的に決める(0.5GB は「512 MB」と出る)
 */
export function sizeUnitFor(min: number | null, max: number | null): typeof MB | typeof GB {
  const biggest = Math.max(min ?? 0, max ?? 0);
  return biggest >= GB ? GB : MB;
}

/** サイズの範囲の表示名。fmtSize と違って「以上 / 未満 / 〜」の形にする */
export function sizeLabel(min: number | null, max: number | null): string {
  const unit = sizeUnitFor(min, max);
  const suffix = unit === GB ? 'GB' : 'MB';
  // 端数が出るときだけ小数を見せる(1.00 GB とは書かない)
  const n = (b: number) => {
    const v = b / unit;
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  };
  if (min !== null && max !== null) return `${n(min)}〜${n(max)} ${suffix}`;
  if (min !== null) return `${n(min)} ${suffix} 以上`;
  if (max !== null) return `${n(max)} ${suffix} 未満`;
  return 'サイズ指定なし';
}

/** 再生回数の範囲の表示名 */
export function viewCountLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return min === max ? `${min} 回` : `${min}〜${max} 回`;
  if (min !== null) return `${min} 回以上`;
  if (max !== null) return max === 0 ? '未視聴' : `${max} 回以下`;
  return '再生回数の指定なし';
}

/**
 * store のフィルタ状態から Tauri / MCP に渡す VideoQuery を組み立てる。
 * 効いていない条件は undefined にして落とす(Rust 側で「未指定なら従来どおり」になるため)。
 * グリッド・件数表示・スマートフォルダの保存がすべてこの 1 か所を通る
 */
export function buildQuery(s: FilterState): VideoQuery {
  const a = s.advanced;
  return {
    text: s.text || undefined,
    sort: s.sort,
    folderId: s.folderId,
    dirPath: s.dirPath ?? undefined,
    // 単体では意味を持たないので、フォルダで絞っているときだけ送る
    dirPathRecursive: s.dirPath !== null && s.dirPathRecursive ? true : undefined,
    tagIds: s.tagIds.length > 0 ? s.tagIds : undefined,
    seriesId: s.seriesId,
    missing: s.missingOnly ? true : undefined,
    duplicatesOnly: s.duplicatesOnly ? true : undefined,

    searchPath: a.searchPath ? true : undefined,
    searchComment: a.searchComment ? true : undefined,
    minRating: a.minRating > 0 ? a.minRating : undefined,
    unrated: a.unrated ? true : undefined,
    minDurationMs: a.minDurationMs ?? undefined,
    maxDurationMs: a.maxDurationMs ?? undefined,
    minSizeBytes: a.minSizeBytes ?? undefined,
    maxSizeBytes: a.maxSizeBytes ?? undefined,
    extensions: a.extensions.length > 0 ? a.extensions : undefined,
    minHeight: a.minHeight > 0 ? a.minHeight : undefined,
    maxHeight: a.maxHeight > 0 ? a.maxHeight : undefined,
    orientation: a.orientation || undefined,
    videoCodecs: a.videoCodecs.length > 0 ? a.videoCodecs : undefined,
    untagged: a.untagged ? true : undefined,
    unwatched: a.unwatched ? true : undefined,
    resumedOnly: a.resumedOnly ? true : undefined,
    minViewCount: a.minViewCount ?? undefined,
    maxViewCount: a.maxViewCount ?? undefined,
    addedAfter: a.addedAfter || undefined,
    addedBefore: a.addedBefore || undefined,
    addedWithinDays: a.addedWithinDays > 0 ? a.addedWithinDays : undefined,
    modifiedAfter: a.modifiedAfter || undefined,
    modifiedBefore: a.modifiedBefore || undefined,
    modifiedWithinDays: a.modifiedWithinDays > 0 ? a.modifiedWithinDays : undefined,

    // 種はランダム並びのときだけ意味を持つ。常に送ると保存した条件の差分が無駄に出る
    randomSeed: s.sort === 'random' ? s.randomSeed : undefined,
  };
}

/**
 * `buildQuery` の逆。VideoQuery を画面の状態に戻す。
 *
 * **保存したスマートフォルダを開くときと、AI の `apply_filter` が共用する唯一の経路**。
 * 以前は Sidebar が項目を手で並べていたため、条件を足すたびに書き忘れが起き
 * (実際に尺の範囲が復元されていなかった)、しかもテストが無いので気づけなかった。
 * `query.test.ts` の往復テストが `buildQuery` との対応を担保している ——
 * 条件を足したら、まず向こうのテストが落ちる。
 *
 * `VideoQuery` にしか無い条件(`minWidth`)はここでは落ちる。UI が持っていない条件で、
 * `buildQuery` も出さないので、画面から保存した条件には入らない
 */
export function toFilterState(q: VideoQuery): FilterState {
  return {
    text: q.text ?? '',
    sort: q.sort ?? EMPTY_FILTER.sort,
    folderId: q.folderId ?? null,
    dirPath: q.dirPath ?? null,
    dirPathRecursive: q.dirPathRecursive ?? false,
    tagIds: q.tagIds ?? [],
    seriesId: q.seriesId ?? null,
    missingOnly: q.missing ?? false,
    duplicatesOnly: q.duplicatesOnly ?? false,
    advanced: {
      searchPath: q.searchPath ?? false,
      searchComment: q.searchComment ?? false,
      minRating: q.minRating ?? 0,
      unrated: q.unrated ?? false,
      minDurationMs: q.minDurationMs ?? null,
      maxDurationMs: q.maxDurationMs ?? null,
      minSizeBytes: q.minSizeBytes ?? null,
      maxSizeBytes: q.maxSizeBytes ?? null,
      extensions: q.extensions ?? [],
      minHeight: q.minHeight ?? 0,
      maxHeight: q.maxHeight ?? 0,
      orientation: q.orientation ?? '',
      videoCodecs: q.videoCodecs ?? [],
      untagged: q.untagged ?? false,
      unwatched: q.unwatched ?? false,
      resumedOnly: q.resumedOnly ?? false,
      minViewCount: q.minViewCount ?? null,
      maxViewCount: q.maxViewCount ?? null,
      addedAfter: q.addedAfter ?? '',
      addedBefore: q.addedBefore ?? '',
      addedWithinDays: q.addedWithinDays ?? 0,
      modifiedAfter: q.modifiedAfter ?? '',
      modifiedBefore: q.modifiedBefore ?? '',
      modifiedWithinDays: q.modifiedWithinDays ?? 0,
    },
    randomSeed: q.randomSeed ?? EMPTY_FILTER.randomSeed,
  };
}

/**
 * 詳細検索で何件の条件が効いているか(ツールバーのバッジ)。
 *
 * v1.35 で★と長さもここに入ったので、**この数字は「絞り込みの総数」に近い**
 * (別の入口を持つテキスト・タグ・フォルダ・見つからない・重複だけが外れる)。
 * 上限が 2 桁になったので、バッジの CSS も 2 桁が入る幅にしてある。
 *
 * 数え方は「1 行 = 1 件」ではなく**軸ごとに 1 件**。範囲の上下を別々に数えると
 * 「1 つ絞っただけで 2 件」と出て数字の意味が薄れる
 */
export function advancedCount(a: AdvancedFilter): number {
  const range = (min: number | null, max: number | null) => (min !== null || max !== null ? 1 : 0);
  return (
    (a.searchPath ? 1 : 0) +
    (a.searchComment ? 1 : 0) +
    (a.minRating > 0 ? 1 : 0) +
    (a.unrated ? 1 : 0) +
    range(a.minDurationMs, a.maxDurationMs) +
    range(a.minSizeBytes, a.maxSizeBytes) +
    (a.extensions.length > 0 ? 1 : 0) +
    (a.minHeight > 0 ? 1 : 0) +
    (a.maxHeight > 0 ? 1 : 0) +
    (a.orientation !== '' ? 1 : 0) +
    (a.videoCodecs.length > 0 ? 1 : 0) +
    (a.untagged ? 1 : 0) +
    (a.unwatched ? 1 : 0) +
    (a.resumedOnly ? 1 : 0) +
    range(a.minViewCount, a.maxViewCount) +
    (a.addedAfter || a.addedBefore ? 1 : 0) +
    (a.addedWithinDays > 0 ? 1 : 0) +
    (a.modifiedAfter || a.modifiedBefore ? 1 : 0) +
    (a.modifiedWithinDays > 0 ? 1 : 0)
  );
}
