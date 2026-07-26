import { describe, expect, it } from 'vitest';
import { normalizeDir, parentDir } from './paths';

// 期待値は Rust 側 core/folders.rs のテストと同じにしてある。
// どちらかだけ直すとフォルダー絞り込みが静かに 0 件になるため
describe('normalizeDir', () => {
  it('ドライブ直下は区切りを残す', () => {
    expect(normalizeDir('C:\\')).toBe('C:\\');
    expect(normalizeDir('C:/')).toBe('C:\\');
    expect(normalizeDir('C:')).toBe('C:\\');
  });

  it('末尾の区切りを落とす', () => {
    expect(normalizeDir('C:\\動画\\')).toBe('C:\\動画');
    expect(normalizeDir('C:\\動画\\\\')).toBe('C:\\動画');
  });

  it('スラッシュを円記号に揃える', () => {
    expect(normalizeDir('C:/動画/2026')).toBe('C:\\動画\\2026');
  });
});

describe('parentDir', () => {
  it('フォルダの中のファイル', () => {
    expect(parentDir('C:\\動画\\サンプル.mp4')).toBe('C:\\動画');
    expect(parentDir('D:\\映像\\2026\\旅行 01.mkv')).toBe('D:\\映像\\2026');
  });

  it('ドライブ直下のファイルはドライブルートになる', () => {
    expect(parentDir('C:\\a.mp4')).toBe('C:\\');
  });

  it('UNC パス', () => {
    expect(parentDir('\\\\nas\\share\\動画\\a.mp4')).toBe('\\\\nas\\share\\動画');
  });

  it('区切りが無ければ null', () => {
    expect(parentDir('a.mp4')).toBeNull();
  });
});
