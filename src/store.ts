import { create } from 'zustand';
import { DEFAULT_COLUMNS } from './lib/listColumns';
import type { ColumnKey } from './lib/listColumns';
import { EMPTY_FILTER } from './lib/query';
import type { FilterState } from './lib/query';
import { DEFAULT_SUB_STYLE } from './lib/subtitleStyle';
import type { SubStyle } from './lib/subtitleStyle';
import { EMPTY_ADVANCED } from './types';
import type { AdvancedFilter, PlayQueue, SortKey, Toast, VideoRow, ViewMode } from './types';

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

/**
 * `applyFilter` に渡せるもの。詳細検索(`advanced`)だけ**部分指定を許す** ——
 * 統計モーダルの「未視聴」タイルのように、1 項目だけ立てて飛ぶ呼び出しがあるため。
 * 残りは既定値に戻る
 */
export type FilterPatch =
  Partial<Omit<FilterState, 'advanced'>> & { advanced?: Partial<AdvancedFilter> };

interface LibraryState {
  text: string;
  sort: SortKey;
  /** 監視フォルダで絞る(配下すべて)。サイドバー「ライブラリ」タブの監視フォルダ一覧から */
  folderId: number | null;
  /** フォルダ直下だけで絞る(サブフォルダは含まない)。サイドバー「フォルダー」タブのツリーから */
  dirPath: string | null;
  /** 選択中のタグフィルタ。同じグループ同士は OR、グループをまたぐと AND(v1.19。組み立ては Rust) */
  tagIds: number[];
  /** 選択中のシリーズフィルタ */
  seriesId: number | null;
  /** dirPath をサブフォルダ込みで見る(絞り込み帯のトグル。v1.35) */
  dirPathRecursive: boolean;
  /** true のとき「見つからないファイル」だけを表示 */
  missingOnly: boolean;
  /** true のとき内容が同一の動画だけを表示する(重複整理) */
  duplicatesOnly: boolean;
  /** 詳細検索ポップオーバーの中身ぜんぶ(v1.35。★・長さもここに入った) */
  advanced: AdvancedFilter;
  /** sort='random' のシャッフル種。ページングしても順序を保つために固定値を持つ */
  randomSeed: number;
  /** ライブラリ内容の変更通知。増えると各所が再取得する */
  version: number;
  /**
   * サムネイルの中身の変更通知。`{id}.jpg` という名前は変わらないので、
   * これを URL に足さないと WebView2 が古い絵を出し続ける(lib/thumbs.ts)。
   * version と分けてあるのは、タグ付けのたびに全サムネイルを読み直させないため
   */
  thumbVersion: number;
  /**
   * いま開いているライブラリの id(v1.27)。起動直後は空。
   * **localStorage のキーを分けるのに使う** —— タググループの折りたたみ状態は
   * `tag_groups.id` の配列で、id はライブラリごとに別物なので、共有すると
   * 「ジャンル(id=3)」を畳んだ状態が別ライブラリの「出演者(id=3)」に効いてしまう
   */
  libraryId: string;
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
   * 詳細リストの行を 1 行おきに濃くするか(v1.25。設定 `list_zebra` に永続化)。
   * 既定 OFF —— 既存の見た目を勝手に変えないため。切り替えは列ピッカーの中にある
   */
  listZebra: boolean;
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
   * グリッドのカード下にタグ行 / シリーズ行を出すか(v1.23。設定で切り替え)。
   * 詳細リストは列ピッカー(listColumns)で切り替えるのでここは使わない。
   *
   * **行の高さが変わる**(lib/grid.ts の CARD_CHIP_ROW_H)。切り替えたら
   * gridMetrics に渡す chipRows も一緒に変えること
   */
  cardTags: boolean;
  cardSeries: boolean;
  /**
   * プレイヤーのシークバーにカーソルを合わせたときコマを出すか(v1.14。設定で切り替え。既定 ON)。
   * カードのプレビューとは別設定にしている — こちらは再生中に**同じ動画をもう 1 本デコード**
   * するので、外付け HDD の大きいファイルで本編がカクつくなら単独で切りたい
   */
  seekPreview: boolean;
  /**
   * HDR 動画を HDR のまま画面へ渡すか(v1.30、mpv のみ。設定 `hdr_passthrough`、既定 OFF)。
   * mpv の `target-colorspace-hint` に `auto` / `no` として渡る。
   *
   * `auto` は「Windows 側が HDR モードのときだけ HDR 出力し、SDR なら従来どおり
   * トーンマップする」挙動だが、**既定は OFF にしてある** —— 見え方が変わる設定を
   * 黙って入れないため。ensureMpv(初期化)と useMpvPlayer(実行中の反映)が見る
   */
  hdrPassthrough: boolean;
  /**
   * 字幕の見た目(v1.24、mpv のみ)。設定 `subtitle_style` に永続化する。
   * プレイヤーのパネル・設定モーダル・useMpvPlayer の 3 か所が同じ値を見るので store に置く。
   *
   * **DB への書き込みはここではしない** — スライダーのドラッグ中に set_setting を
   * 叩かないよう、App.tsx がデバウンスして保存する
   */
  subStyle: SubStyle;
  /**
   * 右クリックメニューを開いているか(v1.14)。メニューの中身は**開いた側の**
   * ローカル state(hooks/useContextMenu.ts)で持ち、ここには開閉だけを置く。
   * 開いている間はグリッドの矢印キー・App の Esc(選択解除)・
   * プレイヤーのショートカットを止めるため、複数の場所から見える必要がある
   */
  contextMenuOpen: boolean;
  /**
   * 開いているメニューの数(v1.20)。**contextMenuOpen を直接 false にしない**ための内部値。
   *
   * 別のホストのメニューへ移ると「新しい方の mount → 古い方の unmount」の順で
   * 呼ばれることがあり、素直に true/false を書くとそこでフラグが落ちる。
   * 落ちた瞬間、メニューが出ているのに裏のグリッドが矢印キーを拾い始める
   */
  contextMenuDepth: number;
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
  /** サブフォルダも含めるかを切り替える(フォルダで絞っているときだけ意味を持つ) */
  toggleDirPathRecursive: () => void;
  setAdvanced: (patch: Partial<AdvancedFilter>) => void;
  clearAdvanced: () => void;
  bumpVersion: () => void;
  bumpThumbVersion: () => void;
  setLibraryId: (id: string) => void;
  setStatus: (scanning: boolean, status: string) => void;
  setPlayingVideo: (video: VideoRow | null) => void;
  /** 一覧から再生を始める(⏭ で次へ進めるようにキュー情報も持つ) */
  playFromList: (video: VideoRow, queue: PlayQueue) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setCardWidth: (cardWidth: number) => void;
  setInspectorPinned: (inspectorPinned: boolean) => void;
  setMediaInfoOpen: (mediaInfoOpen: boolean) => void;
  setListColumns: (listColumns: ColumnKey[]) => void;
  setListZebra: (listZebra: boolean) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setInspectorWidth: (inspectorWidth: number) => void;
  setSidebarCollapsed: (sidebarCollapsed: boolean) => void;
  setAiPanelWidth: (aiPanelWidth: number) => void;
  setAutoplayNext: (autoplayNext: boolean) => void;
  setRepeatOne: (repeatOne: boolean) => void;
  setPlayerPath: (playerPath: string) => void;
  setPreviewOnHover: (previewOnHover: boolean) => void;
  setCardTags: (cardTags: boolean) => void;
  setCardSeries: (cardSeries: boolean) => void;
  setSeekPreview: (seekPreview: boolean) => void;
  setHdrPassthrough: (hdrPassthrough: boolean) => void;
  /** 字幕の見た目を部分更新する(スライダー 1 本ぶんの patch を渡す) */
  setSubStyle: (patch: Partial<SubStyle>) => void;
  /** 字幕の見た目を mpv 素の状態に戻す(保存される JSON も '{}' になる) */
  resetSubStyle: () => void;
  /** メニューの mount で true、unmount で false。呼び出し側は入れ子を意識しなくてよい */
  setContextMenuOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setShowStats: (showStats: boolean) => void;
  /**
   * フィルタ一式をまとめて置き換える(AI アシスタントの apply_filter・
   * スマートフォルダの復元・統計からのジャンプで共用)。
   * **省略項目は EMPTY_FILTER の値に戻る**。
   *
   * 引数を FilterState の Partial にしてあるので、条件が増えてもこの型は増えない。
   * 呼ぶ側は `toFilterState(query)` の結果をそのまま渡せばよい
   */
  applyFilter: (filter: FilterPatch) => void;
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
  // 絞り込みの初期値は 1 か所(lib/query.ts)から取る。条件が増えてもここは増えない
  ...EMPTY_FILTER,
  // 種だけは起動ごとに引き直す(EMPTY_FILTER の 1 は「種を持たない」を表す固定値)
  randomSeed: newSeed(),
  version: 0,
  thumbVersion: 0,
  libraryId: '',
  status: '',
  scanning: false,
  ...CLEARED,
  viewMode: 'grid',
  cardWidth: CARD_WIDTH_DEFAULT,
  inspectorPinned: false,
  mediaInfoOpen: false,
  listColumns: DEFAULT_COLUMNS,
  listZebra: false,
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
  // タグは付いている動画が多いので既定 ON、シリーズは限られるので既定 OFF
  cardTags: true,
  cardSeries: false,
  seekPreview: true,
  hdrPassthrough: false,
  subStyle: DEFAULT_SUB_STYLE,
  contextMenuOpen: false,
  contextMenuDepth: 0,
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
  setListZebra: (listZebra) => set({ listZebra }),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_WIDTH) }),
  setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, INSPECTOR_WIDTH) }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setAiPanelWidth: (w) => set({ aiPanelWidth: clamp(w, AI_PANEL_WIDTH) }),
  setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
  setRepeatOne: (repeatOne) => set({ repeatOne }),
  setPlayerPath: (playerPath) => set({ playerPath }),
  setPreviewOnHover: (previewOnHover) => set({ previewOnHover }),
  setCardTags: (cardTags) => set({ cardTags }),
  setCardSeries: (cardSeries) => set({ cardSeries }),
  setSeekPreview: (seekPreview) => set({ seekPreview }),
  setHdrPassthrough: (hdrPassthrough) => set({ hdrPassthrough }),
  setSubStyle: (patch) => set((s) => ({ subStyle: { ...s.subStyle, ...patch } })),
  resetSubStyle: () => set({ subStyle: DEFAULT_SUB_STYLE }),
  setContextMenuOpen: (open) =>
    set((s) => {
      // 0 を下回らせない。二重に閉じても負の借金が残らないようにする
      const contextMenuDepth = Math.max(0, s.contextMenuDepth + (open ? 1 : -1));
      return { contextMenuDepth, contextMenuOpen: contextMenuDepth > 0 };
    }),
  toggleAiPanel: () => set((s) => ({ showAiPanel: !s.showAiPanel })),
  setShowStats: (showStats) => set({ showStats }),
  applyFilter: (f) =>
    set((s) => ({
      ...EMPTY_FILTER,
      ...f,
      advanced: { ...EMPTY_ADVANCED, ...f.advanced },
      // 並び順だけは既定に戻さない。指定が無ければ今の並びを引き継ぐ
      // (シリーズを選んだらシリーズ順、外したら追加日順に戻すのは従来どおり)
      sort: f.sort ?? (f.seriesId != null ? 'series_asc' : s.sort === 'series_asc' ? 'added_desc' : s.sort),
      // 種も同じ。指定が無ければ今の種のまま(ランダム並びが勝手に組み変わらないように)
      randomSeed: f.randomSeed ?? s.randomSeed,
      ...CLEARED,
    })),
  setText: (text) => set({ text, ...CLEARED }),
  // 選択の照合は id の Set なので、並べ替えても正しい行がハイライトされ続ける。
  // 「ランダム」は**選ぶたびに引き直す**(v1.20)。種を据え置くと 2 回目以降が
  // 同じ並びになり「シャッフルされない」と見える。専用のシャッフルボタンはこれで畳んだ
  setSort: (sort) =>
    set(sort === 'random' ? { sort, randomSeed: newSeed(), ...REORDERED } : { sort, ...REORDERED }),
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
  toggleDirPathRecursive: () =>
    set((s) => ({ dirPathRecursive: !s.dirPathRecursive, ...CLEARED })),
  setAdvanced: (patch) =>
    set((s) => ({ advanced: { ...s.advanced, ...patch }, ...CLEARED })),
  clearAdvanced: () => set({ advanced: EMPTY_ADVANCED, ...CLEARED }),
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
  bumpThumbVersion: () => set((s) => ({ thumbVersion: s.thumbVersion + 1 })),
  setLibraryId: (libraryId) => set({ libraryId }),
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
