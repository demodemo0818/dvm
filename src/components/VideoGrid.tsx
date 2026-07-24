import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVideos } from '../hooks/useVideos';
import { useLibrary } from '../store';
import type { VideoQuery } from '../types';
import { VideoCard } from './VideoCard';

const CARD_W = 224; // カード幅 + ギャップの目安
const CARD_H = 210; // 1 行の高さ

export function VideoGrid() {
  const { text, sort, folderId, tagIds, seriesId, version, clearSelection } = useLibrary();
  const query = useMemo<VideoQuery>(
    () => ({
      text: text || undefined,
      sort,
      folderId,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      seriesId,
    }),
    [text, sort, folderId, tagIds, seriesId],
  );
  const { total, getVideo } = useVideos(query, version);

  const parentRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => setCols(Math.max(2, Math.floor(el.clientWidth / CARD_W)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.ceil(total / cols);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_H,
    overscan: 4,
  });

  return (
    <div
      ref={parentRef}
      className="grid-scroll"
      onClick={(e) => {
        // カード以外の余白クリックで選択解除
        if (!(e.target as HTMLElement).closest('.card')) clearSelection();
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
              height: CARD_H,
              transform: `translateY(${row.start}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 12,
              padding: '0 12px',
            }}
          >
            {Array.from({ length: cols }, (_, c) => {
              const index = row.index * cols + c;
              if (index >= total) return <div key={c} />;
              return <VideoCard key={c} video={getVideo(index)} />;
            })}
          </div>
        ))}
      </div>
      {total === 0 && (
        <div className="empty-hint">
          左の「+ フォルダを追加」から動画フォルダを登録するか、
          <br />
          動画ファイルをこのウィンドウにドロップしてください
        </div>
      )}
    </div>
  );
}
