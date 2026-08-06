import type { ViewMode } from '../types';

/**
 * ツールバーの項目定義と折りたたみ(v1.17)。
 *
 * **ツールバーの幅に関する知識はすべてここに置く**。コンポーネントは
 * 「どれをバーに出し、どれを ≫ メニューに入れるか」を受け取って描くだけにする
 * (列定義を lib/listColumns.ts に寄せているのと同じ作法)。
 *
 * 幅は実測に基づく固定 px。DOM を測らないのは、**畳んだ項目は DOM から消えるので
 * 二度と測れない**ため。測る方式にすると「一度畳むと広げても戻らない」か
 * 「不可視の複製を常時描いて測る」のどちらかになり、後者は 16 項目ぶんの
 * 二重レンダーとちらつきを招く。
 *
 * 代わりに **CSS 側で実寸をこの値に合わせる**(App.css の .tb-icon と
 * .toolbar > select.* の明示幅)。**片方だけ直さないこと**
 */

export type ToolbarItemKey =
  | 'sidebarToggle'
  | 'search'
  | 'advanced'
  | 'sort'
  | 'saveQuery'
  | 'viewMode'
  | 'cardSize'
  | 'rescan'
  | 'stats'
  | 'history'
  | 'inspectorPin'
  | 'aiPanel'
  | 'settings'
  | 'shortcuts';

export interface ToolbarItemDef {
  key: ToolbarItemKey;
  /**
   * ≫ メニューでの見出し。バーではアイコンの title にも使う。
   * トグル項目(サイドバー・詳細ペイン)は状態で文言が変わるので、
   * コンポーネント側で上書きする
   */
  label: string;
  /** バーに置いたときの実寸(px)。App.css の明示幅と対で持つ */
  width: number;
  /**
   * 小さいほど先に畳む。**0 は「畳まない」**。
   * 畳まないのは、狭い窓でも必ず押せる必要がある 3 つだけ:
   * - search   … 主機能。これが無いツールバーは意味がない
   * - advanced … ポップオーバーを持つので ≫ の中に入れると入れ子になって壊れる
   * - sidebarToggle … 中央の幅を取り戻す逃げ道そのもの
   */
  priority: number;
}

/** アイコンだけのボタンの幅。App.css の .tb-icon と対 */
const ICON_W = 32;

/** .toolbar の gap / 左右 padding(8px 12px)。App.css と対 */
export const TOOLBAR_GAP = 8;
export const TOOLBAR_PADDING = 24;

/** ≫ ボタンの幅。アイコンボタンと同じ */
export const OVERFLOW_W = ICON_W;

export const TOOLBAR_ITEMS: Record<ToolbarItemKey, ToolbarItemDef> = {
  sidebarToggle: { key: 'sidebarToggle', label: 'サイドバー', width: ICON_W, priority: 0 },
  /*
   * 判定に使う幅と、CSS の min-width: 120px はわざと別の数字。
   * 120 は「これ以上は潰さない」ハードな床で、180 は「ここを切りそうになったら
   * 畳み始める」しきい値。畳んで余ったぶんは max-width: 420px まで伸び直す
   */
  search: { key: 'search', label: '検索', width: 180, priority: 0 },
  advanced: { key: 'advanced', label: '絞り込み', width: ICON_W, priority: 0 },
  // 並び順で「ランダム」を選ぶたびにシャッフルし直すので、専用ボタンは持たない(v1.20)
  sort: { key: 'sort', label: '並び順', width: 172, priority: 13 },
  saveQuery: { key: 'saveQuery', label: '条件を保存', width: ICON_W, priority: 1 },
  viewMode: { key: 'viewMode', label: '表示の切り替え', width: ICON_W, priority: 12 },
  cardSize: { key: 'cardSize', label: 'サムネイルの大きさ', width: 110, priority: 11 },
  rescan: { key: 'rescan', label: '再スキャン', width: ICON_W, priority: 5 },
  stats: { key: 'stats', label: '統計', width: ICON_W, priority: 3 },
  // v1.18 で視聴履歴のタブが入ったので「操作履歴」ではなくなった
  history: { key: 'history', label: '履歴', width: ICON_W, priority: 2 },
  inspectorPin: { key: 'inspectorPin', label: '詳細ペイン', width: ICON_W, priority: 10 },
  aiPanel: { key: 'aiPanel', label: 'AI アシスタント', width: ICON_W, priority: 9 },
  settings: { key: 'settings', label: '設定', width: ICON_W, priority: 6 },
  // v1.39。一度覚えれば ? で開けるので、バーの取り合いでは早めに畳んでよい
  shortcuts: { key: 'shortcuts', label: 'キー操作', width: ICON_W, priority: 4 },
};

