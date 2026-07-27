import { ChevronsRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** .tb-menu の幅(App.css と対)と、画面端に残す余白 */
const MENU_W = 260;
const EDGE = 8;

/**
 * ツールバーに入りきらなかった項目を入れる ≫ メニュー(v1.17)。
 *
 * 器だけを持ち、中身は呼び出し側が渡す。**メニューは画面基準(fixed)で描く** ——
 * ツールバーは overflow: hidden なので、中に absolute で置くと切られる
 * (列選択ポップオーバー・右クリックメニューと同じ扱い)。
 *
 * 開閉は呼び出し側が持つ。幅が変わるとバーとメニューの中身が入れ替わるので、
 * そのときに閉じる責任は呼び出し側にある
 */
export function ToolbarOverflow({
  open, onOpenChange, active, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 畳んだ中に効いている絞り込みがあるか。あればボタン自体を光らせる。
   * これが無いと「一覧の件数が少ない理由が分からない」事故が起きる
   */
  active: boolean;
  children: ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });

  // 開くたびにボタンの位置を測り直す(右端揃え)
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right - MENU_W, y: r.bottom + 6 });
  }, [open]);

  // 外側クリックと Esc で閉じる(列選択ポップオーバーと同じ作法)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // ボタン自身は click 側でトグルするので、ここでは触らない
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onOpenChange(false);
    };
    // 開いた直後の同じクリックで閉じないよう、次のフレームから拾う
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  // 画面の右端をはみ出すぶんは寄せる
  const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - MENU_W - EDGE));

  return (
    <>
      <button
        ref={btnRef}
        className={`tb-icon${active ? ' active' : ''}`}
        title="入りきらない操作"
        onClick={() => onOpenChange(!open)}
      >
        <ChevronsRight />
      </button>
      {open && (
        <div ref={menuRef} className="tb-menu" style={{ left, top: at.y }}>
          {children}
        </div>
      )}
    </>
  );
}
