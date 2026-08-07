import {
  AppWindow, ArrowDown, ArrowDownUp, ArrowUp, BookmarkPlus, Camera, ChevronDown, Copy, CopyMinus,
  CopyPlus, ExternalLink, EyeOff, Folder, FolderInput, FolderOpen, FolderPlus, FolderSearch,
  FolderUp, Funnel, FunnelPlus, FunnelX, GalleryThumbnails, Layers, LayoutGrid, Library,
  ListOrdered, ListVideo, ListX, Palette, Pencil, Play, Plus, RefreshCw, SquareCheck, SquareDashed,
  Star, Trash2, Unplug, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  FolderNode, LibraryEntry, Playlist, Series, SmartFolder, Tag, TagGroup, VideoRow, ViewMode,
  WatchedFolder,
} from '../types';
import { hasActiveFilter } from './filterChips';
import { sortLabel, sortOptions } from './listColumns';
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
 * 再生キューのサブメニュー(v1.40)。3 つはそれぞれ別の場面を埋める:
 *
 * - **末尾に追加** が基本形
 * - **次に再生** は再生中の直後に挟む(一覧側からしか挟めない)。
 *   キューで再生していないときは末尾に足すのと同じになる(lib/queue.ts の addToQueue)
 * - **キューを置き換えて再生** は、選んだものだけで再生を始める唯一の入口。
 *   ダブルクリックはクエリ方式の連続再生のままなので、これが無いと
 *   「選択した数本だけを流す」ができない
 */
