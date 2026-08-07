import { useVirtualizer } from '@tanstack/react-virtual';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useContextMenu } from '../hooks/useContextMenu';
import { useVideos } from '../hooks/useVideos';
import { buildFolderMenu, buildGridBlankMenu, buildVideoMenu } from '../lib/contextMenu';
import { excludeTargets, type ExcludeTargets } from '../lib/excludeOnDelete';
import { GRID_GAP, GRID_PAD, gridMetrics } from '../lib/grid';
import { gridTemplate, needsLabels, totalWidth } from '../lib/listColumns';
import { parentDir } from '../lib/paths';
import { buildQuery, type FilterState } from '../lib/query';
import { addToQueue, EMPTY_QUEUE, QUEUE_LIMIT } from '../lib/queue';
import type { AddMode } from '../lib/queue';
import { useShallow } from 'zustand/react/shallow';
import { pickState, useLibrary } from '../store';
import type { PlanItem, SortKey, VideoQuery, VideoRow, ViewMode } from '../types';
import { ContextMenu } from './ContextMenu';
import { DeleteDialog } from './DeleteDialog';
import { ExcludeOnDeleteDialog, type ExcludeChoice } from './ExcludeOnDeleteDialog';
import { FileOpDialog } from './FileOpDialog';
import { FilterBar } from './FilterBar';
import type { FileOpKind } from './FileOpDialog';
import { FolderCard, FolderListRow, toEntry, upEntry, type FolderEntry } from './FolderCard';
import { ListHeader } from './ListHeader';
import { VideoCard } from './VideoCard';
import { VideoListRow } from './VideoListRow';

/** 詳細リストの行の高さ。サムネイルを外したら文字だけになるので詰める */
const LIST_ROW_H = 44;
const LIST_ROW_H_SLIM = 28;
/**
 * Ctrl+A で選択できる上限。数万件を state に載せると Inspector の再描画が固まるため。
 * 超えたぶんは黙って捨てずにトーストで知らせる
 */
const SELECT_ALL_LIMIT = 1000;

/** 右クリックメニューの対象。動画・サブフォルダ・余白で持ち物が違う */
type MenuTarget =
  | { kind: 'video'; video: VideoRow; index: number }
  | { kind: 'folder'; path: string }
  | { kind: 'blank' };

