import { useEffect } from 'react';
import type { VideoPlayer } from './types';
import { useAutoplayToggle, useRepeatToggle } from './usePlayQueue';

/**
 * プレイヤーのキーボードショートカット(両エンジン共用)。
 * Space/K=再生⇄停止、←→=±10秒、↑↓=音量±10%、M=ミュート、F=フルスクリーン、
 * < >=速度、A=連続再生の切替(v1.12)、R=リピート再生の切替(v1.13)、
 * U=表示サイズ 等倍⇄フィット(v1.12、mpv のみ)、
 * Esc=onEscape(フルスクリーン解除か閉じるかは呼び出し側が決める)
 */
export function usePlayerShortcuts(
  player: VideoPlayer,
  opts: {
    onEscape: () => void;
    toggleFullscreen: () => void;
    /** ショートカット操作でコントロールを再表示する */
    wake: () => void;
    /** 連続再生の前後移動(N / P)。単発再生なら省略 */
    onNext?: () => void;
    onPrev?: () => void;
    /** 現在位置をサムネイルにする(T) */
    onSetThumbnail?: () => void;
  },
) {
  const { togglePlay, seekBy, changeVolume, toggleMute, cycleRate, toggleUnscaled } = player;
  const { onEscape, toggleFullscreen, wake, onNext, onPrev, onSetThumbnail } = opts;
  // 連続再生・リピートは engine ごとに実装が変わらないので、opts を経由せず直接取る
  const { toggle: toggleAutoplay } = useAutoplayToggle();
  const { toggle: toggleRepeat } = useRepeatToggle();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscape();
        return;
      }
      // スライダーや速度メニューにフォーカスがある間は要素側の操作を優先する
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekBy(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolume(-0.1);
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case '<':
          cycleRate(-1);
          break;
        case '>':
          cycleRate(1);
          break;
        case 'n':
        case 'N':
          onNext?.();
          break;
        case 'p':
        case 'P':
          onPrev?.();
          break;
        case 't':
        case 'T':
          onSetThumbnail?.();
          break;
        // U / A / R は修飾キー付きを除ける(v1.12)。特に Ctrl+A(全選択)や Ctrl+R
        // (再読み込み)は手が覚えているので、うっかり設定を書き換えないようにする
        case 'u':
        case 'U':
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          // mpv のみ。未対応エンジンでは undefined なので何も起きない
          toggleUnscaled?.();
          break;
        case 'a':
        case 'A':
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          toggleAutoplay();
          break;
        case 'r':
        case 'R':
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          toggleRepeat();
          break;
        default:
          return;
      }
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    onEscape, toggleFullscreen, wake, togglePlay, seekBy, changeVolume, toggleMute, cycleRate,
    onNext, onPrev, onSetThumbnail, toggleUnscaled, toggleAutoplay, toggleRepeat,
  ]);
}
