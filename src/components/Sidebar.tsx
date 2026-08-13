import { convertFileSrc } from '@tauri-apps/api/core';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  ChevronDown, Copy, FolderSearch, Library, ListOrdered, TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useContextMenu } from '../hooks/useContextMenu';
import {
  buildLibraryMenu, buildPlaylistMenu, buildSeriesMenu, buildSideSectionMenu, buildSmartFolderMenu,
  buildWatchedFolderMenu,
} from '../lib/contextMenu';
import { fmtTime } from '../lib/format';
import { baseName } from '../lib/paths';
import { buildQuery, toFilterState } from '../lib/query';
import { QUEUE_LIMIT, sourceRemoved, sourceRenamed } from '../lib/queue';
import { replaceQueueWith } from '../lib/queueLoad';
import {
  SECTION_KEYS, parseCollapsedSections, serializeCollapsedSections,
} from '../lib/settings';
import type { SectionKey } from '../lib/settings';
import { thumbSrc } from '../lib/thumbs';
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
  // v1.42。セクション見出しの折りたたみ
  | { kind: 'section'; section: SectionKey; label: string }
  // v1.27。これだけ右クリックではなくボタンの左クリックで開く
  | { kind: 'library' };

/**
 * 折りたためるセクションの見出し(v1.42)。ライブラリタブの 5 か所で使う。
 *
 * **見出しの JSX はここ 1 本にする**。三角・件数・右クリックが付いて 1 か所 10 行になり、
 * 5 か所に写すと片方だけ直したときにずれる。三角の見た目は詳細ペインの
 * `.section-toggle` / `.section-chevron` をそのまま使う(もともと `.side-section` と
 * 同じトーンで作られている。App.css の v1.15 の節を参照)。
 *
 * **`<div>` で包まずフラグメントを返すこと**。`.sidebar` は `gap: 2px` の 1 段の flex で
 * 行がすべてその直接の子なので、包むとセクションまるごとが 1 個の flex アイテムに潰れて
 * 行間が消える(`MediaInfoSection` がフラグメントを返しているのも同じ理由)。
 *
 * `children` にはその節の一覧だけでなく「+ フォルダを追加」のような**付属のボタンも入れる** ——
 * 見出しを畳んだのにボタンだけ残ると、何に対する追加なのか分からなくなる
 */
