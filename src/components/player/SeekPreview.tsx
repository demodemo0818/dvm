import { useEffect, useRef, useState } from 'react';

/**
 * シークバーのコマ出し(v1.14)。
 *
 * **見えない `<video>` をもう 1 本持ち、`currentTime` を動かしてそのコマを見せる**。
 * スプライトシートの事前生成はしない — カードのホバープレビューと同じ判断で、
 * ライブラリ 1 万件ぶんのキャッシュを持たずに済ませる(DESIGN.md「生成キャッシュを持たない理由」)。
 *
 * 代償として、mpv で再生している最中に WebView2 が同じファイルをもう 1 本デコードする。
 * 重いと感じたら設定「シークバーにカーソルを合わせるとコマを表示する」で切れる。
 *
 * 再生できない形式(WebView2 が扱えないコーデック)は `onError` で静かに諦め、
 * 呼び出し側の時刻表示だけを残す。
 */
export function SeekPreview({ src, time }: { src: string; time: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  /** シーク中に来た最後の要求。seeked で反映する */
  const pending = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);

  // 実際のシークが終わる前に次の位置を叩くと、外付け HDD / NAS で詰まる。
  // 最後の 1 つだけ覚えておいて seeked で追いつかせる(HoverPreview と同じ手当て)
  useEffect(() => {
    const el = ref.current;
    if (!el || failed || el.readyState === 0) return;
    if (el.seeking) {
      pending.current = time;
      return;
    }
    el.currentTime = time;
  }, [time, failed]);

  if (failed) return null;

  return (
    <video
      ref={ref}
      className="seek-preview-video"
      src={src}
      muted
      playsInline
      preload="auto"
      // 再生はしない。メタデータが来た時点で狙いの位置へ飛ばす
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = time;
      }}
      onSeeked={(e) => {
        if (pending.current == null) return;
        const t = pending.current;
        pending.current = null;
        e.currentTarget.currentTime = t;
      }}
      onError={() => setFailed(true)}
    />
  );
}
