import { useEffect, useRef } from 'react';
import { CODEC_OPTIONS, RESOLUTION_OPTIONS, advancedCount } from '../lib/query';
import { useLibrary } from '../store';

/** .adv-popover の幅(App.css と対)と、画面端に残す余白 */
const POPOVER_W = 340;
const EDGE = 8;

/**
 * ツールバーの「詳細検索」ポップオーバー。
 * よく使う条件(検索・並び・★・長さ)はツールバー本体に置いたままで、
 * ここには使用頻度の低い条件だけをまとめる。
 *
 * **位置はボタンの座標を受け取って画面基準(fixed)で決める**。ツールバーは
 * overflow: hidden なので、中に absolute で置くとそこで切られてしまう。
 * 列選択ポップオーバー・右クリックメニューと同じ扱い
 */
export function AdvancedSearch({
  at, onClose,
}: {
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const { advanced, setAdvanced, clearAdvanced } = useLibrary();
  const ref = useRef<HTMLDivElement>(null);

  // 外側クリックと Esc で閉じる
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
    // クリックで開いた直後の同じイベントで閉じないよう次のフレームから拾う
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 画面の右端をはみ出すぶんは左へ寄せる(右クリックメニューと同じ作法)
  const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - POPOVER_W - EDGE));

  const toggleCodec = (codec: string) => {
    const next = advanced.videoCodecs.includes(codec)
      ? advanced.videoCodecs.filter((c) => c !== codec)
      : [...advanced.videoCodecs, codec];
    setAdvanced({ videoCodecs: next });
  };

  return (
    <div className="adv-popover" ref={ref} style={{ left, top: at.y }}>
      <div className="adv-title">詳細検索</div>

      <label className="adv-check">
        <input
          type="checkbox"
          checked={advanced.searchPath}
          onChange={(e) => setAdvanced({ searchPath: e.target.checked })}
        />
        フォルダのパスも検索対象にする
      </label>
      <label className="adv-check">
        <input
          type="checkbox"
          checked={advanced.untagged}
          onChange={(e) => setAdvanced({ untagged: e.target.checked })}
        />
        タグが付いていないものだけ
      </label>
      <label className="adv-check">
        <input
          type="checkbox"
          checked={advanced.unwatched}
          onChange={(e) => setAdvanced({ unwatched: e.target.checked })}
        />
        まだ観ていないものだけ
      </label>

      <div className="adv-row">
        <span className="adv-label">解像度</span>
        <select
          value={advanced.minHeight}
          onChange={(e) => setAdvanced({ minHeight: Number(e.target.value) })}
        >
          {RESOLUTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="adv-row adv-col">
        <span className="adv-label">コーデック</span>
        <div className="adv-chips">
          {CODEC_OPTIONS.map((c) => (
            <button
              key={c}
              type="button"
              className={`adv-chip ${advanced.videoCodecs.includes(c) ? 'on' : ''}`}
              onClick={() => toggleCodec(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="adv-row">
        <span className="adv-label">追加日</span>
        <input
          type="date"
          value={advanced.addedAfter}
          onChange={(e) => setAdvanced({ addedAfter: e.target.value })}
        />
        <span>〜</span>
        <input
          type="date"
          value={advanced.addedBefore}
          onChange={(e) => setAdvanced({ addedBefore: e.target.value })}
        />
      </div>

      <div className="adv-actions">
        <button onClick={clearAdvanced} disabled={advancedCount(advanced) === 0}>
          条件をクリア
        </button>
        <button onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
