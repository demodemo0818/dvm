import { describe, expect, it } from 'vitest';
import { fmtTime } from './format';

describe('fmtTime', () => {
  it('1 時間未満は m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(5)).toBe('0:05');
    expect(fmtTime(65)).toBe('1:05');
    expect(fmtTime(3599)).toBe('59:59');
  });

  it('1 時間以上は h:mm:ss', () => {
    expect(fmtTime(3600)).toBe('1:00:00');
    expect(fmtTime(3661)).toBe('1:01:01');
    expect(fmtTime(36000)).toBe('10:00:00');
  });

  it('端数は切り捨てる', () => {
    expect(fmtTime(59.9)).toBe('0:59');
  });

  // メタデータ未取得の動画で NaN が来ることがある(尺バッジ・プレビューの時刻表示)
  it('不正な値は 0:00 に落とす', () => {
    expect(fmtTime(NaN)).toBe('0:00');
    expect(fmtTime(Infinity)).toBe('0:00');
    expect(fmtTime(-1)).toBe('0:00');
  });
});
