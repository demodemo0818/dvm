import {
  AppWindow, ArrowDown, ArrowDownUp, ArrowUp, BookmarkPlus, ChevronDown, Copy, ExternalLink,
  Folder, FolderInput, FolderOpen, FolderPlus, FolderSearch, FolderUp, Funnel, FunnelPlus, FunnelX,
  GalleryThumbnails, Layers, LayoutGrid, ListOrdered, ListX, Palette, Pencil, Play, Plus, RefreshCw,
  SquareCheck, SquareDashed, Star, Trash2, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  FolderNode, Series, SmartFolder, Tag, TagGroup, VideoRow, ViewMode, WatchedFolder,
} from '../types';
import { sortLabel, sortOptions } from './listColumns';
import { advancedCount } from './query';
import type { FilterState } from './query';
import { TAG_PALETTE } from './tagColors';

/**
 * 右クリックメニューの項目(v1.14。適用範囲の拡大は v1.20)。
 * **どの項目をどんな状態で出すかはここだけで決める**。ContextMenu.tsx は
 * 受け取った配列を描画するだけにして、条件分岐をテストできる場所に閉じ込める。
 *
 * 使えない項目は消さずに disabled で残す(エクスプローラーと同じ)。
 * 選択件数やオフラインかどうかで項目の位置が動くと、
 * 「いつもの位置をクリックしたら別のものが実行された」が起きるため。
 *
 * **id は対象ごとの接頭辞を持つ**(`tag:` `group:` `wf:` `sf:` `series:` `tree:`
 * `blank:` `player:`)。v1.14 からある動画メニューとサブフォルダカードだけは
 * 接頭辞なしのまま据え置く — 既に id 文字列で分岐しているので無用な差分を作らない
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** ホバーで出す補足。disabled のときは「なぜ押せないか」を入れる */
  hint?: string;
  /** 赤字で見せる(削除系) */
  danger?: boolean;
  /** 現在値としてチェック印を出す */
  checked?: boolean;
  /**
   * アイコンの代わりに描く色丸(v1.20。タグの色サブメニュー用)。
   * 「赤」「オレンジ」という名前だけでは色を選べないので、実物を見せる
   */
  swatch?: string;
  submenu?: MenuItem[];
}

/** 区切り線 */
export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

export const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e;

/** 実体のファイルに触れるか(オフラインドライブと見失ったファイルは触らない) */
const usable = (v: VideoRow) => !v.isMissing && !v.isOffline;

/** disabled にする理由を 1 つ返す。押せない項目をホバーしたときの説明に使う */
function whyUnusable(v: VideoRow): string {
  return v.isOffline ? 'ドライブが未接続です' : 'ファイルが見つかりません';
}

/** 選択全件のレーティングが揃っていればその値。バラバラなら null */
function commonRating(selection: VideoRow[]): number | null {
  const first = selection[0]?.rating ?? 0;
  return selection.every((v) => v.rating === first) ? first : null;
}

/** レーティングの ★5〜★1 +「評価なし」。プレイヤーのメニューとも共有する(v1.20) */
export function ratingSubmenu(selection: VideoRow[]): MenuItem[] {
  const current = commonRating(selection);
  const stars = [5, 4, 3, 2, 1].map((n) => ({
    id: `rating:${n}`,
    label: '★'.repeat(n) + '☆'.repeat(5 - n),
    checked: current === n,
  }));
  return [...stars, { id: 'rating:0', label: '評価なし', checked: current === 0 }];
}

/**
 * 動画カード / リスト行のメニュー。
 * `selection` が対象の全件、`target` は右クリックしたカードの動画。
 * 1 件しか意味を持たない項目(エクスプローラーで表示など)は target を見る
 */
