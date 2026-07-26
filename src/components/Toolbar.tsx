import { useEffect, useState } from 'react';
import { api } from '../api';
import { advancedCount, buildQuery } from '../lib/query';
import { CARD_WIDTH_MAX, CARD_WIDTH_MIN, useLibrary } from '../store';
import type { DurationBucket, SortKey } from '../types';
import { AdvancedSearch } from './AdvancedSearch';
import { HistoryModal } from './HistoryModal';
import { SettingsModal } from './SettingsModal';
import { StatsModal } from './StatsModal';

export function Toolbar() {
  const {
    text, setText, sort, setSort, scanning, seriesId,
    minRating, setMinRating, durationBucket, setDurationBucket,
    showAiPanel, toggleAiPanel, advanced, reshuffle, duplicatesOnly,
    setShowStats, bumpVersion, pushToast,
    viewMode, setViewMode, cardWidth, setCardWidth,
    inspectorPinned, setInspectorPinned,
  } = useLibrary();
  const [input, setInput] = useState(text);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // 入力から 300ms 落ち着いたら検索を反映
  useEffect(() => {
    const t = setTimeout(() => setText(input), 300);
    return () => clearTimeout(t);
  }, [input, setText]);

  // AI の apply_filter やスマートフォルダで text が外から変わったら入力欄も追従させる
  useEffect(() => {
    setInput((cur) => (cur === text ? cur : text));
  }, [text]);

  const advCount = advancedCount(advanced);

  const saveCurrentAsSmartFolder = async () => {
    const name = window.prompt('この検索条件に名前を付けて保存します');
    if (name === null) return;
    if (!name.trim()) {
      pushToast('名前を入力してください', 'info');
      return;
    }
    await api.createSmartFolder(name, buildQuery(useLibrary.getState()));
    bumpVersion();
  };

  return (
    <div className="toolbar">
      <input
        className="search"
        type="search"
        placeholder="ファイル名・タイトルで検索(空白区切りで AND)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="adv-anchor">
        <button
          title="詳細検索"
          className={advCount > 0 ? 'active' : ''}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          絞り込み{advCount > 0 ? ` (${advCount})` : ''}
        </button>
        {showAdvanced && <AdvancedSearch onClose={() => setShowAdvanced(false)} />}
      </div>
      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        <option value="added_desc">追加日時(新しい順)</option>
        <option value="added_asc">追加日時(古い順)</option>
        <option value="name_asc">名前(昇順)</option>
        <option value="name_desc">名前(降順)</option>
        <option value="size_desc">サイズ(大きい順)</option>
        <option value="duration_desc">長さ(長い順)</option>
        <option value="rating_desc">レーティング順</option>
        <option value="viewed_desc">最近見た順</option>
        <option value="random">ランダム</option>
        {seriesId !== null && <option value="series_asc">シリーズ順</option>}
        {duplicatesOnly && <option value="dup">重複をまとめる</option>}
      </select>
      <button title="並びをシャッフルする" onClick={reshuffle}>🔀</button>
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
      <button title="今の検索条件をスマートフォルダとして保存" onClick={saveCurrentAsSmartFolder}>
        条件を保存
      </button>
      <button
        title={viewMode === 'grid' ? '詳細リスト表示に切り替え' : 'サムネイル表示に切り替え'}
        onClick={() => {
          const next = viewMode === 'grid' ? 'list' : 'grid';
          setViewMode(next);
          void api.setSetting('view_mode', next);
        }}
      >
        {viewMode === 'grid' ? '☰' : '▦'}
      </button>
      {viewMode === 'grid' && (
        <input
          className="card-size"
          type="range"
          min={CARD_WIDTH_MIN}
          max={CARD_WIDTH_MAX}
          step={4}
          value={cardWidth}
          onChange={(e) => setCardWidth(Number(e.target.value))}
          // ドラッグ中に毎回書き込まない(離したときだけ保存する)
          onPointerUp={() => void api.setSetting('card_width', String(cardWidth))}
          title="サムネイルの大きさ"
        />
      )}
      <button onClick={() => api.rescanAll()} disabled={scanning}>
        再スキャン
      </button>
      <button title="統計" onClick={() => setShowStats(true)}>📊</button>
      <button title="操作履歴" onClick={() => setShowHistory(true)}>🕘</button>
      <button
        title={
          inspectorPinned
            ? '詳細ペインの固定を解除(選択中だけ表示に戻す)'
            : '詳細ペインを常に表示する'
        }
        className={inspectorPinned ? 'active' : ''}
        onClick={() => {
          const next = !inspectorPinned;
          setInspectorPinned(next);
          void api.setSetting('inspector_pinned', next ? '1' : '0');
        }}
      >
        📋
      </button>
      <button
        title="AI アシスタント"
        className={showAiPanel ? 'active' : ''}
        onClick={toggleAiPanel}
      >
        ✨
      </button>
      <button title="設定" onClick={() => setShowSettings(true)}>⚙</button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
      <StatsModal />
    </div>
  );
}
