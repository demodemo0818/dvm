import { ask, open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  ChevronDown, Copy, FolderSearch, Library, ListOrdered, ListVideo, TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useContextMenu } from '../hooks/useContextMenu';
import {
  buildLibraryMenu, buildPlaylistMenu, buildSeriesMenu, buildSmartFolderMenu, buildWatchedFolderMenu,
} from '../lib/contextMenu';
import { baseName } from '../lib/paths';
import { buildQuery, toFilterState } from '../lib/query';
import { loadedQueue, needsSavePrompt, sourceRemoved, sourceRenamed } from '../lib/queue';
import { useShallow } from 'zustand/react/shallow';
import { pickState, useLibrary } from '../store';
import type {
  FolderNode, LibraryEntry, PlanItem, Playlist, Series, SidebarTab, SmartFolder, Tag, TagGroup,
  VideoQuery, WatchedFolder,
} from '../types';
import { ContextMenu } from './ContextMenu';
import { FileOpDialog } from './FileOpDialog';
import { FolderTree } from './FolderTree';
import { TagTree } from './TagTree';

const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'avi', 'wmv', 'mov', 'flv', 'webm',
  'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'vob', 'ogv', 'ogm',
  'rm', 'rmvb', 'asf', 'divx', '3gp',
];

/** 右クリックメニューの対象(v1.20)。タグは TagTree、フォルダーツリーは FolderTree の担当 */
type MenuTarget =
  | { kind: 'wf'; folder: WatchedFolder }
  | { kind: 'sf'; sf: SmartFolder }
  | { kind: 'series'; series: Series }
  | { kind: 'playlist'; playlist: Playlist }
  // v1.27。これだけ右クリックではなくボタンの左クリックで開く
  | { kind: 'library' };

/**
 * いま画面に効いている絞り込みを VideoQuery にする(スマートフォルダの上書き用)。
 * store は FilterState を丸ごと含んでいるのでそのまま渡す ——
 * 項目を書き写すと、条件が増えたときにここだけ古いまま残る
 */
function currentQuery(): VideoQuery {
  return buildQuery(useLibrary.getState());
}

