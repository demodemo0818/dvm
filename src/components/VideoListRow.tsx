import { convertFileSrc } from '@tauri-apps/api/core';
import { fmtTime } from '../lib/format';
import type { VideoRowProps } from './rowProps';

function fmtSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${(bytes / MB).toFixed(0)} MB`;
}

/**
 * 詳細リスト表示の 1 行(v1.8)。グリッドと同じ仮想化に乗るので、
 * 数万件でも DOM に載るのは可視分だけ。
 * ホバープレビューは付けない — 行が細く、マウスが横切るだけで次々に
 * 元動画を開くことになるため(グリッドのカードは面積が大きいので誤爆しにくい)
 */
export function VideoListRow({
  video, index, selected, focused, onPick, onPlay, onContextMenu, height,
}: VideoRowProps & { height: number }) {
  if (!video) return <div className="list-row list-loading" style={{ height }} />;

  return (
    <div
      className={`list-row ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      style={{ height }}
      title={video.path}
      onClick={(e) => onPick(video, index, e)}
      onDoubleClick={() => onPlay(video, index)}
      onContextMenu={(e) => onContextMenu(video, index, e)}
    >
      <div className="list-thumb">
        {video.thumbPath ? (
          <img
            src={convertFileSrc(video.thumbPath)}
            loading="lazy"
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
        ) : null}
      </div>
      <div className="list-name">
        {video.title ?? video.filename}
        {video.isOffline && <span className="list-flag offline">オフライン</span>}
        {video.isMissing && !video.isOffline && (
          <span className="list-flag missing">見つかりません</span>
        )}
      </div>
      <div className="list-col list-duration">
        {video.durationMs != null ? fmtTime(video.durationMs / 1000) : '—'}
      </div>
      <div className="list-col list-size">{fmtSize(video.size)}</div>
      <div className="list-col list-res">
        {video.width && video.height ? `${video.width}×${video.height}` : '—'}
      </div>
      <div className="list-col list-rating">{video.rating > 0 ? '★'.repeat(video.rating) : ''}</div>
      <div className="list-col list-added">{video.addedAt.slice(0, 10)}</div>
    </div>
  );
}
