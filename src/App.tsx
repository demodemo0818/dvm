import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ask } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef } from 'react';
import './App.css';
import { api } from './api';
import { AiPanel } from './components/AiPanel';
import { Inspector } from './components/Inspector';
import { PaneResizer } from './components/PaneResizer';
import { PlayerOverlay } from './components/PlayerOverlay';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { VideoGrid } from './components/VideoGrid';
import { INSPECTOR_WIDTH, SIDEBAR_WIDTH, useLibrary } from './store';

export default function App() {
  const {
    bumpVersion, setStatus, status, scanning, setPlayerPath, setPreviewOnHover,
    setViewMode, setCardWidth, setAutoplayNext,
    setInspectorPinned, setSidebarWidth, setInspectorWidth,
    inspectorPinned, sidebarWidth, inspectorWidth, selection,
  } = useLibrary();
  const debounceTimer = useRef<number | undefined>(undefined);

  // 詳細ペインは「固定表示」か「何か選択中」のときに出す。
  // 幅を変える帯もペインと一緒に出し入れするので、判定はここに置く
  const showInspector = inspectorPinned || selection.length > 0;

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

  // 外部プレイヤー設定(再生分岐)・ホバープレビュー・表示設定をロード
  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    // 既定は ON。明示的に '0' のときだけ OFF
    api.getSetting('preview_on_hover').then((v) => setPreviewOnHover(v !== '0'));
    api.getSetting('view_mode').then((v) => {
      if (v === 'list' || v === 'grid') setViewMode(v);
    });
    api.getSetting('card_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setCardWidth(n);
    });
    // 連続再生は既定 OFF(勝手に次が始まると驚くため)
    api.getSetting('autoplay_next').then((v) => setAutoplayNext(v === '1'));
    // 詳細ペインの固定は既定 OFF(従来どおり選択中だけ出る)
    api.getSetting('inspector_pinned').then((v) => setInspectorPinned(v === '1'));
    // 幅は setter 側で上下限に丸められる
    api.getSetting('sidebar_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setSidebarWidth(n);
    });
    api.getSetting('inspector_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setInspectorWidth(n);
    });
  }, [
    setPlayerPath, setPreviewOnHover, setViewMode, setCardWidth, setAutoplayNext,
    setInspectorPinned, setSidebarWidth, setInspectorWidth,
  ]);

  /**
   * ドロップされたパスを取り込む。フォルダが混ざっていたら扱いを尋ねる(v1.9)。
   * 「監視フォルダ」にすると以後の追加も自動で拾うが、フォルダごと登録したくない
   * ケース(一度きりの取り込み)もあるので選ばせる
   */
  const handleDrop = useCallback(
    async (paths: string[]) => {
      const { dirs, files } = await api.classifyPaths(paths);
      if (files.length > 0) await api.registerFiles(files);

      if (dirs.length > 0) {
        const watch = await ask(
          `フォルダが ${dirs.length} 件あります。監視フォルダとして登録しますか?\n\n` +
            'はい = 監視フォルダにする(以後の追加も自動で取り込みます)\n' +
            'いいえ = 中の動画を個別登録する(このときの分だけ)',
          { title: 'フォルダの扱い' },
        );
        for (const dir of dirs) {
          if (watch) await api.addWatchedFolder(dir);
          else await api.registerFiles([dir]);
        }
      }
      bumpVersion();
    },
    [bumpVersion],
  );

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
          void handleDrop(e.payload.paths);
        }
      })
      .then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, [bumpVersion, setStatus, handleDrop]);

  return (
    <>
      {/* mpv 再生中は .app ごと非表示にするため、プレイヤーは .app の外に置く */}
      <div className="app">
        <Sidebar />
        <PaneResizer
          label="サイドバー"
          edge="left"
          width={sidebarWidth}
          min={SIDEBAR_WIDTH.min}
          max={SIDEBAR_WIDTH.max}
          defaultWidth={SIDEBAR_WIDTH.default}
          onResize={setSidebarWidth}
          // 丸められたあとの値を保存したいので、状態は store から読み直す
          onCommit={() =>
            void api.setSetting('sidebar_width', String(useLibrary.getState().sidebarWidth))
          }
        />
        <main className="main">
          <Toolbar />
          <VideoGrid />
          <div className="statusbar">{scanning || status ? status : '準備完了'}</div>
        </main>
        {showInspector && (
          <PaneResizer
            label="詳細ペイン"
            edge="right"
            width={inspectorWidth}
            min={INSPECTOR_WIDTH.min}
            max={INSPECTOR_WIDTH.max}
            defaultWidth={INSPECTOR_WIDTH.default}
            onResize={setInspectorWidth}
            onCommit={() =>
              void api.setSetting('inspector_width', String(useLibrary.getState().inspectorWidth))
            }
          />
        )}
        <Inspector />
        <AiPanel />
      </div>
      <PlayerOverlay />
      {/* 通知も .app の外(mpv 再生中でもエラーが見えるように) */}
      <Toasts />
    </>
  );
}
