import { ask, message } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useTextSetting } from '../../hooks/useSetting';
import { fmtSize } from '../../lib/format';
import { CACHE_GB_DEFAULT, CACHE_GB_MAX, CACHE_GB_MIN, parseCacheGb } from '../../lib/settings';
import type { AppInfo, BackupInfo } from '../../types';

/**
 * データの保存場所とバックアップ(v1.38 で 1 カテゴリにまとめた)。
 *
 * どちらも「ライブラリの中身がディスクのどこにどれだけあるか」の話で、
 * 見せる情報(AppInfo)も共通している。
 */
export function DataSection({
  info,
  reloadInfo,
}: {
  info: AppInfo | null;
  reloadInfo: () => void;
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * 変換キャッシュの上限 GB(v1.38。それまでは読み手だけで UI が無かった)。
   * 確定時に parseCacheGb を通すので、**0 や壊れた値が DB に入らない** ——
   * 0 のまま Rust に渡ると、変換のたびにキャッシュが全消しになる
   */
  const cacheGb = useTextSetting('transcode_cache_limit_gb', {
    // 未設定でも欄は既定の 20 を出す(placeholder では「今いくつなのか」が伝わらない)
    defaultValue: String(CACHE_GB_DEFAULT),
    normalize: (s) => String(parseCacheGb(s)),
  });

  useEffect(() => {
    api.listDbBackups().then(setBackups).catch(() => {});
  }, []);

  /** 上限を超えているぶんを古い順に削る。減った量は AppInfo を取り直して見せる */
  const purgeCache = async () => {
    setBusy(true);
    try {
      await api.purgeTranscodeCache();
      reloadInfo();
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
      reloadInfo();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
        <div className="settings-heading">再生用の変換キャッシュ</div>
        {info && (
          <div className="settings-info">
            <div className="settings-info-row">
              <span>今の使用量(すべてのライブラリの合計)</span>
              <span>
                {info.transcodeCount} 件 / {fmtSize(info.transcodeSize)}
              </span>
            </div>
          </div>
        )}
        <label className="modal-label">上限</label>
        <div className="modal-row settings-cache-limit">
          <input
            type="number"
            min={CACHE_GB_MIN}
            max={CACHE_GB_MAX}
            step={1}
            value={cacheGb.value}
            onChange={(e) => cacheGb.edit(e.target.value)}
            onBlur={cacheGb.commit}
          />
          <span className="settings-unit">GB</span>
          <button onClick={purgeCache} disabled={busy}>今すぐ掃除</button>
        </div>
        <div className="settings-note">
          mpv でそのまま再生できない形式は、mp4 に変換してから再生します。その変換結果を
          貯めておく上限です。超えたぶんは古い順に消え、消えても再生し直せば作り直されるので、
          減らしても失われるものはありません(次に変換したときかアプリを起動したときに効きます)
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
    </>
  );
}
