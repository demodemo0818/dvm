import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import {
  clamp01,
  RATE_OPTIONS,
  savedMuted,
  savedVolume,
  saveMutedPref,
  saveVolumePref,
} from './types';
import type { PlayerState, VideoPlayer } from './types';

/**
 * <video> 要素(WebView2 エンジン)用の VideoPlayer 実装。
 * 状態はイベント経由で同期し、操作は要素へ直接反映する(要素が唯一の真実)。
 * 音量・ミュートは localStorage に保存して次回再生・mpv エンジンと共有する。
 */
export function useVideoPlayer(videoRef: RefObject<HTMLVideoElement | null>, src: string): VideoPlayer {
  const [state, setState] = useState<PlayerState>(() => ({
    currentTime: 0,
    duration: 0,
    paused: true,
    volume: savedVolume(),
    muted: savedMuted(),
    rate: 1,
    bufferedEnd: 0,
  }));

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = savedVolume();
    v.muted = savedMuted();

    const sync = () => {
      let bufferedEnd = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > bufferedEnd) {
          bufferedEnd = v.buffered.end(i);
        }
      }
      setState({
        currentTime: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
        volume: v.volume,
        muted: v.muted,
        rate: v.playbackRate,
        bufferedEnd,
      });
    };
    const events = [
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'play',
      'pause',
      'volumechange',
      'ratechange',
      'progress',
      'seeking',
      'seeked',
      'ended',
    ];
    events.forEach((ev) => v.addEventListener(ev, sync));
    sync();
    return () => events.forEach((ev) => v.removeEventListener(ev, sync));
  }, [videoRef, src]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, [videoRef]);

  const seekTo = useCallback(
    (sec: number) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      v.currentTime = Math.min(Math.max(sec, 0), v.duration);
    },
    [videoRef],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (v) seekTo(v.currentTime + delta);
    },
    [videoRef, seekTo],
  );

  const setVolume = useCallback(
    (vol: number) => {
      const v = videoRef.current;
      if (!v) return;
      const nv = clamp01(vol);
      v.volume = nv;
      v.muted = false;
      saveVolumePref(nv);
      saveMutedPref(false);
    },
    [videoRef],
  );

  const changeVolume = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (v) setVolume(v.volume + delta);
    },
    [videoRef, setVolume],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    saveMutedPref(v.muted);
  }, [videoRef]);

  const setRate = useCallback(
    (rate: number) => {
      const v = videoRef.current;
      if (v) v.playbackRate = rate;
    },
    [videoRef],
  );

  /** RATE_OPTIONS の並びを 1 段上下する(< > キー用) */
  const cycleRate = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      const cur = RATE_OPTIONS.indexOf(v.playbackRate);
      const base = cur >= 0 ? cur : RATE_OPTIONS.indexOf(1);
      const next = Math.min(Math.max(base + dir, 0), RATE_OPTIONS.length - 1);
      v.playbackRate = RATE_OPTIONS[next];
    },
    [videoRef],
  );

  return { state, togglePlay, seekTo, seekBy, setVolume, changeVolume, toggleMute, setRate, cycleRate };
}
