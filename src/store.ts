import { create } from 'zustand';
import { EMPTY_ADVANCED } from './types';
import type {
  AdvancedFilter, DurationBucket, PlayQueue, SortKey, Toast, VideoRow, ViewMode,
} from './types';

let toastSeq = 0;

/** シャッフル種。0 は使わない(Rust 側で 1 に丸められる) */
const newSeed = () => Math.floor(Math.random() * 999_000) + 1;

/** カード幅の下限・上限(px)。ツールバーのスライダーの範囲 */
export const CARD_WIDTH_MIN = 140;
export const CARD_WIDTH_MAX = 400;
export const CARD_WIDTH_DEFAULT = 224;

/** サイドバー / 詳細ペインの幅(px)。ドラッグの上下限と初期値 */
export const SIDEBAR_WIDTH = { min: 180, max: 480, default: 240 };
export const INSPECTOR_WIDTH = { min: 220, max: 520, default: 260 };

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(Math.max(Math.round(v), min), max);

/**
 * 絞り込みが変わったら選択は無効になる(一覧の中身も通し番号も別物になるため)。
 * 選択だけ消して anchor / focus が残ると、次の Shift+クリックが的外れな範囲を選ぶ
 */
const CLEARED = { selection: [] as VideoRow[], anchorIndex: null, focusIndex: null };