export function buildVideoMenu(selection: VideoRow[], target: VideoRow): MenuEntry[] {
  const n = selection.length;
  const single = n === 1;
  /** 1 件でも実体を触れるものがあるか(複数件まとめて実行する操作の判定) */
  const anyUsable = selection.some(usable);
  const targetHint = usable(target) ? undefined : whyUnusable(target);
  // 複数選択中は単一件専用の項目を押せなくする。10 件選んだまま押して
  // アプリが 10 個立ち上がる、といった事故を防ぐ
  const singleHint = single ? targetHint : '1 件だけ選んでいるときに使えます';
  const someHint = anyUsable ? undefined : '実体を触れるファイルがありません';
  const count = single ? '' : `${n} 件を`;

  return [
    {
      id: 'play',
      label: '再生',
      icon: Play,
      disabled: !usable(target),
      hint: targetHint,
    },
    { separator: true },
    {
      id: 'rating',
      label: 'レーティング',
      icon: Star,
      submenu: ratingSubmenu(selection),
    },
    { separator: true },
    {
      id: 'openDefault',
      label: '既定のアプリで開く',
      icon: ExternalLink,
      disabled: !single || !usable(target),
      hint: singleHint,
    },
    {
      id: 'openWith',
      label: '他のプログラムから開く...',
      icon: AppWindow,
      disabled: !single || !usable(target),
      hint: singleHint,
    },
    {
      id: 'reveal',
      label: 'エクスプローラーで表示',
      icon: FolderSearch,
      disabled: !usable(target),
      // 複数選んでいても、右クリックした 1 件だけを見せる
      hint: targetHint ?? (single ? undefined : '右クリックした 1 件を表示します'),
    },
    { separator: true },
    {
      id: 'openFolder',
      label: 'このフォルダーを開く',
      icon: FolderOpen,
      // DB のパスから絞り込むだけなので、オフラインでも使える
      hint: single ? undefined : '右クリックした動画のフォルダーで絞り込みます',
    },
    {
      id: 'copyPath',
      label: single ? 'フルパスをコピー' : `${n} 件のフルパスをコピー`,
      icon: Copy,
    },
    { separator: true },
    {
      id: 'rename',
      label: '名前を変更...',
      icon: Pencil,
      disabled: !single || !usable(target),
      hint: singleHint,
    },
    {
      id: 'move',
      label: `${count}移動...`,
      icon: FolderInput,
      disabled: !anyUsable,
      hint: someHint,
    },
    {
      id: 'rethumb',
      label: 'サムネイルを作り直す',
      icon: RefreshCw,
      disabled: !anyUsable,
      hint: someHint,
    },
    { separator: true },
    {
      id: 'removeFromLibrary',
      label: `${count}ライブラリから削除`,
      icon: ListX,
      danger: true,
      // 見失ったファイルの後始末に使うので、オフラインでも押せる必要がある
      hint: 'ファイル自体は削除されません',
    },
    {
      id: 'trash',
      label: `${count}ごみ箱へ`,
      icon: Trash2,
      danger: true,
      disabled: !anyUsable,
      hint: someHint ?? 'ファイルをごみ箱へ送り、ライブラリからも削除します',
    },
  ];
}

/** 一覧の先頭に並ぶサブフォルダカードのメニュー(v1.14 は 3 項目だけ) */
export function buildFolderMenu(): MenuEntry[] {
  return [
    { id: 'folderOpen', label: '開く', icon: FolderOpen },
    { id: 'folderReveal', label: 'エクスプローラーで表示', icon: FolderSearch },
    { id: 'folderCopyPath', label: 'パスをコピー', icon: Copy },
  ];
}

// ============================================================================
// v1.20:適用範囲の拡大。サイドバー・グリッドの余白・プレイヤー
//
// 「12 項目を超えたらサブメニューに畳む」の目安は**対象ごとに数える**。
// 動画メニューが 12 で上限なのは動画メニューの話であって、他の対象の予算は食わない
// ============================================================================

/** 「上へ / 下へ」が押せない理由。押せるときは undefined */
function whyCantMove(index: number, total: number, dir: -1 | 1): string | undefined {
  if (dir === -1) return index <= 0 ? 'すでに先頭です' : undefined;
  return index >= total - 1 ? 'すでに末尾です' : undefined;
}

