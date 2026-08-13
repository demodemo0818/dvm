import { create } from 'zustand';
import { DEFAULT_COLUMNS } from './lib/listColumns';
import type { ColumnKey } from './lib/listColumns';
import { EMPTY_FILTER } from './lib/query';
import type { FilterState } from './lib/query';

/** 絞り込み履歴(C-8)に積める上限。超えたら古いものから捨てる */
const FILTER_HISTORY_LIMIT = 50;
import { SETTINGS_SIZE_DEFAULT, clampModalSize } from './lib/settings';
import type { ModalSize } from './lib/settings';
import { DEFAULT_SUB_STYLE } from './lib/subtitleStyle';
import type { SubStyle } from './lib/subtitleStyle';
import * as queue from './lib/queue';
import { EMPTY_ADVANCED } from './types';
import type {
  AdvancedFilter, PlayQueue, QueueState, SortKey, Toast, VideoRow, ViewMode,
} from './types';

let toastSeq = 0;

/**
 * セレクタ購読の定型。`useLibrary(useShallow(pickState('a', 'b')))` の形で使う。
 *
 * セレクタなしの `useLibrary()` はストア全体を返し、**どのフィールドが変わっても
 * 再レンダー**される(Zustand v5)。スキャン中の scan:state や字幕スライダーの
 * ドラッグのたびにアプリ全ツリーが描き直されていたので、使うキーだけを列挙して購読する
 */
export function pickState<K extends keyof LibraryState>(...keys: K[]) {
  return (s: LibraryState): Pick<LibraryState, K> => {
    const out = {} as Pick<LibraryState, K>;
    for (const k of keys) out[k] = s[k];
    return out;
  };
}

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
 * いまの絞り込み一式を写し取る(v1.41、C-8)。
 * 戻り値の型が FilterState なので、条件が増えてここに書き忘れるとコンパイルで落ちる
 */
function snapshotFilter(s: LibraryState): FilterState {
  return {
    text: s.text,
    sort: s.sort,
    folderId: s.folderId,
    dirPath: s.dirPath,
    dirPathRecursive: s.dirPathRecursive,
    tagIds: s.tagIds,
    seriesId: s.seriesId,
    playlistId: s.playlistId,
    missingOnly: s.missingOnly,
    duplicatesOnly: s.duplicatesOnly,
    advanced: s.advanced,
    randomSeed: s.randomSeed,
  };
}

/**
 * 手動順(シリーズ / プレイリスト)を選んだときの並び。`applyFilter` の sort 決定に使う。
 *
 * 選んだらその手動順に切り替え、**外したら追加日順へ戻す**。戻さないと
 * `playlist_asc` のまま絞りだけが消え、Rust 側で意味を失った ORDER BY が
 * 素通しされて「並べ替えたはずなのに既定順」に見える
 */
