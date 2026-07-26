import {
  AppWindow, Copy, ExternalLink, FolderInput, FolderOpen, FolderSearch, ListX, Pencil, Play,
  RefreshCw, Star, Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { VideoRow } from '../types';

/**
 * 右クリックメニューの項目(v1.14)。
 * **どの項目をどんな状態で出すかはここだけで決める**。ContextMenu.tsx は
 * 受け取った配列を描画するだけにして、条件分岐をテストできる場所に閉じ込める。
 *
 * 使えない項目は消さずに disabled で残す(エクスプローラーと同じ)。
 * 選択件数やオフラインかどうかで項目の位置が動くと、
 * 「いつもの位置をクリックしたら別のものが実行された」が起きるため
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

function ratingSubmenu(selection: VideoRow[]): MenuItem[] {
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
