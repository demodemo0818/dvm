import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { SortKey } from '../types';

export function Toolbar() {
  const { text, setText, sort, setSort, scanning } = useLibrary();
  const [input, setInput] = useState(text);

  // 入力から 300ms 落ち着いたら検索を反映
  useEffect(() => {
    const t = setTimeout(() => setText(input), 300);
    return () => clearTimeout(t);
  }, [input, setText]);

  return (
    <div className="toolbar">
      <input
        className="search"
        type="search"
        placeholder="ファイル名・タイトルで検索"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        <option value="added_desc">追加日時(新しい順)</option>
        <option value="added_asc">追加日時(古い順)</option>
        <option value="name_asc">名前(昇順)</option>
        <option value="name_desc">名前(降順)</option>
        <option value="size_desc">サイズ(大きい順)</option>
        <option value="duration_desc">長さ(長い順)</option>
      </select>
      <button onClick={() => api.rescanAll()} disabled={scanning}>
        再スキャン
      </button>
    </div>
  );
}