/** タグの色サブメニュー。7 色 + 色なし。現在の色にチェックを付ける */
function tagColorSubmenu(current: string | null): MenuItem[] {
  return [
    ...TAG_PALETTE.map((c) => ({
      id: `tag:color:${c.value}`,
      label: c.label,
      swatch: c.value,
      checked: current === c.value,
    })),
    { id: 'tag:color:none', label: '色なし', checked: current === null },
  ];
}

/** タグの所属グループを選ぶサブメニュー。未分類も 1 つの選択肢として並べる */
function tagGroupSubmenu(current: number | null, groups: TagGroup[]): MenuItem[] {
  return [
    { id: 'tag:group:none', label: '(未分類)', checked: current === null },
    ...groups.map((g) => ({
      id: `tag:group:${g.id}`,
      label: g.name,
      checked: current === g.id,
    })),
  ];
}

/**
 * サイドバーのタグ行(v1.20)。
 *
 * ここが受け持つのは**タグそのものの管理**(絞り込み・名前・色・グループ・削除)。
 * 動画へのタグ付与は詳細ペインのタグパレットの担当で、v1.19 の切り分けは変えていない。
 *
 * `activeTagIds` は store の tagIds をそのまま渡す(絞り込み中のタグ)
 */
export function buildTagMenu(tag: Tag, groups: TagGroup[], activeTagIds: number[]): MenuEntry[] {
  const active = activeTagIds.includes(tag.id);
  // 「これだけで絞り込む」が今の状態と同じ結果になるなら押させない
  const onlyThis = activeTagIds.length === 1 && active;
  const noOthers = activeTagIds.length === 0;

  return [
    {
      id: 'tag:filter',
      label: active ? '絞り込みから外す' : '絞り込みに追加',
      icon: Funnel,
      checked: active,
      hint: 'このタグが付いた動画に絞ります',
    },
    {
      id: 'tag:filterOnly',
      label: 'このタグだけで絞り込む',
      icon: FunnelPlus,
      disabled: onlyThis || noOthers,
      hint: onlyThis
        ? 'すでにこのタグだけで絞り込んでいます'
        : noOthers
          ? '他に絞り込み中のタグがありません'
          : '他のタグの絞り込みを外してこれだけにします',
    },
    { separator: true },
    { id: 'tag:rename', label: '名前を変更...', icon: Pencil },
    {
      id: 'tag:color',
      label: '色',
      icon: Palette,
      submenu: tagColorSubmenu(tag.color),
    },
    {
      id: 'tag:group',
      label: 'グループ',
      icon: Layers,
      disabled: groups.length === 0,
      hint: groups.length === 0 ? 'タググループがまだありません' : undefined,
      submenu: tagGroupSubmenu(tag.groupId, groups),
    },
    { separator: true },
    {
      id: 'tag:delete',
      label: 'タグを削除',
      icon: Trash2,
      danger: true,
      hint: `${tag.videoCount} 件の動画から外れます(動画自体は消えません)`,
    },
  ];
}

/**
 * サイドバーのタググループ見出し(v1.20)。**未分類は `group = null` で呼ぶ**。
 *
 * 未分類は DB 上の行ではないので、名前・並び順・削除がどれも意味を持たない。
 * 項目を消さずに disabled で残すのは動画メニューと同じ方針
 * (見出しごとに項目の位置が動くと押し間違える)
 */
