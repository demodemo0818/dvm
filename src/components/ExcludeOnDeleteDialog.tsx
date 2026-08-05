import { useEffect, useState } from 'react';
import { EyeOff, FolderMinus, ListX, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { collateralCount, excludeTargets, type ExcludeTargets } from '../lib/excludeOnDelete';
import type { VideoRow } from '../types';

/** 何をしてから削除するか */
export type ExcludeChoice = 'none' | 'files' | 'folders';

/** フォルダの件数をいくつまで数えに行くか。多いと count_videos を叩く回数が増える */
const COUNT_LIMIT = 8;

/**
 * 監視フォルダ配下の動画を削除するときに出す確認(v1.33)。
 *
 * **消しても次のスキャンで再登録される**のはこの場面だけなので、ここでだけ尋ねる。
 * 個別登録の動画しか選んでいなければ、呼び出し側がこのダイアログを出さない。
 *
 * 単位はその場で選ばせる。フォルダごとは一発で済む代わりに、そのフォルダに
 * 今後入る動画まで取り込まれなくなるので、**巻き込む本数を数えて添える**
 */
export function ExcludeOnDeleteDialog({
  selection, onChoose, onClose,
}: {
  selection: VideoRow[];
  onChoose: (choice: ExcludeChoice, targets: ExcludeTargets) => void;
  onClose: () => void;
}) {
  const targets = excludeTargets(selection);
  /** 親フォルダ直下の登録数。数え終わるまでは null(「巻き込み 0 件」と誤読させない) */
  const [collateral, setCollateral] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    if (targets.folders.length > COUNT_LIMIT) {
      return;
    }
    Promise.all(
      targets.folders.map(async (dir) => [dir.toLowerCase(), await api.countVideos({ dirPath: dir })] as const),
    )
      .then((pairs) => {
        if (alive) setCollateral(collateralCount(targets, Object.fromEntries(pairs)));
      })
      .catch(() => {
        // 数えられなくても選択肢は出す(文言側で「不明」と伝える)
      });
    return () => { alive = false; };
    // targets は selection から毎回作り直されるので、依存はパスの並びで見る
  }, [targets.folders.join('|')]);

  const folderLabel =
    targets.folders.length === 1
      ? targets.folders[0]
      : `${targets.folders.length} 個のフォルダー`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal delete-modal exclude-on-delete-modal" onClick={(e) => e.stopPropagation()}>
        {/* このダイアログ自体が削除の確認も兼ねる(呼び出し側で二重に尋ねない) */}
        <div className="modal-title">
          <EyeOff size={18} /> {selection.length.toLocaleString()} 件をライブラリから削除
        </div>
        <div className="settings-note">
          このうち {targets.files.length.toLocaleString()} 件は監視フォルダの中にあるので、
          このまま削除しても<strong>次のスキャンで再登録されます</strong>。
          監視除外に登録しておけば二度と取り込まれません。
          <strong>どれを選んでも動画ファイルは削除しません。</strong>
        </div>

        <div className="delete-choices">
          <button className="delete-choice" onClick={() => onChoose('files', targets)}>
            <ListX />
            <span>
              <span className="delete-choice-title">選んだファイルだけ除外して削除</span>
              <span className="delete-choice-note">
                この {targets.files.length.toLocaleString()} 件だけを監視除外に登録します。
                同じフォルダーの他の動画には影響しません
              </span>
            </span>
          </button>

          <button className="delete-choice" onClick={() => onChoose('folders', targets)}>
            <FolderMinus />
            <span>
              <span className="delete-choice-title">親フォルダーごと除外して削除</span>
              <span className="delete-choice-note">
                {folderLabel} を監視除外に登録します。
                {collateral === null
                  ? 'そのフォルダーに今後入る動画も取り込まれなくなります'
                  : collateral > 0
                    ? `選んでいない ${collateral.toLocaleString()} 件と、今後入る動画も取り込まれなくなります`
                    : '今後そのフォルダーに入る動画も取り込まれなくなります'}
              </span>
            </span>
          </button>

          <button className="delete-choice" onClick={() => onChoose('none', targets)}>
            <RotateCcw />
            <span>
              <span className="delete-choice-title">除外せずに削除する</span>
              <span className="delete-choice-note">
                次のスキャンで再登録されます(いま一時的に消したいだけのとき)
              </span>
            </span>
          </button>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}
