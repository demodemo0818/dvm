import { convertFileSrc } from '@tauri-apps/api/core';
import { memo } from 'react';
import { COLUMNS, layout } from '../lib/listColumns';
import type { ColumnKey } from '../lib/listColumns';
import { thumbSrc } from '../lib/thumbs';
import { useLibrary } from '../store';
import type { VideoRowProps } from './rowProps';

/**
 * 詳細リスト表示の 1 行(v1.8、列可変は v1.16)。グリッドと同じ仮想化に乗るので、
 * 数万件でも DOM に載るのは可視分だけ。
 *
 * どの列をどの順で出すかは lib/listColumns.ts が持ち、ここは受け取った定義を描くだけ。
 * 列幅は親が流す CSS 変数 --list-cols で決まる(ヘッダ行・フォルダ行と共有)。
 *
 * ホバープレビューは付けない — 行が細く、マウスが横切るだけで次々に
 * 元動画を開くことになるため(グリッドのカードは面積が大きいので誤爆しにくい)
 */
export const VideoListRow = memo(function VideoListRow({
  video, labels, index, selected, focused, onPick, onPlay, onContextMenu, height, columns,
}: VideoRowProps & { height: number; columns: ColumnKey[] }) {
  const { thumb, rest } = layout(columns);
  const thumbVersion = useLibrary((s) => s.thumbVersion);

  if (!video) return <div className="list-row list-loading" style={{ height }} />;

  return (
    <div
      className={`list-row ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      style={{ height }}
      title={video.path}
      // キューパネルへの D&D の掴み先(v1.41、C-5)。VideoGrid が委譲で拾う
      data-grid-index={index}
      onClick={(e) => onPick(video, index, e)}
      onDoubleClick={() => onPlay(video, index)}
      onContextMenu={(e) => onContextMenu(video, index, e)}
    >
      {thumb && (
        <div className="list-thumb">
          {video.thumbPath ? (
            <img
              src={thumbSrc(convertFileSrc(video.thumbPath), thumbVersion)}
              loading="lazy"
              alt=""
              draggable={false}
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden';
              }}
              // 再生成に成功して読めるようになったら戻す(onError で隠しっぱなしにしない)
              onLoad={(e) => {
                e.currentTarget.style.visibility = '';
              }}
            />
          ) : null}
        </div>
      )}
      <div className="list-name">
        <span className="list-title">{video.title ?? video.filename}</span>
        {video.isOffline && <span className="list-flag offline">オフライン</span>}
        {video.isMissing && !video.isOffline && (
          <span className="list-flag missing">見つかりません</span>
        )}
      </div>
      {rest.map((key) => {
        const col = COLUMNS[key];
        // タグ・シリーズは別便なので未取得がある。null は '—'、'' はそのまま空欄
        const text = col.text(video, labels);
        return (
          <div
            key={key}
            className={`list-col ${col.align === 'left' ? 'left' : ''} ${key === 'rating' ? 'rating' : ''}`}
            // 列幅に収まらないぶんは省略されるので、全文をツールチップに出す
            title={text || undefined}
          >
            {text ?? '—'}
          </div>
        );
      })}
    </div>
  );
});
