import {
  Camera,
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
  Subtitles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { chapterLabelAt, hasChapters } from '../../lib/chapters';
import { fmtTime } from '../../lib/format';
import { hdrTooltip } from '../../lib/hdrInfo';
import { useLibrary } from '../../store';
import { QueuePanel } from '../queue/QueuePanel';
import { ChapterList } from './ChapterList';
import { SeekPreview } from './SeekPreview';
import { RATE_OPTIONS } from './types';
import type { MediaTrack, VideoPlayer } from './types';
import { useAutoplayToggle, useRepeatToggle } from './usePlayQueue';
import type { PlayQueueControls } from './usePlayQueue';

/** コマ出しの幅(px)。CSS の .seek-preview-video と合わせること(端の回り込みに使う) */
const PREVIEW_W = 160;
/**
 * バーに乗ってからコマを読みに行くまでの待ち(ms)。
 * ボタンへ向かう途中でバーを横切っただけで、外付け HDD を起こさないための猶予
 */
const PREVIEW_DELAY_MS = 80;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * バッファ帯付きシークバー。ドラッグ中はプレビュー位置を表示し、離した時にシークする。
 * カーソルを合わせるとその位置の時刻と**コマ**を出す(v1.14)
 */
function SeekBar({ player, previewSrc }: { player: VideoPlayer; previewSrc?: string }) {
  const { state, seekTo } = player;
  const seekPreview = useLibrary((s) => s.seekPreview);
  const barRef = useRef<HTMLDivElement>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  /** カーソル位置。left はバー左端からの px(コマが画面外へ出ないよう寄せてある) */
  const [hover, setHover] = useState<{ time: number; left: number } | null>(null);
  /** 待ち時間を過ぎて、実際にコマを読みに行ってよいか */
  const [loadPreview, setLoadPreview] = useState(false);

  const hovering = hover != null;
  useEffect(() => {
    if (!hovering) {
      setLoadPreview(false);
      return;
    }
    const t = window.setTimeout(() => setLoadPreview(true), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [hovering]);

  const timeFromEvent = (clientX: number): number => {
    const rect = barRef.current!.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * state.duration;
  };

  const updateHover = (clientX: number) => {
    if (state.duration <= 0) return;
    const rect = barRef.current!.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    setHover({
      time: ratio * state.duration,
      left: clamp(ratio * rect.width, PREVIEW_W / 2, rect.width - PREVIEW_W / 2),
    });
  };

  const pos = dragTime ?? state.currentTime;
  const playedPct = state.duration > 0 ? (pos / state.duration) * 100 : 0;
  const bufferedPct = state.duration > 0 ? (state.bufferedEnd / state.duration) * 100 : 0;

  // チャプター(v1.29、mpv のみ)。0:00 の目盛りは左端に埋もれるだけなので出さない
  const chapters = player.chapters ?? [];
  const marks = hasChapters(chapters) && state.duration > 0 ? chapters.filter((c) => c.time > 0) : [];
  const hoverChapter = hover && hasChapters(chapters) ? chapterLabelAt(chapters, hover.time) : null;

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
        updateHover(e.clientX);
      }}
      onPointerUp={(e) => {
        if (dragTime == null) return;
        seekTo(timeFromEvent(e.clientX));
        setDragTime(null);
        // ドラッグ中はポインタを捕まえているので pointerleave が来ない。
        // バーの外で離したならここで消す
        const r = barRef.current!.getBoundingClientRect();
        const inside =
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) setHover(null);
      }}
      onPointerLeave={() => {
        // ドラッグ中の離脱では消さない(掴んだまま外へ振っても位置を見せ続ける)
        if (dragTime == null) setHover(null);
      }}
    >
      {hover && state.duration > 0 && (
        <div className="seek-preview" style={{ left: hover.left }}>
          {/* 設定オフ・src 無し・読み込み前は時刻だけ出す(枠は出さない) */}
          {seekPreview && previewSrc && loadPreview && (
            <SeekPreview src={previewSrc} time={hover.time} />
          )}
          <span className="seek-preview-time">{fmtTime(hover.time)}</span>
          {/* 目盛りが見えている以上「この先は何のシーンか」を確かめたくなる(v1.29) */}
          {hoverChapter && <span className="seek-preview-chapter">{hoverChapter}</span>}
        </div>
      )}
      <div className="seekbar-track">
        <div className="seekbar-buffered" style={{ width: `${bufferedPct}%` }} />
        <div className="seekbar-played" style={{ width: `${playedPct}%` }} />
        {/* 再生済みの帯より後ろに置く(青く塗った上でも区切りが見えるように) */}
        {marks.map((c) => (
          <div
            key={c.time}
            className="seekbar-chapter"
            style={{ left: `${(c.time / state.duration) * 100}%` }}
          />
        ))}
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
  onSaveFrame,
  previewSrc,
  queue,
  onOpenSubtitleStyle,
  subtitleStyleOpen = false,
  chaptersOpen = false,
  onToggleChapters,
  queueOpen = false,
  onToggleQueue,
  queueCount = 0,
}: {
  player: VideoPlayer;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 今見ているコマをサムネイルにする。上のバーに置くと ✕ の誤爆が起きるのでここに置く */
  onSetThumbnail?: () => void;
  /** 今見ているコマを画像として保存する(v1.26)。撮影系なので隣に並べる */
  onSaveFrame?: () => void;
  /**
   * シークバーのコマ出しに使う src(v1.14)。
   * WebView2 経路では再生中と同じもの(変換済みなら変換キャッシュ)を渡す。
   * mpv 経路では元動画そのもの — WebView2 が読めない形式なら静かに諦める
   */
  previewSrc?: string;
  queue?: PlayQueueControls;
  /**
   * 字幕の見た目パネルの開閉(v1.24)。mpv 経路だけが渡す —
   * WebView2 側は変換で字幕を落とすので、そもそも出す意味がない
   */
  onOpenSubtitleStyle?: () => void;
  subtitleStyleOpen?: boolean;
  /**
   * チャプター一覧の開閉(v1.29)。字幕パネルと同じく**状態は呼び出し側が持つ** ——
   * 開いている間はコントロールバーを隠せないし、Esc は一覧だけを閉じたいため
   */
  chaptersOpen?: boolean;
  onToggleChapters?: () => void;
  /**
   * 再生キューの開閉(v1.40)。チャプター・字幕パネルと同じく**状態は呼び出し側が持つ**。
   * 開いている間はコントロールバーを隠せないし、Esc はパネルだけを閉じたい
   */
  queueOpen?: boolean;
  onToggleQueue?: () => void;
  /** ボタンに出す件数バッジ。0 のときは出さない */
  queueCount?: number;
}) {
  const { state } = player;
  const { autoplayNext, toggle: toggleAutoplay } = useAutoplayToggle();
  const { repeatOne, toggle: toggleRepeat } = useRepeatToggle();
  // HDR バッジ(v1.31)。パススルーの状態で見た目と説明を変える
  const hdrPassthrough = useLibrary((s) => s.hdrPassthrough);
  // ボタンにフォーカスを残さない(スペース等のショートカットが二重発火しないように)
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="player-controls" onClick={(e) => e.stopPropagation()}>
      <SeekBar player={player} previewSrc={previewSrc} />
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
        {/*
          位置表示。**キューモードではアイコンを添える**(v1.40) ——
          数字だけだと「絞り込み結果の中の 3 / 12」なのか
          「手で並べたキューの 3 / 12」なのかが読み取れない
        */}
        {queue?.position && (
          <span className={`player-position ${queue.inQueue ? 'in-queue' : ''}`}>
            {queue.inQueue && <ListVideo />}
            {queue.position}
          </span>
        )}
        {/*
          HDR バッジ(v1.31)。時刻の隣に置く —— 「今流れているものの説明」で、
          右側の操作ボタン群とは性質が違う。SDR の動画では何も出さない
        */}
        {player.hdr && (
          <span
            /*
              色は**設定ではなく実際の出力**で決める(v1.31)。設定がオンでも
              Windows 側が HDR モードでなければ mpv はトーンマップしており、
              そこで青くすると「HDR で見えている」と嘘をつくことになる
            */
            className={`player-hdr ${player.hdrOutput ? 'passthrough' : ''}`}
            title={hdrTooltip(player.hdr, player.hdrOutput === true, hdrPassthrough)}
          >
            {player.hdr.short}
          </span>
        )}
        <div className="player-spacer" />
        {/*
          再生キュー(v1.40)。**再生中は `.app` ごと消える**ので、再生中に並べ替え・削除を
          するにはここから開くしかない(ChapterList と同じ制約・同じ作法)。
          中身は右ペインのキュータブとまったく同じコンポーネント
        */}
        {onToggleQueue && (
          <div className="queue-anchor">
            <button
              className={queueOpen ? 'active' : ''}
              onMouseDown={noFocus}
              onClick={onToggleQueue}
              title="再生キュー(並べ替え・削除)(Q)"
            >
              <ListVideo />
              {queueCount > 0 && <span className="queue-badge">{queueCount}</span>}
            </button>
            {queueOpen && (
              <div className="queue-popover">
                <QueuePanel compact />
              </div>
            )}
          </div>
        )}
        {/*
          チャプター(v1.29)。音声・字幕の選択と同じ「この動画の中身から選ぶもの」の
          一角に置く。チャプターが 2 つ未満のファイルでは ChapterList 側が何も描かない
        */}
        {player.chapters && onToggleChapters && (
          <ChapterList
            chapters={player.chapters}
            currentTime={state.currentTime}
            open={chaptersOpen}
            onToggle={onToggleChapters}
            onSeek={player.seekTo}
          />
        )}
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
        {/*
          字幕の見た目(v1.24)。字幕トラックの select の隣に置く —
          「字幕まわりの操作はこの一角にある」と一目で分かるようにするため
        */}
        {onOpenSubtitleStyle && (
          <button
            className={subtitleStyleOpen ? 'active' : ''}
            onMouseDown={noFocus}
            onClick={onOpenSubtitleStyle}
            title="字幕の見た目(フォント・サイズ・色・縁取り)を変える"
          >
            <Subtitles />
          </button>
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
            {/*
              カメラは隣の「画像として保存」(v1.26)が使う。
              こちらは一覧に出る絵を決める操作なので、サムネイル一覧の形にしている
            */}
            <GalleryThumbnails />
          </button>
        )}
        {/*
          「このコマを画像として保存」(v1.26)。サムネイル指定の隣に置いて
          「この一角は絵まわり」と読めるようにしている。輪郭が全く違うアイコンなので
          隣り合っていても取り違えない
        */}
        {onSaveFrame && (
          <button
            onMouseDown={noFocus}
            onClick={onSaveFrame}
            title="このコマを画像として保存する (S)"
          >
            <Camera />
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
