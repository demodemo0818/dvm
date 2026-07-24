import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { DurationBucket, SortKey } from '../types';
import { SettingsModal } from './SettingsModal';

export function Toolbar() {
  const {
    text, setText, sort, setSort, scanning, seriesId,
    minRating, setMinRating, durationBucket, setDurationBucket,
  } = useLibrary();
  const [input, setInput] = useState(text);
  const [showSettings, setShowSettings] = useState(false);

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
        <option value="rating_desc">レーティング順</option>
        <option value="viewed_desc">最近見た順</option>
        {seriesId !== null && <option value="series_asc">シリーズ順</option>}
      </select>
      <select
        value={minRating}
        onChange={(e) => setMinRating(Number(e.target.value))}
        title="レーティングで絞り込み"
      >
        <option value={0}>★ 指定なし</option>
        <option value={1}>★1 以上</option>
        <option value={2}>★2 以上</option>
        <option value={3}>★3 以上</option>
        <option value={4}>★4 以上</option>
        <option value={5}>★5</option>
      </select>
      <select
        value={durationBucket ?? ''}
        onChange={(e) => setDurationBucket((e.target.value || null) as DurationBucket | null)}
        title="長さで絞り込み"
      >
        <option value="">長さ指定なし</option>
        <option value="lt5">5 分未満</option>
        <option value="5to20">5〜20 分</option>
        <option value="20to60">20〜60 分</option>
        <option value="gt60">60 分以上</option>
      </select>
      <button onClick={() => api.rescanAll()} disabled={scanning}>
        再スキャン
      </button>
      <button title="設定" onClick={() => setShowSettings(true)}>⚙</button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