export function buildTagGroupMenu(
  group: TagGroup | null,
  index: number,
  total: number,
  tagCount: number,
  allOn: boolean,
  collapsed: boolean,
): MenuEntry[] {
  const emptyHint = tagCount === 0 ? 'タグがまだありません' : undefined;
  // 未分類は常に最後に置いているので、並べ替えの対象にしない
  const ungroupedHint = group === null ? '未分類は並べ替えられません' : undefined;

  return [
    {
      id: 'group:filter',
      label: allOn ? 'このグループの絞り込みを解除' : 'このグループで絞り込む',
      icon: Funnel,
      checked: allOn,
      disabled: tagCount === 0,
      hint: emptyHint ?? 'この中のタグが付いた動画をまとめて表示します',
    },
    {
      id: 'group:toggle',
      label: collapsed ? 'タグを表示' : 'タグを隠す',
      icon: ChevronDown,
      disabled: tagCount === 0,
      hint: emptyHint,
    },
    { separator: true },
    {
      id: 'group:newTag',
      label: group ? 'このグループにタグを作成...' : 'グループに属さないタグを作成...',
      icon: Plus,
    },
    { id: 'group:newGroup', label: 'グループを作成...', icon: FolderPlus },
    { separator: true },
    {
      id: 'group:rename',
      label: '名前を変更...',
      icon: Pencil,
      disabled: group === null,
      hint: group === null ? '未分類は名前を変えられません' : undefined,
    },
    {
      id: 'group:moveUp',
      label: '上へ移動',
      icon: ArrowUp,
      disabled: group === null || index <= 0,
      hint: ungroupedHint ?? whyCantMove(index, total, -1),
    },
    {
      id: 'group:moveDown',
      label: '下へ移動',
      icon: ArrowDown,
      disabled: group === null || index >= total - 1,
      hint: ungroupedHint ?? whyCantMove(index, total, 1),
    },
    { separator: true },
    {
      id: 'group:delete',
      label: 'グループを削除',
      icon: Trash2,
      danger: true,
      disabled: group === null,
      hint: group === null
        ? '未分類は削除できません'
        : `${group.tagCount} 個のタグは未分類に移ります`,
    },
  ];
}

/**
 * サイドバーの監視フォルダ行(v1.20)。
 *
 * オフラインでも「表示」「パスをコピー」「監視対象から外す」は押せる —
 * どれも DB とパス文字列だけの操作で、ドライブに触らない。
 * ライブラリから削除をオフラインでも押せるようにしたのと同じ理由
 */
export function buildWatchedFolderMenu(folder: WatchedFolder, isActive: boolean): MenuEntry[] {
  const offlineHint = folder.online ? undefined : 'ドライブが未接続です';
  return [
    {
      id: 'wf:open',
      label: 'このフォルダー配下を表示',
      icon: FolderOpen,
      checked: isActive,
      hint: 'サブフォルダーも含めてまとめて表示します',
    },
    {
      id: 'wf:openDirect',
      label: 'このフォルダー直下だけを表示',
      icon: Folder,
      hint: 'サブフォルダーを含めず直下だけに絞ります',
    },
    { separator: true },
    {
      id: 'wf:reveal',
      label: 'エクスプローラーで表示',
      icon: FolderSearch,
      disabled: !folder.online,
      hint: offlineHint,
    },
    { id: 'wf:copyPath', label: 'パスをコピー', icon: Copy },
    { separator: true },
    {
      id: 'wf:remove',
      label: '監視対象から外す',
      icon: ListX,
      danger: true,
      hint: 'フォルダー自体は削除されません',
    },
  ];
}

/**
 * サイドバーのスマートフォルダ行(v1.20)。
 *
 * 並べ替えはサイドバーを絞り込んでいる間は使えない — 見えている行の index で
 * 動かすと、隠れている行を飛び越して並びが壊れるため。
 * 呼ぶ側は**絞り込む前の配列**の index / total を渡すこと
 */
export function buildSmartFolderMenu(
  sf: SmartFolder,
  index: number,
  total: number,
  filtering: boolean,
): MenuEntry[] {
  const filterHint = filtering ? '絞り込み中は並べ替えられません' : undefined;
  return [
    {
      id: 'sf:open',
      label: 'この条件を開く',
      icon: FolderSearch,
      hint: '保存した検索条件を復元します',
    },
    { separator: true },
    { id: 'sf:rename', label: '名前を変更...', icon: Pencil },
    {
      id: 'sf:overwrite',
      label: '現在の検索条件で上書き',
      icon: BookmarkPlus,
      hint: `いまの絞り込みで「${sf.name}」を置き換えます`,
    },
    {
      id: 'sf:moveUp',
      label: '上へ移動',
      icon: ArrowUp,
      disabled: filtering || index <= 0,
      hint: filterHint ?? whyCantMove(index, total, -1),
    },
    {
      id: 'sf:moveDown',
      label: '下へ移動',
      icon: ArrowDown,
      disabled: filtering || index >= total - 1,
      hint: filterHint ?? whyCantMove(index, total, 1),
    },
    { separator: true },
    {
      id: 'sf:delete',
      label: '削除',
      icon: Trash2,
      danger: true,
      hint: '保存した条件だけを消します(動画は消えません)',
    },
  ];
}

