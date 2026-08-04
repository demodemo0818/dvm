import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtSize } from '../lib/format';
import { useLibrary } from '../store';
import type { AppInfo, BackupInfo, LibraryEntry } from '../types';
import { McpSettings } from './McpSettings';
import { SubtitleStyleEditor } from './SubtitleStyleEditor';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  /*
   * 字幕の見た目(v1.24)だけは他の項目と違い、ローカル state に写さず store を直に
   * バインドして**その場で保存する**(保存は App.tsx がデバウンスして書く)。
   * 理由は DESIGN.md「設定モーダルの中でここだけ即時保存にした」を参照 ——
   * 再生画面のパネルと同じコンポーネントを使う以上、片方だけドラフト方式にできない
   */
  const subStyle = useLibrary((s) => s.subStyle);
  const setSubStyle = useLibrary((s) => s.setSubStyle);
  const resetSubStyle = useLibrary((s) => s.resetSubStyle);
  const [playerPath, setPlayerPath] = useState('');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  /** MCP の設定スニペットに DVM_ALLOW_WRITE を含めるか。表示用だが次回も同じ内容を出せるよう保存する */
  const [mcpAllowWrite, setMcpAllowWrite] = useState(false);
  const [previewOnHover, setPreviewOnHover] = useState(true);
  const [cardTags, setCardTags] = useState(true);
  const [cardSeries, setCardSeries] = useState(false);
  const [seekPreview, setSeekPreview] = useState(true);
  const [autoplayNext, setAutoplayNext] = useState(false);
  const [useEmbeddedCover, setUseEmbeddedCover] = useState(true);
  /** コマの画像の保存先(v1.26)。空欄なら AppInfo.framesDir(ピクチャ\DVM) */
  const [frameSaveDir, setFrameSaveDir] = useState('');
  /**
   * ライブラリの管理(v1.27)。ここが持つのは**名前の変更と一覧からの削除**だけ。
   * 切り替えの入口はサイドバーの上部に固定する(同じ操作の入口を 2 か所に置かない)
   */
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);

  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    // 既定は ON。明示的に '0' のときだけ OFF
    api.getSetting('preview_on_hover').then((v) => setPreviewOnHover(v !== '0'));
    api.getSetting('card_tags').then((v) => setCardTags(v !== '0'));
    // シリーズ行だけは既定 OFF(付いている動画が限られるので、既定で行を空けたくない)
    api.getSetting('card_series').then((v) => setCardSeries(v === '1'));
    api.getSetting('seek_preview').then((v) => setSeekPreview(v !== '0'));
    api.getSetting('autoplay_next').then((v) => setAutoplayNext(v === '1'));
    api.getSetting('use_embedded_cover').then((v) => setUseEmbeddedCover(v !== '0'));
    api.getSetting('frame_save_dir').then((v) => setFrameSaveDir(v ?? ''));
    api.getSetting('anthropic_api_key').then((v) => setAiKey(v ?? ''));
    api.getSetting('anthropic_model').then((v) => setAiModel(v ?? ''));
    api.getSetting('mcp_allow_write').then((v) => setMcpAllowWrite(v === '1'));
    api.getAppInfo().then(setInfo).catch(() => {});
    api.listDbBackups().then(setBackups).catch(() => {});
    api.listLibraries().then(setLibraries).catch(() => {});
  }, []);

  /** 名前を変える。フォルダ名は変えない(開いている最中に動かせないため) */
  const renameLibrary = async (lib: LibraryEntry) => {
    const name = window.prompt('新しいライブラリ名', lib.name);
    if (name === null || name.trim() === '' || name.trim() === lib.name) return;
    await api.renameLibrary(lib.id, name.trim());
    setLibraries(await api.listLibraries());
    // サイドバーのボタンの表示を追従させる
    useLibrary.getState().bumpVersion();
  };

  /** 一覧から外す。**ファイルは消さない**ことを文言で必ず言い切る */
  const forgetLibrary = async (lib: LibraryEntry) => {
    const yes = await ask(
      `「${lib.name}」を一覧から外しますか?\n\n`
        + 'フォルダとファイルは削除されません。\n'
        + `${lib.root} はそのまま残るので、あとで「既存のライブラリを開く」から戻せます。`,
      { title: '一覧から外す' },
    );
    if (!yes) return;
    await api.forgetLibrary(lib.id);
    setLibraries(await api.listLibraries());
    useLibrary.getState().bumpVersion();
  };

  const browseFrameDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'コマの画像の保存先フォルダ',
    });
    if (typeof selected === 'string') setFrameSaveDir(selected);
  };

  const browsePlayer = async () => {
    const selected = await open({
      multiple: false,
      title: '外部プレイヤーの実行ファイルを選択',
      filters: [{ name: '実行ファイル', extensions: ['exe'] }],
    });
    if (typeof selected === 'string') setPlayerPath(selected);
  };

  const save = async () => {
    await api.setSetting('player_path', playerPath.trim());
    // 再生分岐(アプリ内 or 外部)が即座に切り替わるようストアにも反映
    useLibrary.getState().setPlayerPath(playerPath.trim());
    await api.setSetting('preview_on_hover', previewOnHover ? '1' : '0');
    useLibrary.getState().setPreviewOnHover(previewOnHover);
    // カードの高さが変わるので、閉じた瞬間にグリッドへ反映させる
    await api.setSetting('card_tags', cardTags ? '1' : '0');
    useLibrary.getState().setCardTags(cardTags);
    await api.setSetting('card_series', cardSeries ? '1' : '0');
    useLibrary.getState().setCardSeries(cardSeries);
    await api.setSetting('seek_preview', seekPreview ? '1' : '0');
    useLibrary.getState().setSeekPreview(seekPreview);
    await api.setSetting('autoplay_next', autoplayNext ? '1' : '0');
    useLibrary.getState().setAutoplayNext(autoplayNext);
    // 次にサムネイルを作るときから効く(既存のサムネイルは「すべて再生成」で作り直す)
    await api.setSetting('use_embedded_cover', useEmbeddedCover ? '1' : '0');
    // 空欄なら既定(ピクチャ\DVM)。実効フォルダの解決は Rust 側がやるので store には載せない
    await api.setSetting('frame_save_dir', frameSaveDir.trim());
    await api.setSetting('anthropic_api_key', aiKey.trim());
    await api.setSetting('anthropic_model', aiModel.trim());
    await api.setSetting('mcp_allow_write', mcpAllowWrite ? '1' : '0');
    onClose();
  };

  const regenerate = async (onlyFailed: boolean) => {
    const yes = await ask(
      onlyFailed
        ? '生成に失敗したサムネイルだけを作り直しますか?'
        : 'すべてのサムネイルを作り直しますか?件数が多いと時間がかかります。',
      { title: 'サムネイル再生成' },
    );
    if (!yes) return;
    const count = await api.regenerateThumbnails(onlyFailed);
    if (count === 0) {
      await message('対象のサムネイルはありませんでした', { title: 'サムネイル再生成' });
    }
    // 進捗は画面下部のステータスバーに表示される
    onClose();
  };

  /** ライブラリから外した動画のサムネイルが残っていたら消す */
  const purgeOrphans = async () => {
    setBusy(true);
    try {
      const r = await api.purgeOrphanThumbnails();
      await message(
        r.removed === 0
          ? '不要なサムネイルはありませんでした'
          : `${r.removed} 件(${fmtSize(r.freedBytes)})を削除しました`,
        { title: '孤児サムネイルの掃除' },
      );
      setInfo(await api.getAppInfo());
    } finally {
      setBusy(false);
    }
  };

  /** 復元を予約する。実際の差し替えは次回起動時 */
  const restore = async (b: BackupInfo) => {
    const yes = await ask(
      `「${b.fileName}」(${b.createdAt})から復元しますか?\n\n` +
        '現在のライブラリ(タグ・レーティング・視聴履歴を含む)はこのバックアップの内容で置き換わります。\n' +
        '動画ファイル自体には影響しません。\n\n' +
        '復元はアプリを再起動したときに適用されます。',
      { title: 'バックアップから復元' },
    );
    if (!yes) return;
    setBusy(true);
    try {
      const safety = await api.restoreBackup(b.path);
      await message(
        `復元を予約しました。アプリを再起動すると適用されます。\n\n` +
          `現在のデータは ${safety} として保存しました。`,
        { title: 'バックアップから復元' },
      );
      setBackups(await api.listDbBackups());
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      await api.backupDb();
      setBackups(await api.listDbBackups());
      setInfo(await api.getAppInfo());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">設定</div>

        <div className="settings-section">
          <div className="settings-heading">ライブラリ</div>
          <div className="settings-note">
            ライブラリごとに動画・タグ・シリーズ・監視フォルダが分かれます。
            見た目や API キーなどの設定は切り替えても変わりません。
            切り替えはサイドバー上部のライブラリ名から行います
          </div>
          <ul className="library-list">
            {libraries.map((lib) => {
              const isCurrent = lib.id === info?.libraryId;
              return (
                <li key={lib.id} className={isCurrent ? 'current' : ''}>
                  <div className="library-list-main">
                    <span className="library-list-name">
                      {lib.name}
                      {isCurrent && <span className="library-badge">開いています</span>}
                      {!lib.online && <span className="library-badge warn">未接続</span>}
                    </span>
                    <span className="library-list-root" title={lib.root}>{lib.root}</span>
                  </div>
                  <div className="library-list-actions">
                    <button onClick={() => renameLibrary(lib)}>名前を変更...</button>
                    <button onClick={() => api.openLibraryDir(lib.id)} disabled={!lib.online}>
                      フォルダを開く
                    </button>
                    <button
                      onClick={() => forgetLibrary(lib)}
                      disabled={isCurrent}
                      title={
                        isCurrent
                          ? '開いているライブラリは外せません(別のライブラリに切り替えてから)'
                          : 'フォルダとファイルは削除されません'
                      }
                    >
                      一覧から外す
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="settings-section">
          <div className="settings-heading">再生</div>
          <label className="modal-label">
            外部プレイヤー(空欄なら Windows の既定のプレイヤーで開く)
          </label>
          <div className="modal-row">
            <input
              value={playerPath}
              placeholder="例: C:\\Program Files\\mpv\\mpv.exe"
              onChange={(e) => setPlayerPath(e.target.value)}
            />
            <button onClick={browsePlayer}>参照...</button>
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={previewOnHover}
              onChange={(e) => setPreviewOnHover(e.target.checked)}
            />
            カードにカーソルを合わせるとプレビュー再生する(マウスを左右に動かすとシーンを送れます)
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={cardTags}
              onChange={(e) => setCardTags(e.target.checked)}
            />
            グリッドのカードにタグを表示する(詳細リストは列の選択から追加できます)
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={cardSeries}
              onChange={(e) => setCardSeries(e.target.checked)}
            />
            グリッドのカードにシリーズを表示する
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={seekPreview}
              onChange={(e) => setSeekPreview(e.target.checked)}
            />
            再生中、シークバーにカーソルを合わせるとその位置のコマを表示する(重い動画で本編がカクつく場合はオフ)
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={autoplayNext}
              onChange={(e) => setAutoplayNext(e.target.checked)}
            />
            最後まで再生したら次の動画へ進む(一覧の並び順。⏭ / N キーでも進めます)
          </label>
          <div className="settings-note">
            プレビューは元の動画ファイルを直接読みます。外付け HDD / NAS のアクセスを抑えたいときは
            オフにしてください
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-heading">字幕の見た目(アプリ内再生)</div>
          <div className="settings-note">
            ここの設定はその場で保存されます(「保存」を押す必要はありません)。
            再生中はコントロールバーの字幕ボタンから、映像を見ながら同じ設定を調整できます。
            変換して再生する形式(mp4 に変換されるもの)では字幕そのものが表示されません
          </div>
          <SubtitleStyleEditor
            value={subStyle}
            onChange={setSubStyle}
            onReset={resetSubStyle}
          />
        </div>

        <div className="settings-section">
          <div className="settings-heading">データの保存場所</div>
          {info && (
            <div className="settings-info">
              <div className="settings-info-row">
                <span>ライブラリ「{info.libraryName}」</span>
                <span className="settings-path" title={info.libraryRoot}>{info.libraryRoot}</span>
              </div>
              <div className="settings-info-row">
                <span>データフォルダ(アプリ全体)</span>
                <span className="settings-path" title={info.dataDir}>{info.dataDir}</span>
              </div>
              <div className="settings-info-row">
                <span>データベース</span>
                <span>{fmtSize(info.dbSize)}</span>
              </div>
              <div className="settings-info-row">
                <span>サムネイルキャッシュ</span>
                <span>
                  {info.thumbCount} 件 / {fmtSize(info.thumbCacheSize)}
                </span>
              </div>
            </div>
          )}
          <div className="settings-note">
            動画・タグ・サムネイル・バックアップはライブラリフォルダの中にあります。
            設定と再生用の変換キャッシュだけがアプリ全体のデータフォルダに入ります
          </div>
          <div className="modal-row">
            <button onClick={() => api.openLibraryDir()}>ライブラリフォルダを開く</button>
            <button onClick={() => api.openDataDir()}>データフォルダを開く</button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-heading">サムネイル</div>
          <div className="modal-row">
            <button onClick={() => regenerate(true)}>失敗した分を再生成</button>
            <button onClick={() => regenerate(false)}>すべて再生成</button>
            <button onClick={purgeOrphans} disabled={busy}>
              孤児サムネイルを掃除
            </button>
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={useEmbeddedCover}
              onChange={(e) => setUseEmbeddedCover(e.target.checked)}
            />
            動画にカバー画像が埋め込まれていればサムネイルに使う(生成が速く、絵も的確になります)
          </label>
          <div className="settings-note">
            再生中にサムネイルのボタン(T キー)を押すと、その位置を個別にサムネイルにできます。
            手動で指定したコマはカバー画像より優先されます
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-heading">コマの保存</div>
          <label className="modal-label">
            保存先フォルダ(空欄なら {info?.framesDir ?? 'ピクチャ\\DVM'})
          </label>
          <div className="modal-row">
            <input
              value={frameSaveDir}
              placeholder={info?.framesDir ?? ''}
              onChange={(e) => setFrameSaveDir(e.target.value)}
            />
            <button onClick={browseFrameDir}>参照...</button>
          </div>
          <div className="modal-row">
            <button onClick={() => api.openFrameDir()}>保存先を開く</button>
            <button onClick={() => setFrameSaveDir('')} disabled={frameSaveDir === ''}>
              既定に戻す
            </button>
          </div>
          <div className="settings-note">
            再生中にカメラのボタン(S キー)を押すと、そのコマを PNG で保存します。
            元の動画から原寸のまま取り出すので、字幕やコントロールバーは写りません。
            同じ名前があれば上書きせず連番を付けます
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-heading">AI アシスタント</div>
          <label className="modal-label">Anthropic API キー(AI アシスタントで使用)</label>
          <div className="modal-row">
            <input
              type="password"
              value={aiKey}
              placeholder="sk-ant-..."
              onChange={(e) => setAiKey(e.target.value)}
            />
          </div>
          <label className="modal-label">モデル(空欄なら claude-opus-5)</label>
          <div className="modal-row">
            <input
              value={aiModel}
              placeholder="claude-opus-5"
              onChange={(e) => setAiModel(e.target.value)}
            />
          </div>
          <div className="settings-note">
            キーは library.db に平文で保存され、DB バックアップにも含まれます。利用量に応じて Anthropic の API 料金が発生します
          </div>
        </div>

        <McpSettings
          exePath={info ? info.mcpPath : undefined}
          allowWrite={mcpAllowWrite}
          onAllowWriteChange={setMcpAllowWrite}
          libraryName={info?.libraryName}
        />

        <div className="settings-section">
          <div className="settings-heading">バックアップ</div>
          <div className="modal-row">
            <button onClick={backupNow} disabled={busy}>
              {busy ? 'バックアップ中...' : '今すぐバックアップ'}
            </button>
            <button onClick={() => api.openBackupsDir()}>バックアップフォルダを開く</button>
          </div>
          {backups.length > 0 && (
            <div className="settings-backup-list">
              {backups.map((b) => (
                <div key={b.fileName} className="settings-info-row">
                  <span className="settings-path" title={b.path}>{b.fileName}</span>
                  <span>
                    {fmtSize(b.size)} ・ {b.createdAt}
                  </span>
                  <button className="backup-restore" onClick={() => restore(b)}>
                    復元
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="settings-note">
            復元はアプリの再起動時に適用されます(起動中に library.db を差し替えると壊れるため)。
            復元の直前に現在のデータも pre-restore-... として自動でバックアップします
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
