import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { COLUMNS, layout, nextSort, sortDirOf } from '../lib/listColumns';
import type { ColumnKey } from '../lib/listColumns';
import { useLibrary } from '../store';
import { ColumnPicker } from './ColumnPicker';

/**
 * 詳細リストの列ヘッダ(v1.16)。
 *
 * `.grid-scroll` の**内側**に sticky で置く。外に出すとスクロールバーの幅ぶん
 * 列がずれる。仮想化アイテムとして入れないのは、先頭の folderRows を数える
 * 添字計算(VideoGrid)が崩れるため。
 *
 * ソートは store の `sort` を書き換えるだけ。グリッドと共有の 1 つしか持たない
 */
export function ListHeader({ columns }: { columns: ColumnKey[] }) {
  const sort = useLibrary((s) => s.sort);
  const setSort = useLibrary((s) => s.setSort);
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null);
  const { thumb, rest } = layout(columns);

  const openPicker = (e: React.MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPickerAt({ x: r.right, y: r.bottom + 4 });
  };

  return (
    <>
      <div className="list-head" onContextMenu={openPicker}>
        {thumb && <div />}
        <div />
        {rest.map((key) => {
          const col = COLUMNS[key];
          const dir = sortDirOf(col, sort);
          return (
            <button
              key={key}
              className={`${col.align === 'right' ? 'right' : ''} ${dir ? 'sorted' : ''}`}
              title={`${col.label}で並べ替え`}
              onClick={() => setSort(nextSort(col, sort))}
            >
              <span className="head-label">{col.label}</span>
              {dir === 'asc' && <ChevronUp className="sort-arrow" />}
              {dir === 'desc' && <ChevronDown className="sort-arrow" />}
            </button>
          );
        })}
        {/* 名前セルの右端に重ねる。列を 1 つ潰さずに済ませるため */}
        <button className="col-menu" title="表示する列を選ぶ" onClick={openPicker}>
          <SlidersHorizontal />
        </button>
      </div>
      {pickerAt && <ColumnPicker at={pickerAt} onClose={() => setPickerAt(null)} />}
    </>
  );
}
