import type { VideoRow } from '../types';

/**
 * アプリ内再生の方式。
 * - native: そのまま <video> で再生できる
 * - remux: コンテナ詰め替え(-c copy)だけで再生できる(数秒〜数十秒)
 * - transcode: 再エンコードが必要(HW エンコードでも尺に応じた時間がかかる)
 */
export type PlayMode = 'native' | 'remux' | 'transcode';

/**
 * WebView2 がネイティブ再生できる可能性が高いコンテナ拡張子。
 * mkv を含むのは、WebM が Matroska のサブセットで Chromium に Matroska パーサが
 * あるため(v1.6 で mkv + HEVC の直接再生を実測確認)。
 * 判定を外しても native の onError で transcode に落ちるので、楽観側に倒してよい
 */
const NATIVE_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
/** Chromium がデコードできる映像コーデック(HEVC は OS 拡張がある場合のみ。下記参照) */
const SAFE_VIDEO = new Set(['h264', 'av1', 'vp8', 'vp9']);
/** Chromium がデコードできる音声コーデック(ac3 / dts / truehd は非対応) */
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function extOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Windows の「HEVC ビデオ拡張機能」の有無を検出する。
 * WebView2(Edge)の canPlayType は OS デコーダの有無を反映する。
 * 確実ではないため、native 再生に失敗したら transcode へ切り替える前提で使う。
 */
export function hevcSupported(): boolean {
  return document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L120.B0"') !== '';
}

/**
 * DB のコーデック情報(ffprobe 由来)から再生方式を判定する。
 * コーデック未取得(プローブ未了・失敗)の場合は従来通り拡張子だけで楽観判定し、
 * native の onError で transcode に落ちる。
 */
export function decidePlayback(v: VideoRow): PlayMode {
  const ext = extOf(v.path);
  const vc = v.videoCodec;
  if (!vc) return NATIVE_EXTS.has(ext) ? 'native' : 'transcode';

  const videoOk = SAFE_VIDEO.has(vc) || (vc === 'hevc' && hevcSupported());
  const audioOk = v.audioCodec == null || SAFE_AUDIO.has(v.audioCodec);

  if (NATIVE_EXTS.has(ext) && videoOk && audioOk) return 'native';
  // 映像はそのまま使えるのでコンテナ/音声だけ直す(vp8/vp9 は mp4 に copy できないので除外)
  if (videoOk && vc !== 'vp8' && vc !== 'vp9') return 'remux';
  return 'transcode';
}
