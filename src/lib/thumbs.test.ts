import { describe, expect, it } from 'vitest';
import { thumbSrc } from './thumbs';

describe('thumbSrc', () => {
  it('起動直後(version 0)は URL を変えない', () => {
    expect(thumbSrc('http://asset.localhost/C%3A/thumbs/7.jpg', 0)).toBe(
      'http://asset.localhost/C%3A/thumbs/7.jpg',
    );
  });

  it('再生成が起きたらバージョンを足して読み直させる', () => {
    expect(thumbSrc('http://asset.localhost/C%3A/thumbs/7.jpg', 3)).toBe(
      'http://asset.localhost/C%3A/thumbs/7.jpg?v=3',
    );
  });

  it('convertFileSrc が既にクエリを付けていても壊さない', () => {
    expect(thumbSrc('http://asset.localhost/x.jpg?token=abc', 2)).toBe(
      'http://asset.localhost/x.jpg?token=abc&v=2',
    );
  });
});
