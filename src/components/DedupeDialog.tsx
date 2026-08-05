import { ask } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { CopyMinus, ListX, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { DedupePlan, DedupeResult } from '../types';

/**
 * 重複解消の確認ダイアログ(v1.33)。
 *
 * **下見を見せてからでないと実行させない。** 開いた時点で `plan_dedupe` を呼び、
 * 何本外れて何が残るのかを出してからボタンを押させる。
 * 実行してもファイルには触らない(ライブラリの登録を外すだけ)ので、
 * ごみ箱送りのような二段構えの警告までは出していない。
 */
export function DedupeDialog({
  scope, onDone, onClose,
}: {
  /** 対象フォルダ。未指定ならライブラリ全体 */
  scope?: string;
  onDone: (result: DedupeResult, trashed: boolean) => void;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<DedupePlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.planDedupe(scope).then((p) => {
      if (alive) setPlan(p);
    }).catch(() => onClose());
    return () => { alive = false; };
  }, [scope, onClose]);

  /**
   * ごみ箱送りは**もう一段確認する**。下見は見せてあるが、登録を外すのと違って
   * ファイルが動くので、押し間違いで通り抜けないようにする
   */
  const run = async (trashFiles: boolean) => {
    if (trashFiles) {
      const yes = await ask(
        `重複した ${plan?.removeCount.toLocaleString()} 件のファイルを Windows のごみ箱へ送ります。\n\n` +
          '各グループで残す 1 本には手を付けません。\n' +
          'ごみ箱から戻して再スキャンすれば元に戻せます。\n\n' +
          '実行しますか?',
        { title: 'ファイルをごみ箱へ送る', kind: 'warning' },
      );
      if (!yes) return;
    }
    setBusy(true);
    try {
      onDone(await api.applyDedupe(scope, trashFiles), trashFiles);
    } finally {
      setBusy(false);
    }
  };

  const nothing = plan !== null && plan.removeCount === 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dedupe-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <CopyMinus size={18} /> 重複を解消
        </div>
        <div className="settings-note">
          {scope ? <>対象: <code>{scope}</code> の配下</> : 'ライブラリ全体が対象です'}
        </div>

        {plan === null && (
          <div className="dedupe-loading"><Loader2 className="spin" /> 重複を数えています…</div>
        )}

        {plan !== null && (
          <>
            <div className="dedupe-summary">
              <div className="dedupe-stat">
                <span className="dedupe-num">{plan.removeCount.toLocaleString()}</span>
                <span className="dedupe-label">ライブラリから外す</span>
              </div>
              <div className="dedupe-stat">
                <span className="dedupe-num">{plan.groups.toLocaleString()}</span>
                <span className="dedupe-label">残る本数(1 グループ 1 本)</span>
              </div>
            </div>

            <div className="settings-note">
              同じ内容(サイズと先頭ハッシュが一致)の動画を 1 本だけ残します。
              タグ・レーティング・視聴履歴が付いた動画は優先して残します。
              下のどちらのボタンを押すかで、ファイルを残すか捨てるかが決まります。
            </div>

            {(plan.skippedOutside > 0 || plan.skippedZeroSize > 0) && (
              <div className="settings-note dedupe-skipped">
                {plan.skippedOutside > 0 && (
                  <div>
                    {plan.skippedOutside.toLocaleString()} グループは、同じ内容がこのフォルダーの
                    外にもあるため触りません
                  </div>
                )}
                {plan.skippedZeroSize > 0 && (
                  <div>
                    {plan.skippedZeroSize.toLocaleString()} グループは 0 バイトのファイルなので
                    対象外です(中身が同じとは限りません)
                  </div>
                )}
              </div>
            )}

            {plan.byFolder.length > 0 && (
              <div className="dedupe-breakdown">
                <div className="dedupe-breakdown-title">外す動画のあるフォルダー</div>
                <ul>
                  {plan.byFolder.map((f) => (
                    <li key={f.path}>
                      <span className="dedupe-path" title={f.path}>{f.path}</span>
                      <span className="dedupe-count">{f.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.samples.length > 0 && (
              <details className="dedupe-samples">
                <summary>残すものと外すものの例({plan.samples.length} 組)</summary>
                {plan.samples.map((s) => (
                  <div className="dedupe-sample" key={s.keep}>
                    <div className="dedupe-keep" title={s.keep}>残す: {s.keep}</div>
                    {s.remove.map((r) => (
                      <div className="dedupe-remove" key={r} title={r}>外す: {r}</div>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </>
        )}

        {/*
          削除先の選び方は Delete キーのダイアログ(DeleteDialog)と同じ作法にそろえる。
          「何が起きるか」を選択肢の中に書いて、押す前に結果が分かるようにする
        */}
        {plan !== null && !nothing && (
          <div className="delete-choices">
            <button className="delete-choice" disabled={busy} onClick={() => void run(false)}>
              <ListX />
              <span>
                <span className="delete-choice-title">
                  {plan.removeCount.toLocaleString()} 件をライブラリから外す
                </span>
                <span className="delete-choice-note">
                  登録だけを消します。ファイルは元の場所に残ります
                </span>
              </span>
            </button>

            <button className="delete-choice danger" disabled={busy} onClick={() => void run(true)}>
              <Trash2 />
              <span>
                <span className="delete-choice-title">
                  {plan.removeCount.toLocaleString()} 件のファイルをごみ箱へ
                </span>
                <span className="delete-choice-note">
                  重複したファイルをごみ箱へ送り、登録も消します(残す 1 本には触れません)
                </span>
              </span>
            </button>
          </div>
        )}

        <div className="modal-actions">
          {busy && <span className="settings-note">実行中…</span>}
          <button onClick={onClose}>{nothing ? '閉じる' : 'キャンセル'}</button>
        </div>
      </div>
    </div>
  );
}