function SideSection({
  label, count, collapsed, filtering, onToggle, onContextMenu, children,
}: {
  label: string;
  /** 項目数。**畳んでいるときだけ出す** —— 行の `.count` は動画の本数なので、
   *  開いている間も出すと同じ見た目の数字が 2 つの意味で並ぶ */
  count: number;
  collapsed: boolean;
  /** 絞り込み中。畳みを無視して必ず開き、押しても何も起きない三角は消す */
  filtering: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const open = filtering || !collapsed;
  return (
    <>
      <div className="side-section-head" onContextMenu={onContextMenu}>
        {filtering ? (
          // 絞り込み中は畳めないので、v1.41 までと同じただの見出しに戻す。
          // 三角を残すと「押しても何も変わらないボタン」になる
          <span className="side-section-label">{label}</span>
        ) : (
          <button
            className={`section-toggle ${open ? 'open' : ''}`}
            onClick={onToggle}
            title={open ? `${label}を隠す` : `${label}を表示`}
          >
            {/* 開閉でアイコンを変えず CSS で回す(形が変わると大きさが違って見える) */}
            <ChevronDown className="section-chevron" />
            {label}
          </button>
        )}
        {!open && <span className="count">{count}</span>}
      </div>
      {open && children}
    </>
  );
}

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
    libraryId: currentLibId, thumbVersion,
  } = useLibrary(useShallow(pickState(
    'folderId', 'setFolderId', 'dirPath', 'version', 'bumpVersion', 'sidebarWidth',
    'seriesId', 'toggleSeriesFilter', 'playlistId', 'togglePlaylistFilter',
    'missingOnly', 'toggleMissingOnly', 'duplicatesOnly', 'toggleDuplicatesOnly',
    'applyFilter', 'pushToast', 'libraryId', 'thumbVersion',
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
  /*
   * 畳んでいるセクション(v1.42)。項目が増えると左ペインが縦に伸びきるので節ごとに畳める。
   *
   * **localStorage ではなく settings に持つ**。TagTree のグループを localStorage に
   * 置いているのは中身が `tag_groups.id` でライブラリごとに別物だからで、
   * こちらのキーはライブラリに依存しない固定文字列。`sidebar_tab` と同じ扱いにする
   */
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());

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

  // 畳んでいた節を復元する(sidebar_tab と同じくここで読む)
  useEffect(() => {
    api.getSetting('sidebar_sections').then((v) => setCollapsed(parseCollapsedSections(v)));
  }, []);

  const selectTab = (next: SidebarTab) => {
    setTab(next);
    api.setSetting('sidebar_tab', next);
  };

  /** 畳み状態の唯一の書き込み口。state と設定を必ず一緒に動かす */
  const saveCollapsed = (next: Set<SectionKey>) => {
    setCollapsed(next);
    api.setSetting('sidebar_sections', serializeCollapsedSections(next));
  };

  const toggleSection = (key: SectionKey) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    saveCollapsed(next);
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
   * (書き戻すのは「上書き保存」を押したときだけ)。
   * 確認(A-29)・上限・再生開始は replaceQueueWith(v1.41 で C-4 と共通化)の担当
   */
  const loadPlaylist = async (p: Playlist) => {
    try {
      const rows = await api.getPlaylistVideos(p.id);
      await replaceQueueWith(rows, { id: p.id, name: p.name }, {
        label: `「${p.name}」`,
        emptyMessage: `「${p.name}」は空です`,
      });
    } catch {
      // トーストは call() の担当
    }
  };

  /**
   * スマートフォルダの中身でキューを置き換えて再生する(v1.41、C-4)。
   * 「平日の消化リスト」のような条件を 1 クリックで流すための入口
   */
  const loadSmartFolder = async (sf: SmartFolder) => {
    let q: VideoQuery;
    try {
      q = JSON.parse(sf.queryJson);
    } catch {
      pushToast(`「${sf.name}」の検索条件を読めませんでした`);
      return;
    }
    try {
      // 上限 + 1 件引く。501 件返れば「切り詰めた」と分かる(件数クエリを別に投げない)
      const rows = await api.queryVideos(q, QUEUE_LIMIT + 1, 0);
      await replaceQueueWith(rows, null, {
        label: `「${sf.name}」`,
        emptyMessage: `「${sf.name}」に一致する動画はありません`,
      });
    } catch {
      // トーストは call() の担当
    }
  };

  /** プレイリストを M3U8 に書き出す(v1.41、C-3)。外部プレイヤーでそのまま流せる */
  const exportPlaylist = async (p: Playlist) => {
    const dest = await save({
      title: 'M3U8 へ書き出す',
      // リスト名はファイル名に使えない文字を含み得るので、そこだけ置き換える
      defaultPath: `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u8`,
      filters: [{ name: 'M3U8 プレイリスト', extensions: ['m3u8'] }],
    });
    if (typeof dest !== 'string') return;
    try {
      const n = await api.exportM3u8(p.id, dest);
      pushToast(`「${p.name}」を書き出しました(${n} 件)`, 'info');
    } catch {
      // トーストは call() の担当
    }
  };

  /**
   * M3U8 を読み込んでプレイリストを作る(v1.41、C-3)。
   * 未登録の動画は個別登録としてライブラリにも入る(取り込みは Rust 側)
   */
  const importM3u8 = async () => {
    const selected = await open({
      multiple: false,
      title: 'M3U8 を読み込む',
      filters: [{ name: 'M3U8 プレイリスト', extensions: ['m3u8', 'm3u'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      const r = await api.importM3u8(selected);
      pushToast(
        r.skipped > 0
          ? `「${r.name}」を作成しました(${r.count} 件。${r.skipped} 行は見つからないため外しました)`
          : `「${r.name}」を作成しました(${r.count} 件)`,
        'info',
      );
      bumpVersion();
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
     * v1.40 まではここで「キューが失われます」の確認を挟んでいたが、v1.41 の
     * 常時自動保存(C-2)で不要になった —— キューはこのライブラリの library.db に
     * 保存済みで、戻ってくればそのまま復元される
     */
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

      if (target.kind === 'section') {
        switch (id) {
          case 'section:toggle': toggleSection(target.section); break;
          case 'section:collapseAll': saveCollapsed(new Set(SECTION_KEYS)); break;
          case 'section:expandAll': saveCollapsed(new Set()); break;
          default:
        }
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
          case 'sf:load': await loadSmartFolder(sf); break;
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
          case 'pl:export': await exportPlaylist(p); break;
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
  /*
   * セクション見出しに渡す共通の props(v1.42)。絞り込み中は畳みを無視して必ず開く ——
   * TagTree のグループ(`renderHeader` の `!filtering && collapsed.has(key)`)と同じ規約で、
   * 絞った結果が畳まれていては意味がないため
   */
  const sectionProps = (section: SectionKey, label: string, count: number) => ({
    label,
    count,
    collapsed: collapsed.has(section),
    filtering: needle !== '',
    onToggle: () => toggleSection(section),
    onContextMenu: (e: React.MouseEvent) =>
      openMenu(e, buildSideSectionMenu(label, collapsed.has(section)), {
        kind: 'section' as const, section, label,
      }),
  });
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

          {shownSmart.length > 0 && (
            <SideSection {...sectionProps('smart', 'スマートフォルダ', smartFolders.length)}>
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
            </SideSection>
          )}

          {/*
            保存プレイリスト(v1.40)。**スマートフォルダの直後**に置く ——
            スマートフォルダ = 条件で選んだ集合、プレイリスト = 手で選んだ集合で、
            並べるなら隣同士が意味的に正しい。
            クリックは既存 2 つと揃えて「一覧を絞り込む」。キューへの読み込みは右クリックから。
            **0 件でも見出し + 案内を出す**(タグと同じ「ここから始める」流儀)——
            機能に気づく入口が右クリックメニューと Q キーだけで、棚が空の人ほど見えなかった
          */}
          {(shownPlaylists.length > 0 || !needle) && (
            <SideSection {...sectionProps('playlist', 'プレイリスト', playlists.length)}>
              {playlists.length === 0 && !needle && (
                <div className="side-empty">
                  動画を選んで右クリック →「キュー」で並べ、キューパネルから保存するとここに並びます
                </div>
              )}
              {shownPlaylists.map((p) => (
                <div
                  key={p.id}
                  className={`side-item playlist-row ${playlistId === p.id ? 'active' : ''}`}
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
                  {/*
                    先頭サムネイル + 2 行(v1.41、C-6)。キュー行と同じ 44×25 の枠で、
                    **ディスクキャッシュの jpg を読むだけ**(原則 2 の内側)。
                    サムネイルを持つ動画が 1 本も無ければ枠の地色だけが見える
                  */}
                  <span className="pl-thumb">
                    {p.thumbPath && (
                      <img
                        src={thumbSrc(convertFileSrc(p.thumbPath), thumbVersion)}
                        loading="lazy"
                        alt=""
                        draggable={false}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                        onLoad={(e) => {
                          e.currentTarget.style.display = '';
                        }}
                      />
                    )}
                  </span>
                  <span className="pl-lines">
                    <span className="folder-name">{p.name}</span>
                    <span className="pl-meta">
                      {p.videoCount} 本
                      {p.durationMs > 0 ? `・${fmtTime(p.durationMs / 1000)}` : ''}
                    </span>
                  </span>
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
              {/* M3U8 の取り込み(v1.41、C-3)。絞り込み中は追加ボタンを隠す(下の 2 つと同じ) */}
              {!needle && (
                <button
                  className="side-action"
                  title="M3U8 / M3U を読み込んで同じ名前のプレイリストを作ります(未登録の動画はライブラリにも登録されます)"
                  onClick={importM3u8}
                >
                  + M3U8 を読み込む
                </button>
              )}
            </SideSection>
          )}

          {(shownFolders.length > 0 || !needle) && (
            <SideSection {...sectionProps('watched', '監視フォルダ', folders.length)}>
              {shownFolders.map((f) => (
                <div
                  key={f.id}
                  className={`side-item folder ${folderId === f.id ? 'active' : ''}`}
                  onClick={() => setFolderId(f.id)}
                  onContextMenu={(e) =>
                    openMenu(e, buildWatchedFolderMenu(f, folderId === f.id), {
                      kind: 'wf', folder: f,
                    })}
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
            </SideSection>
          )}

          {shownSeries.length > 0 && (
            <SideSection {...sectionProps('series', 'シリーズ', seriesList.length)}>
              {shownSeries.map((s) => (
                <div
                  key={s.id}
                  className={`side-item folder ${seriesId === s.id ? 'active' : ''}`}
                  onClick={() => toggleSeriesFilter(s.id)}
                  onContextMenu={(e) =>
                    openMenu(e, buildSeriesMenu(s, seriesId === s.id), {
                      kind: 'series', series: s,
                    })}
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
            </SideSection>
          )}

          {/* タグが 0 個でも見出しを出す — ここから作成を始めるため。
              ただし絞り込み中にヒットが無いなら消す(TagTree 側も全部 null を返す) */}
          {(shownTags.length > 0 || !needle) && (
            <SideSection {...sectionProps('tag', 'タグ', tags.length)}>
              <TagTree tags={shownTags} groups={tagGroups} filtering={needle !== ''} />
            </SideSection>
          )}

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
