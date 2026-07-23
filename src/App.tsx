import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useEffect, useRef } from 'react';
import './App.css';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { VideoGrid } from './components/VideoGrid';
import { useLibrary } from './store';

export default function App() {
  const { bumpVersion, setStatus, status, scanning } = useLibrary();
  const debounceTimer = useRef<number | undefined>(undefined);

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
    </div>
  );
}
