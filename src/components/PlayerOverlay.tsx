import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { decidePlayback } from '../lib/playback';
import type { PlayMode } from '../lib/playback';
import { useLibrary } from '../store';
import { ContextMenu } from './ContextMenu';
import { ensureMpv } from './player/mpv';
import { MpvPlayerView } from './player/MpvPlayerView';
import { PlayerControls } from './player/PlayerControls';
import { resumeValueMs, shouldCountView } from './player/types';
import { usePlayerMenu } from './player/usePlayerMenu';
import { usePlayerShortcuts } from './player/usePlayerShortcuts';
import { usePlayQueue } from './player/usePlayQueue';
import { useVideoPlayer } from './player/useVideoPlayer';
import type { TranscodeProgress, VideoRow } from '../types';

/**
 * アプリ内プレイヤー(全画面オーバーレイ)。
 * エンジンは 2 系統:
 * - mpv(優先): ほぼ全フォーマットを変換なしで直接再生
 * - WebView2 <video>(フォールバック): mpv init 失敗・再生エラー時。
 *   v1.4 の 3 段判定(native / remux / transcode)+ FFmpeg 変換パイプラインで再生
 */
export function PlayerOverlay() {
  const playingVideo = useLibrary((s) => s.playingVideo);
  if (!playingVideo) return null;
  // key で動画切替時に内部状態(視聴カウント・コントロール類)をリセットする
  return <PlayerView key={playingVideo.id} video={playingVideo} />;
}

function PlayerView({ video }: { video: VideoRow }) {
  // mpv が使えるかは初回再生時に一度だけ判定される(ensureMpv がセッションキャッシュ)
  const [engine, setEngine] = useState<'pending' | 'mpv' | 'html5'>('pending');
  useEffect(() => {
    let alive = true;
    ensureMpv().then((ok) => {
      if (alive) setEngine(ok ? 'mpv' : 'html5');
    });
    return () => {
      alive = false;
    };
  }, []);

  if (engine === 'pending') return null; // 初回のみ数百 ms
  if (engine === 'mpv') return <MpvPlayerView video={video} onFail={() => setEngine('html5')} />;
  return <Html5PlayerView video={video} />;
}

/**
 * WebView2 <video> エンジン(v1.4 実装)。
 * WebView2 で直接再生できない形式(mkv/HEVC 等)は FFmpeg で mp4 に変換してから再生する。
 * ネイティブ再生に失敗したら transcode へ切り替え、それでも失敗したら外部プレイヤーへ。
 */
