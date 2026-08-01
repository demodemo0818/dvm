import { useCallback, useEffect, useRef, useState } from 'react';
import { command, observeProperties, setProperty } from 'tauri-plugin-libmpv-api';
import { useLibrary } from '../../store';
import { mpvSubProps } from '../../lib/subtitleStyle';
import { MPV_OBSERVED } from './mpv';
import type { MpvTrackEntry } from './mpv';
import {
  clamp01,
  RATE_OPTIONS,
  savedMuted,
  savedUnscaled,
  savedVolume,
  saveMutedPref,
  saveUnscaledPref,
  saveVolumePref,
} from './types';
import type { MediaTrack, PlayerState, VideoPlayer } from './types';

/** mpv の track-list を UI 用に整形する(音声・字幕だけ拾う) */
function toTracks(data: unknown): MediaTrack[] {
  if (!Array.isArray(data)) return [];
  return (data as MpvTrackEntry[])
    .filter((t) => t && (t.type === 'audio' || t.type === 'sub'))
    .map((t) => {
      // 「日本語」「Commentary」など人が読める名前を優先し、無ければコーデック名で代用する
      const parts = [t.lang, t.title, t.codec].filter(Boolean);
      return {
        id: t.id,
        kind: t.type as 'audio' | 'sub',
        label: parts.length > 0 ? parts.join(' / ') : `#${t.id}`,
        selected: t.selected === true,
        codec: t.codec,
      };
    });
}

/** IPC コマンドの失敗(ファイル未ロード中の seek 等)は無害なので握りつぶす */
const run = (p: Promise<unknown>) => {
  p.catch(() => {});
};

/**
 * 字幕プロパティ用(v1.24)。run と違って**名前を出して警告する** —
 * こちらの失敗は「libmpv がそのオプションを知らない」= 設定が丸ごと効かない事故なので、
 * 黙って消えると原因に辿り着けない。トーストは出さない(再生を邪魔しないため)
 */
const runSub = (name: string, p: Promise<unknown>) => {
  p.catch((e) => console.warn('字幕プロパティを設定できません:', name, e));
};

/**
 * 表示サイズ → mpv の video-unscaled。
 * フィット = 'no'、等倍 = 'downscale-big'(拡大はしないが、ウィンドウより大きい動画は
 * 縮小して収める)。'yes' は「ウィンドウより大きい動画を切り取る」挙動なので使わない
 * (4K を開くと画面外が切れる)
 */
const unscaledValue = (unscaled: boolean) => (unscaled ? 'downscale-big' : 'no');

/**
 * mpv エンジン用の VideoPlayer 実装。
 * 状態は observeProperties のイベントで同期し、操作は mpv コマンドを送る。
 * 初期値は localStorage 由来(実値は MpvPlayerView が mount 時に setProperty で
 * 反映し、その property-change イベントで state と一致する)。
 */