/** サイドバーのシリーズ行(v1.20) */
export function buildSeriesMenu(series: Series, isActive: boolean): MenuEntry[] {
  return [
    {
      id: 'series:filter',
      label: isActive ? '絞り込みを解除' : 'このシリーズで絞り込む',
      icon: ListOrdered,
      checked: isActive,
      hint: 'シリーズ内は登録順で並べます',
    },
    { separator: true },
    { id: 'series:rename', label: '名前を変更...', icon: Pencil },
    { separator: true },
    {
      id: 'series:delete',
      label: 'シリーズを削除',
      icon: Trash2,
      danger: true,
      hint: `${series.videoCount} 件の動画から外れます(動画自体は消えません)`,
    },
  ];
}

/**
 * サイドバー「フォルダー」タブのツリー行(v1.20)。
 *
 * サブフォルダカードの `buildFolderMenu()` とは**別関数にする**。
 * ツリーはオフライン判定と開閉状態を持つので、無理に共有すると
 * 両方に相手の都合の引数が生える
 */
export function buildFolderTreeMenu(
  node: FolderNode,
  hasChildren: boolean,
  isExpanded: boolean,
  isActive: boolean,
): MenuEntry[] {
  const watched = node.watchedFolderId !== null;
  return [
    {
      id: 'tree:open',
      label: 'このフォルダー直下を表示',
      icon: FolderOpen,
      checked: isActive,
      hint: 'もう一度選ぶと解除します',
    },
    {
      id: 'tree:expand',
      label: isExpanded ? 'サブフォルダーを隠す' : 'サブフォルダーを表示',
      icon: ChevronDown,
      disabled: !hasChildren,
      hint: hasChildren ? undefined : 'サブフォルダーはありません',
    },
    { separator: true },
    {
      id: 'tree:reveal',
      label: 'エクスプローラーで表示',
      icon: FolderSearch,
      disabled: !node.online,
      hint: node.online ? undefined : 'ドライブが未接続です',
    },
    { id: 'tree:copyPath', label: 'パスをコピー', icon: Copy },
    { separator: true },
    {
      id: 'tree:watch',
      label: '監視フォルダに追加',
      icon: FolderPlus,
      disabled: watched,
      // 「外す」は監視フォルダ行の担当。入口を 2 か所に置かない
      hint: watched ? 'すでに監視フォルダです' : '起動時のスキャンと自動監視の対象になります',
    },
  ];
}

/** グリッド余白のメニューが見る状態。絞り込みは buildQuery と同じ FilterState をそのまま渡す */
export interface GridBlankState {
  /** いま一覧に出ている件数 */
  total: number;
  selectionCount: number;
  viewMode: ViewMode;
  /** 「上のフォルダ」。フォルダーで絞っていないか、監視フォルダの外に出るときは null */
  parentPath: string | null;
  filters: FilterState;
}

/** 効いている絞り込みの数。0 なら「絞り込みをすべて解除」は押せない */
function activeFilterCount(f: FilterState): number {
  return (
    (f.text.trim() !== '' ? 1 : 0) +
    (f.tagIds.length > 0 ? 1 : 0) +
    (f.seriesId !== null ? 1 : 0) +
    (f.folderId !== null ? 1 : 0) +
    (f.dirPath !== null ? 1 : 0) +
    (f.minRating > 0 ? 1 : 0) +
    (f.durationBucket !== null ? 1 : 0) +
    (f.missingOnly ? 1 : 0) +
    (f.duplicatesOnly ? 1 : 0) +
    advancedCount(f.advanced)
  );
}

