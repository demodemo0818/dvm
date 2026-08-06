import { Fragment, useEffect } from 'react';
import { chordLabel, SHORTCUTS } from '../lib/shortcuts';
import { useLibrary } from '../store';

/**
 * キー操作の一覧(v1.39)。
 *
 * **キーは変更できない。見るだけ。** リバインドを作らなかった理由は
 * DESIGN.md「キー操作の一覧」節を参照。中身は `lib/shortcuts.ts` が唯一の出所で、
 * ここは受け取った配列を描くだけにする(ContextMenu と lib/contextMenu.ts と同じ作法)。
 *
 * **汎用の Modal 部品は作らない**(DESIGN.md「汎用 UI 部品を作らない方針は維持」)。
 * 外枠は既存のモーダルと同じ骨格を手書きでなぞる。
 *
 * **再生中は開かない。** `.app` は再生中 `html.mpv-active` で丸ごと消えるので、
 * 出すには `.mpv-overlay` の内側にもマウントする必要がある(SubtitleStylePanel と
 * 同じ制約)。今は開く側(App.tsx)が `playingVideo` を見て弾いている
 */
export function ShortcutsModal() {
  const showShortcuts = useLibrary((s) => s.showShortcuts);
  const setShowShortcuts = useLibrary((s) => s.setShowShortcuts);

  /*
   * Escape で閉じる。**window ではなく document に張って stopPropagation する** ——
   * App.tsx の Escape(選択解除)は window にいるので、ここで止めれば届かない
   * (SettingsModal と同じ理由)。IME の変換中は「変換の取り消し」なので拾わない
   */
  useEffect(() => {
    if (!showShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      setShowShortcuts(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showShortcuts, setShowShortcuts]);

  if (!showShortcuts) return null;

  const close = () => setShowShortcuts(false);

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">キー操作</div>

        {/* 45 項目を 1 列に積むと長すぎるので、グループ単位で 2 段組みにする(CSS の grid) */}
        <div className="shortcuts-body">
          {SHORTCUTS.map((g) => (
            <div key={g.key} className="shortcuts-group">
              <div className="shortcuts-group-title">{g.title}</div>
              <div className="shortcuts-when">{g.when}</div>
              {g.items.map((item) => (
                <div key={chordLabel(item).join('+')} className="shortcuts-row">
                  <div className="shortcuts-keys">
                    {chordLabel(item).map((k, i) => (
                      // 修飾キーとキーの間だけ + を挟む。「どれを押しても同じ」の並びは素で置く。
                      // **Fragment で並べる** —— span で包むと + と kbd が 1 つの flex 要素に
                      // なり、gap が片側にしか付かず + が右のキーに貼り付く
                      <Fragment key={`${k}-${i}`}>
                        {i > 0 && i <= (item.mods?.length ?? 0) && (
                          <span className="shortcuts-plus">+</span>
                        )}
                        <kbd>{k}</kbd>
                      </Fragment>
                    ))}
                  </div>
                  <div className="shortcuts-label">
                    {item.label}
                    {item.note && <span className="shortcuts-note">{item.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
