import { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { api } from '../api';

/**
 * フォルダーツリーから「監視除外フォルダに登録」を選んだときの確認(v1.33)。
 *
 * 配下の登録を外すかどうかをここで決めさせる。外さないと、除外したのに
 * 一覧には残ったまま(次のスキャンで増えないだけ)になって分かりにくいので、
 * 既定は「外す」。**どちらを選んでもファイルは消えない**
 */
export function ExcludeDialog({
  path, videoCount, onDone, onClose,
}: {
  path: string;
  /** このフォルダー配下に今ある登録数 */
  videoCount: number;
  onDone: (removed: number) => void;
  onClose: () => void;
}) {
  const [removeVideos, setRemoveVideos] = useState(true);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      onDone(await api.addExcludedPaths([path], removeVideos));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <EyeOff size={18} /> 監視除外フォルダに登録
        </div>
        <div className="settings-note">
          <code>{path}</code> の配下は、次のスキャンから取り込まれなくなります。
          監視フォルダの中にあっても無視されます。<strong>ファイルは削除しません。</strong>
        </div>

        {videoCount > 0 && (
          <label className="settings-row">
            <input
              type="checkbox"
              checked={removeVideos}
              onChange={(e) => setRemoveVideos(e.target.checked)}
            />
            <span>
              今ある登録 {videoCount.toLocaleString()} 件もライブラリから外す
              <span className="settings-note">
                外さないと、除外したフォルダーの動画が一覧に残ったままになります
              </span>
            </span>
          </label>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button className="primary" disabled={busy} onClick={run}>
            {busy ? '登録中…' : '監視除外フォルダに登録'}
          </button>
        </div>
      </div>
    </div>
  );
}
