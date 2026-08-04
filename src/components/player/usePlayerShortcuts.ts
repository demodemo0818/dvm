import { useEffect } from 'react';
import { useLibrary } from '../../store';
import type { VideoPlayer } from './types';
import { useAutoplayToggle, useRepeatToggle } from './usePlayQueue';

/**
 * プレイヤーのキーボードショートカット(両エンジン共用)。
 * Space/K=再生⇄停止、←→=±10秒、↑↓=音量±10%、M=ミュート、F=フルスクリーン、
 * < >=速度、A=連続再生の切替(v1.12)、R=リピート再生の切替(v1.13)、
 * Ctrl+←→ / PageUp・PageDown=前後のチャプター(v1.29、mpv のみ)、
 * U=表示サイズ 等倍⇄フィット(v1.12、mpv のみ)、
 * T=この位置をサムネイルに(v1.8)、S=このコマを画像として保存(v1.26)、
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
    /** 今見ているコマを画像として保存する(S、v1.26) */
    onSaveFrame?: () => void;
    /**
     * 真の間はすべてのキーを無視する(v1.24)。
     * 字幕設定パネルのように、入力欄が並んでいて Esc を自前で処理したい UI 用
     */
    suspended?: boolean;
  },
) {
  const { togglePlay, seekBy, changeVolume, toggleMute, cycleRate, toggleUnscaled, jumpChapter } =
    player;
  const { onEscape, toggleFullscreen, wake, onNext, onPrev, onSetThumbnail, onSaveFrame, suspended } =
    opts;
  // 連続再生・リピートは engine ごとに実装が変わらないので、opts を経由せず直接取る
  const { toggle: toggleAutoplay } = useAutoplayToggle();
  const { toggle: toggleRepeat } = useRepeatToggle();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * 右クリックメニューが開いている間のキーはメニュー側が処理する(v1.20)。
       * ContextMenu の stopPropagation は React のルートまでしか効かないので、
       * メニューがフォーカスを失っていると window まで届いてしまう。
       * **Esc の分岐より前に置くこと** — 後ろだと Esc でプレイヤーごと閉じる
       */
      if (useLibrary.getState().contextMenuOpen) return;
      // 字幕設定パネル等を開いている間は全キーを譲る(v1.24)。
      // **contextMenuOpen と同じくここに置く** — Esc の分岐より後ろだと、
      // パネルを閉じるつもりの Esc でプレイヤーごと閉じてしまう
      if (suspended) return;
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
        /*
         * ←→ は 10 秒シーク、**Ctrl 付きは前後のチャプター**(v1.29)。
         * Ctrl の分岐をここに書かないと、チャプターへ飛んだうえに 10 秒ぶん
         * ずれてしまう(同じ case を 2 つの操作が通るため)。
         * mpv 以外のエンジンでは jumpChapter が undefined なので何も起きない
         */
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey) jumpChapter?.(-1);
          else if (!e.altKey && !e.metaKey) seekBy(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey) jumpChapter?.(1);
          else if (!e.altKey && !e.metaKey) seekBy(10);
          break;
        // mpv 本体と同じ割り当て。他のプレイヤーから来た手が覚えている
        case 'PageUp':
          e.preventDefault();
          jumpChapter?.(-1);
          break;
        case 'PageDown':
          e.preventDefault();
          jumpChapter?.(1);
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
        // S も修飾キー付きを除ける(v1.26)。**Ctrl+S は「保存」として手が最も覚えている**ので、
        // うっかり押したときに画像が増えないようにする
        case 's':
        case 'S':
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          onSaveFrame?.();
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
    onNext, onPrev, onSetThumbnail, onSaveFrame, toggleUnscaled, toggleAutoplay, toggleRepeat,
    jumpChapter, suspended,
  ]);
}
