import { useRef, useState } from 'react';
import { fmtTime } from '../../lib/format';
import { RATE_OPTIONS } from './types';
import type { VideoPlayer } from './types';

/** バッファ帯付きシークバー。ドラッグ中はプレビュー位置を表示し、離した時にシークする */
function SeekBar({ player }: { player: VideoPlayer }) {
  const { state, seekTo } = player;
  const barRef = useRef<HTMLDivElement>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);

  const timeFromEvent = (clientX: number): number => {
    const rect = barRef.current!.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    return ratio * state.duration;
  };

  const pos = dragTime ?? state.currentTime;
  const playedPct = state.duration > 0 ? (pos / state.duration) * 100 : 0;
  const bufferedPct = state.duration > 0 ? (state.bufferedEnd / state.duration) * 100 : 0;

  return (
    <div
      ref={barRef}
      className="seekbar"
      onPointerDown={(e) => {
        if (state.duration <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragTime(timeFromEvent(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragTime != null) setDragTime(timeFromEvent(e.clientX));
      }}
      onPointerUp={(e) => {
        if (dragTime == null) return;
        seekTo(timeFromEvent(e.clientX));
        setDragTime(null);
      }}
    >
      <div className="seekbar-track">
        <div className="seekbar-buffered" style={{ width: `${bufferedPct}%` }} />
        <div className="seekbar-played" style={{ width: `${playedPct}%` }} />
      </div>
    </div>
  );
}

export function PlayerControls({
  player,
  isFullscreen,
  onToggleFullscreen,
}: {
  player: VideoPlayer;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { state } = player;
  // ボタンにフォーカスを残さない(スペース等のショートカットが二重発火しないように)
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="player-controls" onClick={(e) => e.stopPropagation()}>
      <SeekBar player={player} />
      <div className="player-buttons">
        <button
          onMouseDown={noFocus}
          onClick={player.togglePlay}
          title={state.paused ? '再生 (Space)' : '一時停止 (Space)'}
        >
          {state.paused ? '▶' : '❚❚'}
        </button>
        <span className="player-time">
          {fmtTime(state.currentTime)} / {fmtTime(state.duration)}
        </span>
        <div className="player-spacer" />
        <select
          className="player-rate"
          value={state.rate}
          onChange={(e) => player.setRate(Number(e.target.value))}
          title="再生速度 (< >)"
        >
          {RATE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>
        <button onMouseDown={noFocus} onClick={player.toggleMute} title="ミュート (M)">
          {state.muted || state.volume === 0 ? '🔇' : '🔊'}
        </button>
        <input
          className="player-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={state.muted ? 0 : state.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          title="音量 (↑↓)"
        />
        <button onMouseDown={noFocus} onClick={onToggleFullscreen} title="フルスクリーン (F)">
          {isFullscreen ? '🗗' : '⛶'}
        </button>
      </div>
    </div>
  );
}
