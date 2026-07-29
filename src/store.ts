import { create } from 'zustand';
import { DEFAULT_COLUMNS } from './lib/listColumns';
import type { ColumnKey } from './lib/listColumns';
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

/** サイドバー / 詳細ペイン / AI パネルの幅(px)。ドラッグの上下限と初期値 */
export const SIDEBAR_WIDTH = { min: 180, max: 480, default: 240 };
export const INSPECTOR_WIDTH = { min: 220, max: 520, default: 260 };
export const AI_PANEL_WIDTH = { min: 260, max: 560, default: 320 };

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(Math.max(Math.round(v), min), max);

/**
 * 絞り込みが変わったら選択は無効になる(一覧の中身も通し番号も別物になるため)。
 * 選択だけ消して anchor / focus が残ると、次の Shift+クリックが的外れな範囲を選ぶ。
 *
 * **並び替えはこれを使わない**。中身は変わらず順番だけが変わるので、選んだものは残す
 * (v1.16。列ヘッダを付けて並び替えが頻繁な操作になったため)
 */
const CLEARED = { selection: [] as VideoRow[], anchorIndex: null, focusIndex: null };

/** 並び替えたときに捨てるもの。通し番号が変わって意味を失う anchor / focus だけ */
const REORDERED = { anchorIndex: null, focusIndex: null };

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
  /**
   * 詳細リストに出す列と、その並び(設定 `list_columns` に JSON で永続化)。
   * 名前列は固定なのでここには入らない。サムネイルは先頭固定
   */
  listColumns: ColumnKey[];
  /**
   * 詳細ペインの「メディア情報」を開いているか(設定に永続化)。
   * 開いている間は選択を変えるたびに ffprobe が走るので既定は閉じる
   */
  mediaInfoOpen: boolean;
  /** 左サイドバー / 右詳細ペインの幅 px(ドラッグで伸縮。設定に永続化) */
  sidebarWidth: number;
  inspectorWidth: number;
  /**
   * サイドバーを畳んでいるか(設定に永続化)。
   * 畳むと幅を変える帯ごと消えるので、戻す手段はツールバーのボタンだけ
   */
  sidebarCollapsed: boolean;
  /** AI パネルの幅 px(ドラッグで伸縮。設定に永続化) */
  aiPanelWidth: number;
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
  /**
   * プレイヤーのシークバーにカーソルを合わせたときコマを出すか(v1.14。設定で切り替え。既定 ON)。
   * カードのプレビューとは別設定にしている — こちらは再生中に**同じ動画をもう 1 本デコード**
   * するので、外付け HDD の大きいファイルで本編がカクつくなら単独で切りたい
   */
  seekPreview: boolean;
  /**
   * 右クリックメニューを開いているか(v1.14)。メニューの中身はグリッド側の
   * ローカル state で持ち、ここには開閉だけを置く。
   * 開いている間はグリッドの矢印キーと App の Esc(選択解除)を止めるため、
   * 複数のコンポーネントから見える場所に置く必要がある
   */
  contextMenuOpen: boolean;
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
  setTagFilter: (tagIds: number[]) => void;
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
  setMediaInfoOpen: (mediaInfoOpen: boolean) => void;
  setListColumns: (listColumns: ColumnKey[]) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setInspectorWidth: (inspectorWidth: number) => void;
  setSidebarCollapsed: (sidebarCollapsed: boolean) => void;
  setAiPanelWidth: (aiPanelWidth: number) => void;
  setAutoplayNext: (autoplayNext: boolean) => void;
  setRepeatOne: (repeatOne: boolean) => void;
  setPlayerPath: (playerPath: string) => void;
  setPreviewOnHover: (previewOnHover: boolean) => void;
  setSeekPreview: (seekPreview: boolean) => void;
  setContextMenuOpen: (contextMenuOpen: boolean) => void;
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
  mediaInfoOpen: false,
  listColumns: DEFAULT_COLUMNS,
  sidebarWidth: SIDEBAR_WIDTH.default,
  inspectorWidth: INSPECTOR_WIDTH.default,
  sidebarCollapsed: false,
  aiPanelWidth: AI_PANEL_WIDTH.default,
  autoplayNext: false,
  repeatOne: false,
  playingVideo: null,
  playQueue: null,
  playerPath: '',
  previewOnHover: true,
  seekPreview: true,
  contextMenuOpen: false,
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
  setMediaInfoOpen: (mediaInfoOpen) => set({ mediaInfoOpen }),
  setListColumns: (listColumns) => set({ listColumns }),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_WIDTH) }),
  setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, INSPECTOR_WIDTH) }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setAiPanelWidth: (w) => set({ aiPanelWidth: clamp(w, AI_PANEL_WIDTH) }),
  setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
  setRepeatOne: (repeatOne) => set({ repeatOne }),
  setPlayerPath: (playerPath) => set({ playerPath }),
  setPreviewOnHover: (previewOnHover) => set({ previewOnHover }),
  setSeekPreview: (seekPreview) => set({ seekPreview }),
  setContextMenuOpen: (contextMenuOpen) => set({ contextMenuOpen }),
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
  // 選択の照合は id の Set なので、並べ替えても正しい行がハイライトされ続ける
  setSort: (sort) => set({ sort, ...REORDERED }),
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
  // グループ見出しのクリック用。配下タグをまとめて入れ替える
  // (同じグループのタグ同士は Rust 側で OR になるので、これで「このグループの何か」が出る)
  setTagFilter: (tagIds) => set({ tagIds, ...CLEARED }),
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