function Html5PlayerView({ video }: { video: VideoRow }) {
  const { setPlayingVideo, bumpVersion, autoplayNext, repeatOne, pushToast } = useLibrary();
  const queue = usePlayQueue();
  const videoRef = useRef<HTMLVideoElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const counted = useRef(false);
  // 視聴履歴の行(v1.18)。id ではなく Promise を持つ —— markOpened の応答が返る前に
  // 閉じられても、解決してから finishView を投げられるようにするため
  const history = useRef<Promise<number> | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // 再生方式: native はそのまま、remux/transcode は FFmpeg で変換してから再生。
  // native の onError で transcode に切り替える(HEVC 拡張の誤検出などもアプリ内で完結)
  const [mode, setMode] = useState<PlayMode>(() => decidePlayback(video));
  const [src, setSrc] = useState<string | null>(() =>
    decidePlayback(video) === 'native' ? convertFileSrc(video.path) : null,
  );
  const [progress, setProgress] = useState<number | null>(null);
  const [prepareMsg, setPrepareMsg] = useState('変換の準備中…');

  const player = useVideoPlayer(videoRef, src ?? '');

  // remux/transcode: 変換を実行し、完了したらキャッシュ mp4 を再生する
  useEffect(() => {
    if (mode === 'native') return;
    let aborted = false;
    let done = false;
    setSrc(null);
    setProgress(null);
    setPrepareMsg(mode === 'remux' ? '再生の準備中…' : '動画を変換中…');

    const unlisten = listen<TranscodeProgress>('transcode:progress', (e) => {
      if (e.payload.videoId !== video.id) return;
      setProgress(e.payload.percent);
      setPrepareMsg(e.payload.message);
    });
    api
      .prepareVideo(video.id, mode)
      .then((cachePath) => {
        done = true;
        if (!aborted) setSrc(convertFileSrc(cachePath));
      })
      .catch(() => {
        done = true;
        if (aborted) return;
        if (mode === 'remux') {
          // コンテナ詰め替えで通らないファイル → 再エンコードで再試行
          setMode('transcode');
          return;
        }
        // 変換失敗 → 従来通り外部プレイヤーへ
        useLibrary.getState().setPlayingVideo(null);
        api.openVideo(video.id);
      });
    return () => {
      aborted = true;
      unlisten.then((u) => u());
      // 準備中に閉じたら変換を中止する(完了後の呼び出しは何もしない)
      if (!done) void api.cancelPrepare();
    };
  }, [mode, video.id]);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setPlayingVideo(null);
  }, [setPlayingVideo]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void innerRef.current?.requestFullscreen();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // マウスが 2.5 秒止まったらコントロールを隠す(一時停止中は常時表示)
  const wake = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2500);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [wake]);

  // フルスクリーン中の Esc はブラウザが解除するので、通常時のみ閉じる
  const onEscape = useCallback(() => {
    if (!document.fullscreenElement) close();
  }, [close]);

  // 今見ているコマをサムネイルにする(10% 固定で暗転を引いたときの手当て)。
  // 変換キャッシュを再生している場合も尺は同じなので位置はそのまま使える
  const setThumbnail = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    api.setThumbTime(video.id, Math.floor(el.currentTime * 1000)).then(() => {
      pushToast('この位置をサムネイルにしました', 'info');
      bumpVersion();
    });
  }, [video.id, pushToast, bumpVersion]);

  usePlayerShortcuts(player, {
    onEscape,
    toggleFullscreen,
    wake,
    onNext: queue.next,
    onPrev: queue.prev,
    onSetThumbnail: setThumbnail,
  });

  const { menu, onContextMenu, close: closeMenu, run: runMenu } =
    usePlayerMenu(video, { wake, onSetThumbnail: setThumbnail, onClose: close });

  // レジューム保存: 5 秒ごと + 一時停止・終了時
  const lastSavedSec = useRef(0);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || src == null) return;
    const ready = () => Number.isFinite(el.duration) && el.duration > 0;
    const save = () => {
      if (!ready()) return;
      lastSavedSec.current = el.currentTime;
      void api.setResume(video.id, resumeValueMs(el.currentTime, el.duration));
    };
    const onTime = () => {
      if (Math.abs(el.currentTime - lastSavedSec.current) >= 5) save();
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('pause', save);
    el.addEventListener('ended', save);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('pause', save);
      el.removeEventListener('ended', save);
      // 閉じる時は必ず保存し、保存完了後にカードの進捗バーを更新する
      if (ready()) {
        api.setResume(video.id, resumeValueMs(el.currentTime, el.duration)).then(() => bumpVersion());
      }
      // 視聴履歴に到達位置を書き戻す(v1.18)。resumeValueMs は使わない ——
      // あれは 90% 超で 0 に丸めるので、最後まで観たときに「0 ms 観た」と記録されてしまう
      const h = history.current;
      if (h) void h.then((id) => api.finishView(id, Math.round(el.currentTime * 1000))).catch(() => {});
    };
  }, [video.id, src, bumpVersion]);

  const visible = controlsVisible || player.state.paused;

  return (
    <div className="player-overlay" onClick={close} onMouseMove={wake}>
      <div
        ref={innerRef}
        className={`player-inner ${visible ? '' : 'controls-hidden'}`}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={onContextMenu}
      >
        {src != null ? (
          <video
            ref={videoRef}
            src={src}
            autoPlay
            // リピート再生(v1.13)。loop が付いている間は onEnded が発火しないので、
            // 下の連続再生と自然に排他になる
            loop={repeatOne}
            onClick={player.togglePlay}
            onDoubleClick={toggleFullscreen}
            onLoadedMetadata={(e) => {
              // 前回の続きから再生(終端 5 秒以内は最初から)
              const el = e.currentTarget;
              const sec = video.resumeMs / 1000;
              if (video.resumeMs > 0 && sec < el.duration - 5) el.currentTime = sec;
            }}
            onPlaying={() => {
              // 視聴履歴(v1.18): 再生が成功した時点で 1 回だけ記録する。
              // **視聴カウントとは基準が違う** —— こちらは「開いてすぐ閉じた」ものも残す。
              // そうしないと「ちょっと開いて違うと思って閉じたやつ」を履歴から探し直せないため
              if (history.current !== null) return;
              history.current = api.markOpened(video.id);
              void history.current.then(() => bumpVersion()).catch(() => {});
            }}
            onTimeUpdate={(e) => {
              // 視聴カウント: 尺の 5% 以上 or 30 秒以上まで観たら 1 回だけ(v1.8)。
              // onPlaying で即カウントしていたが、開いてすぐ閉じても数えてしまっていた
              if (counted.current) return;
              const el = e.currentTarget;
              if (!shouldCountView(el.currentTime, el.duration)) return;
              counted.current = true;
              api.markViewed(video.id).then(() => bumpVersion());
            }}
            onEnded={() => {
              if (autoplayNext && queue.hasNext) void queue.next();
            }}
            onError={() => {
              if (mode === 'native') {
                // ネイティブ再生失敗 → 変換して再生し直す(アプリ内で完結)
                setMode('transcode');
              } else {
                // 変換済みキャッシュでも再生できない → OS 既定プレイヤーへ
                close();
                api.openVideo(video.id);
              }
            }}
          />
        ) : (
          <div className="player-preparing">
            <div className="player-preparing-msg">{prepareMsg}</div>
            {progress != null ? (
              <div className="prepare-bar">
                <div style={{ width: `${progress}%` }} />
              </div>
            ) : (
              <div className="spinner" />
            )}
          </div>
        )}
        <div className="player-top">
          <div className="player-title" title={video.path}>
            {video.title ?? video.filename}
          </div>
          <button className="player-close" onClick={close} title="閉じる (Esc)">
            <X />
          </button>
        </div>
        {src != null && (
          <PlayerControls
            player={player}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
            onSetThumbnail={setThumbnail}
            // 再生中と同じ src を使う。変換経路ならキャッシュ mp4 なので確実に読める
            previewSrc={src}
            queue={queue}
          />
        )}

        {/* **必ず .player-inner の内側**。全画面のトップレイヤーから外れると見えなくなる */}
        {menu && (
          <ContextMenu
            key={`${menu.x},${menu.y}`}
            x={menu.x}
            y={menu.y}
            entries={menu.entries}
            onClose={closeMenu}
            onSelect={(id) => void runMenu(id)}
          />
        )}
      </div>
    </div>
  );
}
