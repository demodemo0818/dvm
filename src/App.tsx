import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useEffect, useRef } from 'react';
import './App.css';
import { api } from './api';
import { AiPanel } from './components/AiPanel';
import { Inspector } from './components/Inspector';
import { PlayerOverlay } from './components/PlayerOverlay';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { VideoGrid } from './components/VideoGrid';
import { useLibrary } from './store';

export default function App() {
  const { bumpVersion, setStatus, status, scanning, setPlayerPath, setPreviewOnHover } =
    useLibrary();
  const debounceTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useLibrary.getState();
      // プレイヤー表示中のキー操作は PlayerOverlay 側で一元管理する
      if (s.playingVideo) return;
      s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 外部プレイヤー設定(再生分岐)とホバープレビューの可否をロード
  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    // 既定は ON。明示的に '0' のときだけ OFF
    api.getSetting('preview_on_hover').then((v) => setPreviewOnHover(v !== '0'));
  }, [setPlayerPath, setPreviewOnHover]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen('library:changed', () => {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => bumpVersion(), 300);
    }).then((u) => unlisteners.push(u));

    listen<{ scanning: boolean; message: string }>('scan:state', (e) => {
      setStatus(e.payload.scanning, e.payload.message);
    }).then((u) => unlisteners.push(u));

    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === 'drop' && e.payload.paths.length > 0) {
          api.registerFiles(e.payload.paths);
        }
      })
      .then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, [bumpVersion, setStatus]);

  return (
    <>
      {/* mpv 再生中は .app ごと非表示にするため、プレイヤーは .app の外に置く */}
      <div className="app">
        <Sidebar />
        <main className="main">
          <Toolbar />
          <VideoGrid />
          <div className="statusbar">{scanning || status ? status : '準備完了'}</div>
        </main>
        <Inspector />
        <AiPanel />
      </div>
      <PlayerOverlay />
      {/* 通知も .app の外(mpv 再生中でもエラーが見えるように) */}
      <Toasts />
    </>
  );
}