/**
 * グリッドの余白(v1.20)。
 *
 * v1.14 では「余白は選択解除だけでメニューは出さない」としていたが、
 * エクスプローラーの余白メニュー(表示 ▸ / 並べ替え ▸ / 最新の情報に更新)が
 * まさにこの内容で、ユーザーの手が覚えている。それに合わせる。
 *
 * 「再スキャン」「フォルダを追加」はアプリ全体の処理なので載せない
 * (ツールバー / サイドバーの担当)
 */
export function buildGridBlankMenu(s: GridBlankState): MenuEntry[] {
  const f = s.filters;
  const noFolder = f.dirPath === null ? 'フォルダーで絞り込んでいるときに使えます' : undefined;
  const filterCount = activeFilterCount(f);

  return [
    {
      id: 'blank:selectAll',
      label: 'すべて選択',
      icon: SquareCheck,
      disabled: s.total === 0,
      hint: s.total === 0 ? '表示中の動画がありません' : undefined,
    },
    {
      id: 'blank:clearSelection',
      label: '選択を解除',
      icon: SquareDashed,
      disabled: s.selectionCount === 0,
      hint: s.selectionCount === 0 ? '選択中の動画がありません' : undefined,
    },
    { separator: true },
    {
      id: 'blank:view',
      label: '表示',
      icon: LayoutGrid,
      submenu: [
        { id: 'blank:view:grid', label: 'サムネイル', checked: s.viewMode === 'grid' },
        { id: 'blank:view:list', label: '詳細リスト', checked: s.viewMode === 'list' },
      ],
    },
    {
      id: 'blank:sort',
      label: '並べ替え',
      icon: ArrowDownUp,
      // ツールバーの select と同じ選択肢を使う(片方だけ増えるのを防ぐ)
      submenu: sortOptions(f).map((k) => ({
        id: `blank:sort:${k}`,
        label: sortLabel(k),
        checked: f.sort === k,
      })),
    },
    { separator: true },
    {
      id: 'blank:up',
      label: '上のフォルダーへ',
      icon: FolderUp,
      disabled: s.parentPath === null,
      hint: s.parentPath === null
        ? (noFolder ?? 'これ以上、上のフォルダーはありません')
        : undefined,
    },
    {
      id: 'blank:reveal',
      label: 'このフォルダーをエクスプローラーで表示',
      icon: FolderSearch,
      disabled: f.dirPath === null,
      hint: noFolder,
    },
    { separator: true },
    {
      id: 'blank:clearFilters',
      label: '絞り込みをすべて解除',
      icon: FunnelX,
      disabled: filterCount === 0,
      hint: filterCount === 0 ? 'いま絞り込んでいる条件はありません' : undefined,
    },
    { id: 'blank:refresh', label: '再読み込み', icon: RefreshCw },
  ];
}

/**
 * プレイヤー画面(v1.20)。
 *
 * **再生・音量・速度・全画面・連続再生・リピートは載せない** —
 * 同じバーにボタンがあり、キーもある。「対象そのものへの操作」という基準では
 * 再生の制御は「対象(ファイル)」ではなく「今の再生状態」に属する。
 *
 * 例外はサムネイル位置。ボタンはあるが 2.5 秒で消える帯の中にあり、
 * 操作の対象も再生状態ではなく動画レコード(set_thumb_time)なので基準の内側にある
 */
export function buildPlayerMenu(video: VideoRow): MenuEntry[] {
  const hint = usable(video) ? undefined : whyUnusable(video);
  return [
    { id: 'player:rating', label: 'レーティング', icon: Star, submenu: ratingSubmenu([video]) },
    { separator: true },
    {
      id: 'player:setThumb',
      label: 'この位置をサムネイルにする',
      icon: GalleryThumbnails,
      hint: 'ショートカット: T',
    },
    { separator: true },
    {
      id: 'player:reveal',
      label: 'エクスプローラーで表示',
      icon: FolderSearch,
      disabled: !usable(video),
      hint,
    },
    { id: 'player:copyPath', label: 'フルパスをコピー', icon: Copy },
    { separator: true },
    { id: 'player:close', label: '閉じる', icon: X, hint: 'ショートカット: Esc' },
  ];
}
