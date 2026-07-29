/**
 * タグに付けられる色(v1.19)。自由入力より選ばせた方が一覧が散らからない。
 *
 * v1.20 で `lib/` に移した — サイドバーのインライン編集(TagTree.tsx)と
 * 右クリックメニューの「色 ▸」(lib/contextMenu.ts)の両方から使うため。
 * `lib/` からコンポーネントを import するのは依存の向きが逆になる
 */
export interface TagColor {
  /** DB に入る値。CSS の色としてそのまま使う */
  value: string;
  /** メニューに出す名前。色丸だけだと読み上げ・ホバーで何色か分からない */
  label: string;
}

export const TAG_PALETTE: TagColor[] = [
  { value: '#e05252', label: '赤' },
  { value: '#e08c3a', label: 'オレンジ' },
  { value: '#d9c04a', label: '黄' },
  { value: '#5aab5a', label: '緑' },
  { value: '#4a9ed9', label: '青' },
  { value: '#8f6fd0', label: '紫' },
  { value: '#c76fa8', label: 'ピンク' },
];
