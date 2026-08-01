import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { COLUMN_ORDER, COLUMNS, DEFAULT_COLUMNS } from '../lib/listColumns';
import type { ColumnKey } from '../lib/listColumns';
import { useLibrary } from '../store';

/**
 * 詳細リストの見た目を決めるポップオーバー(列は v1.16、1 行おきの濃淡は v1.25)。
 *
 * `.grid-scroll` の overflow に切られるので**スクロール領域の外**に fixed で描く
 * (右クリックメニューと同じ扱い)。
 *
 * 並べ替えはドラッグではなく ↑↓ ボタン。項目が十数個なら十分で、
 * ヘッダのクリック(並び替え)とドラッグ開始の見分けを書かずに済む。
 * サムネイルは先頭固定なので移動できない。
 *
 * **リスト表示の見た目に関する切替はここに集める**(設定モーダルには置かない)。
 * ここはリスト表示のときしか開けないので、設定が効く場所と操作する場所が一致する
 */
export function ColumnPicker({
  at, onClose,
}: {
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const columns = useLibrary((s) => s.listColumns);
  const setColumns = useLibrary((s) => s.setListColumns);
  const zebra = useLibrary((s) => s.listZebra);
  const setZebra = useLibrary((s) => s.setListZebra);
  const ref = useRef<HTMLDivElement>(null);

  // 外側のクリックと Esc で閉じる(右クリックメニューと同じ作法)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // 開いた直後のクリックで閉じないよう、次のフレームから拾う
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const apply = (next: ColumnKey[]) => {
    setColumns(next);
    void api.setSetting('list_columns', JSON.stringify(next));
  };

  /** apply() は「列を確定する」関数なので流用しない。保存の作法だけ合わせる */
  const applyZebra = (next: boolean) => {
    setZebra(next);
    void api.setSetting('list_zebra', next ? '1' : '0');
  };

  const toggle = (key: ColumnKey) => {
    if (columns.includes(key)) {
      apply(columns.filter((k) => k !== key));
      return;
    }
    // チェックを付けたら COLUMN_ORDER の位置に入れる(末尾に付けると毎回動かす手間が出る)
    const rank = (k: ColumnKey) => COLUMN_ORDER.indexOf(k);
    apply([...columns, key].sort((a, b) => rank(a) - rank(b)));
  };

  /** 表示中の列だけを対象に 1 つ動かす。サムネイルは先頭固定なので対象外 */
  const move = (key: ColumnKey, delta: -1 | 1) => {
    const movable: ColumnKey[] = columns.filter((k) => k !== 'thumb');
    const i = movable.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= movable.length) return;
    [movable[i], movable[j]] = [movable[j], movable[i]];
    apply(columns.includes('thumb') ? ['thumb', ...movable] : movable);
  };

  const movable: ColumnKey[] = columns.filter((k) => k !== 'thumb');

  return (
    <div
      ref={ref}
      className="col-popover"
      // 右端を押した位置に合わせる(画面外へはみ出さないよう左に寄せる)
      style={{ left: Math.max(8, at.x - 220), top: at.y }}
    >
      {COLUMN_ORDER.map((key) => {
        const shown = columns.includes(key);
        const i = movable.indexOf(key);
        return (
          <div key={key} className="col-item">
            <label>
              <input type="checkbox" checked={shown} onChange={() => toggle(key)} />
              <span className="name">{COLUMNS[key].label}</span>
            </label>
            {key !== 'thumb' && (
              <>
                <button
                  className="col-move"
                  title="上へ"
                  disabled={!shown || i <= 0}
                  onClick={() => move(key, -1)}
                >
                  <ChevronUp />
                </button>
                <button
                  className="col-move"
                  title="下へ"
                  disabled={!shown || i < 0 || i >= movable.length - 1}
                  onClick={() => move(key, 1)}
                >
                  <ChevronDown />
                </button>
              </>
            )}
          </div>
        );
      })}
      <div className="col-sep" />
      <div className="col-item">
        <label>
          <input type="checkbox" checked={zebra} onChange={() => applyZebra(!zebra)} />
          <span className="name">1 行おきに背景を濃くする</span>
        </label>
      </div>
      {/* ラベルは「列を既定に戻す」ではなくポップオーバー全体を指すので、縞も一緒に戻す */}
      <button
        className="col-reset"
        onClick={() => {
          apply(DEFAULT_COLUMNS);
          applyZebra(false);
        }}
      >
        既定に戻す
      </button>
    </div>
  );
}
