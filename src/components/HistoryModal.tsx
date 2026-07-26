import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { OpEntry } from '../types';

const PAGE = 100;

/** action を日本語の見出しにする(未知の action はそのまま出す) */
const ACTION_LABEL: Record<string, string> = {
  tag_videos: 'タグを付けた',
  untag_videos: 'タグを外した',
  add_to_series: 'シリーズに追加した',
  remove_from_series: 'シリーズから外した',
  set_rating: 'レーティングを変更した',
  set_video_info: 'タイトル・コメントを変更した',
  rename_tag: 'タグ名を変更した',
  delete_tag: 'タグを削除した',
  delete_series: 'シリーズを削除した',
  set_tag_color: 'タグの色を変更した',
  set_tag_parent: 'タグの親を変更した',
  remove_videos: 'ライブラリから削除した',
  trash_file: 'ファイルをごみ箱へ送った',
  move_file: 'ファイルを移動した',
  rename_file: 'ファイル名を変更した',
  relink: 'パスを再リンクした',
  undo: '操作を取り消した',
  drive_remap: 'ドライブレターを再マップした',
  move_detected: '移動を検出した',
  backup_db: 'バックアップを作成した',
  request_restore: '復元を予約した',
  regenerate_thumbnails: 'サムネイルを再生成した',
  purge_orphan_thumbnails: '孤児サムネイルを掃除した',
  create_smart_folder: 'スマートフォルダを作成した',
  update_smart_folder: 'スマートフォルダを更新した',
  delete_smart_folder: 'スマートフォルダを削除した',
};

/** payload の JSON から一行の要約を作る。読めなければそのまま返す */
function summarize(entry: OpEntry): string {
  if (!entry.payload) return '';
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(entry.payload);
  } catch {
    return entry.payload; // v1.9 より前の自由文字列
  }
  const count = (key: string) => (Array.isArray(p[key]) ? (p[key] as unknown[]).length : 0);
  switch (entry.action) {
    case 'tag_videos':
      return `「${p.tag}」を ${count('added')} 件に`;
    case 'untag_videos':
      return `「${p.tag}」を ${count('removed')} 件から`;
    case 'add_to_series':
      return `「${p.series}」に ${count('added')} 件`;
    case 'remove_from_series':
      return `「${p.series}」から ${count('removed')} 件`;
    case 'set_rating':
      return `★${p.rating} を ${count('before')} 件に`;
    case 'rename_tag':
      return `${p.before} → ${p.after}`;
    case 'relink':
      return `${count('items')} 件のパス`;
    case 'move_file':
    case 'rename_file':
    case 'trash_file':
      return String(p.path ?? p.to ?? '');
    case 'remove_videos':
      return `${count('videos')} 件`;
    default:
      return entry.payload.length > 90 ? `${entry.payload.slice(0, 90)}…` : entry.payload;
  }
}

/**
 * 操作履歴(v1.9)。operations_log を読んで表示し、可逆な操作だけ取り消せる。
 * ファイルを動かす操作は履歴には出すが取り消しは拒否する(理由を出す)
 */
export function HistoryModal({ onClose }: { onClose: () => void }) {
  const { bumpVersion, pushToast } = useLibrary();
  const [entries, setEntries] = useState<OpEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (off: number) => {
      setLoading(true);
      try {
        const rows = await api.listOperations(PAGE, off);
        setEntries((cur) => (off === 0 ? rows : [...cur, ...rows]));
        setOffset(off + rows.length);
      } catch {
        // api 側でトースト済み
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const undo = async (entry: OpEntry) => {
    try {
      const msg = await api.undoOperation(entry.id);
      pushToast(msg, 'info');
      bumpVersion();
      void load(0);
    } catch {
      // api 側でトースト済み
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">操作履歴</div>
        <div className="settings-note">
          タグ・レーティング・シリーズ・再リンクは取り消せます。ファイルを動かした操作
          (ごみ箱送り・移動・リネーム)と登録削除は取り消せません
        </div>

        <div className="history-list">
          {entries.length === 0 && !loading && <div className="stats-empty">履歴がありません</div>}
          {entries.map((e) => (
            <div key={e.id} className={`history-row ${e.undoneAt ? 'undone' : ''}`}>
              <span className="history-time">{e.timestamp}</span>
              <span className={`history-actor ${e.actor}`}>{e.actor}</span>
              <span className="history-action">{ACTION_LABEL[e.action] ?? e.action}</span>
              <span className="history-detail" title={e.payload ?? ''}>{summarize(e)}</span>
              {e.undoable ? (
                <button className="history-undo" onClick={() => undo(e)}>
                  取り消す
                </button>
              ) : (
                <span className="history-reason" title={e.reason ?? ''}>
                  {e.undoneAt ? '取り消し済み' : ''}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          {entries.length > 0 && entries.length % PAGE === 0 && (
            <button onClick={() => load(offset)} disabled={loading}>
              さらに読み込む
            </button>
          )}
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
