import {
  BookmarkPlus,
  ChartColumn,
  Check,
  Funnel,
  Keyboard,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  RefreshCw,
  RotateCcwClock,
  Settings,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { sortLabel, sortOptions } from '../lib/listColumns';
import { advancedCount, buildQuery } from '../lib/query';
import { splitToolbar, TOOLBAR_ITEMS, toolbarKeys } from '../lib/toolbarItems';
import type { ToolbarItemKey } from '../lib/toolbarItems';
import { useShallow } from 'zustand/react/shallow';
import { CARD_WIDTH_MAX, CARD_WIDTH_MIN, pickState, useLibrary } from '../store';
import type { SortKey } from '../types';
import { AdvancedSearch } from './AdvancedSearch';
import { HistoryModal } from './HistoryModal';
import { SettingsModal } from './SettingsModal';
import { ShortcutsModal } from './ShortcutsModal';
import { StatsModal } from './StatsModal';
import { ToolbarOverflow } from './ToolbarOverflow';

/** 部品をバーに置くか、≫ メニューの中に置くか */
type Place = 'bar' | 'menu';

export function Toolbar() {
  const {
    text, setText, sort, setSort, scanning, seriesId,
    showAiPanel, toggleAiPanel, advanced, duplicatesOnly,
    setShowStats, setShowShortcuts, bumpVersion, pushToast,
    viewMode, setViewMode, cardWidth, setCardWidth,
    inspectorPinned, setInspectorPinned, sidebarCollapsed, setSidebarCollapsed,
  } = useLibrary(useShallow(pickState(
    'text', 'setText', 'sort', 'setSort', 'scanning', 'seriesId',
    'showAiPanel', 'toggleAiPanel', 'advanced', 'duplicatesOnly',
    'setShowStats', 'setShowShortcuts', 'bumpVersion', 'pushToast',
    'viewMode', 'setViewMode', 'cardWidth', 'setCardWidth',
    'inspectorPinned', 'setInspectorPinned', 'sidebarCollapsed', 'setSidebarCollapsed',
  )));
  const [input, setInput] = useState(text);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const advBtnRef = useRef<HTMLButtonElement>(null);
  const [advAt, setAdvAt] = useState({ x: 0, y: 0 });

  const barRef = useRef<HTMLDivElement>(null);
  /** ツールバーの内寸。測れるまでは null = 全項目を出す */
  const [avail, setAvail] = useState<number | null>(null);

  /*
   * 幅を測って、入りきらない項目を ≫ に畳む。
   *
   * useEffect ではなく useLayoutEffect なのは、初回に「全部出た姿」が 1 フレーム
   * 見えてしまうため(VideoGrid の列数計算は 1 フレームずれても目立たないので
   * あちらは useEffect のままでよい)。
   *
   * 初期値を null(= 全部出す)にしているのは、畳まれた姿から広がるより
   * 目に付きにくいから。「全部畳む」を初期値にすると起動時に必ずガタつく
   */
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => setAvail(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 幅が変わるとバーと ≫ の中身が入れ替わる。開いたまま項目が消えるのを防ぐ
  useEffect(() => {
    setMenuOpen(false);
  }, [avail]);

  // 開くたびにボタンの位置を測り直す。ポップオーバーは画面基準で描くため。
  // 幅が変わると検索欄が伸縮してボタンの x が動くので avail も見る
  useLayoutEffect(() => {
    if (!showAdvanced) return;
    const r = advBtnRef.current?.getBoundingClientRect();
    if (r) setAdvAt({ x: r.left, y: r.bottom + 6 });
  }, [showAdvanced, avail]);

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

  /**
   * 1 項目を描く。**同じ項目の JSX を 2 か所に書かない** —— バーと ≫ メニューの
   * 違いは ToolButton / ToolSelect / ToolSlider の中だけに閉じ込める
   */
  const renderItem = (key: ToolbarItemKey, place: Place): ReactNode => {
    const { label } = TOOLBAR_ITEMS[key];
    /*
     * メニューの項目を押したら閉じてから実行する。「条件を保存」の window.prompt は
     * 同期的にスレッドを止めるので、閉じる描画を先に済ませないとメニューが
     * 出たままダイアログが開く(右クリックメニューと同じ理由)
     */
    const act = (fn: () => void) => () => {
      if (place !== 'menu') {
        fn();
        return;
      }
      setMenuOpen(false);
      window.setTimeout(fn, 0);
    };

    switch (key) {
      case 'sidebarToggle':
        /*
          サイドバーを畳むと幅を変える帯ごと消えるので、戻す手段はこのボタンだけ。
          サイドバー側に置くと畳んだあとに押せなくなる。だから畳まない項目にしてある
        */
        return (
          <ToolButton
            key={key}
            place={place}
            icon={PanelLeft}
            label={sidebarCollapsed ? 'サイドバーを表示' : 'サイドバーを隠す'}
            onClick={act(() => {
              const next = !sidebarCollapsed;
              setSidebarCollapsed(next);
              void api.setSetting('sidebar_collapsed', next ? '1' : '0');
            })}
          />
        );

      case 'search':
        // 畳まないので place は必ず 'bar'
        return (
          <input
            key={key}
            className="search"
            type="search"
            // 狭いと切れるので短くし、説明は title に回す
            placeholder="検索(空白区切りで AND)"
            title="ファイル名・タイトルで検索(空白区切りで AND)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        );

      case 'advanced':
        /*
          畳まない。ポップオーバーを ≫ メニューの中から開くと、互いの
          「外側クリックで閉じる」が食い合って開いた瞬間に閉じる。
          件数はアイコンの右上にバッジで重ねる(文字を並べる場所が無いため)
        */
        return (
          <button
            key={key}
            ref={advBtnRef}
            className={`tb-icon${advCount > 0 ? ' active' : ''}`}
            title={advCount > 0 ? `詳細検索(${advCount} 件の条件)` : '詳細検索'}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <Funnel />
            {advCount > 0 && <span className="tb-badge">{advCount}</span>}
          </button>
        );

      case 'sort':
        /*
          並び順はグリッドとリストで共有の 1 つ。詳細リストの列ヘッダで選べる並びは
          26 種あり全部は並べられないので、ここは代表的なものだけを常設し、
          列ヘッダで選ばれた並びは「今それが選ばれている間だけ」項目を足して見せる
          (シリーズ順・重複まとめと同じ作法)
        */
        return (
          <ToolSelect
            key={key}
            place={place}
            label={label}
            className="sort-select"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
          >
            {/* 選択肢の組み立ては余白の右クリックメニューと共有する(片方だけ増えるのを防ぐ) */}
            {sortOptions({ sort, seriesId, duplicatesOnly }).map((k) => (
              <option key={k} value={k}>{sortLabel(k)}</option>
            ))}
          </ToolSelect>
        );

      case 'saveQuery':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={BookmarkPlus}
            label={label}
            title="今の検索条件をスマートフォルダとして保存"
            onClick={act(() => void saveCurrentAsSmartFolder())}
          />
        );

      case 'viewMode':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={viewMode === 'grid' ? List : LayoutGrid}
            label={viewMode === 'grid' ? '詳細リスト表示' : 'サムネイル表示'}
            title={viewMode === 'grid' ? '詳細リスト表示に切り替え' : 'サムネイル表示に切り替え'}
            onClick={act(() => {
              const next = viewMode === 'grid' ? 'list' : 'grid';
              setViewMode(next);
              void api.setSetting('view_mode', next);
            })}
          />
        );

      case 'cardSize':
        return (
          <ToolSlider
            key={key}
            place={place}
            label={label}
            value={cardWidth}
            pct={cardWidthPct}
            onChange={setCardWidth}
            onCommit={() => void api.setSetting('card_width', String(cardWidth))}
          />
        );

      case 'rescan':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={RefreshCw}
            label={label}
            disabled={scanning}
            onClick={act(() => void api.rescanAll())}
          />
        );

      case 'stats':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={ChartColumn}
            label={label}
            onClick={act(() => setShowStats(true))}
          />
        );

      case 'history':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={RotateCcwClock}
            label={label}
            onClick={act(() => setShowHistory(true))}
          />
        );

      case 'inspectorPin':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={PanelRight}
            active={inspectorPinned}
            label="詳細ペインを常に表示"
            title={
              inspectorPinned
                ? '詳細ペインの固定を解除(選択中だけ表示に戻す)'
                : '詳細ペインを常に表示する'
            }
            onClick={act(() => {
              const next = !inspectorPinned;
              setInspectorPinned(next);
              void api.setSetting('inspector_pinned', next ? '1' : '0');
            })}
          />
        );

      case 'aiPanel':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={Sparkles}
            active={showAiPanel}
            label={label}
            onClick={act(toggleAiPanel)}
          />
        );

      case 'settings':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={Settings}
            label={label}
            onClick={act(() => setShowSettings(true))}
          />
        );

      case 'shortcuts':
        return (
          <ToolButton
            key={key}
            place={place}
            icon={Keyboard}
            label={label}
            // キーで開けることを、キーを知らない人に教える唯一の場所
            title="キー操作の一覧 (?)"
            onClick={act(() => setShowShortcuts(true))}
          />
        );
    }
  };

  const { bar, menu } = splitToolbar(toolbarKeys(viewMode), avail);
  /*
   * かつてここには「畳んだ中に効いている絞り込みがあれば ≫ を光らせる」判定があった。
   * v1.28 の絞り込み帯が★も長さも常にチップで出すようになったので、
   * 「件数が少ない理由が分からない」事故はそちらで防がれている。
   * 条件を足すたびにこの式にも足す必要があり(足し忘れても静かに動く)、
   * 帯と二重に持つ意味が無くなったので消した
   */

  return (
    <div className="toolbar" ref={barRef}>
      {bar.map((key) => renderItem(key, 'bar'))}
      {menu.length > 0 && (
        <ToolbarOverflow open={menuOpen} onOpenChange={setMenuOpen}>
          {menu.map((key) => renderItem(key, 'menu'))}
        </ToolbarOverflow>
      )}

      {/*
        モーダルとポップオーバーは項目マップの外に置く。トリガーがバーにあっても
        ≫ の中にあっても、開いている間はレンダーされ続ける必要があるため
      */}
      {showAdvanced && <AdvancedSearch at={advAt} onClose={() => setShowAdvanced(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
      <StatsModal />
      {/* 他のモーダルより後ろに書く —— .modal-overlay はどれも z-index 100 なので、
          設定を開いたまま出したときに DOM 順で前に来る必要がある */}
      <ShortcutsModal />
    </div>
  );
}

/**
 * バーではアイコンだけ、≫ メニューではアイコン + ラベル。
 * 押した状態はバーでは青塗り(.active)、メニューでは右端のチェック印で示す
 */
function ToolButton({
  place, label, title, icon: Icon, active, disabled, onClick,
}: {
  place: Place;
  /** メニューに出す短い見出し。長いと切れる */
  label: string;
  /** バーでのツールチップ。省くと label をそのまま使う */
  title?: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  if (place === 'menu') {
    return (
      <button className="tb-menu-item" disabled={disabled} onClick={onClick}>
        <Icon />
        <span className="tb-menu-label">{label}</span>
        {active && <Check className="tb-menu-mark" />}
      </button>
    );
  }
  return (
    <button
      className={`tb-icon${active ? ' active' : ''}`}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon />
    </button>
  );
}

/** メニューでは「ラベル : コントロール」の 1 行にする。裸の select だと何の select か分からない */
function ToolSelect({
  place, label, title, className, value, onChange, children,
}: {
  place: Place;
  label: string;
  title?: string;
  className: string;
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const select = (
    <select
      className={className}
      value={value}
      title={place === 'bar' ? (title ?? label) : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
  if (place === 'bar') return select;
  return (
    <label className="tb-menu-row">
      <span className="tb-menu-label">{label}</span>
      {select}
    </label>
  );
}

/** サムネイルの大きさ。グリッド表示のときだけ出る */
function ToolSlider({
  place, label, value, pct, onChange, onCommit,
}: {
  place: Place;
  label: string;
  value: number;
  /** 左側の塗りの割合。ネイティブの range は「ここまで塗る」を CSS だけでは表せない */
  pct: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const slider = (
    <input
      className="card-size"
      type="range"
      min={CARD_WIDTH_MIN}
      max={CARD_WIDTH_MAX}
      step={4}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      // ドラッグ中に毎回書き込まない(離したときだけ保存する)
      onPointerUp={onCommit}
      style={{ '--fill': `${pct}%` } as React.CSSProperties}
      title={place === 'bar' ? label : undefined}
    />
  );
  if (place === 'bar') return slider;
  return (
    <label className="tb-menu-row">
      <span className="tb-menu-label">{label}</span>
      {slider}
    </label>
  );
}
