import {
  BookmarkPlus,
  ChartColumn,
  Funnel,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  RefreshCw,
  RotateCcwClock,
  Settings,
  Shuffle,
  Sparkles,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { CURATED_SORTS, sortLabel } from '../lib/listColumns';
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
    inspectorPinned, setInspectorPinned, sidebarCollapsed, setSidebarCollapsed,
  } = useLibrary();
  const [input, setInput] = useState(text);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const advBtnRef = useRef<HTMLButtonElement>(null);
  const [advAt, setAdvAt] = useState({ x: 0, y: 0 });

  // 開くたびにボタンの位置を測り直す。ポップオーバーは画面基準で描くため
  useLayoutEffect(() => {
    if (!showAdvanced) return;
    const r = advBtnRef.current?.getBoundingClientRect();
    if (r) setAdvAt({ x: r.left, y: r.bottom + 6 });
  }, [showAdvanced]);

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
  const cardWidthPct =
    ((cardWidth - CARD_WIDTH_MIN) / (CARD_WIDTH_MAX - CARD_WIDTH_MIN)) * 100;

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
      {/*
        サイドバーを畳むと幅を変える帯ごと消えるので、戻す手段はこのボタンだけ。
        サイドバー側に置くと畳んだあとに押せなくなる。
        右端の詳細ペインのボタン(PanelRight)と対になる位置でもある
      */}
      <button
        className="tb-icon"
        title={sidebarCollapsed ? 'サイドバーを表示する' : 'サイドバーを隠す'}
        onClick={() => {
          const next = !sidebarCollapsed;
          setSidebarCollapsed(next);
          void api.setSetting('sidebar_collapsed', next ? '1' : '0');
        }}
      >
        <PanelLeft />
      </button>
      <input
        className="search"
        type="search"
        // 狭いと切れるので短くし、説明は title に回す
        placeholder="検索(空白区切りで AND)"
        title="ファイル名・タイトルで検索(空白区切りで AND)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {/* 件数はアイコンの右上にバッジで重ねる。文字を並べる場所が無いため */}
      <button
        ref={advBtnRef}
        className={`tb-icon${advCount > 0 ? ' active' : ''}`}
        title={advCount > 0 ? `詳細検索(${advCount} 件の条件)` : '詳細検索'}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        <Funnel />
        {advCount > 0 && <span className="tb-badge">{advCount}</span>}
      </button>
      {showAdvanced && <AdvancedSearch at={advAt} onClose={() => setShowAdvanced(false)} />}
      {/*
        並び順はグリッドとリストで共有の 1 つ。詳細リストの列ヘッダで選べる並びは
        26 種あり全部は並べられないので、ここは代表的なものだけを常設し、
        列ヘッダで選ばれた並びは「今それが選ばれている間だけ」項目を足して見せる
        (シリーズ順・重複まとめと同じ作法)
      */}
      <select
        className="sort-select"
        value={sort}
        onChange={(e) => setSort(e.target.value as SortKey)}
        title="並び順"
      >
        {CURATED_SORTS.map((key) => (
          <option key={key} value={key}>{sortLabel(key)}</option>
        ))}
        {seriesId !== null && <option value="series_asc">シリーズ順</option>}
        {duplicatesOnly && <option value="dup">重複をまとめる</option>}
        {!CURATED_SORTS.includes(sort) && sort !== 'series_asc' && sort !== 'dup' && (
          <option value={sort}>{sortLabel(sort)}</option>
        )}
      </select>
      <button className="tb-icon" title="並びをシャッフルする" onClick={reshuffle}>
        <Shuffle />
      </button>
      <select
        className="rating-select"
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
        className="duration-select"
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
      <button
        className="tb-icon"
        title="今の検索条件をスマートフォルダとして保存"
        onClick={saveCurrentAsSmartFolder}
      >
        <BookmarkPlus />
      </button>
      <button
        className="tb-icon"
        title={viewMode === 'grid' ? '詳細リスト表示に切り替え' : 'サムネイル表示に切り替え'}
        onClick={() => {
          const next = viewMode === 'grid' ? 'list' : 'grid';
          setViewMode(next);
          void api.setSetting('view_mode', next);
        }}
      >
        {viewMode === 'grid' ? <List /> : <LayoutGrid />}
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
          // 左側の塗り。ネイティブの range は「ここまで塗る」を CSS だけでは表せない
          style={{ '--fill': `${cardWidthPct}%` } as React.CSSProperties}
          title="サムネイルの大きさ"
        />
      )}
      <button
        className="tb-icon"
        title="再スキャン"
        onClick={() => api.rescanAll()}
        disabled={scanning}
      >
        <RefreshCw />
      </button>
      <button className="tb-icon" title="統計" onClick={() => setShowStats(true)}>
        <ChartColumn />
      </button>
      <button className="tb-icon" title="操作履歴" onClick={() => setShowHistory(true)}>
        <RotateCcwClock />
      </button>
      <button
        className={`tb-icon${inspectorPinned ? ' active' : ''}`}
        title={
          inspectorPinned
            ? '詳細ペインの固定を解除(選択中だけ表示に戻す)'
            : '詳細ペインを常に表示する'
        }
        onClick={() => {
          const next = !inspectorPinned;
          setInspectorPinned(next);
          void api.setSetting('inspector_pinned', next ? '1' : '0');
        }}
      >
        <PanelRight />
      </button>
      <button
        className={`tb-icon${showAiPanel ? ' active' : ''}`}
        title="AI アシスタント"
        onClick={toggleAiPanel}
      >
        <Sparkles />
      </button>
      <button className="tb-icon" title="設定" onClick={() => setShowSettings(true)}>
        <Settings />
      </button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
      <StatsModal />
    </div>
  );
}
