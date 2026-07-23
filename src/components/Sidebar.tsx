import { ask, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { WatchedFolder } from '../types';

const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'avi', 'wmv', 'mov', 'flv', 'webm',
  'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'vob', 'ogv', 'ogm',
  'rm', 'rmvb', 'asf', 'divx', '3gp',
];

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function Sidebar() {
  const { folderId, setFolderId, version, bumpVersion } = useLibrary();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    api.listWatchedFolders().then(setFolders);
    api.countVideos({}).then(setTotalCount);
  }, [version]);

  const addFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: '監視フォルダを追加' });
    if (typeof selected === 'string') {
      await api.addWatchedFolder(selected);
      bumpVersion();
    }
  };

  const addFiles = async () => {
    const selected = await open({
      multiple: true,
      title: '動画ファイルを追加',
      filters: [{ name: '動画', extensions: VIDEO_EXTENSIONS }],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      await api.registerFiles(selected);
      bumpVersion();
    }
  };

  const removeFolder = async (f: WatchedFolder) => {
    const yes = await ask(`「${f.path}」を監視対象から外しますか?`, { title: '監視フォルダの解除' });
    if (!yes) return;
    let removeVideos = false;
    if (f.videoCount > 0) {
      removeVideos = await ask(
        `このフォルダ由来の動画 ${f.videoCount} 件をライブラリからも削除しますか?\n(いいえ = 個別登録として残します。ファイル自体は消えません)`,
        { title: '登録の扱い' },
      );
    }
    await api.removeWatchedFolder(f.id, removeVideos);
    if (folderId === f.id) setFolderId(null);
    bumpVersion();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">VideoShelf</div>
      <button
        className={`side-item ${folderId === null ? 'active' : ''}`}
        onClick={() => setFolderId(null)}
      >
        すべての動画 <span className="count">{totalCount}</span>
      </button>

      <div className="side-section">監視フォルダ</div>
      {folders.map((f) => (
        <div
          key={f.id}
          className={`side-item folder ${folderId === f.id ? 'active' : ''}`}
          onClick={() => setFolderId(f.id)}
          title={f.path}
        >
          <span className={`dot ${f.online ? 'online' : 'offline'}`} />
          <span className="folder-name">{folderName(f.path)}</span>
          <span className="count">{f.videoCount}</span>
          <button
            className="remove"
            title="監視対象から外す"
            onClick={(e) => {
              e.stopPropagation();
              removeFolder(f);
            }}
          >
            ×
          </button>
        </div>
      ))}

      <button className="side-action" onClick={addFolder}>+ フォルダを追加</button>
      <button className="side-action" onClick={addFiles}>+ ファイルを追加</button>
    </aside>
  );
}
