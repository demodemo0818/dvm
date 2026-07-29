import { useVirtualizer } from '@tanstack/react-virtual';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useContextMenu } from '../hooks/useContextMenu';
import { useVideos } from '../hooks/useVideos';
import { buildFolderMenu, buildGridBlankMenu, buildVideoMenu } from '../lib/contextMenu';
import { GRID_GAP, GRID_PAD, gridMetrics } from '../lib/grid';
import { gridTemplate, totalWidth } from '../lib/listColumns';
import { parentDir } from '../lib/paths';
import { buildQuery } from '../lib/query';
import { useLibrary } from '../store';
import type { PlanItem, SortKey, VideoQuery, VideoRow, ViewMode } from '../types';
import { ContextMenu } from './ContextMenu';
import { DeleteDialog } from './DeleteDialog';
import { FileOpDialog } from './FileOpDialog';
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
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed, version,
    viewMode, cardWidth, listColumns, selection, anchorIndex, focusIndex,
    clearSelection, setSelection, setFocusIndex, selectOnly, playFromList, toggleDirPath,
    playerPath, playingVideo, showAiPanel, pushToast, contextMenuOpen,
  } = useLibrary();

  /** 絞り込み一式。buildQuery と余白メニューが同じものを見る */
  const filters = useMemo(() => ({
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed,
  }), [
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed,
  ]);
  const query = useMemo<VideoQuery>(() => buildQuery(filters), [filters]);
  const { total, getVideo, getRange } = useVideos(query, version);

  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<MenuTarget>();
  /** Delete キーで開く「どちらの削除か」の確認 */
  const [askDelete, setAskDelete] = useState(false);
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
  useEffect(() => {
    // フォルダを移ったら先頭から見せる(前のフォルダのスクロール位置が残ると迷子になる)
    parentRef.current?.scrollTo({ top: 0 });
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
  // まだ測れていないうちは 4 列ぶんの幅と仮定する
  const grid = gridMetrics(width || cardWidth * 4, cardWidth);
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
    [play, toggleDirPath, pushToast, copyToClipboard, removeFromLibrary, trashSelection],
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
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    playingVideo, showAiPanel, contextMenuOpen, focusIndex, cols, total, selection.length,
    moveFocus, selectAll, getVideo, play,
  ]);

  // 選択が空になったら削除の確認は用済み。Esc(App 側で選択解除)でも閉じることになる
  useEffect(() => {
    if (selection.length === 0) setAskDelete(false);
  }, [selection.length]);

  const selectedIds = useMemo(() => new Set(selection.map((v) => v.id)), [selection]);

  return (
    <>
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
                <VideoCard key={c} {...props} />
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
    {fileOp && (
      <FileOpDialog kind={fileOp.kind} plan={fileOp.plan} onClose={() => setFileOp(null)} />
    )}
    </>
  );
}