interface LibraryState {
  text: string;
  sort: SortKey;
  /** 監視フォルダで絞る(配下すべて)。サイドバー「ライブラリ」タブの監視フォルダ一覧から */
  folderId: number | null;
  /** フォルダ直下だけで絞る(サブフォルダは含まない)。サイドバー「フォルダー」タブのツリーから */
  dirPath: string | null;
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
  /** true のとき内容が同一の動画だけを表示する(重複整理) */
  duplicatesOnly: boolean;
  /** ツールバーに出していない詳細検索の条件 */
  advanced: AdvancedFilter;
  /** sort='random' のシャッフル種。ページングしても順序を保つために固定値を持つ */
  randomSeed: number;
  /** ライブラリ内容の変更通知。増えると各所が再取得する */
  version: number;
  status: string;
  scanning: boolean;
  /** グリッドで選択中の動画(行データごと保持) */
  selection: VideoRow[];
  /** Shift+クリックの起点。範囲選択はここから現在位置まで */
  anchorIndex: number | null;
  /** キーボード操作のフォーカス位置(一覧内の通し番号) */
  focusIndex: number | null;
  /** サムネイルグリッドか詳細リストか(設定に永続化) */
  viewMode: ViewMode;
  /** グリッドのカード幅 px(設定に永続化) */
  cardWidth: number;
  /** 選択が空でも詳細ペインを出したままにする(設定に永続化) */
  inspectorPinned: boolean;
  /** 左サイドバー / 右詳細ペインの幅 px(ドラッグで伸縮。設定に永続化) */
  sidebarWidth: number;
  inspectorWidth: number;
  /** 再生が終わったら次の動画へ進むか(設定に永続化) */
  autoplayNext: boolean;
  /**
   * 今見ている動画を繰り返すか(v1.13)。**永続化しない** —
   * 短い動画をループさせたまま次のセッションに持ち越すと、連続再生が壊れたように
   * 見えてしまうため。アプリを再起動すればオフに戻る
   */
  repeatOne: boolean;
  /** アプリ内プレイヤーで再生中の動画(null = 非表示) */
  playingVideo: VideoRow | null;
  /** 連続再生の位置(null = 単発再生。⏭ が無効になる) */
  playQueue: PlayQueue | null;
  /** 外部プレイヤーのパス設定(起動時ロード・設定保存時更新) */
  playerPath: string;
  /** カードのホバープレビューを有効にするか(設定で切り替え。既定 ON) */
  previewOnHover: boolean;
  /** AI アシスタントパネルの表示状態 */
  showAiPanel: boolean;
  /** 統計ダッシュボードの表示状態 */
  showStats: boolean;
  /** 画面右下の通知(API 失敗を無反応にしないため) */
  toasts: Toast[];
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setText: (text: string) => void;
  setSort: (sort: SortKey) => void;
  setFolderId: (folderId: number | null) => void;
  /** 同じフォルダをもう一度渡すと解除する。null で明示的に解除 */
  toggleDirPath: (dirPath: string | null) => void;
  toggleTagFilter: (tagId: number) => void;
  clearTagFilter: () => void;
  toggleSeriesFilter: (seriesId: number) => void;
  toggleMissingOnly: () => void;
  toggleDuplicatesOnly: () => void;
  setMinRating: (minRating: number) => void;
  setDurationBucket: (durationBucket: DurationBucket | null) => void;
  setAdvanced: (patch: Partial<AdvancedFilter>) => void;
  clearAdvanced: () => void;
  /** ランダムソートに切り替える / すでにランダムなら並びを引き直す */
  reshuffle: () => void;
  bumpVersion: () => void;
  setStatus: (scanning: boolean, status: string) => void;
  setPlayingVideo: (video: VideoRow | null) => void;
  /** 一覧から再生を始める(⏭ で次へ進めるようにキュー情報も持つ) */
  playFromList: (video: VideoRow, queue: PlayQueue) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setCardWidth: (cardWidth: number) => void;
  setInspectorPinned: (inspectorPinned: boolean) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setInspectorWidth: (inspectorWidth: number) => void;
  setAutoplayNext: (autoplayNext: boolean) => void;
  setRepeatOne: (repeatOne: boolean) => void;
  setPlayerPath: (playerPath: string) => void;
  setPreviewOnHover: (previewOnHover: boolean) => void;
  toggleAiPanel: () => void;
  setShowStats: (showStats: boolean) => void;
  /**
   * フィルタ一式をまとめて置き換える(AI アシスタントの apply_filter・
   * スマートフォルダの復元で共用)。省略項目は既定値に戻る
   */
  applyFilter: (filter: {
    text?: string;
    tagIds?: number[];
    seriesId?: number | null;
    minRating?: number;
    durationBucket?: DurationBucket | null;
    missingOnly?: boolean;
    duplicatesOnly?: boolean;
    sort?: SortKey;
    advanced?: Partial<AdvancedFilter>;
    folderId?: number | null;
    dirPath?: string | null;
  }) => void;
  /** index は一覧内の通し番号。省略すると範囲選択の起点を持たない選択になる */
  selectOnly: (video: VideoRow, index?: number | null) => void;
  toggleSelect: (video: VideoRow, index?: number | null) => void;
  /** 範囲選択・全選択の結果をまとめて反映する */
  setSelection: (videos: VideoRow[], focusIndex?: number | null) => void;
  setFocusIndex: (focusIndex: number | null) => void;
  clearSelection: () => void;
  /** 選択中の全行に部分更新を適用する(例: レーティング変更の即時反映) */
  patchSelection: (patch: Partial<VideoRow>) => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  text: '',
  sort: 'added_desc',
  folderId: null,
  dirPath: null,
  tagIds: [],
  seriesId: null,
  missingOnly: false,
  minRating: 0,
  durationBucket: null,
  duplicatesOnly: false,
  advanced: EMPTY_ADVANCED,
  randomSeed: newSeed(),
  version: 0,
  status: '',
  scanning: false,
  ...CLEARED,
  viewMode: 'grid',
  cardWidth: CARD_WIDTH_DEFAULT,
  inspectorPinned: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
  inspectorWidth: INSPECTOR_WIDTH.default,
  autoplayNext: false,
  repeatOne: false,
  playingVideo: null,
  playQueue: null,
  playerPath: '',
  previewOnHover: true,
  showAiPanel: false,
  showStats: false,
  toasts: [],
  pushToast: (message, kind = 'error') =>
    set((s) => {
      // 同じ内容が出ている間は増やさない(ページ取得のリトライなどで連投されるため)
      if (s.toasts.some((t) => t.message === message)) return s;
      return { toasts: [...s.toasts, { id: ++toastSeq, message, kind }].slice(-4) };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  // 単発再生。プレイヤーを閉じたらキューも捨てる
  setPlayingVideo: (playingVideo) =>
    set(playingVideo === null ? { playingVideo: null, playQueue: null } : { playingVideo }),
  playFromList: (playingVideo, playQueue) => set({ playingVideo, playQueue }),
  setViewMode: (viewMode) => set({ viewMode }),
  setCardWidth: (cardWidth) =>
    set({ cardWidth: Math.min(Math.max(Math.round(cardWidth), CARD_WIDTH_MIN), CARD_WIDTH_MAX) }),
  setInspectorPinned: (inspectorPinned) => set({ inspectorPinned }),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_WIDTH) }),
  setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, INSPECTOR_WIDTH) }),
  setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
  setRepeatOne: (repeatOne) => set({ repeatOne }),
  setPlayerPath: (playerPath) => set({ playerPath }),
  setPreviewOnHover: (previewOnHover) => set({ previewOnHover }),
  toggleAiPanel: () => set((s) => ({ showAiPanel: !s.showAiPanel })),
  setShowStats: (showStats) => set({ showStats }),
  applyFilter: (f) =>
    set((s) => ({
      text: f.text ?? '',
      tagIds: f.tagIds ?? [],
      seriesId: f.seriesId ?? null,
      minRating: f.minRating ?? 0,
      durationBucket: f.durationBucket ?? null,
      missingOnly: f.missingOnly ?? false,
      duplicatesOnly: f.duplicatesOnly ?? false,
      advanced: { ...EMPTY_ADVANCED, ...f.advanced },
      sort: f.sort ?? (f.seriesId != null ? 'series_asc' : s.sort === 'series_asc' ? 'added_desc' : s.sort),
      folderId: f.folderId ?? null,
      dirPath: f.dirPath ?? null,
      ...CLEARED,
    })),
  setText: (text) => set({ text, ...CLEARED }),
  setSort: (sort) => set({ sort, ...CLEARED }),
  // フォルダの 2 系統(監視フォルダ配下すべて / フォルダ直下だけ)は同時に使わない。
  // 片方を選んだらもう片方を外す(AND で 0 件になるのを避ける)
  setFolderId: (folderId) => set({ folderId, dirPath: null, ...CLEARED }),
  toggleDirPath: (dirPath) =>
    set((s) => ({
      // Windows のパスは大文字小文字を区別しない。保存した条件から復元したときも
      // 同じフォルダなら 2 回目のクリックで外れるようにする
      dirPath:
        dirPath !== null && s.dirPath?.toLowerCase() === dirPath.toLowerCase() ? null : dirPath,
      folderId: null,
      ...CLEARED,
    })),
  toggleTagFilter: (tagId) =>
    set((s) => ({
      tagIds: s.tagIds.includes(tagId)
        ? s.tagIds.filter((t) => t !== tagId)
        : [...s.tagIds, tagId],
      ...CLEARED,
    })),
  clearTagFilter: () => set({ tagIds: [], ...CLEARED }),
  toggleMissingOnly: () => set((s) => ({ missingOnly: !s.missingOnly, ...CLEARED })),
  toggleDuplicatesOnly: () =>
    set((s) => {
      const next = !s.duplicatesOnly;
      return {
        duplicatesOnly: next,
        // 重複表示では同じファイルが隣り合う並びにする。外したら追加日順に戻す
        sort: next ? 'dup' : s.sort === 'dup' ? 'added_desc' : s.sort,
        ...CLEARED,
      };
    }),
  setMinRating: (minRating) => set({ minRating, ...CLEARED }),
  setDurationBucket: (durationBucket) => set({ durationBucket, ...CLEARED }),
  setAdvanced: (patch) =>
    set((s) => ({ advanced: { ...s.advanced, ...patch }, ...CLEARED })),
  clearAdvanced: () => set({ advanced: EMPTY_ADVANCED, ...CLEARED }),
  reshuffle: () => set({ sort: 'random', randomSeed: newSeed(), ...CLEARED }),
  toggleSeriesFilter: (seriesId) =>
    set((s) => {
      const next = s.seriesId === seriesId ? null : seriesId;
      return {
        seriesId: next,
        // シリーズを選んだらシリーズ順、外したら追加日順に戻す
        sort: next !== null ? 'series_asc' : s.sort === 'series_asc' ? 'added_desc' : s.sort,
        ...CLEARED,
      };
    }),
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
  setStatus: (scanning, status) => set({ scanning, status }),
  selectOnly: (video, index = null) =>
    set({ selection: [video], anchorIndex: index, focusIndex: index }),
  toggleSelect: (video, index = null) =>
    set((s) => ({
      selection: s.selection.some((v) => v.id === video.id)
        ? s.selection.filter((v) => v.id !== video.id)
        : [...s.selection, video],
      // Ctrl+クリックした位置が次の Shift+クリックの起点になる
      anchorIndex: index,
      focusIndex: index,
    })),
  setSelection: (selection, focusIndex) =>
    set((s) => ({ selection, focusIndex: focusIndex === undefined ? s.focusIndex : focusIndex })),
  setFocusIndex: (focusIndex) => set({ focusIndex }),
  clearSelection: () => set({ ...CLEARED }),
  patchSelection: (patch) =>
    set((s) => ({ selection: s.selection.map((v) => ({ ...v, ...patch })) })),
}));
