import { describe, expect, it } from 'vitest';
import { hdrFromVideoParams, hdrTooltip } from './hdrInfo';

describe('hdrFromVideoParams', () => {
  it('PQ と HLG を見分ける', () => {
    expect(hdrFromVideoParams({ gamma: 'pq', primaries: 'bt.2020' })).toEqual({
      short: 'HDR10',
      full: 'HDR10 (PQ)',
    });
    expect(hdrFromVideoParams({ gamma: 'hlg', primaries: 'bt.2020' })).toEqual({
      short: 'HLG',
      full: 'HLG',
    });
  });

  // libmpv のバージョンで名前が変わっても静かに壊れないようにしてある
  it('ffprobe 側の綴りでも読む', () => {
    expect(hdrFromVideoParams({ gamma: 'smpte2084' })?.short).toBe('HDR10');
    expect(hdrFromVideoParams({ gamma: 'ARIB-STD-B67' })?.short).toBe('HLG');
  });

  // 広色域の SDR は HDR ではない。primaries だけで判定すると誤って出る
  it('bt.2020 でも転送特性が SDR なら HDR ではない', () => {
    expect(hdrFromVideoParams({ gamma: 'bt.1886', primaries: 'bt.2020' })).toBeNull();
    expect(hdrFromVideoParams({ gamma: 'srgb', primaries: 'bt.709' })).toBeNull();
  });

  it('ロード前・壊れた値では null', () => {
    expect(hdrFromVideoParams(null)).toBeNull();
    expect(hdrFromVideoParams(undefined)).toBeNull();
    expect(hdrFromVideoParams({})).toBeNull();
    expect(hdrFromVideoParams({ gamma: 42 })).toBeNull();
    expect(hdrFromVideoParams('pq')).toBeNull();
  });
});

describe('hdrTooltip', () => {
  // パススルーは auto なので「HDR で出している」とは言い切らない
  it('パススルーの状態で言い方を変える', () => {
    const info = { short: 'HDR10', full: 'HDR10 (PQ)' };
    expect(hdrTooltip(info, true)).toContain('オン');
    expect(hdrTooltip(info, true)).not.toContain('SDR に変換');
    expect(hdrTooltip(info, false)).toContain('SDR に変換');
  });
});
