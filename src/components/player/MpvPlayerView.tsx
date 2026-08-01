import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { command, listenEvents, setProperty } from 'tauri-plugin-libmpv-api';
import { api } from '../../api';
import { isAssCodec } from '../../lib/subtitleStyle';
import { useLibrary } from '../../store';
import type { VideoRow } from '../../types';
import { ContextMenu } from '../ContextMenu';
import { PlayerControls } from './PlayerControls';
import { SubtitleStylePanel } from './SubtitleStylePanel';
import { resumeValueMs, savedMuted, savedVolume, shouldCountView } from './types';
import { useMpvPlayer } from './useMpvPlayer';
import { usePlayerMenu } from './usePlayerMenu';
import { usePlayerShortcuts } from './usePlayerShortcuts';
import { usePlayQueue } from './usePlayQueue';

/**
 * mpv エンジンのプレイヤービュー。
 * 映像は透過ウィンドウの背後にウィンドウ全面で描画され(html.mpv-active でグリッドを
 * 隠して透過)、HTML のコントロールをその上に重ねる。
 * ファイルが再生できない(end-file reason=error)ときは onFail で WebView2 経路へ。
 */
export function MpvPlayerView({ video, onFail }: { video: VideoRow; onFail: () => void }) {
  const { setPlayingVideo, bumpVersion, autoplayNext, pushToast } = useLibrary();
  const player = useMpvPlayer();
  const queue = usePlayQueue();
  const counted = useRef(false);
  // 視聴履歴の行(v1.18)。id ではなく Promise を持つ —— markOpened の応答が返る前に
  // 閉じられても、解決してから finishView を投げられるようにするため
  const history = useRef<Promise<number> | null>(null);
  const restored = useRef(false);
  const advanced = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  // 字幕の見た目パネル(v1.24)
  const [styleOpen, setStyleOpen] = useState(false);

  const stateRef = useRef(player.state);
  stateRef.current = player.state;
  // 連続再生はプレイヤーからも切り替えられる(v1.12)。値を deps に入れると、終端で
  // 止まったまま ON にした瞬間に下の effect が走って次へ飛ぶので ref 経由で読む
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  // 再生中だけ WebView を透過して背後の mpv を見せる(グリッドは非表示)
  useEffect(() => {
    document.documentElement.classList.add('mpv-active');
    return () => document.documentElement.classList.remove('mpv-active');
  }, []);

  const close = useCallback(() => {
    void getCurrentWindow().setFullscreen(false).catch(() => {});
    setPlayingVideo(null);
  }, [setPlayingVideo]);

  // mpv はウィンドウ全面描画なので Web Fullscreen API ではなく Tauri のウィンドウ全画面を使う
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((cur) => {
      void getCurrentWindow().setFullscreen(!cur).catch(() => {});
      return !cur;
    });
  }, []);

  // 再生開始: 音量・速度を復元してから loadfile → 再生。終了時は保存して stop
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await setProperty('volume', Math.round(savedVolume() * 100));
      await setProperty('mute', savedMuted());
      await setProperty('speed', 1);
      await command('loadfile', [video.path]);
      if (!cancelled) await setProperty('pause', false);
    })().catch((e) => {
      console.warn('mpv で再生を開始できません:', e);
      onFail();
    });
    return () => {
      cancelled = true;
      const s = stateRef.current;
      if (s.duration > 0) {
        api.setResume(video.id, resumeValueMs(s.currentTime, s.duration)).then(() => bumpVersion());
      }
      // 視聴履歴に到達位置を書き戻す(v1.18)。resumeValueMs は使わない ——
      // あれは 90% 超で 0 に丸めるので、最後まで観たときに「0 ms 観た」と記録されてしまう
      const h = history.current;
      if (h) void h.then((id) => api.finishView(id, Math.round(s.currentTime * 1000))).catch(() => {});
      void command('stop').catch(() => {});
      void setProperty('pause', true).catch(() => {});
      void getCurrentWindow().setFullscreen(false).catch(() => {});
    };
    // onFail/bumpVersion は安定参照。video.id が変わったら key で remount される
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // レジューム復元: duration が初めて取れた時点で 1 回だけシーク
  // (loadfile の start オプションは mpv バージョンで引数位置が変わるため使わない)
  useEffect(() => {
    if (restored.current) return;
    const d = player.state.duration;
    if (d <= 0) return;
    restored.current = true;
    const sec = video.resumeMs / 1000;
    if (video.resumeMs > 0 && sec < d - 5) void command('seek', [sec, 'absolute']).catch(() => {});
  }, [player.state.duration, video.resumeMs]);

  // 視聴履歴(v1.18): 実際にデコードが進んだ時点で 1 回だけ記録する。
  // **視聴カウントとは基準が違う** —— こちらは「開いてすぐ閉じた」ものも残す。
  // そうしないと「ちょっと開いて違うと思って閉じたやつ」を履歴から探し直せないため
  useEffect(() => {
    if (history.current !== null) return;
    if (player.state.currentTime <= 0) return;
    history.current = api.markOpened(video.id);
    void history.current.then(() => bumpVersion()).catch(() => {});
  }, [player.state.currentTime, video.id, bumpVersion]);

  // 視聴カウント: 尺の 5% 以上 or 30 秒以上まで観たら 1 回だけ(v1.8。
  // それまでは「開いてすぐ閉じた」扱いで数えない)
  useEffect(() => {
    if (counted.current) return;
    if (!shouldCountView(player.state.currentTime, player.state.duration)) return;
    counted.current = true;
    api.markViewed(video.id).then(() => bumpVersion());
  }, [player.state.currentTime, player.state.duration, video.id, bumpVersion]);

  // 連続再生: 最後まで再生したら次へ(keep-open=yes なので EOF では pause 状態で止まる)。
  // 設定は autoplayRef から読む(deps に入れない理由は ref の宣言部を参照)。
  // 再生中は time-pos で走り続け、EOF では paused が変わるので判定機会は失われない
  useEffect(() => {
    if (!autoplayRef.current || advanced.current) return;
    const s = player.state;
    if (s.duration <= 0 || !s.paused) return;
    // 終端から 1 秒以内で停止 = 最後まで観た。手動の一時停止と区別する
    if (s.duration - s.currentTime > 1) return;
    if (!queue.hasNext) return;
    advanced.current = true;
    void queue.next();
  }, [player.state.paused, player.state.currentTime, player.state.duration, queue]);

  // レジューム保存: 5 秒ごと + 一時停止遷移時(keep-open の EOF 停止もここで拾える)
  const lastSavedSec = useRef(0);
  useEffect(() => {
    const s = player.state;
    if (s.duration <= 0) return;
    if (Math.abs(s.currentTime - lastSavedSec.current) >= 5) {
      lastSavedSec.current = s.currentTime;
      void api.setResume(video.id, resumeValueMs(s.currentTime, s.duration));
    }
  }, [player.state.currentTime, video.id]);

  const prevPaused = useRef(true);
  useEffect(() => {
    const s = player.state;
    if (s.paused && !prevPaused.current && s.duration > 0) {
      lastSavedSec.current = s.currentTime;
      void api.setResume(video.id, resumeValueMs(s.currentTime, s.duration));
    }
    prevPaused.current = s.paused;
  }, [player.state.paused, video.id]);

  // このファイルだけ mpv で再生できない → WebView2 エンジン(変換パイプライン付き)へ
  useEffect(() => {
    const unlisten = listenEvents((e) => {
      if (e.event === 'end-file' && e.reason === 'error') {
        console.warn('mpv がファイルを再生できません。WebView2 プレイヤーへ切り替えます');
        onFail();
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, [onFail]);

  // マウスが 2.5 秒止まったらコントロールを隠す(一時停止中は常時表示)
  const wake = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2500);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [wake]);

  const onEscape = useCallback(() => {
    if (isFullscreen) toggleFullscreen();
    else close();
  }, [isFullscreen, toggleFullscreen, close]);

  // 今見ているコマをサムネイルにする(10% 固定で暗転を引いたときの手当て)
  const setThumbnail = useCallback(() => {
    const ms = Math.floor(stateRef.current.currentTime * 1000);
    api.setThumbTime(video.id, ms).then(() => {
      pushToast('この位置をサムネイルにしました', 'info');
      bumpVersion();
    });
  }, [video.id, pushToast, bumpVersion]);

  // 今見ているコマを画像として保存する(v1.26)。サムネイル指定とは別物で、
  // 出るのはユーザーのフォルダの PNG。**DB は変わらないので bumpVersion は呼ばない**
  const saveFrame = useCallback(() => {
    const ms = Math.floor(stateRef.current.currentTime * 1000);
    api.saveFrame(video.id, ms).then((path) => {
      pushToast(`画像を保存しました: ${path}`, 'info');
    });
  }, [video.id, pushToast]);

  usePlayerShortcuts(player, {
    onEscape,
    toggleFullscreen,
    wake,
    onNext: queue.next,
    onPrev: queue.prev,
    onSetThumbnail: setThumbnail,
    onSaveFrame: saveFrame,
    // パネルは入力欄だらけなので、開いている間はキーをすべてパネルに譲る
    suspended: styleOpen,
  });

  const { menu, onContextMenu, close: closeMenu, run: runMenu } =
    usePlayerMenu(video, { wake, onSetThumbnail: setThumbnail, onSaveFrame: saveFrame, onClose: close });

  // パネルを開いている間はバーを消さない(アンカーのボタンごと消えるうえ、
  // .mpv-overlay.controls-hidden の cursor:none でカーソルまで見えなくなる)
  const visible = controlsVisible || player.state.paused || styleOpen;

  // 今出ている字幕が自前のスタイルを持っているか。持っていれば色を変えても効かない
  const assWarning = (player.tracks ?? []).some(
    (t) => t.kind === 'sub' && t.selected && isAssCodec(t.codec),
  );

  return (
    <div
      className={`mpv-overlay ${visible ? '' : 'controls-hidden'}`}
      onMouseMove={wake}
      onContextMenu={onContextMenu}
    >
      <div className="mpv-stage" onClick={player.togglePlay} onDoubleClick={toggleFullscreen} />
      <div className="player-top">
        <div className="player-title" title={video.path}>
          {video.title ?? video.filename}
        </div>
        <button className="player-close" onClick={close} title="閉じる (Esc)">
          <X />
        </button>
      </div>
      <PlayerControls
        player={player}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onSetThumbnail={setThumbnail}
        onSaveFrame={saveFrame}
        // 映像は mpv が描いているので、コマ出しは WebView2 側で元動画を開き直す
        previewSrc={convertFileSrc(video.path)}
        queue={queue}
        subtitleStyleOpen={styleOpen}
        onOpenSubtitleStyle={() => {
          wake();
          setStyleOpen((v) => !v);
        }}
      />

      {/* パネルも ContextMenu と同じく .mpv-overlay の内側に置くこと(v1.24) */}
      {styleOpen && (
        <SubtitleStylePanel assWarning={assWarning} onClose={() => setStyleOpen(false)} />
      )}

      {/* **必ず .mpv-overlay の内側**。再生中は html.mpv-active が .app ごと消す */}
      {menu && (
        <ContextMenu
          key={`${menu.x},${menu.y}`}
          x={menu.x}
          y={menu.y}
          entries={menu.entries}
          onClose={closeMenu}
          onSelect={(id) => void runMenu(id)}
        />
      )}
    </div>
  );
}
