import { create } from 'zustand';
import type { DurationBucket, SortKey, Toast, VideoRow } from './types';

let toastSeq = 0;

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
  /** カードのホバープレビューを有効にするか(設定で切り替え。既定 ON) */
  previewOnHover: boolean;
  /** AI アシスタントパネルの表示状態 */
  showAiPanel: boolean;
  /** 画面右下の通知(API 失敗を無反応にしないため) */
  toasts: Toast[];
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
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
  setPreviewOnHover: (previewOnHover: boolean) => void;
  toggleAiPanel: () => void;
  /** フィルタ一式をまとめて置き換える(AI アシスタントの apply_filter 用)。省略項目は既定値に戻る */
  applyFilter: (filter: {
    text?: string;
    tagIds?: number[];
    seriesId?: number | null;
    minRating?: number;
    durationBucket?: DurationBucket | null;
    missingOnly?: boolean;
    sort?: SortKey;
  }) => void;
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
  previewOnHover: true,
  showAiPanel: false,
  toasts: [],
  pushToast: (message, kind = 'error') =>
    set((s) => {
      // 同じ内容が出ている間は増やさない(ページ取得のリトライなどで連投されるため)
      if (s.toasts.some((t) => t.message === message)) return s;
      return { toasts: [...s.toasts, { id: ++toastSeq, message, kind }].slice(-4) };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPlayingVideo: (playingVideo) => set({ playingVideo }),
  setPlayerPath: (playerPath) => set({ playerPath }),
  setPreviewOnHover: (previewOnHover) => set({ previewOnHover }),
  toggleAiPanel: () => set((s) => ({ showAiPanel: !s.showAiPanel })),
  applyFilter: (f) =>
    set((s) => ({
      text: f.text ?? '',
      tagIds: f.tagIds ?? [],
      seriesId: f.seriesId ?? null,
      minRating: f.minRating ?? 0,
      durationBucket: f.durationBucket ?? null,
      missingOnly: f.missingOnly ?? false,
      sort: f.sort ?? (f.seriesId != null ? 'series_asc' : s.sort === 'series_asc' ? 'added_desc' : s.sort),
      folderId: null,
      selection: [],
    })),
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
