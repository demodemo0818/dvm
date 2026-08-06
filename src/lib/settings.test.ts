import { describe, expect, it } from 'vitest';
import {
  CACHE_GB_DEFAULT,
  SETTINGS_SIZE_DEFAULT,
  SETTINGS_SIZE_MAX,
  SETTINGS_SIZE_MIN,
  parseCacheGb,
  parseFlag,
  parseModalSize,
  serializeFlag,
  serializeModalSize,
} from './settings';

describe('parseFlag', () => {
  it('未設定は既定値を返す', () => {
    expect(parseFlag(null, true)).toBe(true);
    expect(parseFlag(null, false)).toBe(false);
  });

  it("'0' は false、'1' は true(既定値によらない)", () => {
    expect(parseFlag('0', true)).toBe(false);
    expect(parseFlag('1', false)).toBe(true);
  });

  it('往復しても値が変わらない', () => {
    expect(parseFlag(serializeFlag(true), false)).toBe(true);
    expect(parseFlag(serializeFlag(false), true)).toBe(false);
  });
});

describe('parseCacheGb', () => {
  it('未設定・空欄は既定の 20GB', () => {
    expect(parseCacheGb(null)).toBe(CACHE_GB_DEFAULT);
    expect(parseCacheGb('')).toBe(CACHE_GB_DEFAULT);
    expect(parseCacheGb('   ')).toBe(CACHE_GB_DEFAULT);
  });

  it('壊れた値は既定に落とす', () => {
    expect(parseCacheGb('abc')).toBe(CACHE_GB_DEFAULT);
  });

  // 0 を通すとキャッシュが変換のたびに全消しになる(core/playback.rs の purge_cache)
  it('0 と負数は下限 1 に丸める', () => {
    expect(parseCacheGb('0')).toBe(1);
    expect(parseCacheGb('-5')).toBe(1);
  });

  it('上限を超えたら 1000 に丸める', () => {
    expect(parseCacheGb('99999')).toBe(1000);
  });

  it('小数は四捨五入する', () => {
    expect(parseCacheGb('12.4')).toBe(12);
    expect(parseCacheGb('12.6')).toBe(13);
    // 丸めた結果が 0 になっても、そのあとの clamp が下限まで持ち上げる
    expect(parseCacheGb('0.4')).toBe(1);
  });

  it('普通の値はそのまま', () => {
    expect(parseCacheGb('50')).toBe(50);
  });
});

describe('parseModalSize', () => {
  it('未設定・壊れた値は既定', () => {
    expect(parseModalSize(null)).toEqual(SETTINGS_SIZE_DEFAULT);
    expect(parseModalSize('')).toEqual(SETTINGS_SIZE_DEFAULT);
    expect(parseModalSize('あいうえお')).toEqual(SETTINGS_SIZE_DEFAULT);
    // 片方だけ・区切りが違う・小数はすべて既定へ
    expect(parseModalSize('780')).toEqual(SETTINGS_SIZE_DEFAULT);
    expect(parseModalSize('780,720')).toEqual(SETTINGS_SIZE_DEFAULT);
    expect(parseModalSize('780.5x720')).toEqual(SETTINGS_SIZE_DEFAULT);
  });

  it('普通の値はそのまま読む', () => {
    expect(parseModalSize('900x800')).toEqual({ w: 900, h: 800 });
    expect(parseModalSize(' 900x800 ')).toEqual({ w: 900, h: 800 });
  });

  // 大きい画面で広げたまま小さい画面で開いても、下限より小さくはならない
  it('範囲外は上下限に丸める', () => {
    expect(parseModalSize('100x100')).toEqual(SETTINGS_SIZE_MIN);
    expect(parseModalSize('9999x9999')).toEqual(SETTINGS_SIZE_MAX);
  });

  it('往復しても値が変わらない', () => {
    expect(parseModalSize(serializeModalSize({ w: 900, h: 800 }))).toEqual({ w: 900, h: 800 });
    expect(serializeModalSize(SETTINGS_SIZE_DEFAULT)).toBe('780x720');
  });
});
