import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { AppInfo, BackupInfo } from '../types';

function fmtSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [playerPath, setPlayerPath] = useState('');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [previewOnHover, setPreviewOnHover] = useState(true);
  const [autoplayNext, setAutoplayNext] = useState(false);

  useEffect(() => {
    api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    // 既定は ON。明示的に '0' のときだけ OFF
    api.getSetting('preview_on_hover').then((v) => setPreviewOnHover(v !== '0'));
    api.getSetting('autoplay_next').then((v) => setAutoplayNext(v === '1'));
    api.getSetting('anthropic_api_key').then((v) => setAiKey(v ?? ''));
    api.getSetting('anthropic_model').then((v) => setAiModel(v ?? ''));
    api.getAppInfo().then(setInfo).catch(() => {});
    api.listDbBackups().then(setBackups).catch(() => {});
  }, []);

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
    await api.setSetting('autoplay_next', autoplayNext ? '1' : '0');
    useLibrary.getState().setAutoplayNext(autoplayNext);
    await api.setSetting('anthropic_api_key', aiKey.trim());
    await api.setSetting('anthropic_model', aiModel.trim());
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
          <div className="settings-heading">データの保存場所</div>
          {info && (
            <div className="settings-info">
              <div className="settings-info-row">
                <span>データフォルダ</span>
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
          <div className="modal-row">
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
          <div className="settings-note">
            再生中にカメラのボタン(T キー)を押すと、その位置を個別にサムネイルにできます
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
          <label className="modal-label">モデル(空欄なら claude-opus-4-8)</label>
          <div className="modal-row">
            <input
              value={aiModel}
              placeholder="claude-opus-4-8"
              onChange={(e) => setAiModel(e.target.value)}
            />
          </div>
          <div className="settings-note">
            キーは library.db に平文で保存され、DB バックアップにも含まれます。利用量に応じて Anthropic の API 料金が発生します
          </div>
        </div>

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
