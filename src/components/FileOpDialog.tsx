import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { FileOpProgress, OpResult, PlanItem, PlanStatus } from '../types';

const STATUS_LABEL: Record<PlanStatus, string> = {
  ok: '実行',
  conflict: '移動先に同名あり',
  sourceMissing: '元が見つからない',
  offline: 'ドライブ未接続',
  unchanged: '変更なし',
};

export type FileOpKind = 'relink' | 'move' | 'rename' | 'trash';

const TITLE: Record<FileOpKind, string> = {
  relink: 'パスの再リンク',
  move: 'ファイルの移動',
  rename: 'ファイル名の変更',
  trash: 'ファイルをごみ箱へ',
};

const DESCRIPTION: Record<FileOpKind, string> = {
  relink: 'データベースのパスだけを書き換えます。ファイルは移動しません。',
  move: '実際のファイルを移動します。取り消しはできません(逆向きの移動で戻せます)。',
  rename: '実際のファイル名を変更します。取り消しはできません。',
  trash:
    'ファイルをごみ箱へ送り、続けてライブラリ登録も削除します。' +
    'ごみ箱から戻して再スキャンすれば表示は戻りますが、タグ・レーティング・視聴回数は復元されません。',
};

/**
 * ファイル操作の確認ダイアログ(v1.9)。
 * **必ず dry-run の結果を表で見せてから実行する**。
 * 実行できない行(衝突・元が無い・未接続)は自動的に対象外にする
 */
export function FileOpDialog({
  kind,
  plan,
  onClose,
}: {
  kind: FileOpKind;
  plan: PlanItem[];
  onClose: () => void;
}) {
  const { bumpVersion, pushToast, clearSelection } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<FileOpProgress | null>(null);
  const [results, setResults] = useState<OpResult[] | null>(null);

  useEffect(() => {
    const un = listen<FileOpProgress>('fileop:progress', (e) => setProgress(e.payload));
    return () => {
      un.then((u) => u());
    };
  }, []);

  const actionable = plan.filter((p) => p.status === 'ok');
  const skipped = plan.length - actionable.length;

  const run = async () => {
    setBusy(true);
    try {
      const r =
        kind === 'relink'
          ? await api.applyRelink(actionable)
          : kind === 'trash'
            ? await api.applyTrash(actionable)
            : await api.applyMove(actionable, kind === 'move' ? 'move_file' : 'rename_file');
      setResults(r);
      const failed = r.filter((x) => !x.ok || x.error);
      if (failed.length > 0) {
        pushToast(`${failed.length} 件が失敗しました`);
      } else {
        pushToast(`${r.length} 件を処理しました`, 'info');
      }
      clearSelection();
      bumpVersion();
    } catch {
      // 失敗は api 側でトースト済み。ダイアログは開いたままにして状況を見せる
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal fileop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{TITLE[kind]}</div>
        <div className="settings-note">{DESCRIPTION[kind]}</div>

        {results ? (
          <>
            <div className="settings-heading">実行結果</div>
            <div className="fileop-table">
              {results.map((r) => (
                <div key={r.videoId} className="fileop-row">
                  <span className={`fileop-status ${r.ok && !r.error ? 'ok' : 'ng'}`}>
                    {r.ok && !r.error ? '完了' : '失敗'}
                  </span>
                  <span className="fileop-path" title={r.to}>{r.to}</span>
                  {r.error && <span className="fileop-note">{r.error}</span>}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="settings-heading">
              対象 {actionable.length} 件
              {skipped > 0 && <span className="fileop-skipped">(除外 {skipped} 件)</span>}
            </div>
            <div className="fileop-table">
              {plan.length === 0 && <div className="stats-empty">対象がありません</div>}
              {plan.map((p) => (
                <div
                  key={p.videoId}
                  className={`fileop-row ${p.status === 'ok' ? '' : 'excluded'}`}
                >
                  <span className={`fileop-status ${p.status === 'ok' ? 'ok' : 'ng'}`}>
                    {STATUS_LABEL[p.status]}
                  </span>
                  <span className="fileop-paths">
                    <span className="fileop-path from" title={p.from}>{p.from}</span>
                    <span className="fileop-path to" title={p.to}>→ {p.to}</span>
                  </span>
                  {p.note && <span className="fileop-note">{p.note}</span>}
                </div>
              ))}
            </div>
            {progress && progress.total > 0 && (
              <div className="prepare-bar">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            {results ? '閉じる' : 'キャンセル'}
          </button>
          {!results && (
            <button className="primary" onClick={run} disabled={busy || actionable.length === 0}>
              {busy ? '実行中...' : `${actionable.length} 件を実行`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
