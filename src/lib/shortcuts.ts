/*
 * キー操作の一覧(v1.39)。
 *
 * **ここが一覧の唯一の出所**。キー処理そのものは各ハンドラの switch が持ったままで、
 * この表は「何が割り当てられているか」だけを持つ(リバインドは作らないと決めた。
 * 理由は DESIGN.md「キー操作の一覧」節)。
 *
 * 表とハンドラが二重管理になるのは承知のうえで、**ずれは shortcuts.test.ts が見張る** ——
 * usePlayerShortcuts.ts と VideoGrid.tsx のソースから `case '…':` を抜き出して、
 * ここに載っているかを突き合わせている。キーを足して一覧に書き忘れたらテストが落ちる。
 * だから `keys` には表示用の文字列ではなく **生の `e.key` の値**を入れること。
 */

export type ShortcutMod = 'Ctrl' | 'Shift';

export interface ShortcutDef {
  /** 修飾キー。表示にも使う */
  mods?: ShortcutMod[];
  /**
   * 実際の `e.key` の値。**英字は小文字だけを持つ** —— ハンドラは `case 'k': case 'K':` と
   * 2 つ並べているが、一覧では 1 つに畳む(テスト側が大文字を小文字に寄せて突き合わせる)。
   * 複数入っているものは「どれを押しても同じ」の意味(Space と K など)
   */
  keys: string[];
  /**
   * `e.key` を持たない項目の表記(マウスと組み合わせる操作)。
   * **`keys` が空のときだけ使う**。ソースとの突き合わせからも外れる
   */
  display?: string;
  label: string;
  /** 「mpv のみ」「先頭 1000 件まで」などの補足 */
  note?: string;
}

export type ShortcutGroupKey = 'grid' | 'player' | 'menu' | 'input' | 'mouse' | 'common';

export interface ShortcutGroup {
  key: ShortcutGroupKey;
  title: string;
  /** この系統がいつ効くか。見出しの直下に出す */
  when: string;
  items: ShortcutDef[];
}

/**
 * 表示用のキー名。矢印は記号にする(`←` のほうが一覧では圧倒的に読みやすい)。
 * ここに無いものはそのまま出す(`Home` / `PageUp` / `<` など)
 */
const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
};

export function keyLabel(key: string): string {
  // 英字 1 文字は大文字で見せる(表では小文字で持っている)
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return KEY_LABELS[key] ?? key;
}

/**
 * 1 項目を `<kbd>` に流し込む単位に分ける。
 * `{ mods: ['Ctrl'], keys: ['ArrowLeft', 'ArrowRight'] }` → `['Ctrl', '←', '→']`
 */
export function chordLabel(def: ShortcutDef): string[] {
  // 修飾キーは keys が空でも前に付ける(Ctrl+クリック / Shift+クリック)
  const tail = def.keys.length > 0 ? def.keys.map(keyLabel) : def.display ? [def.display] : [];
  return [...(def.mods ?? []), ...tail];
}

/**
 * 文字を打っている最中か。
 *
 * VideoGrid.tsx と usePlayerShortcuts.ts に同じ判定がベタ書きで 2 つあったものを
 * 関数にした(`?` のハンドラで 3 つめの複製を作らないため)。判定内容は変えていない ——
 * `contentEditable` を見ていないのも従来どおりで、アプリ内に該当する要素が無いから
 */
