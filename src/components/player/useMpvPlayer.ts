import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';
import { command, observeProperties, setProperty } from 'tauri-plugin-libmpv-api';
import { api } from '../../api';
import { useLibrary } from '../../store';
import { chapterJumpTarget, toChapters } from '../../lib/chapters';
import type { Chapter } from '../../lib/chapters';
import { hdrFromParams } from '../../lib/hdrInfo';
import type { HdrInfo } from '../../lib/hdrInfo';
import { mpvSubProps } from '../../lib/subtitleStyle';
import { hdrHintValue, MPV_OBSERVED } from './mpv';
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
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [hdr, setHdr] = useState<HdrInfo | null>(null);
  /** ウィンドウが乗っているモニタで Windows の HDR がオンか(v1.31) */
  const [displayHdr, setDisplayHdr] = useState(false);
  // リピートは engine をまたぐ設定なので store に置いている(v1.13)
  const repeatOne = useLibrary((s) => s.repeatOne);
  // 字幕の見た目(v1.24)。mpv 専用だが、設定モーダルからも触るので store 経由
  const subStyle = useLibrary((s) => s.subStyle);
  // HDR パススルー(v1.30)。同じく設定モーダルから変わるので store 経由
  const hdrPassthrough = useLibrary((s) => s.hdrPassthrough);
  // 表示サイズ(v1.12)。mpv 側は購読しない — 変更できるのはこの UI だけなので手元が真実
  const [unscaled, setUnscaled] = useState(savedUnscaled);
  // 操作コールバックから最新状態を読むための ref(stale closure 回避)
  const stateRef = useRef(state);
  stateRef.current = state;
  const unscaledRef = useRef(unscaled);
  unscaledRef.current = unscaled;
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;

  useEffect(() => {
    const unlisten = observeProperties(MPV_OBSERVED, ({ name, data }) => {
      if (name === 'track-list') {
        setTracks(toTracks(data));
        return;
      }
      if (name === 'video-params') {
        // stop / ロード中は null。前のファイルのバッジを残さないよう素直に消す
        setHdr(hdrFromParams(data));
        return;
      }
      if (name === 'chapter-list') {
        // stop / 別ファイルへの切り替えでは null が来る。前のファイルの目盛りを
        // 残さないよう、ここは time-pos と違って素直に空へ倒す
        setChapters(toChapters(data));
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

  /**
   * HDR パススルー(v1.30)。loop-file / sub-* と同じく loadfile を跨いで残る
   * グローバルプロパティなので、変わるたび押し込むだけでよい(mount 時にも走る)。
   *
   * 失敗は `runSub` と同じく**名前を出して警告する** —— 黙って消えると
   * 「設定を入れたのに HDR にならない」の原因に辿り着けない
   */
  useEffect(() => {
    runSub('target-colorspace-hint', setProperty('target-colorspace-hint', hdrHintValue(hdrPassthrough)));
  }, [hdrPassthrough]);

  /**
   * ディスプレイの HDR 状態を Windows に聞き直す(v1.31)。
   *
   * **mpv には聞けない**。`target-colorspace-hint` は「こちらが出した希望」で、
   * 実際の出力を返す `target-params` は同梱 libmpv では property not found になる
   * (実機で確認済み)。なので Rust の `is_hdr_display` を叩く
   */
  const refreshDisplayHdr = useCallback(() => {
    api.isHdrDisplay().then((v) => setDisplayHdr(v === true)).catch(() => setDisplayHdr(false));
  }, []);

  /*
   * 聞き直す機会は 3 つ: mount(= 再生開始)、パススルー設定の変更、
   * そして **video-params が届いたとき**(ファイル切替や vo の再構成)。
   * `hdr` を deps に入れているのがその 3 つ目。
   *
   * ポーリングはしない。再生中に Windows 側の HDR を切り替えた場合だけは
   * 開き直すまで追従しないが、そのために毎秒 IPC を投げる価値はない
   */
  useEffect(() => {
    refreshDisplayHdr();
  }, [refreshDisplayHdr, hdrPassthrough, hdr]);

  // 別のモニタへ動かしたら聞き直す(HDR のモニタと SDR のモニタの併用は普通にある)
  useEffect(() => {
    const un = getCurrentWindow().onMoved(() => refreshDisplayHdr());
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [refreshDisplayHdr]);

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

  /**
   * 次(1)/前(-1)のチャプターへ(v1.29)。飛び先の計算は純関数に任せ、
   * **端では何もしない** —— mpv の `add chapter 1` に任せると最後のチャプターで
   * 終端に到達し、連続再生が次の動画を始めてしまう
   */
  const jumpChapter = useCallback((dir: 1 | -1) => {
    const target = chapterJumpTarget(chaptersRef.current, stateRef.current.currentTime, dir);
    if (target == null) return;
    run(command('seek', [target, 'absolute']));
  }, []);

  return {
    state, togglePlay, seekTo, seekBy, setVolume, changeVolume, toggleMute, setRate, cycleRate,
    tracks, setTrack, unscaled, toggleUnscaled, chapters, jumpChapter, hdr,
    // 実際に HDR で出ている = パススルーがオン **かつ** ディスプレイが HDR モード。
    // hint は `auto` なので、片方でも欠けたら mpv は SDR にトーンマップしている
    hdrOutput: hdrPassthrough && displayHdr,
  };
}