export function Sidebar() {
  const {
    folderId, setFolderId, dirPath, version, bumpVersion, sidebarWidth,
    seriesId, toggleSeriesFilter,
    playlistId, togglePlaylistFilter,
    missingOnly, toggleMissingOnly,
    duplicatesOnly, toggleDuplicatesOnly, applyFilter, pushToast,
    libraryId: currentLibId,
  } = useLibrary(useShallow(pickState(
    'folderId', 'setFolderId', 'dirPath', 'version', 'bumpVersion', 'sidebarWidth',
    'seriesId', 'toggleSeriesFilter', 'playlistId', 'togglePlaylistFilter',
    'missingOnly', 'toggleMissingOnly', 'duplicatesOnly', 'toggleDuplicatesOnly',
    'applyFilter', 'pushToast', 'libraryId',
  )));
  const [tab, setTab] = useState<SidebarTab>('library');
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [missingCount, setMissingCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [relinkPlan, setRelinkPlan] = useState<PlanItem[] | null>(null);
  // ライブラリの切り替え(v1.27)。一覧は version で取り直す —— 設定モーダルで
  // 名前を変えたときにボタンの表示を追従させるため(切り替え自体は再起動なので稀)
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);
  const [switching, setSwitching] = useState(false);
  const { menu, open: openMenu, openAt, close: closeMenu } = useContextMenu<MenuTarget>();
  // ライブラリタブの項目名で絞り込む(v1.19)。DB は引かず手元の配列を絞るだけなので
  // デバウンスは要らない。動画そのものの検索はツールバー側の担当
  const [sideFilter, setSideFilter] = useState('');

  useEffect(() => {
    api.listWatchedFolders().then(setFolders);
    api.listTags().then(setTags);
    api.listTagGroups().then(setTagGroups);
    api.listSeries().then(setSeriesList);
    api.listSmartFolders().then(setSmartFolders);
    api.listPlaylists().then(setPlaylists);
    api.countVideos({}).then(setTotalCount);
    api.countVideos({ missing: true }).then(setMissingCount);
    api.countVideos({ duplicatesOnly: true }).then(setDuplicateCount);
  }, [version]);

  useEffect(() => {
    api.listLibraries().then(setLibraries);
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

  /**
   * 保存した検索条件を復元する。壊れた JSON は握り潰さずトーストで知らせる。
   *
   * **項目をここで並べないこと**。以前は手で書き写していたため尺の範囲が抜けており、
   * 保存して開き直すと長さの条件だけ静かに消えていた。
   * 変換は `toFilterState`(= `buildQuery` の逆)に一本化してある
   */
  const openSmartFolder = (sf: SmartFolder) => {
    let q: VideoQuery;
    try {
      q = JSON.parse(sf.queryJson);
    } catch {
      pushToast(`「${sf.name}」の検索条件を読めませんでした`);
      return;
    }
    applyFilter(toFilterState(q));
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

  /**
   * 保存リストをキューへ**複写**して再生を始める(v1.40)。
   * 複写なので、ここから先の編集は保存リストに一切届かない
   * (書き戻すのは「上書き保存」を押したときだけ)
   */
  const loadPlaylist = async (p: Playlist) => {
    try {
      /*
       * 手で編集したキューを黙って捨てない(A-29)。終了時は保存を尋ねるのに
       * ここだけ無言で消えるのは非対称。判定は終了時と同じ needsSavePrompt
       */
      if (needsSavePrompt(useLibrary.getState().queue)) {
        const yes = await ask(
          `保存していないキュー(${useLibrary.getState().queue.items.length} 件)を捨てて、\n` +
            `「${p.name}」を読み込みますか?`,
          { title: 'キューの置き換え', kind: 'warning' },
        );
        if (!yes) return;
      }
      const rows = await api.getPlaylistVideos(p.id);
      if (rows.length === 0) {
        pushToast(`「${p.name}」は空です`, 'info');
        return;
      }
      const s = useLibrary.getState();
      s.setQueue(loadedQueue(rows, p.id, p.name));
      s.setQueueTabOpen(true);
      // 先頭から再生。見つからない動画なら開かず、送りに任せて飛ばさせる
      const first = rows.find((v) => !v.isMissing && !v.isOffline);
      if (first) s.playFromQueue(first);
      else pushToast(`「${p.name}」の動画はどれも見つかりませんでした`);
    } catch {
      // トーストは call() の担当
    }
  };

  const removePlaylist = async (p: Playlist) => {
    const yes = await ask(
      `プレイリスト「${p.name}」を削除しますか?\n(動画自体は消えません)`,
      { title: 'プレイリストの削除' },
    );
    if (!yes) return;
    await api.deletePlaylist(p.id);
    if (playlistId === p.id) togglePlaylistFilter(p.id);
    // このリストから読み込んだキューの出所を外す(残すと「上書き保存」が必ず失敗する)
    const s = useLibrary.getState();
    s.setQueue(sourceRemoved(s.queue, p.id));
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

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      pushToast('パスをコピーしました', 'info');
    } catch {
      pushToast('クリップボードにコピーできませんでした');
    }
  };

  const reveal = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch {
      pushToast('エクスプローラーで表示できませんでした');
    }
  };

  /**
   * 並べ替えは 1 つ隣と入れ替えるだけ。**絞り込む前の配列**を渡すこと —
   * 見えている行の index で動かすと、隠れている行を飛び越して並びが壊れる
   * (メニュー側でも絞り込み中は無効にしてある)
   */
  const moveSmartFolder = async (index: number, dir: -1 | 1) => {
    const next = [...smartFolders];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    try {
      await api.reorderSmartFolders(next.map((sf) => sf.id));
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  /** プレイリストの並べ替え。moveSmartFolder と同じ流儀(絞り込む前の index で動かす) */
  const movePlaylist = async (index: number, dir: -1 | 1) => {
    const next = [...playlists];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    try {
      await api.reorderPlaylists(next.map((p) => p.id));
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  /**
   * ライブラリを切り替える(v1.27)。**成功するとアプリが再起動する**ので、
   * この呼び出しの後ろに処理を書かないこと(Promise は解決しない)。
   * 再生中なら先に止める —— mpv は透過ウィンドウを別に持っているので、
   * 再生したままプロセスを差し替えない
   */
  const switchLibrary = async (lib: LibraryEntry) => {
    if (lib.id === currentLibId) return;
    if (!lib.online) {
      pushToast(`「${lib.name}」に接続できません(${lib.root})`);
      return;
    }
    /*
     * キューの保存確認(v1.40)。**切り替えは再起動なのでユーザーから見れば終了と同じ**だが、
     * `AppHandle::restart()` は `CloseRequested` を配送しないので、
     * useQueueLifecycle の確認はここを通らない。だから自前で 1 枚挟む
     */
    if (needsSavePrompt(useLibrary.getState().queue)) {
      const keep = await ask(
        `保存していないキュー(${useLibrary.getState().queue.items.length} 件)があります。\n` +
          '切り替えると失われます。続けますか?',
        { title: 'キューの保存', kind: 'warning' },
      );
      if (!keep) return;
    }
    const yes = await ask(`「${lib.name}」に切り替えます。アプリを再起動しますか?`, {
      title: 'ライブラリの切り替え',
    });
    if (!yes) return;
    setSwitching(true);
    useLibrary.getState().setPlayingVideo(null);
    try {
      await api.switchLibrary(lib.id);
    } catch {
      // ここに戻ってくるのは失敗したときだけ(トーストは call() の担当)
      setSwitching(false);
    }
  };

  /** 新規作成 → 置き場所を選ぶ → 空のライブラリを作る → 続けて切り替えるか聞く */
  const createLibrary = async () => {
    const name = window.prompt('新しいライブラリの名前');
    if (name === null || name.trim() === '') return;
    // 既定はアプリのデータフォルダ配下。外付け HDD を選べばドライブごと持ち運べる
    const parent = await open({
      directory: true,
      defaultPath: await api.defaultLibraryDir(),
      title: 'ライブラリを置くフォルダを選ぶ',
    });
    if (typeof parent !== 'string') return;
    const lib = await api.createLibrary(name.trim(), parent);
    setLibraries(await api.listLibraries());
    await switchLibrary(lib);
  };

  /** 既存のライブラリフォルダを一覧に加える(外付け HDD を別の PC に挿したとき等) */
  const addExistingLibrary = async () => {
    const root = await open({ directory: true, title: 'ライブラリのフォルダを選ぶ' });
    if (typeof root !== 'string') return;
    const lib = await api.addExistingLibrary(root);
    setLibraries(await api.listLibraries());
    await switchLibrary(lib);
  };

  /** 右クリックメニューの実行(v1.20)。削除系は × ボタンと同じ関数を呼ぶ */
  const runMenuAction = async (id: string, target: MenuTarget) => {
    try {
      if (target.kind === 'library') {
        if (id === 'lib:create') return await createLibrary();
        if (id === 'lib:add') return await addExistingLibrary();
        const lib = libraries.find((l) => `lib:switch:${l.id}` === id);
        if (lib) await switchLibrary(lib);
        return;
      }

      if (target.kind === 'wf') {
        const f = target.folder;
        switch (id) {
          case 'wf:open': setFolderId(f.id); break;
          // 配下すべてではなく直下だけ。フォルダーツリー側の絞り込みに切り替わる
          case 'wf:openDirect': useLibrary.getState().toggleDirPath(f.path); break;
          case 'wf:reveal': await reveal(f.path); break;
          case 'wf:copyPath': await copyPath(f.path); break;
          case 'wf:remove': await removeFolder(f); break;
          default:
        }
        return;
      }

      if (target.kind === 'sf') {
        const sf = target.sf;
        const index = smartFolders.findIndex((x) => x.id === sf.id);
        switch (id) {
          case 'sf:open': openSmartFolder(sf); break;
          case 'sf:rename': {
            const name = window.prompt('新しい名前', sf.name);
            if (name === null || name.trim() === '' || name.trim() === sf.name) return;
            await api.updateSmartFolder(sf.id, name.trim());
            bumpVersion();
            break;
          }
          case 'sf:overwrite': {
            const yes = await ask(
              `「${sf.name}」の条件を、いまの絞り込みで置き換えますか?`,
              { title: 'スマートフォルダの上書き' },
            );
            if (!yes) return;
            await api.updateSmartFolder(sf.id, undefined, currentQuery());
            bumpVersion();
            break;
          }
          case 'sf:moveUp': await moveSmartFolder(index, -1); break;
          case 'sf:moveDown': await moveSmartFolder(index, 1); break;
          case 'sf:delete': await removeSmartFolder(sf); break;
          default:
        }
        return;
      }

      if (target.kind === 'playlist') {
        const p = target.playlist;
        const index = playlists.findIndex((x) => x.id === p.id);
        switch (id) {
          case 'pl:load': await loadPlaylist(p); break;
          case 'pl:filter': togglePlaylistFilter(p.id); break;
          case 'pl:rename': {
            const name = window.prompt('新しいプレイリスト名', p.name);
            if (name === null || name.trim() === '' || name.trim() === p.name) return;
            await api.renamePlaylist(p.id, name.trim());
            // このリストから読み込んだキューのタイトルも追随させる
            const s = useLibrary.getState();
            s.setQueue(sourceRenamed(s.queue, p.id, name.trim()));
            bumpVersion();
            break;
          }
          case 'pl:duplicate': await api.duplicatePlaylist(p.id).then(() => bumpVersion()); break;
          case 'pl:moveUp': await movePlaylist(index, -1); break;
          case 'pl:moveDown': await movePlaylist(index, 1); break;
          case 'pl:delete': await removePlaylist(p); break;
          default:
        }
        return;
      }

      const s = target.series;
      switch (id) {
        case 'series:filter': toggleSeriesFilter(s.id); break;
        case 'series:rename': {
          const name = window.prompt('新しいシリーズ名', s.name);
          if (name === null || name.trim() === '' || name.trim() === s.name) return;
          await api.renameSeries(s.id, name.trim());
          bumpVersion();
          break;
        }
        case 'series:delete': await removeSeries(s); break;
        default:
      }
    } catch {
      // トーストは call() の担当
    }
  };

  // ライブラリタブの絞り込み。マッチしないセクションは見出しごと消える
  const needle = sideFilter.trim().toLowerCase();
  const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
  const shownSmart = smartFolders.filter((sf) => hit(sf.name));
  const shownPlaylists = playlists.filter((p) => hit(p.name));
  const shownFolders = folders.filter((f) => hit(baseName(f.path)));
  const shownSeries = seriesList.filter((s) => hit(s.name));
  // タグはグループ名でも引ける(「ジャンル」と打てばそのグループのタグが全部出る)
  const shownTags = tags.filter(
    (t) => hit(t.name) || hit(t.groupName ?? '') || (t.groupId == null && hit('未分類')),
  );
  const currentLib = libraries.find((l) => l.id === currentLibId) ?? null;
  const nothingMatches =
    needle !== '' &&
    shownSmart.length === 0 &&
    shownPlaylists.length === 0 &&
    shownFolders.length === 0 &&
    shownSeries.length === 0 &&
    shownTags.length === 0;

  return (
    // 幅はドラッグで変えられる。min-width も同じ値にして flex に縮められないようにする
    <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      {/*
        v1.27。ここは v1.26 まで「DVM」の固定文字列だった。
        切り替えの入口はここだけ(名前の変更と一覧からの削除は設定モーダルの担当)
      */}
      <button
        className="sidebar-title library-switch"
        disabled={switching}
        title={currentLib ? `${currentLib.root}\nクリックでライブラリを切り替え` : 'DVM'}
        onClick={(e) => {
          // クリック位置ではなくボタンの真下に出す(押す場所で位置がずれない)
          const r = e.currentTarget.getBoundingClientRect();
          openAt(r.left, r.bottom + 2, buildLibraryMenu(libraries, currentLibId), {
            kind: 'library',
          });
        }}
      >
        <Library />
        <span className="library-name">
          {switching ? '切り替え中...' : (currentLib?.name ?? 'DVM')}
        </span>
        <ChevronDown className="library-caret" />
      </button>
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
          <input
            className="side-filter"
            type="search"
            placeholder="タグ・シリーズを絞り込む"
            title="サイドバーの項目名で絞り込みます(動画そのものの検索は上の検索ボックス)"
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value)}
          />

          {shownSmart.length > 0 && <div className="side-section">スマートフォルダ</div>}
          {shownSmart.map((sf) => (
            <div
              key={sf.id}
              className="side-item folder"
              onClick={() => openSmartFolder(sf)}
              onContextMenu={(e) =>
                openMenu(
                  e,
                  // 並べ替えの index は絞り込む前の並びで数える
                  buildSmartFolderMenu(
                    sf,
                    smartFolders.findIndex((x) => x.id === sf.id),
                    smartFolders.length,
                    needle !== '',
                  ),
                  { kind: 'sf', sf },
                )}
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

          {/*
            保存プレイリスト(v1.40)。**スマートフォルダの直後**に置く ——
            スマートフォルダ = 条件で選んだ集合、プレイリスト = 手で選んだ集合で、
            並べるなら隣同士が意味的に正しい。
            クリックは既存 2 つと揃えて「一覧を絞り込む」。キューへの読み込みは右クリックから。
            **0 件でも見出し + 案内を出す**(タグと同じ「ここから始める」流儀)——
            機能に気づく入口が右クリックメニューと Q キーだけで、棚が空の人ほど見えなかった
          */}
          {(shownPlaylists.length > 0 || !needle) && (
            <div className="side-section">プレイリスト</div>
          )}
          {playlists.length === 0 && !needle && (
            <div className="side-empty">
              動画を選んで右クリック →「キュー」で並べ、キューパネルから保存するとここに並びます
            </div>
          )}
          {shownPlaylists.map((p) => (
            <div
              key={p.id}
              className={`side-item folder ${playlistId === p.id ? 'active' : ''}`}
              onClick={() => togglePlaylistFilter(p.id)}
              onContextMenu={(e) =>
                openMenu(
                  e,
                  // 並べ替えの index は絞り込む前の並びで数える(スマートフォルダと同じ)
                  buildPlaylistMenu(
                    p,
                    playlistId === p.id,
                    playlists.findIndex((x) => x.id === p.id),
                    playlists.length,
                    needle !== '',
                  ),
                  { kind: 'playlist', playlist: p },
                )}
              title={`${p.name}(クリックで絞り込み。右クリックからキューに読み込めます)`}
            >
              <ListVideo className="tag-mark" />
              <span className="folder-name">{p.name}</span>
              <span className="count">{p.videoCount}</span>
              <button
                className="remove"
                title="プレイリストを削除"
                onClick={(e) => {
                  e.stopPropagation();
                  removePlaylist(p);
                }}
              >
                ×
              </button>
            </div>
          ))}

          {(shownFolders.length > 0 || !needle) && (
            <div className="side-section" title="クリックするとそのフォルダ配下の動画をまとめて表示します">
              監視フォルダ
            </div>
          )}
          {shownFolders.map((f) => (
            <div
              key={f.id}
              className={`side-item folder ${folderId === f.id ? 'active' : ''}`}
              onClick={() => setFolderId(f.id)}
              onContextMenu={(e) =>
                openMenu(e, buildWatchedFolderMenu(f, folderId === f.id), { kind: 'wf', folder: f })}
              title={`${f.path}\nクリックでこのフォルダ配下すべてを表示(サブフォルダ単位で絞るなら「フォルダー」タブ)`}
            >
              <span className={`dot ${f.online ? 'online' : 'offline'}`} />
              <span className="folder-name">{baseName(f.path)}</span>
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

          {/* 絞り込み中は追加ボタンを隠す — 探している最中に出ていても邪魔なだけ */}
          {!needle && (
            <>
              <button className="side-action" onClick={addFolder}>+ フォルダを追加</button>
              <button className="side-action" onClick={addFiles}>+ ファイルを追加</button>
            </>
          )}

          {shownSeries.length > 0 && <div className="side-section">シリーズ</div>}
          {shownSeries.map((s) => (
            <div
              key={s.id}
              className={`side-item folder ${seriesId === s.id ? 'active' : ''}`}
              onClick={() => toggleSeriesFilter(s.id)}
              onContextMenu={(e) =>
                openMenu(e, buildSeriesMenu(s, seriesId === s.id), { kind: 'series', series: s })}
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

          {/* タグが 0 個でも見出しを出す — ここから作成を始めるため。
              ただし絞り込み中にヒットが無いなら消す */}
          {(shownTags.length > 0 || !needle) && <div className="side-section">タグ</div>}
          <TagTree tags={shownTags} groups={tagGroups} filtering={needle !== ''} />

          {nothingMatches && (
            <div className="side-empty">「{sideFilter.trim()}」に一致する項目はありません</div>
          )}
        </>
      )}

      {menu && (
        <ContextMenu
          key={`${menu.x},${menu.y}`}
          x={menu.x}
          y={menu.y}
          entries={menu.entries}
          onClose={closeMenu}
          onSelect={(id) => void runMenuAction(id, menu.target)}
        />
      )}

      {relinkPlan && (
        <FileOpDialog kind="relink" plan={relinkPlan} onClose={() => setRelinkPlan(null)} />
      )}
    </aside>
  );
}