/**
 * 左から右への表示順。**畳んでも並びは変えない**(押す位置が窓幅で動かないように)。
 * ≫ メニューの中もこの順に並べる
 */
export const TOOLBAR_ORDER: ToolbarItemKey[] = [
  'sidebarToggle',
  'search',
  'advanced',
  'sort',
  'saveQuery',
  'viewMode',
  'cardSize',
  'rescan',
  'stats',
  'history',
  'inspectorPin',
  'aiPanel',
  'settings',
  // ヘルプは慣習どおり右端(v1.39)
  'shortcuts',
];

/** サムネイルの大きさはグリッド表示のときしか意味がないので、リストでは項目ごと消す */
export function toolbarKeys(viewMode: ViewMode): ToolbarItemKey[] {
  return TOOLBAR_ORDER.filter((k) => k !== 'cardSize' || viewMode === 'grid');
}

export interface ToolbarSplit {
  /** バーにそのまま出す項目 */
  bar: ToolbarItemKey[];
  /** ≫ メニューに畳む項目。空なら ≫ ボタン自体を出さない */
  menu: ToolbarItemKey[];
}

/** 並べたときの総幅(左右 padding 込み)。overflow > 0 なら ≫ ボタンのぶんも数える */
function rowWidth(keys: ToolbarItemKey[], overflow: number): number {
  const count = keys.length + (overflow > 0 ? 1 : 0);
  if (count === 0) return TOOLBAR_PADDING;
  const sum = keys.reduce((acc, k) => acc + TOOLBAR_ITEMS[k].width, 0) + overflow;
  return sum + TOOLBAR_GAP * (count - 1) + TOOLBAR_PADDING;
}

/**
 * バーに残す項目と ≫ に畳む項目に分ける。
 *
 * `containerWidth` は `.toolbar` の clientWidth(**左右の padding を含む**)。
 * `null` は「まだ測れていない」= 全部出す —— 畳まれた姿から広がるより、
 * 全部出た姿から畳まれるほうが目に付きにくいため。
 *
 * 畳む順は priority の昇順で固定なので、幅が広いほど `bar` は必ず広義単調に増える。
 * 窓を狭くして戻したときに項目が入れ替わったり戻らなかったりしない
 */
export function splitToolbar(
  keys: ToolbarItemKey[],
  containerWidth: number | null,
): ToolbarSplit {
  if (containerWidth === null || rowWidth(keys, 0) <= containerWidth) {
    return { bar: keys, menu: [] };
  }

  const foldable = keys
    .filter((k) => TOOLBAR_ITEMS[k].priority > 0)
    .sort((a, b) => TOOLBAR_ITEMS[a].priority - TOOLBAR_ITEMS[b].priority);

  const folded = new Set<ToolbarItemKey>();
  for (const key of foldable) {
    folded.add(key);
    // 1 つでも畳むと決まった時点で ≫ ボタンの場所が要る。その幅も含めて判定する
    if (rowWidth(keys.filter((k) => !folded.has(k)), OVERFLOW_W) <= containerWidth) break;
  }

  return {
    bar: keys.filter((k) => !folded.has(k)),
    menu: keys.filter((k) => folded.has(k)),
  };
}
