import { convertFileSrc } from '@tauri-apps/api/core';
import { api } from '../api';
import { useLibrary } from '../store';
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
  const { selection, selectOnly, toggleSelect, playerPath, setPlayingVideo } = useLibrary();
  if (!video) return <div className="card card-loading" />;

  const selected = selection.some((v) => v.id === video.id);
  const openable = !video.isMissing && !video.isOffline;

  const play = () => {
    if (!openable) return;
    // 外部プレイヤー設定があれば従来通り外部。無ければアプリ内再生
    // (native はそのまま、remux/transcode は FFmpeg で変換してから再生)
    if (playerPath.trim() === '') {
      setPlayingVideo(video);
    } else {
      api.openVideo(video.id);
    }
  };
  return (
    <div
      className={`card ${selected ? 'selected' : ''}`}
      title={video.path}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) toggleSelect(video);
        else selectOnly(video);
      }}
      onDoubleClick={play}
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
        {video.resumeMs > 0 && video.durationMs ? (
          <div className="resume-bar">
            <div style={{ width: `${Math.min((video.resumeMs / video.durationMs) * 100, 100)}%` }} />
          </div>
        ) : null}
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
