import { create } from 'zustand';
import type { SortKey, VideoRow } from './types';

interface LibraryState {
  text: string;
  sort: SortKey;
  folderId: number | null;
  /** 選択中のタグフィルタ(AND 条件) */
  tagIds: number[];
  /** ライブラリ内容の変更通知。増えると各所が再取得する */
  version: number;
  status: string;
  scanning: boolean;
  /** グリッドで選択中の動画(行データごと保持) */
  selection: VideoRow[];
  setText: (text: string) => void;
  setSort: (sort: SortKey) => void;
  setFolderId: (folderId: number | null) => void;
  toggleTagFilter: (tagId: number) => void;
  clearTagFilter: () => void;
  bumpVersion: () => void;
  setStatus: (scanning: boolean, status: string) => void;
  selectOnly: (video: VideoRow) => void;
  toggleSelect: (video: VideoRow) => void;
  clearSelection: () => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  text: '',
  sort: 'added_desc',
  folderId: null,
  tagIds: [],
  version: 0,
  status: '',
  scanning: false,
  selection: [],
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
}));
