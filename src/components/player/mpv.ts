import { init } from 'tauri-plugin-libmpv-api';
import type { MpvObservableProperty } from 'tauri-plugin-libmpv-api';

/** useMpvPlayer が購読するプロパティ(init 時に登録が必要) */
export const MPV_OBSERVED = [
  ['pause', 'flag'],
  ['time-pos', 'double', 'none'],
  ['duration', 'double', 'none'],
  ['eof-reached', 'flag', 'none'],
  ['volume', 'double'],
  ['mute', 'flag'],
  ['speed', 'double'],
  ['demuxer-cache-time', 'double', 'none'],
] as const satisfies MpvObservableProperty[];

let initPromise: Promise<boolean> | null = null;

/**
 * mpv をアプリ生涯で 1 回だけ初期化する(初回再生時に遅延実行)。
 * destroy は呼ばず使い回す — StrictMode の effect 二重実行でも init の実体は
 * この Promise 1 つなので競合しない(v1.4 の prepare_lock と同じ思想)。
 * dll 欠落などで失敗したら false(このセッションは WebView2 エンジンで動く)。
 */
export function ensureMpv(): Promise<boolean> {
  if (!initPromise) {
    initPromise = init({
      initialOptions: {
        vo: 'gpu-next',
        hwdec: 'auto-safe',
        // EOF で最終フレーム停止(自動で閉じない)。stop 後もコアを維持して使い回す
        'keep-open': 'yes',
        idle: 'yes',
        'force-window': 'yes',
        pause: 'yes',
        // キー操作・OSD は WebView 側の UI に一元化する
        'input-default-bindings': 'no',
        osc: 'no',
        'osd-level': '0',
      },
      observedProperties: MPV_OBSERVED,
    })
      .then(() => true)
      .catch((e) => {
        console.warn('mpv の初期化に失敗しました。WebView2 プレイヤーで再生します:', e);
        return false;
      });
  }
  return initPromise;
}
