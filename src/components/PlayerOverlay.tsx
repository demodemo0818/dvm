import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';

/**
 * アプリ内プレイヤー(全画面オーバーレイ)。
 * WebView2 で再生できない形式(HEVC の mp4 など)は onError で
 * 外部プレイヤー(OS 既定)へ自動フォールバックする。
 */
export function PlayerOverlay() {
  const { playingVideo, setPlayingVideo, bumpVersion } = useLibrary();
  const counted = useRef(false);
  const playingId = playingVideo?.id;
  useEffect(() => {
    counted.current = false;
  }, [playingId]);
  if (!playingVideo) return null;

  const close = () => setPlayingVideo(null);

  return (
    <div className="player-overlay" onClick={close}>
      <div className="player-inner" onClick={(e) => e.stopPropagation()}>
        <video
          src={convertFileSrc(playingVideo.path)}
          controls
          autoPlay
          onPlaying={() => {
            // 再生に成功したときだけ視聴カウント(フォールバック時の二重カウント防止)
            if (!counted.current) {
              counted.current = true;
              api.markViewed(playingVideo.id).then(() => bumpVersion());
            }
          }}
          onError={() => {
            // WebView2 非対応形式 → OS 既定プレイヤーへ(カウントは open_video 側)
            close();
            api.openVideo(playingVideo.id);
          }}
        />
        <div className="player-title" title={playingVideo.path}>
          {playingVideo.title ?? playingVideo.filename}
        </div>
        <button className="player-close" onClick={close} title="閉じる (Esc)">
          ✕
        </button>
      </div>
    </div>
  );
}
