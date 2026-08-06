import { describe, expect, it } from 'vitest';
import type { ViewEntry, ViewStats } from '../types';
import {
  dateLabel, groupByDate, periodRange, progressLabel, statsLabel, timeOf,
} from './viewHistory';

const TODAY = '2026-07-28';

function entry(patch: Partial<ViewEntry> & { viewedAt: string }): ViewEntry {
  return {
    id: 1,
    videoId: 1,
    watchedMs: null,
    filename: 'a.mp4',
    title: null,
    durationMs: null,
    thumbPath: null,
    isMissing: false,
    ...patch,
  };
}

describe('dateLabel', () => {
  it('今日と昨日は日付ではなく言葉で出す', () => {
    expect(dateLabel('2026-07-28', TODAY)).toBe('今日');
    expect(dateLabel('2026-07-27', TODAY)).toBe('昨日');
  });

  it('それ以前は曜日つきの日付', () => {
    expect(dateLabel('2026-07-20', TODAY)).toBe('7月20日 (月)');
  });

  // 月をまたぐと単純な引き算では「昨日」を取り逃す
  it('月をまたいでも昨日を判定できる', () => {
    expect(dateLabel('2026-07-31', '2026-08-01')).toBe('昨日');
  });

  it('読めない日付はそのまま出す(行を落とさない)', () => {
    expect(dateLabel('こわれた', TODAY)).toBe('こわれた');
  });
});

describe('groupByDate', () => {
  it('同じ日をまとめ、Rust が返した順序を変えない', () => {
    const rows = [
      entry({ id: 3, viewedAt: '2026-07-28 18:42:00' }),
      entry({ id: 2, viewedAt: '2026-07-28 09:05:00' }),
      entry({ id: 1, viewedAt: '2026-07-27 22:10:00' }),
    ];
    const groups = groupByDate(rows, TODAY);
    expect(groups.map((g) => g.label)).toEqual(['今日', '昨日']);
    expect(groups[0].entries.map((e) => e.id)).toEqual([3, 2]);
    expect(groups[1].entries.map((e) => e.id)).toEqual([1]);
  });

  it('空なら空', () => {
    expect(groupByDate([], TODAY)).toEqual([]);
  });

  // 同じ動画を複数回観た記録は畳まない(それが view_history を足した理由そのもの)
  it('同じ動画の複数回をまとめてしまわない', () => {
    const rows = [
      entry({ id: 2, videoId: 7, viewedAt: '2026-07-28 20:00:00' }),
      entry({ id: 1, videoId: 7, viewedAt: '2026-07-28 10:00:00' }),
    ];
    expect(groupByDate(rows, TODAY)[0].entries).toHaveLength(2);
  });
});

describe('progressLabel', () => {
  it('観た位置と尺を並べる', () => {
    const e = entry({ viewedAt: '2026-07-28 18:42:00', watchedMs: 743_000, durationMs: 1_450_000 });
    expect(progressLabel(e)).toBe('12:23 / 24:10');
  });

  // null は「外部プレイヤー / 異常終了で不明」であって 0 秒ではない
  it('不明を 0:00 と書き分ける', () => {
    const unknown = entry({ viewedAt: '2026-07-28 18:42:00', durationMs: 1_450_000 });
    expect(progressLabel(unknown)).toBe('— / 24:10');

    const zero = entry({ viewedAt: '2026-07-28 18:42:00', watchedMs: 0, durationMs: 1_450_000 });
    expect(progressLabel(zero)).toBe('0:00 / 24:10');
  });

  it('尺が未取得でも落ちない', () => {
    expect(progressLabel(entry({ viewedAt: '2026-07-28 18:42:00', watchedMs: 90_000 }))).toBe('1:30');
    expect(progressLabel(entry({ viewedAt: '2026-07-28 18:42:00' }))).toBe('—');
  });
});

describe('timeOf', () => {
  it('秒は落として時刻だけ出す', () => {
    expect(timeOf('2026-07-28 18:42:07')).toBe('18:42');
  });
});

describe('periodRange(v1.36)', () => {
  it('すべて / 期間を指定 は条件を作らない', () => {
    expect(periodRange('all', TODAY)).toEqual({ after: '', before: '' });
    // custom は呼び出し側の入力を使うので、ここでは何も決めない
    expect(periodRange('custom', TODAY)).toEqual({ after: '', before: '' });
  });

  it('今日は前後とも当日', () => {
    expect(periodRange('today', TODAY)).toEqual({ after: '2026-07-28', before: '2026-07-28' });
  });

  // 「過去 7 日」は今日を含めて 7 日ぶん。6 日前が下限になる(7 日前ではない)
  it('過去 7 日は今日を含めて 7 日', () => {
    expect(periodRange('last7', TODAY)).toEqual({ after: '2026-07-22', before: '2026-07-28' });
  });

  it('月をまたぐ引き算でも崩れない', () => {
    expect(periodRange('last7', '2026-03-03').after).toBe('2026-02-25');
  });

  // うるう日を 1 日として数えること(同じ 3/1 でも平年より 1 日ぶん手前にならない)
  it('うるう年の 2 月をまたいでも 7 日ぶん', () => {
    expect(periodRange('last7', '2024-03-01').after).toBe('2024-02-24');
    expect(periodRange('last7', '2025-03-01').after).toBe('2025-02-23');
  });

  it('今月は 1 日から今日まで', () => {
    expect(periodRange('thisMonth', TODAY)).toEqual({ after: '2026-07-01', before: '2026-07-28' });
    expect(periodRange('thisMonth', '2026-01-01')).toEqual({
      after: '2026-01-01', before: '2026-01-01',
    });
  });
});

describe('statsLabel(v1.36)', () => {
  const stats = (patch: Partial<ViewStats> = {}): ViewStats =>
    ({ count: 0, videoCount: 0, watchedMs: 0, unknownCount: 0, ...patch });

  it('記録が無ければそう言う', () => {
    expect(statsLabel(stats())).toBe('この期間の記録はありません');
  });

  it('1 時間以上は時間、未満は分で出す', () => {
    expect(statsLabel(stats({ count: 3, videoCount: 2, watchedMs: 5_400_000 })))
      .toBe('3 回 / 2 本 ・ 合計 1.5 時間');
    expect(statsLabel(stats({ count: 1, videoCount: 1, watchedMs: 720_000 })))
      .toBe('1 回 / 1 本 ・ 合計 12 分');
  });

  // 合計に入っていない行があることを黙らない(「間違った数字を出すくらいなら」の系)
  it('位置が不明な行があれば断る', () => {
    expect(statsLabel(stats({ count: 5, videoCount: 3, watchedMs: 3_600_000, unknownCount: 2 })))
      .toBe('5 回 / 3 本 ・ 合計 1.0 時間(うち 2 回は位置不明)');
  });
});
