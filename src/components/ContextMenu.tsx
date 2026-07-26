import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isSeparator } from '../lib/contextMenu';
import type { MenuEntry, MenuItem } from '../lib/contextMenu';
import { useLibrary } from '../store';

/** 画面端との余白(px)。メニューが端に貼り付いて見えないようにする */
const EDGE = 6;

/** 選べる項目か(区切り線と無効項目はキーボード移動で飛ばす) */
const selectable = (e: MenuEntry): e is MenuItem => !isSeparator(e) && !e.disabled;

/** from の次(step=+1)/前(step=-1)の選べる項目を探す。端で折り返す */
function nextIndex(entries: MenuEntry[], from: number | null, step: number): number | null {
  const n = entries.length;
  if (n === 0) return null;
  let i = from ?? (step > 0 ? -1 : 0);
  for (let tried = 0; tried < n; tried++) {
    i = (i + step + n) % n;
    if (selectable(entries[i])) return i;
  }
  return null;
}

/**
 * 右クリックメニュー(v1.14)。
 * 項目の中身と有効・無効は `lib/contextMenu.ts` の純関数が決め、ここは描画と操作だけを持つ。
 *
 * 位置は fixed。画面の右端・下端をはみ出すときは反対側へ折り返す。
 * 無効項目は button ではなく div で描く — disabled な button は
 * Chromium がホバーを拾わず、`title` の「なぜ押せないか」が出せないため
 */
export function ContextMenu({
  x, y, entries, onSelect, onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const setContextMenuOpen = useLibrary((s) => s.setContextMenuOpen);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [active, setActive] = useState<number | null>(null);
  /** サブメニューを開いている親項目の index */
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState<number | null>(null);
  const [subPos, setSubPos] = useState({ left: 0, top: 0, ready: false });

  // 開いている間はグリッドの矢印キーと App の Esc(選択解除)を止める
  useEffect(() => {
    setContextMenuOpen(true);
    return () => setContextMenuOpen(false);
  }, [setContextMenuOpen]);

  // 画面からはみ出すぶんを折り返す。ペイント前に決めるので位置がちらつかない
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - EDGE ? Math.max(EDGE, x - width) : x;
    const top = y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height) : y;
    setPos({ left, top, ready: true });
    el.focus();
  }, [x, y, entries]);

  // サブメニューは親項目の右に出す。右が詰まっていたら左へ回す
  useLayoutEffect(() => {
    const el = subRef.current;
    const parent = openSub != null ? itemRefs.current[openSub] : null;
    if (!el || !parent) {
      setSubPos((p) => (p.ready ? { ...p, ready: false } : p));
      return;
    }
    const p = parent.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const left = p.right + width > window.innerWidth - EDGE ? p.left - width : p.right;
    const top = Math.min(p.top, Math.max(EDGE, window.innerHeight - EDGE - height));
    setSubPos({ left, top, ready: true });
  }, [openSub]);

  // メニューの外を押したら閉じる。別のカードを右クリックしたときも
  // ここで一度閉じてから、グリッド側が新しい位置で開き直す
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || subRef.current?.contains(t)) return;
      onClose();
    };
    // ウィンドウの大きさが変われば位置の前提が崩れるので閉じる
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  /**
   * 項目を実行する。**閉じてから 1 拍おいて実行する** —
   * 「名前を変更」の window.prompt は同期でスレッドを止めるので、
   * すぐ呼ぶとメニューが画面に残ったままダイアログが出てしまう
   */
  const run = (item: MenuItem) => {
    if (item.disabled) return;
    onClose();
    window.setTimeout(() => onSelect(item.id), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // メニュー操作中のキーは一切外へ流さない(裏のグリッドが拾わないように)
    e.preventDefault();
    e.stopPropagation();

    const sub = openSub != null ? (entries[openSub] as MenuItem).submenu ?? [] : null;

    switch (e.key) {
      case 'Escape':
        if (sub) {
          setOpenSub(null);
          setSubActive(null);
        } else {
          onClose();
        }
        break;
      case 'ArrowDown':
        if (sub) setSubActive(nextIndex(sub, subActive, 1));
        else setActive(nextIndex(entries, active, 1));
        break;
      case 'ArrowUp':
        if (sub) setSubActive(nextIndex(sub, subActive, -1));
        else setActive(nextIndex(entries, active, -1));
        break;
      case 'ArrowRight': {
        if (sub) break;
        const item = active != null ? entries[active] : null;
        if (item && !isSeparator(item) && item.submenu) {
          setOpenSub(active);
          setSubActive(nextIndex(item.submenu, null, 1));
        }
        break;
      }
      case 'ArrowLeft':
        setOpenSub(null);
        setSubActive(null);
        break;
      case 'Enter':
      case ' ': {
        if (sub) {
          if (subActive != null) run(sub[subActive]);
          break;
        }
        const item = active != null ? entries[active] : null;
        if (!item || isSeparator(item)) break;
        if (item.submenu) {
          setOpenSub(active);
          setSubActive(nextIndex(item.submenu, null, 1));
        } else {
          run(item);
        }
        break;
      }
      default:
    }
  };

  const renderItem = (item: MenuItem, key: string, isActive: boolean, onHover: () => void,
    setRef?: (el: HTMLDivElement | null) => void) => (
    <div
      key={key}
      ref={setRef}
      role="menuitem"
      aria-disabled={item.disabled}
      className={`ctx-item${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}${
        isActive ? ' active' : ''
      }`}
      title={item.hint}
      onMouseEnter={onHover}
      onClick={() => run(item)}
    >
      <span className="ctx-icon">{item.icon ? <item.icon /> : null}</span>
      <span className="ctx-label">{item.label}</span>
      {item.checked && <Check className="ctx-mark" />}
      {item.submenu && <ChevronRight className="ctx-mark" />}
    </div>
  );

  const subEntries = openSub != null ? (entries[openSub] as MenuItem).submenu ?? [] : [];

  return (
    <>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        tabIndex={-1}
        // 位置が決まるまでは描かない(左上に一瞬出てから飛ぶのを防ぐ)
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry, i) =>
          isSeparator(entry) ? (
            <div key={`sep${i}`} className="ctx-sep" />
          ) : (
            renderItem(
              entry,
              entry.id,
              active === i,
              () => {
                setActive(entry.disabled ? null : i);
                // サブメニューを持たない項目に移ったら、開いていたものを畳む
                setOpenSub(entry.submenu ? i : null);
                setSubActive(null);
              },
              (el) => {
                itemRefs.current[i] = el;
              },
            )
          ),
        )}
      </div>

      {openSub != null && subEntries.length > 0 && (
        <div
          ref={subRef}
          className="ctx-menu ctx-submenu"
          role="menu"
          style={{
            left: subPos.left,
            top: subPos.top,
            visibility: subPos.ready ? 'visible' : 'hidden',
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {subEntries.map((item, i) =>
            renderItem(item, item.id, subActive === i, () => setSubActive(i)),
          )}
        </div>
      )}
    </>
  );
}
