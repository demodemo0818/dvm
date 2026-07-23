import { create } from 'zustand';
import type { SortKey } from './types';

interface LibraryState {
  text: string;
  sort: SortKey;
  folderId: number | null;
  /** ライブラリ内容の変更通知。増えると各所が再取得する */
  version: number;
  status: string;
  scanning: boolean;
  setText: (text: string) => void;
  setSort: (sort: SortKey) => void;
  setFolderId: (folderId: number | null) => void;
  bumpVersion: () => void;
  setStatus: (scanning: boolean, status: string) => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  text: '',
  sort: 'added_desc',
  folderId: null,
  version: 0,
  status: '',
  scanning: false,
  setText: (text) => set({ text }),
  setSort: (sort) => set({ sort }),
  setFolderId: (folderId) => set({ folderId }),
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
  setStatus: (scanning, status) => set({ scanning, status }),
}));
