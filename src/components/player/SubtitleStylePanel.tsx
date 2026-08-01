import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { SubtitleStyleEditor } from '../SubtitleStyleEditor';
import { useLibrary } from '../../store';

/**
 * 再生画面から開く字幕設定パネル(v1.24)。
 *
 * **必ず .mpv-overlay の内側に描くこと** —— 再生中は html.mpv-active が .app ごと
 * 消すので、外に置くと表示されない(ContextMenu と同じ制約)。
 * 位置は CSS(.sub-style-panel)で帯の上に固定してある。.mpv-overlay が
 * `fixed; inset: 0` なので、ウィンドウ全画面でもリサイズでも座標計算が要らない。
 *
 * 値と保存は store 任せ(App.tsx がデバウンスして書く)。ここは開閉だけを持つ
 */
export function SubtitleStylePanel({
  assWarning, onClose,
}: {
  assWarning: boolean;
  onClose: () => void;
}) {
  const subStyle = useLibrary((s) => s.subStyle);
  const setSubStyle = useLibrary((s) => s.setSubStyle);
  const resetSubStyle = useLibrary((s) => s.resetSubStyle);
  const ref = useRef<HTMLDivElement>(null);

  /*
   * 外側のクリックと Esc で閉じる(ColumnPicker と同じ作法)。
   * **Esc をここで受けるのが要点** —— usePlayerShortcuts の Esc は
   * INPUT/SELECT の素通し判定より前にあるので、パネルを開いている間は
   * MpvPlayerView 側で suspended にして止めてある
   */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // 開いた直後のクリック(ボタンを押した手)で閉じないよう次のフレームから拾う
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="sub-style-panel"
      // 帯のクリック(再生⇄停止)と、オーバーレイの右クリックメニューを止める
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="sub-style-panel-head">
        <span>字幕の見た目</span>
        <button onMouseDown={(e) => e.preventDefault()} onClick={onClose} title="閉じる (Esc)">
          <X />
        </button>
      </div>
      <SubtitleStyleEditor
        compact
        assWarning={assWarning}
        value={subStyle}
        onChange={setSubStyle}
        onReset={resetSubStyle}
      />
    </div>
  );
}
