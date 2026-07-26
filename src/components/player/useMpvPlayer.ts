import { useCallback, useEffect, useRef, useState } from 'react';
import { command, observeProperties, setProperty } from 'tauri-plugin-libmpv-api';
import { MPV_OBSERVED } from './mpv';
import {
  clamp01,
  RATE_OPTIONS,
  savedMuted,
  savedVolume,
  saveMutedPref,
  saveVolumePref,
} from './types';
import type { PlayerState, VideoPlayer } from './types';

/** IPC コマンドの失敗(ファイル未ロード中の seek 等)は無害なので握りつぶす */
const run = (p: Promise<unknown>) => {
  p.catch(() => {});
};

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
  // 操作コールバックから最新状態を読むための ref(stale closure 回避)
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unlisten = observeProperties(MPV_OBSERVED, ({ name, data }) => {
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

  const setRate = useCallback((rate: number) => run(setProperty('speed', rate)), []);

  const cycleRate = useCallback((dir: 1 | -1) => {
    const cur = RATE_OPTIONS.indexOf(stateRef.current.rate);
    const base = cur >= 0 ? cur : RATE_OPTIONS.indexOf(1);
    const next = Math.min(Math.max(base + dir, 0), RATE_OPTIONS.length - 1);
    run(setProperty('speed', RATE_OPTIONS[next]));
  }, []);

  return { state, togglePlay, seekTo, seekBy, setVolume, changeVolume, toggleMute, setRate, cycleRate };
}
