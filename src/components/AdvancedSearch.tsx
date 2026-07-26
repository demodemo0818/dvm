import { useEffect, useRef } from 'react';
import { CODEC_OPTIONS, RESOLUTION_OPTIONS, advancedCount } from '../lib/query';
import { useLibrary } from '../store';

/**
 * ツールバーの「詳細検索」ポップオーバー。
 * よく使う条件(検索・並び・★・長さ)はツールバー本体に置いたままで、
 * ここには使用頻度の低い条件だけをまとめる
 */
export function AdvancedSearch({ onClose }: { onClose: () => void }) {
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

  const toggleCodec = (codec: string) => {
    const next = advanced.videoCodecs.includes(codec)
      ? advanced.videoCodecs.filter((c) => c !== codec)
      : [...advanced.videoCodecs, codec];
    setAdvanced({ videoCodecs: next });
  };

  return (
    <div className="adv-popover" ref={ref}>
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
