import { create } from 'zustand';
import type { DurationBucket, SortKey, VideoRow } from './types';

interface LibraryState {
  text: string;
  sort: SortKey;
  folderId: number | null;
  /** 選択中のタグフィルタ(AND 条件) */
  tagIds: number[];
  /** 選択中のシリーズフィルタ */
  seriesId: number | null;
  /** true のとき「見つからないファイル」だけを表示 */
  missingOnly: boolean;
  /** このレーティング以上に絞る(0 = 絞らない) */
  minRating: number;
  /** 尺フィルタのプリセット(null = 絞らない) */
  durationBucket: DurationBucket | null;
  /** ライブラリ内容の変更通知。増えると各所が再取得する */
  version: number;
  status: string;
  scanning: boolean;
  /** グリッドで選択中の動画(行データごと保持) */
  selection: VideoRow[];
  /** アプリ内プレイヤーで再生中の動画(null = 非表示) */
  playingVideo: VideoRow | null;
  /** 外部プレイヤーのパス設定(起動時ロード・設定保存時更新) */
  playerPath: string;
  setText: (text: string) => void;
  setSort: (sort: SortKey) => void;
  setFolderId: (folderId: number | null) => void;
  toggleTagFilter: (tagId: number) => void;
  clearTagFilter: () => void;
  toggleSeriesFilter: (seriesId: number) => void;
  toggleMissingOnly: () => void;
  setMinRating: (minRating: number) => void;
  setDurationBucket: (durationBucket: DurationBucket | null) => void;
  bumpVersion: () => void;
  setStatus: (scanning: boolean, status: string) => void;
  setPlayingVideo: (video: VideoRow | null) => void;
  setPlayerPath: (playerPath: string) => void;
  selectOnly: (video: VideoRow) => void;
  toggleSelect: (video: VideoRow) => void;
  clearSelection: () => void;
  /** 選択中の全行に部分更新を適用する(例: レーティング変更の即時反映) */
  patchSelection: (patch: Partial<VideoRow>) => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  text: '',
  sort: 'added_desc',
  folderId: null,
  tagIds: [],
  seriesId: null,
  missingOnly: false,
  minRating: 0,
  durationBucket: null,
  version: 0,
  status: '',
  scanning: false,
  selection: [],
  playingVideo: null,
  playerPath: '',
  setPlayingVideo: (playingVideo) => set({ playingVideo }),
  setPlayerPath: (playerPath) => set({ playerPath }),
  setText: (text) => set({ text, selection: [] }),
  setSort: (sort) => set({ sort, selection: [] }),
  setFolderId: (folderId) => set({ folderId, selection: [] }),
  toggleTagFilter: (tagId) =>
    set((s) => ({
      tagIds: s.tagIds.includes(tagId)
        ? s.tagIds.filter((t) => t !== tagId)
        : [...s.tagIds, tagId],
      selection: [],
    })),
  clearTagFilter: () => set({ tagIds: [], selection: [] }),
  toggleMissingOnly: () => set((s) => ({ missingOnly: !s.missingOnly, selection: [] })),
  setMinRating: (minRating) => set({ minRating, selection: [] }),
  setDurationBucket: (durationBucket) => set({ durationBucket, selection: [] }),
  toggleSeriesFilter: (seriesId) =>
    set((s) => {
      const next = s.seriesId === seriesId ? null : seriesId;
      return {
        seriesId: next,
        // シリーズを選んだらシリーズ順、外したら追加日順に戻す
        sort: next !== null ? 'series_asc' : s.sort === 'series_asc' ? 'added_desc' : s.sort,
        selection: [],
      };
    }),
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
  setStatus: (scanning, status) => set({ scanning, status }),
  selectOnly: (video) => set({ selection: [video] }),
  toggleSelect: (video) =>
    set((s) => ({
      selection: s.selection.some((v) => v.id === video.id)
        ? s.selection.filter((v) => v.id !== video.id)
        : [...s.selection, video],
    })),
  clearSelection: () => set({ selection: [] }),
  patchSelection: (patch) =>
    set((s) => ({ selection: s.selection.map((v) => ({ ...v, ...patch })) })),
}));
