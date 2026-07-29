import { describe, expect, it } from 'vitest';
import type { ViewEntry } from '../types';
import { dateLabel, groupByDate, progressLabel, timeOf } from './viewHistory';

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