export function useMpvPlayer(): VideoPlayer {
  const [state, setState] = useState<PlayerState>(() => ({
    currentTime: 0,
    duration: 0,
    paused: true,
    volume: savedVolume(),
    muted: savedMuted(),
    rate: 1,
    bufferedEnd: 0,
  }));
  const [tracks, setTracks] = useState<MediaTrack[]>([]);
  // リピートは engine をまたぐ設定なので store に置いている(v1.13)
  const repeatOne = useLibrary((s) => s.repeatOne);
  // 字幕の見た目(v1.24)。mpv 専用だが、設定モーダルからも触るので store 経由
  const subStyle = useLibrary((s) => s.subStyle);
  // 表示サイズ(v1.12)。mpv 側は購読しない — 変更できるのはこの UI だけなので手元が真実
  const [unscaled, setUnscaled] = useState(savedUnscaled);
  // 操作コールバックから最新状態を読むための ref(stale closure 回避)
  const stateRef = useRef(state);
  stateRef.current = state;
  const unscaledRef = useRef(unscaled);
  unscaledRef.current = unscaled;

  useEffect(() => {
    const unlisten = observeProperties(MPV_OBSERVED, ({ name, data }) => {
      if (name === 'track-list') {
        setTracks(toTracks(data));
        return;
      }
      setState((s) => {
        switch (name) {
          case 'pause':
            return { ...s, paused: data as boolean };
          case 'time-pos':
            // idle・ロード中は null が来る → 前値を維持
            return data == null ? s : { ...s, currentTime: data as number };
          case 'duration':
            return { ...s, duration: (data as number | null) ?? 0 };
          case 'volume':
            return { ...s, volume: clamp01((data as number) / 100) };
          case 'mute':
            return { ...s, muted: data as boolean };
          case 'speed':
            return { ...s, rate: data as number };
          case 'demuxer-cache-time':
            return { ...s, bufferedEnd: (data as number | null) ?? 0 };
          default:
            return s;
        }
      });
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  /**
   * video-unscaled は loadfile を跨いで残るが、セッション最初の再生では mpv の既定(no)
   * なので、mount のたびに localStorage の値を流し込む(音量・ミュートと同じ考え方)。
   * ファイルに依存しないオプションなので loadfile の前後は問わない。
   * MpvPlayerView の再生開始 effect に await で混ぜないこと —
   * あの chain の失敗は onFail() に繋がっており、表示オプションが古い libmpv で
   * 通らなかっただけでファイルが WebView2 の再エンコード経路に落ちてしまう
   */
  useEffect(() => {
    run(setProperty('video-unscaled', unscaledValue(savedUnscaled())));
  }, []);

  /**
   * リピート再生(v1.13)。loop-file も loadfile を跨いで残るグローバルなプロパティ
   * なので、状態が変わるたびに押し込むだけでよい(mount 時にも走る)。
   * 'inf' の間は EOF に到達しないので、連続再生の判定は自然に発動しない
   */
  useEffect(() => {
    run(setProperty('loop-file', repeatOne ? 'inf' : 'no'));
  }, [repeatOne]);

  /**
   * 字幕の見た目(v1.24)。sub-* も loadfile を跨いで残るグローバルプロパティなので、
   * 上の 2 つと同じく「変わるたび全部押し込む」だけでよい(mount 時にも走る)。
   *
   * 差分だけ送るような小細工はしない —— 12 個の setProperty は一瞬で終わるし、
   * 「今の見た目 = subStyle」を常に真にしておく方が読み違えが起きない
   */
  useEffect(() => {
    for (const [name, value] of Object.entries(mpvSubProps(subStyle))) {
      runSub(name, setProperty(name, value));
    }
  }, [subStyle]);

  const togglePlay = useCallback(() => run(command('cycle', ['pause'])), []);
  const seekTo = useCallback((sec: number) => run(command('seek', [sec, 'absolute'])), []);
  const seekBy = useCallback((delta: number) => run(command('seek', [delta, 'relative'])), []);

  const setVolume = useCallback((vol: number) => {
    const nv = clamp01(vol);
    run(setProperty('volume', Math.round(nv * 100)));
    run(setProperty('mute', false));
    saveVolumePref(nv);
    saveMutedPref(false);
  }, []);

  const changeVolume = useCallback(
    (delta: number) => setVolume(stateRef.current.volume + delta),
    [setVolume],
  );

  const toggleMute = useCallback(() => {
    const next = !stateRef.current.muted;
    run(setProperty('mute', next));
    saveMutedPref(next);
  }, []);

  const toggleUnscaled = useCallback(() => {
    const next = !unscaledRef.current;
    setUnscaled(next);
    run(setProperty('video-unscaled', unscaledValue(next)));
    saveUnscaledPref(next);
  }, []);

  const setRate = useCallback((rate: number) => run(setProperty('speed', rate)), []);

  const cycleRate = useCallback((dir: 1 | -1) => {
    const cur = RATE_OPTIONS.indexOf(stateRef.current.rate);
    const base = cur >= 0 ? cur : RATE_OPTIONS.indexOf(1);
    const next = Math.min(Math.max(base + dir, 0), RATE_OPTIONS.length - 1);
    run(setProperty('speed', RATE_OPTIONS[next]));
  }, []);

  const setTrack = useCallback((kind: 'audio' | 'sub', id: number | null) => {
    // mpv の sid/aid は 'no' で無効化する
    run(setProperty(kind === 'audio' ? 'aid' : 'sid', id == null ? 'no' : String(id)));
    // track-list の selected は setProperty 後に property-change で届くが、
    // 反映が遅れて select の表示が戻って見えることがあるので先に手元を更新しておく
    setTracks((cur) =>
      cur.map((t) => (t.kind === kind ? { ...t, selected: t.id === id } : t)),
    );
  }, []);

  return {
    state, togglePlay, seekTo, seekBy, setVolume, changeVolume, toggleMute, setRate, cycleRate,
    tracks, setTrack, unscaled, toggleUnscaled,
  };
}
