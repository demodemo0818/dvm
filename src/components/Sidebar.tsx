import { ask, open } from '@tauri-apps/plugin-dialog';
import { Copy, FolderSearch, ListOrdered, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type {
  FolderNode, PlanItem, Series, SidebarTab, SmartFolder, Tag, VideoQuery, WatchedFolder,
} from '../types';
import { FileOpDialog } from './FileOpDialog';
import { FolderTree } from './FolderTree';
import { TagTree } from './TagTree';

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
  const {
    folderId, setFolderId, dirPath, version, bumpVersion, sidebarWidth,
    seriesId, toggleSeriesFilter,
    missingOnly, toggleMissingOnly,
    duplicatesOnly, toggleDuplicatesOnly, applyFilter, pushToast,
  } = useLibrary();
  const [tab, setTab] = useState<SidebarTab>('library');
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [missingCount, setMissingCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [relinkPlan, setRelinkPlan] = useState<PlanItem[] | null>(null);

  useEffect(() => {
    api.listWatchedFolders().then(setFolders);
    api.listTags().then(setTags);
    api.listSeries().then(setSeriesList);
    api.listSmartFolders().then(setSmartFolders);
    api.countVideos({}).then(setTotalCount);
    api.countVideos({ missing: true }).then(setMissingCount);
    api.countVideos({ duplicatesOnly: true }).then(setDuplicateCount);
  }, [version]);

  // 前回開いていたタブを復元する(view_mode / card_width と同じく settings に持つ)
  useEffect(() => {
    api.getSetting('sidebar_tab').then((v) => {
      if (v === 'folders' || v === 'library') setTab(v);
    });
  }, []);

  /**
   * ツリーは全動画のパスを 1 回読んで組み立てるので、
   * 「フォルダー」タブを開いているときだけ取りに行く
   */
  useEffect(() => {
    if (tab !== 'folders') return;
    api.listFolderTree().then(setFolderTree);
  }, [tab, version]);

  const selectTab = (next: SidebarTab) => {
    setTab(next);
    api.setSetting('sidebar_tab', next);
  };

  /** 保存した検索条件を復元する。壊れた JSON は握り潰さずトーストで知らせる */
  const openSmartFolder = (sf: SmartFolder) => {
    let q: VideoQuery;
    try {
      q = JSON.parse(sf.queryJson);
    } catch {
      pushToast(`「${sf.name}」の検索条件を読めませんでした`);
      return;
    }
    applyFilter({
      text: q.text,
      folderId: q.folderId,
      dirPath: q.dirPath,
      tagIds: q.tagIds,
      seriesId: q.seriesId,
      minRating: q.minRating,
      missingOnly: q.missing,
      duplicatesOnly: q.duplicatesOnly,
      sort: q.sort,
      advanced: {
        searchPath: q.searchPath ?? false,
        untagged: q.untagged ?? false,
        unwatched: q.unwatched ?? false,
        minHeight: q.minHeight ?? 0,
        videoCodecs: q.videoCodecs ?? [],
        addedAfter: q.addedAfter ?? '',
        addedBefore: q.addedBefore ?? '',
      },
    });
  };

  /**
   * フォルダごと動かした動画の再リンク。
   * 変更前は文字入力(消えたフォルダはダイアログで選べない)、変更後はフォルダ選択にする
   */
  const startRelink = async () => {
    const fromPrefix = window.prompt(
      '変更前のフォルダパスを入力してください\n(このパスで始まる動画が対象になります)',
      '',
    );
    if (fromPrefix === null || fromPrefix.trim() === '') return;
    const dest = await open({ directory: true, multiple: false, title: '変更後のフォルダ' });
    if (typeof dest !== 'string') return;
    const plan = await api.planRelink(fromPrefix.trim(), dest);
    if (plan.length === 0) {
      pushToast('そのパスで始まる動画はありませんでした', 'info');
      return;
    }
    setRelinkPlan(plan);
  };

  const removeSmartFolder = async (sf: SmartFolder) => {
    const yes = await ask(`スマートフォルダ「${sf.name}」を削除しますか?\n(動画は消えません)`, {
      title: 'スマートフォルダの削除',
    });
    if (!yes) return;
    await api.deleteSmartFolder(sf.id);
    bumpVersion();
  };

  const removeSeries = async (s: Series) => {
    const yes = await ask(
      `シリーズ「${s.name}」を削除しますか?\n(動画自体は消えません)`,
      { title: 'シリーズの削除' },
    );
    if (!yes) return;
    await api.deleteSeries(s.id);
    if (seriesId === s.id) toggleSeriesFilter(s.id);
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
    // 幅はドラッグで変えられる。min-width も同じ値にして flex に縮められないようにする
    <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar-title">DVM</div>
      <button
        className={`side-item ${folderId === null && dirPath === null && !missingOnly ? 'active' : ''}`}
        onClick={() => {
          if (missingOnly) toggleMissingOnly();
          // setFolderId は dirPath(フォルダーツリーの絞り込み)も一緒に外す
          setFolderId(null);
        }}
      >
        すべての動画 <span className="count">{totalCount}</span>
      </button>
      {missingCount > 0 && (
        <button
          className={`side-item warn ${missingOnly ? 'active' : ''}`}
          onClick={toggleMissingOnly}
          title="ファイルが見つからない動画だけを表示(パスの再リンクか、ライブラリからの削除で整理できます)"
        >
          <TriangleAlert />
          見つからない <span className="count">{missingCount}</span>
        </button>
      )}
      {missingOnly && (
        <button className="side-action" onClick={startRelink}>
          パスを再リンク...
        </button>
      )}
      {duplicateCount > 0 && (
        <button
          className={`side-item ${duplicatesOnly ? 'active' : ''}`}
          onClick={toggleDuplicatesOnly}
          title="内容が同じ動画(サイズと先頭ハッシュが一致)だけを表示。同じものが隣り合って並びます"
        >
          <Copy />
          重複 <span className="count">{duplicateCount}</span>
        </button>
      )}

      {/* ここから下だけをタブで入れ替える。上の 3 行はどちらのタブでも解除できるように残す */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'library' ? 'active' : ''}`}
          onClick={() => selectTab('library')}
          title="スマートフォルダ・監視フォルダ・シリーズ・タグ"
        >
          ライブラリ
        </button>
        <button
          className={`sidebar-tab ${tab === 'folders' ? 'active' : ''}`}
          onClick={() => selectTab('folders')}
          title="フォルダの階層で絞り込む(そのフォルダ直下の動画だけを表示)"
        >
          フォルダー
        </button>
      </div>

      {tab === 'folders' && <FolderTree nodes={folderTree} />}

      {tab === 'library' && (
        <>
          {smartFolders.length > 0 && <div className="side-section">スマートフォルダ</div>}
          {smartFolders.map((sf) => (
            <div
              key={sf.id}
              className="side-item folder"
              onClick={() => openSmartFolder(sf)}
              title={`${sf.name}(保存した検索条件を復元します)`}
            >
              <FolderSearch className="tag-mark" />
              <span className="folder-name">{sf.name}</span>
              <button
                className="remove"
                title="スマートフォルダを削除"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSmartFolder(sf);
                }}
              >
                ×
              </button>
            </div>
          ))}

          <div className="side-section" title="クリックするとそのフォルダ配下の動画をまとめて表示します">
            監視フォルダ
          </div>
          {folders.map((f) => (
            <div
              key={f.id}
              className={`side-item folder ${folderId === f.id ? 'active' : ''}`}
              onClick={() => setFolderId(f.id)}
              title={`${f.path}\nクリックでこのフォルダ配下すべてを表示(サブフォルダ単位で絞るなら「フォルダー」タブ)`}
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

          {seriesList.length > 0 && <div className="side-section">シリーズ</div>}
          {seriesList.map((s) => (
            <div
              key={s.id}
              className={`side-item folder ${seriesId === s.id ? 'active' : ''}`}
              onClick={() => toggleSeriesFilter(s.id)}
              title={`${s.name}(クリックで絞り込み。シリーズ内は登録順で表示)`}
            >
              <ListOrdered className="tag-mark" />
              <span className="folder-name">{s.name}</span>
              <span className="count">{s.videoCount}</span>
              <button
                className="remove"
                title="シリーズを削除"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSeries(s);
                }}
              >
                ×
              </button>
            </div>
          ))}

          {tags.length > 0 && <div className="side-section">タグ</div>}
          <TagTree tags={tags} />
        </>
      )}

      {relinkPlan && (
        <FileOpDialog kind="relink" plan={relinkPlan} onClose={() => setRelinkPlan(null)} />
      )}
    </aside>
  );
}
