import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { fmtTime } from '../lib/format';
import { DURATION_RANGES } from '../lib/query';
import { useShallow } from 'zustand/react/shallow';
import { pickState, useLibrary } from '../store';
import type { DurationBucket, LibraryStats, Orientation, StatBucket } from '../types';

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

/** 棒の横に置く短い時間表記。桁が大きいので分と時間だけで足りる */
function fmtHours(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分`;
  return `${Math.round(ms / 3_600_000).toLocaleString()} 時間`;
}

/**
 * 棒グラフの軸(v1.37)。**同じ内訳を「何本か」「何 GB か」「何時間か」で見比べる**。
 * 外付け HDD 前提のアプリでは「どのフォルダが容量を食っているか」のほうが
 * 件数より知りたい場面が多いので、グラフを増やさず軸だけ切り替えられるようにした
 */
type Metric = 'count' | 'bytes' | 'time';

const METRIC_LABELS: Record<Metric, string> = { count: '件数', bytes: '容量', time: '時間' };

const metricValue = (b: StatBucket, metric: Metric) =>
  metric === 'bytes' ? b.bytes : metric === 'time' ? b.durationMs : b.count;

const metricText = (b: StatBucket, metric: Metric) =>
  metric === 'bytes'
    ? fmtSize(b.bytes)
    : metric === 'time'
      ? fmtHours(b.durationMs)
      : b.count.toLocaleString();

/** 再生回数の内訳(key)→ 絞り込みの範囲。Rust 側の CASE と対になっている */
const VIEW_COUNT_RANGES: Record<string, { min: number | null; max: number | null }> = {
  '0': { min: null, max: 0 },
  '1': { min: 1, max: 1 },
  '2-4': { min: 2, max: 4 },
  '5-9': { min: 5, max: 9 },
  '10-': { min: 10, max: null },
};

/** 横棒グラフ。ライブラリを足さずに CSS の幅指定だけで描く */
function BarList({
  buckets,
  metric = 'count',
  unit = '本',
  empty = 'データがありません',
  tailLabel,
  onPick,
}: {
  buckets: StatBucket[];
  /** 視聴回数の内訳のように容量・時間を持たない棒は 'count' 固定で渡す */
  metric?: Metric;
  unit?: string;
  empty?: string;
  /** ラベルがあふれたら**先頭**を省略する(パス用。末尾のフォルダ名を残すため) */
  tailLabel?: boolean;
  onPick?: (b: StatBucket) => void;
}) {
  if (buckets.length === 0) return <div className="stats-empty">{empty}</div>;
  const max = Math.max(...buckets.map((b) => metricValue(b, metric)), 1);
  // 軸を切り替えても他の 2 つを見失わないよう、ツールチップには 3 つとも出す
  const tooltip = (b: StatBucket) => {
    const parts = [`${b.count.toLocaleString()} ${unit}`];
    if (b.bytes > 0) parts.push(fmtSize(b.bytes));
    if (b.durationMs > 0) parts.push(fmtHours(b.durationMs));
    return `${b.label}: ${parts.join(' / ')}${onPick ? '(クリックで絞り込む)' : ''}`;
  };
  return (
    <div className="stats-bars">
      {buckets.map((b) => (
        <button
          key={b.key}
          type="button"
          className="stats-bar-row"
          disabled={!onPick}
          onClick={() => onPick?.(b)}
          title={tooltip(b)}
        >
          <span className={`stats-bar-label ${tailLabel ? 'tail' : ''}`} title={b.label}>
            {b.label}
          </span>
          <span className="stats-bar-track">
            <span
              className="stats-bar-fill"
              style={{ width: `${(metricValue(b, metric) / max) * 100}%` }}
            />
          </span>
          <span className="stats-bar-count">{metricText(b, metric)}</span>
        </button>
      ))}
    </div>
  );
}

/** グラフ 1 つぶんの枠。wide = 2 列ぶん使う(パスや月が横に長いもの) */
function Section({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`stats-section ${wide ? 'wide' : ''}`}>
      <div className="stats-heading">{title}</div>
      {children}
    </div>
  );
}

/**
 * 統計ダッシュボード。集計は core::stats(MCP の library_stats と同じ関数)で行うので、
 * AI に聞いた数字と画面の数字が食い違わない
 */
export function StatsModal() {
  const { showStats, setShowStats, version, applyFilter } = useLibrary(
    useShallow(pickState('showStats', 'setShowStats', 'version', 'applyFilter')),
  );
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [metric, setMetric] = useState<Metric>('count');

  useEffect(() => {
    if (!showStats) return;
    setStats(null);
    api.libraryStats().then(setStats).catch(() => {});
  }, [showStats, version]);

  /*
   * Escape で閉じる。**window ではなく document に張って stopPropagation する** ——
   * App.tsx の Escape(選択解除)は window にいるので、ここで止めれば届かない
   * (SettingsModal と同じ理由)。IME の変換中は「変換の取り消し」なので拾わない
   */
  useEffect(() => {
    if (!showStats) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      setShowStats(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showStats, setShowStats]);

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

            {/* 内訳の軸(v1.37)。棒の長さと右の数字がまとめて切り替わる */}
            <div className="stats-metrics">
              <span className="stats-metric-label">内訳を見る軸</span>
              {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
                <button
                  key={m}
                  className={`stats-metric ${metric === m ? 'active' : ''}`}
                  onClick={() => setMetric(m)}
                >
                  {METRIC_LABELS[m]}
                </button>
              ))}
            </div>

            <div className="stats-grid">
              <Section title="レーティング">
                <BarList
                  buckets={stats.byRating}
                  metric={metric}
                  onPick={(b) => {
                    const star = Number(b.key);
                    // 未評価には「以上」の概念がないので、そこだけは絞り込まない
                    if (star > 0) jump({ advanced: { minRating: star } });
                  }}
                />
              </Section>

              <Section title="長さ">
                <BarList
                  buckets={stats.byDuration}
                  metric={metric}
                  onPick={(b) => {
                    // key は詳細検索のプリセットそのもの。範囲もそこから引くので条件が二重にならない
                    const range = DURATION_RANGES[b.key as DurationBucket];
                    if (range) {
                      jump({
                        advanced: {
                          minDurationMs: range.min ?? null,
                          maxDurationMs: range.max ?? null,
                        },
                      });
                    }
                  }}
                />
              </Section>

              <Section title="解像度">
                <BarList
                  buckets={stats.byResolution}
                  metric={metric}
                  onPick={(b) => {
                    const h = Number(b.key);
                    if (h > 1) jump({ advanced: { minHeight: h } });
                  }}
                />
              </Section>

              <Section title="向き">
                <BarList
                  buckets={stats.byOrientation}
                  metric={metric}
                  onPick={(b) =>
                    b.key !== 'unknown' && jump({ advanced: { orientation: b.key as Orientation } })
                  }
                />
              </Section>

              <Section title="映像コーデック">
                <BarList
                  buckets={stats.byCodec}
                  metric={metric}
                  onPick={(b) => b.key && jump({ advanced: { videoCodecs: [b.key] } })}
                />
              </Section>

              <Section title="拡張子">
                <BarList
                  buckets={stats.byExtension}
                  metric={metric}
                  onPick={(b) => jump({ advanced: { extensions: [b.key] } })}
                />
              </Section>

              <Section title="再生回数">
                <BarList
                  buckets={stats.byViewCount}
                  metric={metric}
                  onPick={(b) => {
                    const range = VIEW_COUNT_RANGES[b.key];
                    if (range) {
                      jump({ advanced: { minViewCount: range.min, maxViewCount: range.max } });
                    }
                  }}
                />
              </Section>

              <Section title="ファイルの更新年">
                <BarList
                  buckets={stats.byFileYear}
                  metric={metric}
                  onPick={(b) =>
                    b.key &&
                    jump({
                      advanced: {
                        modifiedAfter: `${b.key}-01-01`,
                        modifiedBefore: `${b.key}-12-31`,
                      },
                    })
                  }
                />
              </Section>

              <Section title="保存先" wide>
                <BarList
                  buckets={stats.byFolder}
                  metric={metric}
                  tailLabel
                  onPick={(b) => {
                    // key = 監視フォルダ id。0 は個別登録なので絞り込みで表せない
                    const id = Number(b.key);
                    if (id > 0) jump({ folderId: id });
                  }}
                />
              </Section>

              <Section title="追加した月(直近 24 か月)" wide>
                <BarList
                  buckets={stats.byMonth}
                  metric={metric}
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
              </Section>

              {/*
                ここから下は「ライブラリの中身」ではなく「観かた」の統計(v1.37)。
                view_history は v1.18 から貯めていて、v1.36 の期間集計に続いてここでも使う
              */}
              <Section title="月ごとの視聴回数(直近 24 か月)" wide>
                <BarList
                  buckets={stats.byViewMonth}
                  unit="回"
                  empty="まだ視聴の記録がありません"
                />
              </Section>
            </div>

            <div className="settings-note">
              合計再生時間は尺を取得できた動画のぶんだけです(全体では
              {fmtTime(stats.totalDurationMs / 1000)})。
              「再生回数」はライブラリに記録した全期間の累計、
              「月ごとの視聴回数」は v1.18 以降の記録です
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
