import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtTime } from '../lib/format';
import { useLibrary } from '../store';
import type { LibraryStats, StatBucket } from '../types';

/**
 * lib/format.ts の fmtSize とはわざと別実装。
 * ここはライブラリ全体の合計を出すので TB が要り、桁が大きいぶん小数を減らしている
 */
function fmtSize(bytes: number): string {
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${(bytes / MB).toFixed(0)} MB`;
}

/** 「12 日 3 時間」のようにざっくり表示する(合計再生時間は秒まで要らない) */
function fmtTotalDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours} 時間`;
  return `${Math.floor(hours / 24)} 日 ${hours % 24} 時間`;
}

/** 横棒グラフ。ライブラリを足さずに CSS の幅指定だけで描く */
function BarList({
  buckets,
  onPick,
}: {
  buckets: StatBucket[];
  onPick?: (b: StatBucket) => void;
}) {
  if (buckets.length === 0) return <div className="stats-empty">データがありません</div>;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div className="stats-bars">
      {buckets.map((b) => (
        <button
          key={b.key}
          type="button"
          className="stats-bar-row"
          disabled={!onPick}
          onClick={() => onPick?.(b)}
          title={onPick ? `${b.label} で絞り込む` : b.label}
        >
          <span className="stats-bar-label" title={b.label}>{b.label}</span>
          <span className="stats-bar-track">
            <span className="stats-bar-fill" style={{ width: `${(b.count / max) * 100}%` }} />
          </span>
          <span className="stats-bar-count">{b.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 統計ダッシュボード。集計は core::stats(MCP の library_stats と同じ関数)で行うので、
 * AI に聞いた数字と画面の数字が食い違わない
 */
export function StatsModal() {
  const { showStats, setShowStats, version, applyFilter } = useLibrary();
  const [stats, setStats] = useState<LibraryStats | null>(null);

  useEffect(() => {
    if (!showStats) return;
    setStats(null);
    api.libraryStats().then(setStats).catch(() => {});
  }, [showStats, version]);

  if (!showStats) return null;
  const close = () => setShowStats(false);

  /** 統計から絞り込みに飛ぶ。画面が切り替わるので統計は閉じる */
  const jump = (filter: Parameters<typeof applyFilter>[0]) => {
    applyFilter(filter);
    close();
  };

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">統計</div>

        {!stats ? (
          <div className="stats-empty">集計中...</div>
        ) : (
          <>
            <div className="stats-tiles">
              <button className="stats-tile" onClick={() => jump({})}>
                <span className="stats-tile-value">{stats.videoCount.toLocaleString()}</span>
                <span className="stats-tile-label">動画</span>
              </button>
              <div className="stats-tile">
                <span className="stats-tile-value">{fmtSize(stats.totalSizeBytes)}</span>
                <span className="stats-tile-label">合計サイズ</span>
              </div>
              <div className="stats-tile">
                <span className="stats-tile-value">{fmtTotalDuration(stats.totalDurationMs)}</span>
                <span className="stats-tile-label">合計再生時間</span>
              </div>
              <button
                className="stats-tile"
                onClick={() => jump({ advanced: { unwatched: true } })}
              >
                <span className="stats-tile-value">{stats.unwatchedCount.toLocaleString()}</span>
                <span className="stats-tile-label">未視聴</span>
              </button>
              <button
                className="stats-tile"
                onClick={() => jump({ advanced: { untagged: true } })}
              >
                <span className="stats-tile-value">{stats.untaggedCount.toLocaleString()}</span>
                <span className="stats-tile-label">タグなし</span>
              </button>
              <button
                className="stats-tile"
                onClick={() => jump({ duplicatesOnly: true, sort: 'dup' })}
              >
                <span className="stats-tile-value">{stats.duplicateCount.toLocaleString()}</span>
                <span className="stats-tile-label">重複</span>
              </button>
              <button className="stats-tile" onClick={() => jump({ missingOnly: true })}>
                <span className="stats-tile-value">{stats.missingCount.toLocaleString()}</span>
                <span className="stats-tile-label">見つからない</span>
              </button>
              <div className="stats-tile">
                <span className="stats-tile-value">
                  {stats.tagCount} / {stats.seriesCount}
                </span>
                <span className="stats-tile-label">タグ / シリーズ</span>
              </div>
            </div>

            <div className="stats-section">
              <div className="stats-heading">レーティング</div>
              <BarList
                buckets={stats.ratingCounts.map((count, star) => ({
                  key: String(star),
                  label: star === 0 ? '未評価' : '★'.repeat(star),
                  count,
                }))}
                onPick={(b) => {
                  const star = Number(b.key);
                  // 未評価には「以上」の概念がないので、そこだけは絞り込まない
                  if (star > 0) jump({ advanced: { minRating: star } });
                }}
              />
            </div>

            <div className="stats-section">
              <div className="stats-heading">解像度</div>
              <BarList
                buckets={stats.byResolution}
                onPick={(b) => {
                  const h = Number(b.key);
                  if (h > 1) jump({ advanced: { minHeight: h } });
                }}
              />
            </div>

            <div className="stats-section">
              <div className="stats-heading">映像コーデック</div>
              <BarList
                buckets={stats.byCodec}
                onPick={(b) => b.key && jump({ advanced: { videoCodecs: [b.key] } })}
              />
            </div>

            <div className="stats-section">
              <div className="stats-heading">保存先</div>
              <BarList buckets={stats.byFolder} />
            </div>

            <div className="stats-section">
              <div className="stats-heading">追加した月(直近 24 か月)</div>
              <BarList
                buckets={stats.byMonth}
                onPick={(b) =>
                  jump({
                    advanced: {
                      addedAfter: `${b.key}-01`,
                      // 翌月の 0 日 = 当月末日。月末を自前で数えない
                      addedBefore: new Date(
                        Number(b.key.slice(0, 4)),
                        Number(b.key.slice(5, 7)),
                        0,
                      )
                        .toLocaleDateString('sv-SE'),
                    },
                  })
                }
              />
            </div>

            <div className="settings-note">
              合計再生時間は尺を取得できた動画のぶんだけです(全体では
              {fmtTime(stats.totalDurationMs / 1000)})
            </div>
          </>
        )}

        <div className="modal-actions">
          <button onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
