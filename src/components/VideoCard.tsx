import { convertFileSrc } from '@tauri-apps/api/core';
import { api } from '../api';
import type { VideoRow } from '../types';

function fmtDuration(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function VideoCard({ video }: { video?: VideoRow }) {
  if (!video) return <div className="card card-loading" />;

  const openable = !video.isMissing && !video.isOffline;
  return (
    <div
      className="card"
      title={video.path}
      onDoubleClick={() => {
        if (openable) api.openVideo(video.id);
      }}
    >
      <div className="thumb">
        {video.thumbPath ? (
          <img src={convertFileSrc(video.thumbPath)} loading="lazy" alt="" draggable={false} />
        ) : (
          <div className="thumb-placeholder">{video.thumbState === 2 ? '⚠' : '…'}</div>
        )}
        {video.durationMs != null && (
          <span className="badge duration">{fmtDuration(video.durationMs)}</span>
        )}
        {video.isOffline && <span className="badge offline">オフライン</span>}
        {video.isMissing && !video.isOffline && (
          <span className="badge missing">見つかりません</span>
        )}
      </div>
      <div className="card-name">{video.title ?? video.filename}</div>
      <div className="card-sub">
        {fmtSize(video.size)}
        {video.width && video.height ? ` ・ ${video.width}×${video.height}` : ''}
      </div>
    </div>
  );
}
