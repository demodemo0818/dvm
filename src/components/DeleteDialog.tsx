import { ListX, Trash2 } from 'lucide-react';

/**
 * Delete キーの削除先を選ばせるダイアログ(v1.14)。
 *
 * キーを押した時点では「登録だけ消したい」のか「ファイルごと捨てたい」のかが
 * 分からないので、**押した直後に必ずここで一度止める**。
 * 右クリックメニューはどちらの削除かを指定して選ぶので、こちらは通らない
 */
export function DeleteDialog({
  count, onLibrary, onTrash, onClose,
}: {
  count: number;
  onLibrary: () => void;
  onTrash: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{count} 件を削除</div>
        <div className="settings-note">どちらの削除にしますか?</div>

        <div className="delete-choices">
          <button className="delete-choice" onClick={onLibrary}>
            <ListX />
            <span>
              <span className="delete-choice-title">ライブラリから削除</span>
              <span className="delete-choice-note">
                登録とタグ・レーティングが消えます。ファイル自体は残ります
              </span>
            </span>
          </button>

          <button className="delete-choice danger" onClick={onTrash}>
            <Trash2 />
            <span>
              <span className="delete-choice-title">ファイルをごみ箱へ</span>
              <span className="delete-choice-note">
                ファイルをごみ箱へ送り、ライブラリ登録も消します(実行前に一覧を確認できます)
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
