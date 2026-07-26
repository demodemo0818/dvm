import { convertFileSrc } from '@tauri-apps/api/core';
import { useRef, useState } from 'react';
import { fmtTime } from '../lib/format';
import type { VideoRow } from '../types';

/**
 * カードのサムネイル上に重ねるホバープレビュー。
 *
 * 元動画をそのまま <video> に渡す(プレビュー用の生成キャッシュは持たない)。
 * WebView2 は Chromium なので mkv / HEVC もそのまま再生できる(v1.6 で実測確認)。
 * 再生できない形式は onError で静かに諦め、下のサムネイルを見せたままにする。
 *
 * マウスの X 位置でシーンを送る。シーク中に次の要求が来たら最後の 1 つだけ覚えておき、
 * seeked で反映する(移動のたびに currentTime を叩くと外付け HDD / NAS で詰まるため)。
 */
export function HoverPreview({ video }: { video: VideoRow }) {
  const pending = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  // バーと時間表示は state を通さず直接書き換える。
  // マウス移動のたびに再レンダーすると仮想化グリッドで無駄が大きいため
  const render = (cur: number, dur: number) => {
    if (!Number.isFinite(dur) || dur <= 0) return;
    const ratio = Math.min(Math.max(cur / dur, 0), 1);
    if (barRef.current) barRef.current.style.width = `${ratio * 100}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  };

  const seek = (el: HTMLVideoElement, t: number) => {
    // 実際のシーク完了を待たずに表示だけ先に動かす(マウスへの追従を優先)
    render(t, el.duration);
    if (el.seeking) {
      pending.current = t;
      return;
    }
    el.currentTime = t;
  };

  return (
    <>
      <video
        className="hover-preview"
        src={convertFileSrc(video.path)}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onMouseMove={(e) => {
          const el = e.currentTarget;
          if (!Number.isFinite(el.duration) || el.duration <= 0) return;
          const r = el.getBoundingClientRect();
          const ratio = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
          seek(el, el.duration * ratio);
        }}
        onLoadedMetadata={(e) => render(0, e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          // 再生の進行にあわせて更新(スクラブ中は seek 側が先に動かしている)
          const el = e.currentTarget;
          if (!el.seeking) render(el.currentTime, el.duration);
        }}
        onSeeked={(e) => {
          if (pending.current == null) return;
          const t = pending.current;
          pending.current = null;
          seek(e.currentTarget, t);
        }}
        onError={() => setFailed(true)}
      />
      <div className="preview-bar">
        <div ref={barRef} />
      </div>
      <span className="badge preview-time" ref={timeRef} />
    </>
  );
}
