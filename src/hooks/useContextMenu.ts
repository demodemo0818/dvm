import { useCallback, useState } from 'react';
import type { MenuEntry } from '../lib/contextMenu';

/**
 * 右クリックメニューの開閉状態(v1.20)。
 * `T` には「何に対するメニューか」を入れる — 対象が複数種類ある画面では
 * 判別可能ユニオン(`{ kind: 'video'; ... } | { kind: 'folder'; ... }`)を渡す
 */
export interface ContextMenuState<T> {
  x: number;
  y: number;
  entries: MenuEntry[];
  target: T;
}

/**
 * 右クリックメニューを開くためのフック(v1.20)。
 *
 * 項目の中身は `lib/contextMenu.ts` の純関数が決め、実行は呼び出し側が持つ。
 * ここが受け持つのは「どこに、何を出しているか」だけ。
 *
 * **JSX は返さない**。`<ContextMenu>` は各ホストが自分で描く。
 * 7 行の重複より、描く場所が見えていることを優先する — プレイヤーでは
 * オーバーレイの**内側**に描かないと全画面のトップレイヤーに隠れて見えなくなる、
 * という致命的な例外があり、フックの中に隠すと気づけない(詳しくは App.css の .ctx-menu)
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<ContextMenuState<T> | null>(null);

  /**
   * 座標を直接指定して開く(v1.27)。
   * ボタンの真下に出したいとき(ライブラリ切り替えのようなドロップダウン)に使う —
   * クリック位置に出すと、押した場所によってメニューの位置が毎回ずれる
   */
  const openAt = useCallback((x: number, y: number, entries: MenuEntry[], target: T) => {
    setMenu({ x, y, entries, target });
  }, []);

  /** 右クリックのイベントからメニューを開く。WebView2 の既定メニューはここで止める */
  const open = useCallback(
    (e: React.MouseEvent, entries: MenuEntry[], target: T) => {
      e.preventDefault();
      openAt(e.clientX, e.clientY, entries, target);
    },
    [openAt],
  );

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, openAt, close };
}
