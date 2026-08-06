import { useLibrary } from '../../store';
import { SubtitleStyleEditor } from '../SubtitleStyleEditor';

/**
 * 字幕の見た目(v1.24)。
 *
 * 中身は再生画面の字幕パネルと**同じコンポーネント**(`SubtitleStyleEditor` は状態を
 * 持たない)。store を直にバインドし、DB への書き込みだけ App.tsx が 400ms
 * デバウンスしてまとめる —— スライダーのドラッグ中に set_setting を毎フレーム叩くと
 * 取り込みワーカーとロックを取り合うため。
 */
export function SubtitleSection() {
  const subStyle = useLibrary((s) => s.subStyle);
  const setSubStyle = useLibrary((s) => s.setSubStyle);
  const resetSubStyle = useLibrary((s) => s.resetSubStyle);

  return (
    <div className="settings-section">
      <div className="settings-heading">字幕の見た目(アプリ内再生)</div>
      <div className="settings-note">
        再生中はコントロールバーの字幕ボタンから、映像を見ながら同じ設定を調整できます。
        変換して再生する形式(mp4 に変換されるもの)では字幕そのものが表示されません
      </div>
      <SubtitleStyleEditor value={subStyle} onChange={setSubStyle} onReset={resetSubStyle} />
    </div>
  );
}