function manualSort(current: SortKey, seriesId: number | null, playlistId: number | null): SortKey {
  if (playlistId != null) return 'playlist_asc';
  if (seriesId != null) return 'series_asc';
  const wasManual = current === 'series_asc' || current === 'playlist_asc';
  return wasManual ? 'added_desc' : current;
}

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
  /** 選択中の保存プレイリストフィルタ(v1.40。サイドバーの「プレイリスト」から) */
  playlistId: number | null;
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
  /**
   * 設定モーダルの大きさ(v1.38。右下を掴んで伸縮。設定に永続化)。
   * **起動時に読む**のがポイント —— モーダルが開いてから読むと、既定の大きさで
   * 一瞬描いてから保存した大きさへ跳ねる。サイドバーや詳細ペインの幅と同じ扱い
   */
  settingsModalSize: ModalSize;
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
  /**
   * 再生キュー(v1.40)。**DB には保存しない** —— 名前を付けて保存したものだけが残る、
   * という線引きにしてある(終了時に中身があれば保存するか尋ねる)。
   *
   * `playQueue`(クエリ + 位置)とは**排他**。キューから再生を始めると playQueue が
   * null になり、グリッドのダブルクリックで再生するとキューモードを抜ける。
   * ただし**モードを抜けても中身は消さない** —— ちょっと別の動画を見に戻っただけで
   * 並べたものが消えるのは、終了時に確認する方針より弱い扱いになってしまう
   */
  queue: QueueState;
  /** 右ペインでキュータブを開いているか(v1.40)。開いている間は選択が空でもペインを出す */
  queueTabOpen: boolean;
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
  /**
   * キー操作一覧の表示状態(v1.39)。**設定には保存しない** ——
   * 開いたまま次の起動に持ち越しても意味が無い(統計ダッシュボードと同じ扱い)
   */
  showShortcuts: boolean;
  /**
   * 絞り込みの「戻る / 進む」(v1.41、C-8)。`applyFilter`(条件が丸ごと変わる操作:
   * AI 検索・スマートフォルダ・統計からのジャンプ・全解除)のたびに直前の条件一式を
   * past へ積む。**個別のトグル(タグの付け外し・検索語の編集)は積まない** ——
   * 「大きく変わったときに 1 手で戻れる」が目的で、全操作の undo ではない
   */
  filterPast: FilterState[];
  filterFuture: FilterState[];
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
  /** 保存プレイリストで絞る(v1.40)。同じ id をもう一度渡すと解除 */
  togglePlaylistFilter: (playlistId: number) => void;
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
  /**
   * キューを差し替える(v1.40)。`lib/queue.ts` の純関数が返した状態をそのまま入れる。
   * store 側で中身の判断はしない
   */
  setQueue: (queue: QueueState) => void;
  /** キューから 1 件を再生する。playQueue を捨ててキューモードへ入る */
  playFromQueue: (video: VideoRow) => void;
  setQueueTabOpen: (open: boolean) => void;
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
  setSettingsModalSize: (size: ModalSize) => void;
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
  setShowShortcuts: (showShortcuts: boolean) => void;
  /**
   * フィルタ一式をまとめて置き換える(AI アシスタントの apply_filter・
   * スマートフォルダの復元・統計からのジャンプで共用)。
   * **省略項目は EMPTY_FILTER の値に戻る**。
   *
   * 引数を FilterState の Partial にしてあるので、条件が増えてもこの型は増えない。
   * 呼ぶ側は `toFilterState(query)` の結果をそのまま渡せばよい
   */
  applyFilter: (filter: FilterPatch) => void;
  /** 1 つ前の絞り込みへ戻る(Alt+←)。履歴が無ければ何もしない */
  filterBack: () => void;
  /** 戻る前の絞り込みへ進む(Alt+→) */
  filterForward: () => void;
  /** index は一覧内の通し番号。省略すると範囲選択の起点を持たない選択になる */
  selectOnly: (video: VideoRow, index?: number | null) => void;
  toggleSelect: (video: VideoRow, index?: number | null) => void;
  /**
   * 範囲選択・全選択の結果をまとめて反映する。
   * `anchorIndex` は**省略すると据え置き** —— Shift+クリックや Shift+矢印は
   * 起点を動かさずに範囲を伸ばすため。矩形選択(v1.42)のように
   * 「ここが次の起点」と決まる操作だけが明示的に渡す
   */
  setSelection: (
    videos: VideoRow[], focusIndex?: number | null, anchorIndex?: number | null,
  ) => void;
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
  settingsModalSize: SETTINGS_SIZE_DEFAULT,
  autoplayNext: false,
  repeatOne: false,
  playingVideo: null,
  playQueue: null,
  queue: queue.EMPTY_QUEUE,
  queueTabOpen: false,
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
  showShortcuts: false,
  filterPast: [],
  filterFuture: [],
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
  /*
   * クエリ方式で再生を始める。**playQueue が非 null であることがそのままクエリモードの印**
   * (キューモードは playQueue === null かつ再生中の動画が queue.currentId と一致。
   * 判定は usePlayQueue に集約)。
   * queue は触らない —— 別の動画を見に戻っただけで並べたものを捨てないため
   */
  playFromList: (playingVideo, playQueue) => set({ playingVideo, playQueue }),
  setQueue: (queue) => set({ queue }),
  // キューから再生 = クエリモードを抜ける(2 つのモードは排他)
  playFromQueue: (video) =>
    set((s) => ({
      playingVideo: video,
      playQueue: null,
      queue: queue.playingInQueue(s.queue, video.id),
    })),
  setQueueTabOpen: (queueTabOpen) => set({ queueTabOpen }),
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
  // 丸めは clampModalSize が持つ(幅と高さの 2 軸なので clamp を使い回せない)
  setSettingsModalSize: (size) => set({ settingsModalSize: clampModalSize(size) }),
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
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  applyFilter: (f) =>
    set((s) => {
      const prev = snapshotFilter(s);
      const next: FilterState = {
        ...EMPTY_FILTER,
        ...f,
        advanced: { ...EMPTY_ADVANCED, ...f.advanced },
        // 並び順だけは既定に戻さない。指定が無ければ今の並びを引き継ぐ
        // (シリーズを選んだらシリーズ順、外したら追加日順に戻すのは従来どおり。
        //  v1.40 のプレイリストもまったく同じ扱いにしてある)
        sort: f.sort ?? manualSort(s.sort, f.seriesId ?? null, f.playlistId ?? null),
        // 種も同じ。指定が無ければ今の種のまま(ランダム並びが勝手に組み変わらないように)
        randomSeed: f.randomSeed ?? s.randomSeed,
      };
      // 同じ条件の適用は履歴に積まない —— 「戻る」を押しても見た目が変わらない段が増えるだけ
      // (どちらも EMPTY_FILTER 由来でキーの並びが揃っているので JSON 比較でよい)
      const same = JSON.stringify(prev) === JSON.stringify(next);
      return {
        ...next,
        filterPast: same ? s.filterPast : [...s.filterPast, prev].slice(-FILTER_HISTORY_LIMIT),
        filterFuture: same ? s.filterFuture : [],
        ...CLEARED,
      };
    }),
  // 戻る = いまの条件を future へ退避して、past の末尾を丸ごと復元する(C-8)。
  // applyFilter を経由しない(履歴を積む側と消費する側を分ける)
  filterBack: () =>
    set((s) => {
      const prev = s.filterPast[s.filterPast.length - 1];
      if (!prev) return s;
      return {
        ...prev,
        filterPast: s.filterPast.slice(0, -1),
        filterFuture: [...s.filterFuture, snapshotFilter(s)],
        ...CLEARED,
      };
    }),
  filterForward: () =>
    set((s) => {
      const next = s.filterFuture[s.filterFuture.length - 1];
      if (!next) return s;
      return {
        ...next,
        filterFuture: s.filterFuture.slice(0, -1),
        filterPast: [...s.filterPast, snapshotFilter(s)],
        ...CLEARED,
      };
    }),
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
        sort: manualSort(s.sort, next, s.playlistId),
        ...CLEARED,
      };
    }),
  // シリーズとまったく同じ扱い(選んだら手動順、外したら追加日順)
  togglePlaylistFilter: (playlistId) =>
    set((s) => {
      const next = s.playlistId === playlistId ? null : playlistId;
      return {
        playlistId: next,
        sort: manualSort(s.sort, s.seriesId, next),
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
  setSelection: (selection, focusIndex, anchorIndex) =>
    set((s) => ({
      selection,
      focusIndex: focusIndex === undefined ? s.focusIndex : focusIndex,
      anchorIndex: anchorIndex === undefined ? s.anchorIndex : anchorIndex,
    })),
  setFocusIndex: (focusIndex) => set({ focusIndex }),
  clearSelection: () => set({ ...CLEARED }),
  patchSelection: (patch) =>
    set((s) => ({ selection: s.selection.map((v) => ({ ...v, ...patch })) })),
}));