export function isTypingTarget(e: Event): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    key: 'grid',
    title: '一覧',
    when: 'サムネイル表示・詳細リスト表示のとき',
    items: [
      { keys: ['ArrowLeft', 'ArrowRight'], label: '前後の動画へ' },
      { keys: ['ArrowUp', 'ArrowDown'], label: '1 行ぶん上下へ' },
      { mods: ['Shift'], keys: ['ArrowLeft'], label: '選んだまま移動して範囲を広げる', note: '矢印・Home・End のどれでも' },
      { keys: ['Home', 'End'], label: '先頭 / 末尾へ' },
      { keys: ['Enter'], label: '再生する' },
      { mods: ['Ctrl'], keys: ['a'], label: 'すべて選択', note: '先頭 1000 件まで' },
      { keys: ['q'], label: '選択を再生キューに追加', note: '右クリックの「キュー」からは「次に再生」も選べます' },
      { keys: ['Delete'], label: '削除する', note: 'ライブラリからか、ごみ箱かをダイアログで選びます' },
      { keys: ['Escape'], label: '選択を解除' },
    ],
  },
  {
    key: 'player',
    title: '再生中',
    when: 'アプリ内プレイヤーで再生しているとき',
    items: [
      { keys: [' ', 'k'], label: '再生 ⇄ 一時停止' },
      { keys: ['ArrowLeft', 'ArrowRight'], label: '10 秒 戻す / 進める' },
      { mods: ['Ctrl'], keys: ['ArrowLeft', 'ArrowRight'], label: '前 / 次のチャプターへ', note: 'mpv で再生しているときだけ' },
      { keys: ['PageUp', 'PageDown'], label: '前 / 次のチャプターへ', note: 'mpv で再生しているときだけ' },
      { keys: ['ArrowUp', 'ArrowDown'], label: '音量 ±10%' },
      { keys: ['m'], label: 'ミュート ⇄ 解除' },
      { keys: ['f'], label: 'フルスクリーン ⇄ 解除' },
      { keys: ['<', '>'], label: '再生速度を 下げる / 上げる' },
      { keys: ['n', 'p'], label: '次 / 前の動画へ', note: '連続再生・再生キューで開いたときだけ' },
      { keys: ['q'], label: '再生キューを開く / 閉じる', note: '再生中でも並べ替え・削除ができます' },
      { keys: ['t'], label: 'この位置をサムネイルにする' },
      { keys: ['s'], label: 'このコマを画像として保存' },
      { keys: ['u'], label: '表示サイズ 等倍 ⇄ フィット', note: 'mpv で再生しているときだけ' },
      { keys: ['a'], label: '連続再生の切り替え' },
      { keys: ['r'], label: 'リピート再生の切り替え' },
      { keys: ['Escape'], label: '閉じる', note: 'フルスクリーン中は解除だけ' },
    ],
  },
  {
    key: 'menu',
    title: '右クリックメニュー',
    when: 'メニューが開いている間(裏の一覧・再生の操作は止まります)',
    items: [
      { keys: ['ArrowUp', 'ArrowDown'], label: '項目を選ぶ' },
      { keys: ['ArrowRight'], label: 'サブメニューを開く' },
      { keys: ['ArrowLeft'], label: 'サブメニューを閉じる' },
      { keys: ['Enter', ' '], label: '選んだ項目を実行' },
      { keys: ['Escape'], label: '閉じる', note: 'サブメニューが開いていれば、それだけ閉じます' },
    ],
  },
  {
    key: 'input',
    title: '入力中',
    when: 'タイトル・メモ・タグ・シリーズ・AI アシスタントの入力欄',
    items: [
      { keys: ['Enter'], label: '確定する', note: 'AI アシスタントでは送信' },
      { mods: ['Shift'], keys: ['Enter'], label: 'AI アシスタントで改行' },
      { keys: ['Escape'], label: '編集を取り消す', note: 'タイトル・メモ・タグ名の変更' },
    ],
  },
  {
    key: 'mouse',
    title: 'マウスと組み合わせる',
    when: '一覧のカード・行をクリックするとき',
    items: [
      { keys: [], display: 'クリック', label: 'その 1 件だけを選ぶ' },
      { mods: ['Ctrl'], keys: [], display: 'クリック', label: '選択に足す / 外す' },
      { mods: ['Shift'], keys: [], display: 'クリック', label: '直前に選んだ位置からの範囲を選ぶ' },
    ],
  },
  {
    key: 'common',
    title: 'ウィンドウ共通',
    when: 'どこでも',
    items: [
      { keys: ['?'], label: 'このキー操作の一覧を開く / 閉じる' },
      { keys: ['Escape'], label: '開いているモーダル・メニューを閉じる' },
    ],
  },
];
