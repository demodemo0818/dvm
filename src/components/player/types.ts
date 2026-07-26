/** プレイヤーが選べる再生速度(< > キーはこの並びを移動する) */
export const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const VOLUME_KEY = 'player_volume';
const MUTED_KEY = 'player_muted';
const UNSCALED_KEY = 'player_unscaled';

/** エンジン(WebView2 <video> / mpv)共通のプレイヤー状態 */
export interface PlayerState {
  currentTime: number;
  duration: number;
  paused: boolean;
  /** 0〜1(mpv は内部 0〜100 なので変換する) */
  volume: number;
  muted: boolean;
  rate: number;
  /** バッファ済み末尾(秒)。シークバーの薄い帯に使う */
  bufferedEnd: number;
}

/** mpv の音声・字幕トラック 1 本(WebView2 エンジンでは扱えないので mpv 専用) */
export interface MediaTrack {
  id: number;
  kind: 'audio' | 'sub';
  label: string;
  selected: boolean;
}

/** PlayerControls・ショートカットが両エンジンで共用するインターフェイス */
export interface VideoPlayer {
  state: PlayerState;
  togglePlay: () => void;
  seekTo: (sec: number) => void;
  seekBy: (delta: number) => void;
  setVolume: (vol: number) => void;
  changeVolume: (delta: number) => void;
  toggleMute: () => void;
  setRate: (rate: number) => void;
  cycleRate: (dir: 1 | -1) => void;
  /** mpv のみ。未対応エンジンでは undefined(UI 側は出さない) */
  tracks?: MediaTrack[];
  /** id に null を渡すとそのトラックを無効にする(字幕オフ) */
  setTrack?: (kind: 'audio' | 'sub', id: number | null) => void;
  /**
   * mpv のみ。true = 元のピクセルサイズで表示(ウィンドウが大きくても拡大しない)。
   * ウィンドウより大きい動画は true でも従来どおり縮小して収める
   */
  unscaled?: boolean;
  toggleUnscaled?: () => void;
}

export const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

/** 前回の音量設定(localStorage)。両エンジン共用 */
export function savedVolume(): number {
  const v = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
}

export function savedMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1';
}

export function saveVolumePref(volume: number): void {
  localStorage.setItem(VOLUME_KEY, String(clamp01(volume)));
}

export function saveMutedPref(muted: boolean): void {
  localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
}

/**
 * 前回の表示サイズモード(mpv のみ)。true = 元のピクセルサイズで表示し、
 * ウィンドウが大きくても拡大しない。既定は false = 従来どおりウィンドウにフィット
 */
export function savedUnscaled(): boolean {
  return localStorage.getItem(UNSCALED_KEY) === '1';
}

export function saveUnscaledPref(unscaled: boolean): void {
  localStorage.setItem(UNSCALED_KEY, unscaled ? '1' : '0');
}

/**
 * レジューム保存値(ミリ秒)。
 * 位置が尺の 90% 以上、または残り 30 秒未満なら 0(最後まで観た扱い)
 */
export function resumeValueMs(currentSec: number, durationSec: number): number {
  const finished = currentSec >= durationSec * 0.9 || durationSec - currentSec < 30;
  return finished ? 0 : Math.floor(currentSec * 1000);
}

/**
 * 視聴カウント(view_count)を 1 増やしてよいか。
 * 尺の 5% 以上、または 30 秒以上まで再生されたら「観た」とみなす(v1.8)。
 * それまでは「開いてすぐ閉じた」扱いでカウントしない。
 * 尺が取れていない場合は 30 秒だけで判断する
 */
export function shouldCountView(currentSec: number, durationSec: number): boolean {
  if (!Number.isFinite(currentSec) || currentSec <= 0) return false;
  if (currentSec >= 30) return true;
  return durationSec > 0 && currentSec >= durationSec * 0.05;
}
