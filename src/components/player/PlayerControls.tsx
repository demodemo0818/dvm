import {
  GalleryThumbnails,
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat1,
  Scaling,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { fmtTime } from '../../lib/format';
import { RATE_OPTIONS } from './types';
import type { MediaTrack, VideoPlayer } from './types';
import { useAutoplayToggle, useRepeatToggle } from './usePlayQueue';
import type { PlayQueueControls } from './usePlayQueue';

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

/** mpv のときだけ出る音声・字幕トラックの選択 */
function TrackSelect({
  kind,
  label,
  tracks,
  onChange,
}: {
  kind: 'audio' | 'sub';
  label: string;
  tracks: MediaTrack[];
  onChange: (id: number | null) => void;
}) {
  const mine = tracks.filter((t) => t.kind === kind);
  // 音声は 1 本しかなければ選ばせる意味がない。字幕は「オフ」に切り替えたいので 1 本でも出す
  if (mine.length === 0 || (kind === 'audio' && mine.length < 2)) return null;
  const selected = mine.find((t) => t.selected);

  return (
    <select
      className="player-track"
      value={selected ? String(selected.id) : ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      title={label}
    >
      {kind === 'sub' && <option value="">字幕オフ</option>}
      {mine.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

export function PlayerControls({
  player,
  isFullscreen,
  onToggleFullscreen,
  onSetThumbnail,
  queue,
}: {
  player: VideoPlayer;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 今見ているコマをサムネイルにする。上のバーに置くと ✕ の誤爆が起きるのでここに置く */
  onSetThumbnail?: () => void;
  queue?: PlayQueueControls;
}) {
  const { state } = player;
  const { autoplayNext, toggle: toggleAutoplay } = useAutoplayToggle();
  const { repeatOne, toggle: toggleRepeat } = useRepeatToggle();
  // ボタンにフォーカスを残さない(スペース等のショートカットが二重発火しないように)
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="player-controls" onClick={(e) => e.stopPropagation()}>
      <SeekBar player={player} />
      <div className="player-buttons">
        {queue && (
          <button
            onMouseDown={noFocus}
            onClick={queue.prev}
            disabled={!queue.hasPrev}
            title="前の動画 (P)"
          >
            <SkipBack />
          </button>
        )}
        <button
          onMouseDown={noFocus}
          onClick={player.togglePlay}
          title={state.paused ? '再生 (Space)' : '一時停止 (Space)'}
        >
          {state.paused ? <Play /> : <Pause />}
        </button>
        {queue && (
          <button
            onMouseDown={noFocus}
            onClick={queue.next}
            disabled={!queue.hasNext}
            title="次の動画 (N)"
          >
            <SkipForward />
          </button>
        )}
        {/*
          連続再生の切替。設定 autoplay_next をその場で書き換える(engine 非依存なので
          両エンジンで出す)。単発再生でも隠さない — ⏮⏭ は「今のキューに前後があるか」
          という一時的な状態だから disabled にするが、こちらは永続設定なので
          消えると設定の在り処が分からなくなる。
          アイコンはプレイリスト(ListVideo)。以前はループ記号を使っていて、
          隣のリピートと見分けが付かなかった(v1.13)
        */}
        <button
          className={autoplayNext ? 'active' : ''}
          onMouseDown={noFocus}
          onClick={toggleAutoplay}
          title={
            autoplayNext
              ? '連続再生をオフにする (A)'
              : '連続再生をオンにする(最後まで再生したら次の動画へ)(A)'
          }
        >
          <ListVideo />
        </button>
        {/*
          リピート再生(v1.13)。1 本を繰り返すので Repeat1(ループに 1 が入った形)。
          リピート中は EOF が来ないので連続再生は発動しない = 排他制御は要らない
        */}
        <button
          className={repeatOne ? 'active' : ''}
          onMouseDown={noFocus}
          onClick={toggleRepeat}
          title={
            repeatOne
              ? 'リピート再生をオフにする (R)'
              : 'リピート再生をオンにする(この動画を繰り返す)(R)'
          }
        >
          <Repeat1 />
        </button>
        <span className="player-time">
          {fmtTime(state.currentTime)} / {fmtTime(state.duration)}
        </span>
        {queue?.position && <span className="player-position">{queue.position}</span>}
        <div className="player-spacer" />
        {player.tracks && player.setTrack && (
          <>
            <TrackSelect
              kind="audio"
              label="音声トラック"
              tracks={player.tracks}
              onChange={(id) => player.setTrack!('audio', id)}
            />
            <TrackSelect
              kind="sub"
              label="字幕"
              tracks={player.tracks}
              onChange={(id) => player.setTrack!('sub', id)}
            />
          </>
        )}
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
          {state.muted || state.volume === 0 ? <VolumeX /> : <Volume2 />}
        </button>
        <input
          className="player-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={state.muted ? 0 : state.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          // 左側の塗り。ネイティブの range は「ここまで塗る」を CSS だけでは表せない
          style={{ '--fill': `${(state.muted ? 0 : state.volume) * 100}%` } as React.CSSProperties}
          title="音量 (↑↓)"
        />
        {/*
          「この位置をサムネイルにする」。上のバーに置くと閉じるボタンの誤爆が起きるので
          こちら側に置いている(v1.11)
        */}
        {onSetThumbnail && (
          <button
            onMouseDown={noFocus}
            onClick={onSetThumbnail}
            title="この位置をサムネイルにする (T)"
          >
            {/* カメラは「撮影」に見えて紛らわしいので、サムネイル一覧の形にしている */}
            <GalleryThumbnails />
          </button>
        )}
        {/* 表示サイズ(mpv のみ)。両状態で同じアイコンを使うのでバーの幅が揺れない */}
        {player.toggleUnscaled && (
          <button
            className={player.unscaled ? 'active' : ''}
            onMouseDown={noFocus}
            onClick={player.toggleUnscaled}
            title={
              player.unscaled
                ? 'ウィンドウにフィットさせる (U)'
                : '元のサイズ(等倍)で表示する — 小さい動画を拡大しない (U)'
            }
          >
            <Scaling />
          </button>
        )}
        <button onMouseDown={noFocus} onClick={onToggleFullscreen} title="フルスクリーン (F)">
          {isFullscreen ? <Minimize /> : <Maximize />}
        </button>
      </div>
    </div>
  );
}
