import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoRow } from '../types';
import { decidePlayback } from './playback';

/** decidePlayback が見るフィールドだけ持つ最小の行を作る */
function row(path: string, videoCodec: string | null, audioCodec: string | null): VideoRow {
  return {
    id: 1, path, filename: path, title: null, size: 0, durationMs: null,
    width: null, height: null, rating: 0, viewCount: 0, lastViewedAt: null,
    resumeMs: 0, videoCodec, audioCodec, isMissing: false, isOffline: false,
    thumbState: 0, thumbPath: null, addedAt: '',
  };
}

/** Windows の HEVC ビデオ拡張機能の有無を差し替える(jsdom の既定は「無し」) */
function setHevc(supported: boolean) {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
    supported && type.includes('hvc1') ? 'probably' : '',
  );
}

describe('decidePlayback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setHevc(false);
  });

  it('mp4 + h264/aac は native', () => {
    expect(decidePlayback(row('C:\\v\\a.mp4', 'h264', 'aac'))).toBe('native');
  });

  // v1.6 の楽観化: WebM が Matroska のサブセットである以上 Chromium は mkv を扱える
  it('mkv + h264/aac は native(v1.6 で remux をやめた)', () => {
    expect(decidePlayback(row('C:\\動画\\日本語.mkv', 'h264', 'aac'))).toBe('native');
  });

  it('コンテナだけ非対応(avi + h264)は remux', () => {
    expect(decidePlayback(row('C:\\v\\a.avi', 'h264', 'aac'))).toBe('remux');
  });

  it('音声だけ非対応(mkv + ac3)は remux', () => {
    expect(decidePlayback(row('C:\\v\\a.mkv', 'h264', 'ac3'))).toBe('remux');
  });

  it('vp8/vp9 は mp4 に copy できないので avi なら transcode', () => {
    expect(decidePlayback(row('C:\\v\\a.avi', 'vp9', 'opus'))).toBe('transcode');
  });

  it('HEVC は拡張機能がなければ transcode、あれば native', () => {
    expect(decidePlayback(row('C:\\v\\a.mp4', 'hevc', 'aac'))).toBe('transcode');
    setHevc(true);
    expect(decidePlayback(row('C:\\v\\a.mp4', 'hevc', 'aac'))).toBe('native');
  });

  it('非対応の映像コーデックは transcode', () => {
    expect(decidePlayback(row('C:\\v\\a.wmv', 'wmv3', 'wmav2'))).toBe('transcode');
  });

  it('コーデック未取得なら拡張子だけで楽観判定する', () => {
    expect(decidePlayback(row('C:\\v\\a.mp4', null, null))).toBe('native');
    expect(decidePlayback(row('C:\\v\\a.avi', null, null))).toBe('transcode');
  });

  it('音声トラックなし(null)は再生の妨げにならない', () => {
    expect(decidePlayback(row('C:\\v\\a.mp4', 'h264', null))).toBe('native');
  });

  it('拡張子の大文字小文字を区別しない', () => {
    expect(decidePlayback(row('C:\\v\\A.MP4', 'h264', 'aac'))).toBe('native');
  });
});
