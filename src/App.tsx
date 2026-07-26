import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useEffect, useRef } from 'react';
import './App.css';
import { api } from './api';
import { AiPanel } from './components/AiPanel';
import { Inspector } from './components/Inspector';
import { PlayerOverlay } from './components/PlayerOverlay';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { VideoGrid } from './components/VideoGrid';
import { useLibrary } from './store';

export default function App() {
  const { bumpVersion, setStatus, status, scanning, setPlayerPath } = useLibrary();
  const debounceTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useLibrary.getState();
      // プレイヤー表示中は閉じるだけ(選択は維持)。それ以外は選択解除
      if (s.playingVideo) s.setPlayingVideo(null);
      else s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 外部プレイヤー設定をロード(再生分岐で使う)
  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
  }, [setPlayerPath]);

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
    <div className="app">
      <Sidebar />
      <main className="main">
        <Toolbar />
        <VideoGrid />
        <div className="statusbar">{scanning || status ? status : '準備完了'}</div>
      </main>
      <Inspector />
      <AiPanel />
      <PlayerOverlay />
    </div>
  );
}
