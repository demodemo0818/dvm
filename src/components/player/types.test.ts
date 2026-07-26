import { describe, expect, it } from 'vitest';
import { resumeValueMs, shouldCountView } from './types';

describe('resumeValueMs', () => {
  it('途中なら現在位置をミリ秒で返す', () => {
    // 10 分の動画の 3 分地点
    expect(resumeValueMs(180, 600)).toBe(180_000);
  });

  it('尺の 90% 以上まで観たら 0(最後まで観た扱い)', () => {
    expect(resumeValueMs(540, 600)).toBe(0);
    expect(resumeValueMs(539, 600)).toBe(539_000);
  });

  // 残り 30 秒ルールが単独で効くのは 5 分未満の動画だけ
  //(300 秒以上では 90% の方が先に来るので 90% ルールに吸収される)
  it('短い動画は 90% に届かなくても残り 30 秒未満なら 0', () => {
    // 100 秒の動画。90% は 90 秒だが、75 秒時点で残り 25 秒なので観終わり扱い
    expect(resumeValueMs(75, 100)).toBe(0);
    expect(resumeValueMs(65, 100)).toBe(65_000);
  });

  it('長尺では 90% ルールが先に効く', () => {
    // 3 時間の動画。2:42:00(90%)を超えたら残りが 18 分あっても観終わり扱い
    expect(resumeValueMs(9720, 10800)).toBe(0);
    expect(resumeValueMs(9719, 10800)).toBe(9_719_000);
  });

  it('先頭付近はそのまま保存する', () => {
    expect(resumeValueMs(0, 600)).toBe(0);
    expect(resumeValueMs(1.5, 600)).toBe(1500);
  });

  // 尺が取れていない(ライブ・プローブ失敗)ときに 0 が渡る
  it('尺が 0 なら 0 を返す', () => {
    expect(resumeValueMs(0, 0)).toBe(0);
    expect(resumeValueMs(100, 0)).toBe(0);
  });
});

describe('shouldCountView', () => {
  it('開いてすぐ閉じたらカウントしない', () => {
    expect(shouldCountView(0, 600)).toBe(false);
    expect(shouldCountView(1, 600)).toBe(false);
    expect(shouldCountView(29, 600)).toBe(false);
  });

  it('30 秒以上再生したらカウントする', () => {
    expect(shouldCountView(30, 3600)).toBe(true);
  });

  it('短い動画は尺の 5% でカウントする', () => {
    // 100 秒の動画なら 5 秒で「観た」。30 秒ルールだと短い動画が永久にカウントされない
    expect(shouldCountView(5, 100)).toBe(true);
    expect(shouldCountView(4, 100)).toBe(false);
  });

  it('尺が不明なら 30 秒だけで判断する', () => {
    expect(shouldCountView(10, 0)).toBe(false);
    expect(shouldCountView(31, 0)).toBe(true);
  });

  it('不正な値ではカウントしない', () => {
    expect(shouldCountView(NaN, 600)).toBe(false);
    expect(shouldCountView(-5, 600)).toBe(false);
  });
});
