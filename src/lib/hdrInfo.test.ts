import { describe, expect, it } from 'vitest';
import { hdrFromParams, hdrTooltip } from './hdrInfo';

describe('hdrFromParams', () => {
  it('PQ と HLG を見分ける', () => {
    expect(hdrFromParams({ gamma: 'pq', primaries: 'bt.2020' })).toEqual({
      short: 'HDR10',
      full: 'HDR10 (PQ)',
    });
    expect(hdrFromParams({ gamma: 'hlg', primaries: 'bt.2020' })).toEqual({
      short: 'HLG',
      full: 'HLG',
    });
  });

  // libmpv のバージョンで名前が変わっても静かに壊れないようにしてある
  it('ffprobe 側の綴りでも読む', () => {
    expect(hdrFromParams({ gamma: 'smpte2084' })?.short).toBe('HDR10');
    expect(hdrFromParams({ gamma: 'ARIB-STD-B67' })?.short).toBe('HLG');
  });

  // 広色域の SDR は HDR ではない。primaries だけで判定すると誤って出る
  it('bt.2020 でも転送特性が SDR なら HDR ではない', () => {
    expect(hdrFromParams({ gamma: 'bt.1886', primaries: 'bt.2020' })).toBeNull();
    expect(hdrFromParams({ gamma: 'srgb', primaries: 'bt.709' })).toBeNull();
  });

  it('ロード前・壊れた値では null', () => {
    expect(hdrFromParams(null)).toBeNull();
    expect(hdrFromParams(undefined)).toBeNull();
    expect(hdrFromParams({})).toBeNull();
    expect(hdrFromParams({ gamma: 42 })).toBeNull();
    expect(hdrFromParams('pq')).toBeNull();
  });
});

describe('hdrTooltip', () => {
  const info = { short: 'HDR10', full: 'HDR10 (PQ)' };

  it('HDR で出ているときだけ「HDR のまま出力」と言う', () => {
    expect(hdrTooltip(info, true, true)).toContain('HDR のまま出力');
    expect(hdrTooltip(info, true, true)).not.toContain('SDR に変換');
  });

  /*
   * ここが v1.31 の肝。設定はオンでも Windows 側が HDR モードでなければ
   * mpv はトーンマップする。「オンだから HDR で出ている」と書くと嘘になるので、
   * **なぜ SDR なのか**まで出す
   */
  it('設定がオンでも SDR 出力なら、そう言ったうえで理由を出す', () => {
    const t = hdrTooltip(info, false, true);
    expect(t).toContain('SDR に変換');
    expect(t).toContain('ディスプレイが HDR モードではありません');
  });

  it('設定がオフなら、その旨を出す', () => {
    const t = hdrTooltip(info, false, false);
    expect(t).toContain('SDR に変換');
    expect(t).toContain('HDR パススルー: オフ');
  });
});
