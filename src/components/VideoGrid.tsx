import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useVideos } from '../hooks/useVideos';
import { buildQuery } from '../lib/query';
import { useLibrary } from '../store';
import type { VideoQuery, VideoRow } from '../types';
import { FolderCard, FolderListRow, toEntry, upEntry, type FolderEntry } from './FolderCard';
import { VideoCard } from './VideoCard';
import { VideoListRow } from './VideoListRow';

/** カード幅に対する 1 行の高さ(16:9 のサムネイル + 名前 2 行ぶん) */
const rowHeightForCard = (cardWidth: number) => Math.round(cardWidth * 0.5625) + 56;
/** 詳細リストの行の高さ */
const LIST_ROW_H = 44;
/**
 * Ctrl+A で選択できる上限。数万件を state に載せると Inspector の再描画が固まるため。
 * 超えたぶんは黙って捨てずにトーストで知らせる
 */
const SELECT_ALL_LIMIT = 1000;

export function VideoGrid() {
  const {
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed, version,
    viewMode, cardWidth, selection, anchorIndex, focusIndex,
    clearSelection, setSelection, setFocusIndex, selectOnly, playFromList, toggleDirPath,
    playerPath, playingVideo, showAiPanel, pushToast,
  } = useLibrary();

  const query = useMemo<VideoQuery>(() => buildQuery({
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed,
  }), [
    text, sort, folderId, dirPath, tagIds, seriesId, missingOnly, minRating, durationBucket,
    duplicatesOnly, advanced, randomSeed,
  ]);
  const { total, getVideo, getRange } = useVideos(query, version);

  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

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
  // リスト表示は 1 行 1 件。グリッドは幅から列数を出す(最低 1 列)
  const cols = list ? 1 : Math.max(1, Math.floor((width || cardWidth * 4) / cardWidth));
  const rowHeight = list ? LIST_ROW_H : rowHeightForCard(cardWidth);

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

  // キーボード操作。プレイヤー表示中と入力欄にフォーカスがある間は何もしない
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (playingVideo) return;
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
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playingVideo, showAiPanel, focusIndex, cols, total, moveFocus, selectAll, getVideo, play]);

  const selectedIds = useMemo(() => new Set(selection.map((v) => v.id)), [selection]);

  return (
    <div
      ref={parentRef}
      className={`grid-scroll ${list ? 'list-mode' : ''}`}
      onClick={(e) => {
        // カード以外の余白クリックで選択解除(フォルダは選択の対象外なので押しても解除する)
        const hit = (e.target as HTMLElement).closest('.card, .list-row');
        if (!hit || hit.classList.contains('folder-card') || hit.classList.contains('folder-row')) {
          clearSelection();
        }
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: rowHeight,
              transform: `translateY(${row.start}px)`,
              display: list ? 'block' : 'grid',
              gridTemplateColumns: list ? undefined : `repeat(${cols}, 1fr)`,
              gap: list ? undefined : 12,
              padding: '0 12px',
            }}
          >
            {Array.from({ length: cols }, (_, c) => {
              // 先頭の folderRows 行はフォルダ、その後ろが動画
              if (row.index < folderRows) {
                const entry = folderEntries[row.index * cols + c];
                if (!entry) return <div key={c} />;
                return list ? (
                  <FolderListRow key={c} entry={entry} onOpen={toggleDirPath} height={LIST_ROW_H} />
                ) : (
                  <FolderCard key={c} entry={entry} onOpen={toggleDirPath} />
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
              };
              return list ? (
                <VideoListRow key={c} {...props} height={LIST_ROW_H} />
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
  );
}