export function VideoGrid() {
  const {
    text, sort, folderId, dirPath, dirPathRecursive, tagIds, seriesId, playlistId, missingOnly,
    duplicatesOnly, advanced, randomSeed, version,
    viewMode, cardWidth, listColumns, listZebra, selection, anchorIndex, focusIndex,
    clearSelection, setSelection, setFocusIndex, selectOnly, playFromList, toggleDirPath,
    playerPath, playingVideo, showAiPanel, pushToast, contextMenuOpen, cardTags, cardSeries,
  } = useLibrary(useShallow(pickState(
    'text', 'sort', 'folderId', 'dirPath', 'dirPathRecursive', 'tagIds', 'seriesId', 'playlistId',
    'missingOnly', 'duplicatesOnly', 'advanced', 'randomSeed', 'version', 'viewMode', 'cardWidth',
    'listColumns', 'listZebra', 'selection', 'anchorIndex', 'focusIndex', 'clearSelection',
    'setSelection', 'setFocusIndex', 'selectOnly', 'playFromList', 'toggleDirPath', 'playerPath',
    'playingVideo', 'showAiPanel', 'pushToast', 'contextMenuOpen', 'cardTags', 'cardSeries',
  )));

  /** 絞り込み一式。buildQuery と余白メニューが同じものを見る */
  const filters = useMemo<FilterState>(() => ({
    text, sort, folderId, dirPath, dirPathRecursive, tagIds, seriesId, playlistId, missingOnly,
    duplicatesOnly, advanced, randomSeed,
  }), [
    text, sort, folderId, dirPath, dirPathRecursive, tagIds, seriesId, playlistId, missingOnly,
    duplicatesOnly, advanced, randomSeed,
  ]);
  const query = useMemo<VideoQuery>(() => buildQuery(filters), [filters]);
  /**
   * タグ・シリーズを実際に出すときだけ別便(api.videoLabels)を投げる。
   * リストは列ピッカー、グリッドは設定で決まるので、見ている表示モードのほうだけ見る
   */
  const showChips = viewMode === 'list' ? needsLabels(listColumns) : cardTags || cardSeries;
  const { total, counted, getVideo, getRange, getLabels } = useVideos(query, version, showChips);

  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<MenuTarget>();
  /** Delete キーで開く「どちらの削除か」の確認 */
  const [askDelete, setAskDelete] = useState(false);
  /**
   * 監視除外を勧めるダイアログの対象(v1.33)。
   * 開いた時点の選択を持たせる —— 削除は除外の登録を待つので、
   * その間に選択が変わっても取り違えないようにする
   */
  const [askExclude, setAskExclude] = useState<VideoRow[] | null>(null);
  /** dry-run の結果。null の間はダイアログを出さない(プレビューなしに実行させない) */
  const [fileOp, setFileOp] = useState<{ kind: FileOpKind; plan: PlanItem[] } | null>(null);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * フォルダーツリーで絞っているときだけ、そのフォルダのサブフォルダを一覧の先頭に出す。
   * 「すべての動画」などフォルダ以外の絞り込みでは出さない(従来の見た目のまま)
   */
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  /*
   * 見ているものが変わったら先頭から見せる(前の絞り込みのスクロール位置が残ると迷子になる)。
   *
   * **`version` を混ぜないこと**(v1.32 で分離)。`version` は「中身が変わったので
   * 取り直せ」の合図で、再生中の `setResume` / `markViewed` / 視聴履歴の記録でも上がる。
   * 下のサブフォルダ取得と同じ effect に入れていたせいで、**動画を再生しただけで
   * 一覧が先頭に飛んでいた**(実測: scrollTop 22890 → 0)。
   *
   * 見ている対象そのものは `query` が表す(検索語・並び順・フォルダ・タグ・シリーズ・
   * 詳細検索など一式)。フォルダ移動だけでなく、絞り込みや並び替えでも先頭に戻る
   */
  /** mpv 再生中に一覧が消える間、位置を控えておく場所(下の effect 2 つで使う) */
  const savedTop = useRef(0);

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
    savedTop.current = 0;
  }, [query]);

  /*
   * mpv 再生中の位置の退避(v1.32)。
   *
   * 透過ウィンドウ方式では再生中に `html.mpv-active .app { display: none }` で
   * **一覧ごとレイアウトから外れる**ため、`scrollTop` が 0 に落ちる(DESIGN.md 参照)。
   * `display: none` 自体は mpv を透かして見せるのに要るので変えられない。
   * そこで見えている間の位置を控えておき、閉じたら戻す。
   *
   * **開始の瞬間に読むのではなく scroll イベントで控える** —— `.app` が消えるのは
   * mpv の非同期な初期化のあとなので、「いつ消えるか」に依存しない形にしておく。
   * 隠れている間の 0 を拾わないよう、高さがあるときだけ控える
   */
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.clientHeight > 0) savedTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (playingVideo) return;
    const el = parentRef.current;
    const top = savedTop.current;
    if (!el || top === 0) return;
    // display:none が外れた直後はまだ高さが 0 のことがあるので、次のフレームで当てる
    const id = requestAnimationFrame(() => {
      if (el.clientHeight > 0) el.scrollTop = top;
    });
    return () => cancelAnimationFrame(id);
  }, [playingVideo]);

  useEffect(() => {
    if (dirPath === null) {
      setFolderEntries([]);
      return;
    }
    let alive = true;
    api.listSubfolders(dirPath).then((v) => {
      if (!alive) return;
      setFolderEntries([
        ...(v.parent !== null ? [upEntry(v.parent)] : []),
        ...v.children.map(toEntry),
      ]);
    });
    return () => {
      alive = false;
    };
  }, [dirPath, version]);

  const list = viewMode === 'list';
  const listRowH = listColumns.includes('thumb') ? LIST_ROW_H : LIST_ROW_H_SLIM;
  // カード下に足すタグ行・シリーズ行の本数。行の高さが変わるので gridMetrics に渡す
  const chipRows = (cardTags ? 1 : 0) + (cardSeries ? 1 : 0);
  // まだ測れていないうちは 4 列ぶんの幅と仮定する
  const grid = gridMetrics(width || cardWidth * 4, cardWidth, chipRows);
  // リスト表示は 1 行 1 件
  const cols = list ? 1 : grid.cols;
  const rowHeight = list ? listRowH : grid.rowHeight;

  // フォルダは動画より前に、独立した行として並べる(1 行の中で混ざらないようにする)。
  // こうしておけば選択・キーボード操作は従来どおり動画の通し番号だけで考えられる
  const folderRows = Math.ceil(folderEntries.length / cols);
  const rowCount = folderRows + Math.ceil(total / cols);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  });

  // カード幅・表示モードを変えたら行高が変わるので測り直させる
  useEffect(() => virtualizer.measure(), [rowHeight, cols, virtualizer]);

  /** その位置の動画で再生を開始する(⏭ で続きへ進めるようキューも渡す) */
  const play = useCallback(
    (video: VideoRow, index: number) => {
      if (video.isMissing || video.isOffline) return;
      if (playerPath.trim() !== '') {
        // 外部プレイヤー設定時は従来通り外部起動(連続再生はアプリ内再生のみ)
        void api.openVideo(video.id);
        return;
      }
      playFromList(video, { query, index, total });
    },
    [playerPath, playFromList, query, total],
  );

  /**
   * 選択をキューに入れる(v1.40)。`Q` キーと右クリックメニューが共用する。
   *
   * `replace` は「今のキューを捨てて、選んだものだけで再生を始める」。
   * ダブルクリックはクエリ方式の連続再生のままなので、**選んだものだけを流す唯一の入口**。
   * 上限に当たったときは部分的に入れず全部断る(何が入ったのか分からなくなるため)
   */
  const addSelectionToQueue = useCallback(
    (mode: AddMode | 'replace') => {
      const s = useLibrary.getState();
      const videos = s.selection;
      if (videos.length === 0) return;

      if (mode === 'replace') {
        const { queue: next, overflow } = addToQueue(EMPTY_QUEUE, videos);
        if (overflow) {
          // ここで setQueue すると空キューで**既存のキューを消してしまう**。
          // 断り方は追加系と同じ(部分的に入れず全部断る)
          pushToast(`キューの上限は ${QUEUE_LIMIT} 件です(${videos.length} 件は入りません)`);
          return;
        }
        s.setQueue(next);
        s.setQueueTabOpen(true);
        const first = next.items.find((v) => !v.isMissing && !v.isOffline);
        if (first) s.playFromQueue(first);
        else pushToast('再生できる動画がありません');
        return;
      }

      const { queue: next, added, overflow } = addToQueue(s.queue, videos, mode);
      if (overflow) {
        pushToast(`キューが上限の ${QUEUE_LIMIT} 件を超えるため追加しませんでした`);
        return;
      }
      if (added === 0) {
        pushToast('すでにキューに入っています', 'info');
        return;
      }
      s.setQueue(next);
      s.setQueueTabOpen(true);
      pushToast(
        mode === 'next' ? `${added} 件を次に再生します` : `${added} 件をキューに追加しました`,
        'info',
      );
    },
    [pushToast],
  );

  /** クリック。Shift = anchor からの範囲、Ctrl = トグル、素 = 単独選択 */
  const onPick = useCallback(
    async (video: VideoRow, index: number, e: React.MouseEvent | { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      if (e.shiftKey && anchorIndex != null) {
        const rows = await getRange(anchorIndex, index);
        setSelection(rows, index);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        useLibrary.getState().toggleSelect(video, index);
        return;
      }
      selectOnly(video, index);
    },
    [anchorIndex, getRange, setSelection, selectOnly],
  );

  /**
   * カードの右クリック(v1.14)。エクスプローラーと同じ挙動にする:
   * 選択の外を押したらそこへ選択を移し、選択済みを押したら選択を保ったまま全件を対象にする。
   * メニューを見る前に「何が対象か」が見た目で分かるのが要点
   */
  const onCardContextMenu = useCallback(
    (video: VideoRow, index: number, e: React.MouseEvent) => {
      const current = useLibrary.getState().selection;
      const inSelection = current.some((v) => v.id === video.id);
      const targets = inSelection ? current : [video];
      if (!inSelection) selectOnly(video, index);
      openMenu(e, buildVideoMenu(targets, video), { kind: 'video', video, index });
    },
    [selectOnly, openMenu],
  );

  const onFolderContextMenu = useCallback(
    (entry: FolderEntry, e: React.MouseEvent) => {
      // フォルダは選択の対象外。左クリックと同じく動画の選択は解除する
      clearSelection();
      openMenu(e, buildFolderMenu(), { kind: 'folder', path: entry.path });
    },
    [clearSelection, openMenu],
  );

  /** クリップボードは Tauri プラグインを足さず WebView の API を使う(失敗は必ず見せる) */
  const copyToClipboard = useCallback(
    async (text: string, done: string) => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast(done, 'info');
      } catch {
        pushToast('クリップボードにコピーできませんでした');
      }
    },
    [pushToast],
  );

  /**
   * ライブラリ登録だけ消す(ファイルは残す)。
   * confirm=false は呼び出し側で既に確認を取っているとき(Delete キーのダイアログ)
   */
  const removeFromLibrary = useCallback(async (confirm: boolean) => {
    const s = useLibrary.getState();
    const sel = s.selection;
    if (sel.length === 0) return;
    /*
     * 監視フォルダ由来のものが混じっていたら、消す前に監視除外を勧める。
     * このまま消しても次のスキャンで再登録されるのはこの場合だけなので、
     * 個別登録しか選んでいなければ黙って消す(問いかけを騒がしくしない)。
     *
     * **こちらを先に見る**。あのダイアログは削除の確認も兼ねているので、
     * 手前で ask を出すと同じことを 2 回聞くことになる
     */
    if (excludeTargets(sel).files.length > 0) {
      setAskExclude(sel);
      return;
    }
    if (confirm) {
      const yes = await ask(
        `${sel.length} 件をライブラリから削除しますか?\n(登録とタグ情報が消えます。ファイル自体は削除されません)`,
        { title: 'ライブラリから削除' },
      );
      if (!yes) return;
    }
    await api.removeVideos(sel.map((v) => v.id));
    s.clearSelection();
    s.bumpVersion();
  }, []);

  /**
   * 監視除外の選択を受けて、除外に入れてから削除する。
   * **順番が逆だと、間に監視が走ったときに拾い直される**
   */
  const removeWithExclude = useCallback(
    async (choice: ExcludeChoice, targets: ExcludeTargets, sel: VideoRow[]) => {
      const s = useLibrary.getState();
      setAskExclude(null);
      const paths =
        choice === 'files' ? targets.files : choice === 'folders' ? targets.folders : [];
      if (paths.length > 0) {
        // 削除はこのあと自分でやるので、除外側では登録を触らせない
        await api.addExcludedPaths(paths, false);
      }
      await api.removeVideos(sel.map((v) => v.id));
      s.clearSelection();
      s.bumpVersion();
      if (choice !== 'none') {
        pushToast(
          `${sel.length.toLocaleString()} 件を削除し、${paths.length.toLocaleString()} 件を監視除外に登録しました`,
          'info',
        );
      }
    },
    [pushToast],
  );

  /** ファイルをごみ箱へ。実行前に必ず dry-run の表を見せる(FileOpDialog が承認を取る) */
  const trashSelection = useCallback(async () => {
    const sel = useLibrary.getState().selection;
    if (sel.length === 0) return;
    setFileOp({ kind: 'trash', plan: await api.planTrash(sel.map((v) => v.id)) });
  }, []);

  const runVideoAction = useCallback(
    async (id: string, target: VideoRow, index: number) => {
      const s = useLibrary.getState();
      const sel = s.selection;
      const ids = sel.map((v) => v.id);

      if (id.startsWith('rating:')) {
        const value = Number(id.slice('rating:'.length));
        await api.setRating(ids, value);
        // 再取得までの間に古い星へ戻るのを防ぐ(Inspector と同じ手当て)
        s.patchSelection({ rating: value });
        s.bumpVersion();
        return;
      }

      switch (id) {
        case 'play':
          play(target, index);
          break;
        case 'queue:add':
          addSelectionToQueue('end');
          break;
        case 'queue:next':
          addSelectionToQueue('next');
          break;
        case 'queue:replace':
          addSelectionToQueue('replace');
          break;
        case 'openDefault':
          await api.openWithDefault(target.id);
          break;
        case 'openWith':
          await api.openWithDialog(target.id);
          break;
        case 'reveal':
          try {
            await revealItemInDir(target.path);
          } catch {
            pushToast('エクスプローラーで表示できませんでした');
          }
          break;
        case 'openFolder': {
          const dir = parentDir(target.path);
          if (dir) toggleDirPath(dir);
          break;
        }
        case 'copyPath':
          await copyToClipboard(
            sel.map((v) => v.path).join('\r\n'),
            `${sel.length} 件のパスをコピーしました`,
          );
          break;
        case 'rename': {
          const name = window.prompt('新しいファイル名', target.filename);
          if (name === null || name.trim() === '' || name === target.filename) return;
          setFileOp({ kind: 'rename', plan: [await api.planRename(target.id, name.trim())] });
          break;
        }
        case 'move': {
          const dest = await open({ directory: true, multiple: false, title: '移動先フォルダ' });
          if (typeof dest !== 'string') return;
          setFileOp({ kind: 'move', plan: await api.planMove(ids, dest) });
          break;
        }
        case 'rethumb':
          // 生成そのものは Rust のワーカーが順にこなす。ここでは予約するだけ
          for (const v of sel) await api.setThumbTime(v.id);
          pushToast(`${sel.length} 件のサムネイルを作り直しています`, 'info');
          break;
        case 'removeFromLibrary':
          await removeFromLibrary(true);
          break;
        case 'trash':
          await trashSelection();
          break;
        default:
      }
    },
    [
      play, toggleDirPath, pushToast, copyToClipboard, removeFromLibrary, trashSelection,
      addSelectionToQueue,
    ],
  );

  const runFolderAction = useCallback(
    async (id: string, path: string) => {
      switch (id) {
        case 'folderOpen':
          toggleDirPath(path);
          break;
        case 'folderReveal':
          try {
            await revealItemInDir(path);
          } catch {
            pushToast('エクスプローラーで表示できませんでした');
          }
          break;
        case 'folderCopyPath':
          await copyToClipboard(path, 'パスをコピーしました');
          break;
        default:
      }
    },
    [toggleDirPath, pushToast, copyToClipboard],
  );

  /** フォーカスを動かして 1 件だけ選択する(Shift 併用なら anchor からの範囲) */
  const moveFocus = useCallback(
    async (next: number, extend: boolean) => {
      const clamped = Math.min(Math.max(next, 0), Math.max(total - 1, 0));
      if (total === 0) return;
      // 動画の行はフォルダの行のぶんだけ下にずれている
      virtualizer.scrollToIndex(folderRows + Math.floor(clamped / cols), { align: 'auto' });
      if (extend && anchorIndex != null) {
        const rows = await getRange(anchorIndex, clamped);
        setSelection(rows, clamped);
        return;
      }
      const rows = await getRange(clamped, clamped);
      if (rows.length > 0) selectOnly(rows[0], clamped);
      else setFocusIndex(clamped);
    },
    [total, cols, folderRows, virtualizer, anchorIndex, getRange, setSelection, selectOnly, setFocusIndex],
  );

  const selectAll = useCallback(async () => {
    if (total === 0) return;
    const limit = Math.min(total, SELECT_ALL_LIMIT);
    const rows = await getRange(0, limit - 1);
    setSelection(rows, 0);
    if (total > SELECT_ALL_LIMIT) {
      pushToast(`先頭 ${SELECT_ALL_LIMIT} 件を選択しました(全 ${total} 件)`, 'info');
    }
  }, [total, getRange, setSelection, pushToast]);

  /** 「上のフォルダ」の行き先。フォルダーで絞っていないか、監視フォルダの外に出るときは null */
  const parentPath = folderEntries[0]?.up ? folderEntries[0].path : null;

  /**
   * グリッドの余白(v1.20)。カード・行・列ヘッダの上では出さない —
   * どれも stopPropagation していないので、ここで弾かないと
   * それぞれのメニューが出た直後にこれで上書きされてしまう
   */
  const onBlankContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.card, .list-row, .list-head')) return;
      openMenu(
        e,
        buildGridBlankMenu({
          total,
          selectionCount: useLibrary.getState().selection.length,
          viewMode,
          parentPath,
          filters,
        }),
        { kind: 'blank' },
      );
    },
    [openMenu, total, viewMode, parentPath, filters],
  );

  const runBlankAction = useCallback(
    async (id: string) => {
      const s = useLibrary.getState();

      if (id.startsWith('blank:view:')) {
        const next = id.slice('blank:view:'.length) as ViewMode;
        s.setViewMode(next);
        void api.setSetting('view_mode', next);
        return;
      }
      if (id.startsWith('blank:sort:')) {
        s.setSort(id.slice('blank:sort:'.length) as SortKey);
        return;
      }

      switch (id) {
        case 'blank:selectAll':
          await selectAll();
          break;
        case 'blank:clearSelection':
          s.clearSelection();
          break;
        case 'blank:up':
          if (parentPath) s.toggleDirPath(parentPath);
          break;
        case 'blank:reveal':
          if (!s.dirPath) return;
          try {
            await revealItemInDir(s.dirPath);
          } catch {
            pushToast('エクスプローラーで表示できませんでした');
          }
          break;
        // 空オブジェクトを渡すと絞り込みだけが既定に戻る(並び順は残る)
        case 'blank:clearFilters':
          s.applyFilter({});
          break;
        case 'blank:refresh':
          s.bumpVersion();
          break;
        default:
      }
    },
    [selectAll, parentPath, pushToast],
  );

  // キーボード操作。プレイヤー表示中と入力欄にフォーカスがある間は何もしない
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (playingVideo) return;
      // 右クリックメニューが開いている間のキーはメニュー側が処理する。
      // ここで横取りすると、メニューを出したまま裏で選択が動いてしまう
      if (contextMenuOpen) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        void selectAll();
        return;
      }
      // Ctrl+A 以外の修飾キー付き(コピー・貼り付け等)は横取りしない
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const cur = focusIndex ?? -1;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          void moveFocus(cur + 1, e.shiftKey);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void moveFocus(Math.max(cur - 1, 0), e.shiftKey);
          break;
        case 'ArrowDown':
          e.preventDefault();
          void moveFocus(cur < 0 ? 0 : cur + cols, e.shiftKey);
          break;
        case 'ArrowUp':
          e.preventDefault();
          void moveFocus(cur < 0 ? 0 : Math.max(cur - cols, 0), e.shiftKey);
          break;
        case 'Home':
          e.preventDefault();
          void moveFocus(0, e.shiftKey);
          break;
        case 'End':
          e.preventDefault();
          void moveFocus(total - 1, e.shiftKey);
          break;
        case 'Enter': {
          if (focusIndex == null) return;
          e.preventDefault();
          const v = getVideo(focusIndex);
          if (v) play(v, focusIndex);
          break;
        }
        case 'Delete':
          // ここでは消さない。「ライブラリからか / ごみ箱か」をダイアログで選ばせる
          if (selection.length === 0) return;
          e.preventDefault();
          setAskDelete(true);
          break;
        /*
         * 選択をキューの末尾に足す(v1.40)。プレイヤー側の Q は
         * 「キューパネルの開閉」で意味が違うが、これは既存の作法どおり ——
         * ArrowLeft も一覧では「前の動画へ」、プレイヤーでは「10 秒戻す」になっている
         */
        case 'q':
        case 'Q':
          if (selection.length === 0) return;
          e.preventDefault();
          addSelectionToQueue('end');
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    playingVideo, showAiPanel, contextMenuOpen, focusIndex, cols, total, selection.length,
    moveFocus, selectAll, getVideo, play, addSelectionToQueue,
  ]);

  // 選択が空になったら削除の確認は用済み。Esc(App 側で選択解除)でも閉じることになる
  useEffect(() => {
    if (selection.length === 0) setAskDelete(false);
  }, [selection.length]);

  const selectedIds = useMemo(() => new Set(selection.map((v) => v.id)), [selection]);

  return (
    <>
    {/*
      絞り込み帯(v1.28)。フラグメントの子はそのまま .main の直接の子として並ぶので、
      ツールバーと一覧の間に入る。件数は useVideos のものを渡す(数え直さない)
    */}
    <FilterBar filters={filters} total={total} counted={counted} />
    <div
      ref={parentRef}
      className={`grid-scroll ${list ? 'list-mode' : ''}`}
      // ヘッダ行・動画行・フォルダ行が同じ列幅を共有するための CSS 変数
      style={list ? ({ '--list-cols': gridTemplate(listColumns) } as React.CSSProperties) : undefined}
      // スクロールしたらメニューを閉じる処理は ContextMenu 側が持つ(v1.20)
      onContextMenu={onBlankContextMenu}
      onClick={(e) => {
        // カード以外の余白クリックで選択解除(フォルダは選択の対象外なので押しても解除する)
        const hit = (e.target as HTMLElement).closest('.card, .list-row');
        if (!hit || hit.classList.contains('folder-card') || hit.classList.contains('folder-row')) {
          clearSelection();
        }
      }}
    >
      {/* 仮想化コンテナの手前に置く。中に入れると folderRows の添字計算が崩れる */}
      {list && <ListHeader columns={listColumns} />}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            /*
              1 行おきの濃淡(v1.25)。**縞のクラスはここ(ラッパ)に付け、塗るのは
              .list-row 側**にする —— ここを塗ると左右 12px の padding まで届く
              角無しの帯になり、選択・ホバーのハイライトと形が変わってしまう。

              :nth-child は使えない(仮想化で DOM 上の順番 = 絶対行番号ではないので、
              スクロールすると縞が反転して波打つ)。row.index は**画面上の通し行番号**
              なので、先頭にフォルダ行が混ざってもパリティがずれない
              (動画側の index は folderRows を引いた値なのでこの用途には使えない)。
              動画行・フォルダ行・未取得プレースホルダの 3 種すべてに props 追加なしで乗る。
              **list && を外さないこと**(グリッドのカードにクラスが漏れる)
            */
            className={list && listZebra && row.index % 2 === 1 ? 'list-odd' : undefined}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              // リストは列を増やすと可視幅を超えることがある。width:100% のままだと
              // 行が可視幅で切れ、横スクロールしたときにハイライトの右端が途切れる。
              // max-content は使わない(ファイル名の長さで行ごとに幅が変わってしまう)。
              // 足しているのは下の padding ぶん(border-box なので幅に含める)
              width: list ? `max(100%, ${totalWidth(listColumns) + GRID_PAD * 2}px)` : '100%',
              height: rowHeight,
              transform: `translateY(${row.start}px)`,
              display: list ? 'block' : 'grid',
              // 幅と隙間は lib/grid.ts の寸法計算と対。**片方だけ直さないこと**
              gridTemplateColumns: list ? undefined : `repeat(${cols}, 1fr)`,
              gap: list ? undefined : GRID_GAP,
              padding: `0 ${GRID_PAD}px`,
            }}
          >
            {Array.from({ length: cols }, (_, c) => {
              // 先頭の folderRows 行はフォルダ、その後ろが動画
              if (row.index < folderRows) {
                const entry = folderEntries[row.index * cols + c];
                if (!entry) return <div key={c} />;
                return list ? (
                  <FolderListRow
                    key={c}
                    entry={entry}
                    onOpen={toggleDirPath}
                    onContextMenu={onFolderContextMenu}
                    height={listRowH}
                    columns={listColumns}
                  />
                ) : (
                  <FolderCard
                    key={c}
                    entry={entry}
                    onOpen={toggleDirPath}
                    onContextMenu={onFolderContextMenu}
                  />
                );
              }
              const index = (row.index - folderRows) * cols + c;
              if (index >= total) return <div key={c} />;
              const video = getVideo(index);
              const props = {
                video,
                // 行より一拍遅れて届く。未取得なら undefined のまま渡す
                labels: video ? getLabels(video.id) : undefined,
                index,
                selected: video ? selectedIds.has(video.id) : false,
                focused: focusIndex === index,
                onPick,
                onPlay: play,
                onContextMenu: onCardContextMenu,
              };
              return list ? (
                <VideoListRow key={c} {...props} height={listRowH} columns={listColumns} />
              ) : (
                <VideoCard key={c} {...props} cardW={grid.cardW} />
              );
            })}
          </div>
        ))}
      </div>
      {total === 0 && folderEntries.length === 0 && (
        <div className="empty-hint">
          左の「+ フォルダを追加」から動画フォルダを登録するか、
          <br />
          動画ファイルをこのウィンドウにドロップしてください
        </div>
      )}
    </div>

    {/* メニューとダイアログはスクロール領域の外に置く。
        仮想化の transform が position: fixed の基準になってしまうため */}
    {menu && (
      <ContextMenu
        key={`${menu.x},${menu.y}`}
        x={menu.x}
        y={menu.y}
        entries={menu.entries}
        onClose={closeMenu}
        onSelect={(id) => {
          const t = menu.target;
          if (t.kind === 'video') void runVideoAction(id, t.video, t.index);
          else if (t.kind === 'folder') void runFolderAction(id, t.path);
          else void runBlankAction(id);
        }}
      />
    )}
    {askDelete && (
      <DeleteDialog
        count={selection.length}
        onClose={() => setAskDelete(false)}
        // このダイアログ自体が確認なので、ライブラリ削除で二重に尋ねない
        onLibrary={() => {
          setAskDelete(false);
          void removeFromLibrary(false);
        }}
        onTrash={() => {
          setAskDelete(false);
          void trashSelection();
        }}
      />
    )}
    {askExclude && (
      <ExcludeOnDeleteDialog
        selection={askExclude}
        onClose={() => setAskExclude(null)}
        onChoose={(choice, targets) => void removeWithExclude(choice, targets, askExclude)}
      />
    )}
    {fileOp && (
      <FileOpDialog kind={fileOp.kind} plan={fileOp.plan} onClose={() => setFileOp(null)} />
    )}
    </>
  );
}
