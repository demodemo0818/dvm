import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ask } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { api } from './api';
import { useQueueLifecycle } from './hooks/useQueueLifecycle';
import { parseColumns } from './lib/listColumns';
import { parseModalSize, SETTINGS_SIZE_KEY } from './lib/settings';
import { isTypingTarget } from './lib/shortcuts';
import { parseSubStyle, serializeSubStyle, SUB_STYLE_KEY } from './lib/subtitleStyle';
import type { LibraryState } from './types';
import { AiPanel } from './components/AiPanel';
import { Inspector } from './components/Inspector';
import { LibraryUnavailable } from './components/LibraryUnavailable';
import { PaneResizer } from './components/PaneResizer';
import { PlayerOverlay } from './components/PlayerOverlay';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { VideoGrid } from './components/VideoGrid';
import { useShallow } from 'zustand/react/shallow';
import { AI_PANEL_WIDTH, INSPECTOR_WIDTH, SIDEBAR_WIDTH, pickState, useLibrary } from './store';

export default function App() {
  const {
    bumpVersion, bumpThumbVersion, setStatus, status, scanning, setPlayerPath, setPreviewOnHover,
    setViewMode, setCardWidth, setAutoplayNext, setSeekPreview, setHdrPassthrough,
    setCardTags, setCardSeries,
    setInspectorPinned, setMediaInfoOpen, setListColumns, setListZebra, setSidebarWidth,
    setInspectorWidth, setSidebarCollapsed, setAiPanelWidth, setSettingsModalSize,
    setSubStyle, subStyle,
    inspectorPinned, sidebarWidth, inspectorWidth, sidebarCollapsed, selection,
    showAiPanel, aiPanelWidth, queueTabOpen, version,
  } = useLibrary(useShallow(pickState(
    'bumpVersion', 'bumpThumbVersion', 'setStatus', 'status', 'scanning', 'setPlayerPath',
    'setPreviewOnHover', 'setViewMode', 'setCardWidth', 'setAutoplayNext', 'setSeekPreview',
    'setHdrPassthrough', 'setCardTags', 'setCardSeries', 'setInspectorPinned', 'setMediaInfoOpen',
    'setListColumns', 'setListZebra', 'setSidebarWidth', 'setInspectorWidth', 'setSidebarCollapsed',
    'setAiPanelWidth', 'setSettingsModalSize', 'setSubStyle', 'subStyle', 'inspectorPinned',
    'sidebarWidth', 'inspectorWidth', 'sidebarCollapsed', 'selection', 'showAiPanel',
    'aiPanelWidth', 'queueTabOpen', 'version',
  )));
  // キューの引き直しと、閉じるときの保存確認(v1.40)
  useQueueLifecycle(version);
  const debounceTimer = useRef<number | undefined>(undefined);
  /** 字幕スタイルのロードが済んだか。済むまでは保存側を動かさない(下の effect 参照) */
  const subStyleLoaded = useRef(false);
  /**
   * ライブラリを開けたか(v1.27)。null は判定前。
   * 起動時に 1 回だけ聞く —— 結果が変わるのは再起動したときだけなので、購読はしない
   */
  const [libState, setLibState] = useState<LibraryState | null>(null);

  useEffect(() => {
    void api.getLibraryState().then((s) => {
      setLibState(s);
      // localStorage をライブラリごとに分けるために store にも入れる(TagTree が使う)
      useLibrary.getState().setLibraryId(s.current?.id ?? '');
    });
  }, []);

  // 詳細ペインは「固定表示」か「何か選択中」か「キュータブを開いている」ときに出す。
  // 幅を変える帯もペインと一緒に出し入れするので、判定はここに置く
  const showInspector = inspectorPinned || selection.length > 0 || queueTabOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useLibrary.getState();
      // プレイヤー表示中のキー操作は PlayerOverlay 側で一元管理する
      if (s.playingVideo) return;
      // 右クリックメニュー中の Esc はメニューを閉じるだけ(選択は残す)
      if (s.contextMenuOpen) return;
      s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * `?` でキー操作の一覧を開く / 閉じる(v1.39)。
   *
   * **修飾キー付きのショートカットとして足している** —— 素の 1 文字キーは空きが少なく、
   * `A` / `R` / `U` で既に修飾キーの手当てが要った経緯がある(DESIGN.md「字幕の見た目」節)。
   * `?` は JIS でも US でも Shift+/ で、`e.key` は生成された文字なので配列に依存しない。
   * `/` はどの系統でも未使用で、既存の switch には case が無いので default に落ちる。
   *
   * **再生中は開かない** —— 再生中は `html.mpv-active` が `.app` ごと消すので、
   * 出すには `.mpv-overlay` の内側にもマウントする必要がある(DESIGN.md 参照)
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME の変換中に打った ? は文字入力。ショートカットとして拾わない
      if (e.key !== '?' || e.isComposing) return;
      if (isTypingTarget(e)) return;
      const s = useLibrary.getState();
      if (s.playingVideo) return;
      // 右クリックメニュー中のキーはメニュー側が処理する
      if (s.contextMenuOpen) return;
      /*
       * 他のモーダルが開いている間は拾わない。重ねて出すと、Escape が
       * (どちらも document で受けるので)両方に届いて 2 枚同時に閉じる。
       * 開いているモーダルを数える state は無いので DOM を 1 回読む ——
       * 下の contextmenu ハンドラで closest() を使っているのと同じ扱い。
       *
       * **自分が開いているときは通す** —— この一覧も `.modal-overlay` を持つので、
       * 素通しにすると ? で閉じられなくなる(開けるが閉じられない)
       */
      if (!s.showShortcuts && document.querySelector('.modal-overlay')) return;
      e.preventDefault();
      s.setShowShortcuts(!s.showShortcuts);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * WebView2 の既定メニューを画面全体で止める(v1.20)。
   *
   * 自前のメニューを付けた場所は各ハンドラが preventDefault するが、
   * ツールバー・詳細ペイン・モーダルなど付けていない場所では
   * 「再読み込み」「ページのソースを表示」といったブラウザのメニューが出てしまい、
   * デスクトップアプリとして明らかに異物になる。
   *
   * **入力欄だけは残す** — コピー・貼り付けと IME の変換候補が要るため。
   * 自前のメニューで置き換えるほどの中身も無い
   */
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  // 外部プレイヤー設定(再生分岐)・ホバープレビュー・表示設定をロード
  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    // 既定は ON。明示的に '0' のときだけ OFF
    api.getSetting('preview_on_hover').then((v) => setPreviewOnHover(v !== '0'));
    // シークバーのコマ出しも既定 ON
    api.getSetting('seek_preview').then((v) => setSeekPreview(v !== '0'));
    /*
     * HDR パススルー(v1.30)は既定 OFF。見え方が変わる設定なので黙って入れない。
     * **mpv の初期化(ensureMpv)より先に読めている必要がある**が、初期化は
     * 初回再生まで遅延するので、起動時にここで読んでおけば必ず間に合う
     */
    api.getSetting('hdr_passthrough').then((v) => setHdrPassthrough(v === '1'));
    api.getSetting('view_mode').then((v) => {
      if (v === 'list' || v === 'grid') setViewMode(v);
    });
    api.getSetting('card_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setCardWidth(n);
    });
    // カードのタグ行は既定 ON、シリーズ行は既定 OFF(付いている動画が限られるため)
    api.getSetting('card_tags').then((v) => setCardTags(v !== '0'));
    api.getSetting('card_series').then((v) => setCardSeries(v === '1'));
    // 連続再生は既定 OFF(勝手に次が始まると驚くため)
    api.getSetting('autoplay_next').then((v) => setAutoplayNext(v === '1'));
    // 詳細ペインの固定は既定 OFF(従来どおり選択中だけ出る)
    api.getSetting('inspector_pinned').then((v) => setInspectorPinned(v === '1'));
    // メディア情報も既定 OFF(開いていると選択のたびに ffprobe が走る)
    api.getSetting('media_info_open').then((v) => setMediaInfoOpen(v === '1'));
    // 詳細リストの列構成。壊れた値は parseColumns がすべて既定に落とす
    api.getSetting('list_columns').then((v) => setListColumns(parseColumns(v)));
    // 1 行おきの濃淡(v1.25)は既定 OFF。既存の見た目を勝手に変えない
    api.getSetting('list_zebra').then((v) => setListZebra(v === '1'));
    // サイドバーは既定で開く
    api.getSetting('sidebar_collapsed').then((v) => setSidebarCollapsed(v === '1'));
    // 幅は setter 側で上下限に丸められる
    api.getSetting('sidebar_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setSidebarWidth(n);
    });
    api.getSetting('inspector_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setInspectorWidth(n);
    });
    api.getSetting('ai_panel_width').then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setAiPanelWidth(n);
    });
    /*
     * 設定モーダルの大きさ(v1.38)。**モーダル側では読まない** ——
     * 開いてから読むと既定の大きさで一瞬描いてから跳ねる。
     * 壊れた値は parseModalSize がすべて既定に落とす
     */
    api.getSetting(SETTINGS_SIZE_KEY).then((v) => setSettingsModalSize(parseModalSize(v)));
    // 字幕の見た目(v1.24)。壊れた値は parseSubStyle がすべて既定に落とす
    api.getSetting(SUB_STYLE_KEY)
      .then((v) => setSubStyle(parseSubStyle(v)))
      .finally(() => {
        subStyleLoaded.current = true;
      });
  }, [
    setPlayerPath, setPreviewOnHover, setSeekPreview, setHdrPassthrough,
    setViewMode, setCardWidth, setAutoplayNext,
    setInspectorPinned, setMediaInfoOpen, setListColumns, setListZebra, setSidebarWidth,
    setInspectorWidth, setSidebarCollapsed, setAiPanelWidth, setSettingsModalSize,
    setCardTags, setCardSeries,
    setSubStyle,
  ]);

  /**
   * 字幕の見た目を保存する(v1.24)。
   *
   * **スライダーの onChange から直接 setSetting を呼ばない** — set_setting は書き込み
   * コネクションを使うので、ドラッグ中に毎フレーム叩くと取り込みワーカーとロックを
   * 取り合う。ここで 400ms まとめてから 1 回だけ書く。
   *
   * **App に置く**理由: プレイヤーのパネルや設定モーダルは閉じると unmount するので、
   * そちらにタイマーを置くと「値をいじって即閉じ」で最後の 1 手が消える。
   * App は一度 mount したら畳まれないのでタイマーが生き残る
   */
  useEffect(() => {
    // 起動時ロードの setSubStyle で書き戻さない(未設定の DB に '{}' を作らないため)
    if (!subStyleLoaded.current) return;
    const t = window.setTimeout(() => {
      void api.setSetting(SUB_STYLE_KEY, serializeSubStyle(subStyle));
    }, 400);
    return () => window.clearTimeout(t);
  }, [subStyle]);

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
    /*
     * cleanup が Promise 解決より先に走ると解除漏れになる(StrictMode の
     * 「mount → 即 cleanup → 再 mount」で必ず起きる)ので、解決後に
     * disposed を見て、手遅れならその場で解除する。放置すると開発中は
     * D&D や library:changed が**二重に処理される**(ドロップの確認が 2 回出る)
     */
    let disposed = false;
    const track = (u: () => void) => {
      if (disposed) u();
      else unlisteners.push(u);
    };

    listen('library:changed', () => {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => bumpVersion(), 300);
    }).then(track);

    listen<{ scanning: boolean; message: string }>('scan:state', (e) => {
      setStatus(e.payload.scanning, e.payload.message);
    }).then(track);

    // 中身が変わったサムネイルを読み直させる(URL は {id}.jpg のままなので lib/thumbs.ts 参照)
    listen('thumbs:changed', () => bumpThumbVersion()).then(track);

    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === 'drop' && e.payload.paths.length > 0) {
          void handleDrop(e.payload.paths);
        }
      })
      .then(track);

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [bumpVersion, bumpThumbVersion, setStatus, handleDrop]);

  // ライブラリを開けていないときは通常の UI を出さない(v1.27)。
  // 空の placeholder で起動しているので、そのまま操作させると
  // 「ライブラリが消えた」と誤解して作り直しにかかってしまう
  if (libState && libState.status !== 'ok') {
    return (
      <>
        <LibraryUnavailable state={libState} />
        <Toasts />
      </>
    );
  }

  return (
    <>
      {/* mpv 再生中は .app ごと非表示にするため、プレイヤーは .app の外に置く */}
      <div className="app">
        {/* 畳んだら幅を変える帯も一緒に消す(詳細ペインと同じ扱い) */}
        {!sidebarCollapsed && (
          <>
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
          </>
        )}
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
        {showAiPanel && (
          <PaneResizer
            label="AI パネル"
            edge="right"
            width={aiPanelWidth}
            min={AI_PANEL_WIDTH.min}
            max={AI_PANEL_WIDTH.max}
            defaultWidth={AI_PANEL_WIDTH.default}
            onResize={setAiPanelWidth}
            onCommit={() =>
              void api.setSetting('ai_panel_width', String(useLibrary.getState().aiPanelWidth))
            }
          />
        )}
        <AiPanel />
      </div>
      <PlayerOverlay />
      {/* 通知も .app の外(mpv 再生中でもエラーが見えるように) */}
      <Toasts />
    </>
  );
}
