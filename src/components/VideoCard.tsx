import { convertFileSrc } from '@tauri-apps/api/core';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../lib/format';
import { useLibrary } from '../store';
import { HoverPreview } from './HoverPreview';
import type { VideoRowProps } from './rowProps';

/** この時間ホバーし続けたらプレビューを開始する(グリッドを撫でただけで再生しない) */
const HOVER_DELAY_MS = 400;

function fmtSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function VideoCard({
  video, index, selected, focused, onPick, onPlay, onContextMenu,
}: VideoRowProps) {
  const previewOnHover = useLibrary((s) => s.previewOnHover);
  const menuOpen = useLibrary((s) => s.contextMenuOpen);
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);

  // 仮想化で同じカードが別の動画に使い回されたときにプレビューを引きずらない
  useEffect(() => {
    setHovering(false);
    return () => window.clearTimeout(hoverTimer.current);
  }, [video?.id]);

  // 右クリックメニューを開いたらプレビューを止める。
  // メニューの裏で動画が鳴り続けるのを防ぐ(v1.14)
  useEffect(() => {
    if (!menuOpen) return;
    window.clearTimeout(hoverTimer.current);
    setHovering(false);
  }, [menuOpen]);

  if (!video) return <div className="card card-loading" />;

  const openable = !video.isMissing && !video.isOffline;

  return (
    <div
      className={`card ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      title={video.path}
      onClick={(e) => onPick(video, index, e)}
      onDoubleClick={() => onPlay(video, index)}
      onContextMenu={(e) => onContextMenu(video, index, e)}
    >
      <div
        className="thumb"
        onMouseEnter={() => {
          // オフライン・missing はファイルに触れないのでプレビューしない
          if (!previewOnHover || !openable || menuOpen) return;
          hoverTimer.current = window.setTimeout(() => setHovering(true), HOVER_DELAY_MS);
        }}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current);
          setHovering(false);
        }}
      >
        {/* 一覧クエリではサムネイルの実在確認をしていない(I/O 削減)。
            読めなかった img を隠して、下に敷いたプレースホルダを見せる */}
        <div className="thumb-placeholder">
          {video.thumbState === 2 ? <TriangleAlert size={22} /> : '…'}
        </div>
        {video.thumbPath && (
          <img
            key={video.id}
            src={convertFileSrc(video.thumbPath)}
            loading="lazy"
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        {hovering && <HoverPreview key={video.id} video={video} />}
        {/* プレビュー中は「現在位置 / 尺」を出すので、尺だけのバッジは隠す */}
        {!hovering && video.durationMs != null && (
          <span className="badge duration">{fmtTime(video.durationMs / 1000)}</span>
        )}
        {/* プレビュー中は再生位置バーが出るので、レジューム位置のバーは隠す */}
        {!hovering && video.resumeMs > 0 && video.durationMs ? (
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
