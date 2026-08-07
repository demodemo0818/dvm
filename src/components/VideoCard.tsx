import { convertFileSrc } from '@tauri-apps/api/core';
import { ListOrdered, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { fmtSize, fmtTime } from '../lib/format';
import { chipBudget } from '../lib/grid';
import { thumbSrc } from '../lib/thumbs';
import { useLibrary } from '../store';
import { HoverPreview } from './HoverPreview';
import type { VideoRowProps } from './rowProps';

/** この時間ホバーし続けたらプレビューを開始する(グリッドを撫でただけで再生しない) */
const HOVER_DELAY_MS = 400;

/**
 * memo 化(A-4): 可視カードは数十枚あるので、スキャン中の status 更新や
 * 選択移動のたびに全カードを描き直さない。コールバック(onPick / onPlay /
 * onContextMenu)は VideoGrid 側が useCallback で安定させている前提
 */
export const VideoCard = memo(function VideoCard({
  video, labels, index, selected, focused, onPick, onPlay, onContextMenu, cardW,
}: VideoRowProps & { cardW: number }) {
  const previewOnHover = useLibrary((s) => s.previewOnHover);
  const cardTags = useLibrary((s) => s.cardTags);
  const cardSeries = useLibrary((s) => s.cardSeries);
  const menuOpen = useLibrary((s) => s.contextMenuOpen);
  const thumbVersion = useLibrary((s) => s.thumbVersion);
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
        {/*
          一覧クエリではサムネイルの実在確認をしていない(I/O 削減)。
          読めなかった img は onError で隠し、下の `.thumb` の地色を見せる。

          **読み込み待ちの「…」は出さない**(v1.32) —— img は lazy 読み込みなので、
          スクロールするたび画面じゅうのカードで「…」が一瞬出ては消えて目障りだった。
          地色のままでも「まだ出ていない」ことは分かる。
          生成に失敗したものだけは地色と区別が付かないので警告アイコンを残す
        */}
        {video.thumbState === 2 && (
          <div className="thumb-placeholder">
            <TriangleAlert size={22} />
          </div>
        )}
        {video.thumbPath && (
          <img
            key={video.id}
            src={thumbSrc(convertFileSrc(video.thumbPath), thumbVersion)}
            loading="lazy"
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
            // 再生成に成功して読めるようになったら戻す(onError で隠しっぱなしにしない)
            onLoad={(e) => {
              e.currentTarget.style.display = '';
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
      {/*
        タグ行・シリーズ行(v1.23)。設定が ON なら**中身が空でも必ず描く** —
        付いている動画だけ背が高くなると、行単位で 1 つの高さしか持てない仮想化が破綻する
        (高さは lib/grid.ts の CARD_CHIP_ROW_H と対)
      */}
      {cardTags && (
        <div className="card-chips">
          {chips(
            (labels?.tags ?? []).map((t) => (
              <span
                key={t.id}
                className="chip mini"
                style={t.color ? { borderColor: t.color, color: t.color } : undefined}
              >
                {t.name}
              </span>
            )),
            cardW,
          )}
        </div>
      )}
      {cardSeries && (
        <div className="card-chips">
          {chips(
            (labels?.series ?? []).map((s) => (
              <span key={s.id} className="chip mini series">
                <ListOrdered size={11} />
                {s.name}
              </span>
            )),
            cardW,
          )}
        </div>
      )}
    </div>
  );
});

/**
 * 1 行に収まるぶんだけ出し、余りは `+N` にまとめる。
 * カードは 140〜400px と幅が変わるので、入る個数は幅から決める(DOM は測らない)
 */
function chips(items: React.ReactNode[], cardW: number): React.ReactNode {
  const budget = chipBudget(cardW);
  if (items.length <= budget) return items;
  return [
    ...items.slice(0, budget),
    <span key="more" className="chip mini more">
      +{items.length - budget}
    </span>,
  ];
}