export function queueSubmenu(count: number): MenuItem[] {
  const n = count > 1 ? `${count} 件を` : '';
  return [
    { id: 'queue:add', label: `${n}キューに追加`, icon: Plus, hint: 'キューの末尾に足します' },
    {
      id: 'queue:next',
      label: `${n}次に再生`,
      icon: ListVideo,
      hint: 'いま再生している動画の次に挟みます',
    },
    // サブメニューは区切り線を持てない(MenuItem[] なので)。3 項目なので要らない
    {
      id: 'queue:replace',
      label: `${n}キューを置き換えて再生`,
      icon: Play,
      hint: '今のキューを捨てて、選んだ動画だけで再生を始めます',
    },
  ];
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
    /*
     * 再生キュー(v1.40)。**サブメニューに畳んである** —— 動画メニューはちょうど
     * 12 項目で目安の上限なので、トップレベルはこの 1 つに収める。
     *
     * 「キューは常に 1 本」にしたので、**どのキューに入れるかを選ぶ入力が要らない**。
     * だからこの基準(候補一覧から選ぶ入力が要るものは載せない)の内側に入る。
     * 逆に「保存リストに追加」は**載せない** —— どのリストかを選ぶ必要があり、
     * シリーズ登録・タグ付けとまったく同じ理由で詳細ペイン側の担当になる
     */
    {
      id: 'queue',
      label: 'キュー',
      icon: ListVideo,
      submenu: queueSubmenu(selection.length),
    },
    { separator: true },
    /*
     * OS 連携の 2 つ(v1.40 でサブメニューに畳んだ)。
     *
     * v1.39 まで動画メニューはちょうど 12 項目で目安の上限にあり、キューを足すと
     * 13 になる。**新項目をサブメニューにしても、その入口 1 つぶんは増える** ——
     * 「サブメニューに畳むか既存項目を見直す」の後半を使い、
     * 「どのアプリで開くか」という同じ問いの 2 つをここにまとめて 1 枠に戻した。
     * `reveal`(エクスプローラーで表示)は入れない —— あちらは動画を再生するのではなく
     * 場所を見せる操作で、問いが違う
     */
    {
      id: 'openWithApp',
      label: '他のアプリで開く',
      icon: ExternalLink,
      disabled: !single || !usable(target),
      hint: singleHint,
      submenu: [
        { id: 'openDefault', label: '既定のアプリ', icon: ExternalLink },
        { id: 'openWith', label: 'プログラムを選ぶ...', icon: AppWindow },
      ],
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

/**
 * サイドバーの保存プレイリスト行(v1.40)。
 *
 * **中身の編集はここに置かない** —— 編集経路は「キューに読み込む → 直す → 上書き保存」の
 * 1 本だけにしてある。棚側にも直接編集を足すと書き込み経路が 2 本になり、
 * 「削除は即反映、追加は上書き保存が必要」という説明しづらい非対称が生まれる
 * (詳細ペインからファイル操作を外したときと同じ判断)
 */
export function buildPlaylistMenu(
  playlist: Playlist,
  isActive: boolean,
  index: number,
  total: number,
  filtering: boolean,
): MenuEntry[] {
  const empty = playlist.videoCount === 0;
  // スマートフォルダと同じ理由で、絞り込み中は並べ替えを無効にする
  const filterHint = filtering ? '絞り込み中は並べ替えられません' : undefined;
  return [
    {
      id: 'pl:load',
      label: 'キューに読み込んで再生',
      icon: ListVideo,
      disabled: empty,
      hint: empty ? '空のプレイリストです' : '今のキューを置き換えます',
    },
    {
      id: 'pl:filter',
      label: isActive ? '絞り込みを解除' : 'このリストで絞り込む',
      icon: Funnel,
      checked: isActive,
      hint: '一覧に保存した並び順で出します',
    },
    { separator: true },
    { id: 'pl:rename', label: '名前を変更...', icon: Pencil },
    {
      id: 'pl:duplicate',
      label: '複製',
      icon: CopyPlus,
      hint: `「${playlist.name} のコピー」を作ります`,
    },
    {
      id: 'pl:moveUp',
      label: '上へ移動',
      icon: ArrowUp,
      disabled: filtering || index <= 0,
      hint: filterHint ?? whyCantMove(index, total, -1),
    },
    {
      id: 'pl:moveDown',
      label: '下へ移動',
      icon: ArrowDown,
      disabled: filtering || index >= total - 1,
      hint: filterHint ?? whyCantMove(index, total, 1),
    },
    { separator: true },
    {
      id: 'pl:delete',
      label: '削除',
      icon: Trash2,
      danger: true,
      hint: 'リストだけを消します(動画は消えません)',
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
    { separator: true },
    {
      // 実行前に必ず下見(件数と内訳)を出すので、ここでは確認を挟まず開くだけ
      id: 'tree:dedupe',
      label: 'このフォルダーの重複を解消',
      icon: CopyMinus,
      hint: '同じ内容の動画を 1 本だけ残します(ファイルは消しません)',
    },
    {
      id: 'tree:exclude',
      label: '監視除外フォルダに登録',
      icon: EyeOff,
      hint: '次のスキャンから配下を無視します(ファイルは消しません)',
    },
  ];
}

/**
 * ライブラリの切り替え(v1.27)。サイドバー最上部のボタンから**左クリックで**開く。
 *
 * **「名前を変更」「一覧から外す」はここに置かない。** 破壊的に見える操作と
 * 候補一覧から選ぶ入力が要るものは管理画面(設定モーダル)の担当、という v1.14 の基準。
 * 逆に切り替えは設定モーダルに置かない —— 同じ操作の入口を 2 か所に作らない。
 *
 * **未接続のライブラリも押せるままにする。** 無効にすると「なぜ出ているのか」だけが
 * 残って何も起きないので、選んだときにドライブを繋ぐよう案内するほうが先に進める
 */
export function buildLibraryMenu(libraries: LibraryEntry[], currentId: string): MenuEntry[] {
  return [
    ...libraries.map((lib) => ({
      id: `lib:switch:${lib.id}`,
      label: lib.online ? lib.name : `${lib.name}(未接続)`,
      icon: lib.online ? Library : Unplug,
      checked: lib.id === currentId,
      hint: lib.online ? lib.root : `${lib.root} に接続できません`,
    })),
    { separator: true },
    { id: 'lib:create', label: 'ライブラリを新規作成...', icon: FolderPlus },
    { id: 'lib:add', label: '既存のライブラリを開く...', icon: FolderOpen },
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
  // 絞り込み帯(v1.28)と同じ判定を使う。「帯にチップが 1 つも無いのにここは押せる」
  // という食い違いが構造的に起きないようにするため
  const filtered = hasActiveFilter(f);

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
      disabled: !filtered,
      hint: filtered ? undefined : 'いま絞り込んでいる条件はありません',
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
    {
      // v1.26。バーにボタンはあるが 2.5 秒で消えるので、setThumb と同じ理由でここにも置く。
      // 実体のファイルを読む操作なので、オフライン・見失ったファイルでは無効にする
      id: 'player:saveFrame',
      label: 'このコマを画像として保存',
      icon: Camera,
      disabled: !usable(video),
      hint: hint ?? 'ショートカット: S',
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
