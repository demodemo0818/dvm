import { ask, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { Tag, WatchedFolder } from '../types';

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
  const { folderId, setFolderId, version, bumpVersion, tagIds, toggleTagFilter } = useLibrary();
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    api.listWatchedFolders().then(setFolders);
    api.listTags().then(setTags);
    api.countVideos({}).then(setTotalCount);
  }, [version]);

  const removeTag = async (tag: Tag) => {
    const yes = await ask(
      `タグ「${tag.name}」を削除しますか?\n(${tag.videoCount} 件の動画から外れます。動画自体は消えません)`,
      { title: 'タグの削除' },
    );
    if (!yes) return;
    await api.deleteTag(tag.id);
    if (tagIds.includes(tag.id)) toggleTagFilter(tag.id);
    bumpVersion();
  };

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

      {tags.length > 0 && <div className="side-section">タグ</div>}
      {tags.map((t) => (
        <div
          key={t.id}
          className={`side-item folder ${tagIds.includes(t.id) ? 'active' : ''}`}
          onClick={() => toggleTagFilter(t.id)}
          title={`${t.name}(クリックで絞り込み。複数選択で AND 検索)`}
        >
          <span className="tag-mark">#</span>
          <span className="folder-name">{t.name}</span>
          <span className="count">{t.videoCount}</span>
          <button
            className="remove"
            title="タグを削除"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(t);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </aside>
  );
}
