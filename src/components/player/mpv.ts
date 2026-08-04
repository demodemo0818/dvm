import { init } from 'tauri-plugin-libmpv-api';
import type { MpvObservableProperty } from 'tauri-plugin-libmpv-api';
import { useLibrary } from '../../store';

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
  // 音声・字幕トラックの一覧と現在の選択(v1.8)。
  // node は JSON 相当のまま届くので、選択状態も track-list 側で分かる
  ['track-list', 'node', 'none'],
  /*
   * チャプター(v1.29)。**一覧だけ購読して現在位置は time-pos から自前で求める** ——
   * `chapter` も購読すると「今どのチャプターか」の出所が 2 つになり、
   * シークバーの目盛りと現在チャプターの表示がずれて見える瞬間ができる
   */
  ['chapter-list', 'node', 'none'],
  /*
   * 映像のパラメータ(v1.31)。HDR バッジの判定に使う転送特性(gamma)がここに入る。
   * **ファイルではなく「今デコードしている映像」が出所**なので追加の I/O が要らない
   */
  ['video-params', 'node', 'none'],
] as const satisfies MpvObservableProperty[];

/** mpv の track-list の 1 要素(必要なフィールドだけ) */
export interface MpvTrackEntry {
  id: number;
  type: string;
  title?: string;
  lang?: string;
  selected?: boolean;
  codec?: string;
}

/**
 * HDR パススルー(v1.30)の mpv 値。`target-colorspace-hint` に渡す。
 *
 * `auto` は「**ディスプレイが HDR のときだけ** HDR のまま出し、SDR なら従来どおり
 * トーンマップする」。`yes` 固定にしないのは、SDR モニタで色が転ぶのを避けるため。
 * ensureMpv(初期化時)と useMpvPlayer(実行中の切り替え)の両方がこれを使う ——
 * **片方だけ直さないこと**(初回再生と設定変更で挙動が食い違う)
 */
export const hdrHintValue = (on: boolean) => (on ? 'auto' : 'no');

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
        /*
         * HDR パススルー(v1.30)。実行中は useMpvPlayer が setProperty で押し込むが、
         * **初期化時にも渡しておく** —— 初回再生を必ず正しい状態で始めるため。
         * 設定は App.tsx が起動時に読んでおり、init はここまで遅延しているので間に合う
         */
        'target-colorspace-hint': hdrHintValue(useLibrary.getState().hdrPassthrough),
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
