import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  SETTINGS_SIZE_DEFAULT,
  SETTINGS_SIZE_KEY,
  SETTINGS_SIZE_MIN,
  clampModalSize,
  serializeModalSize,
} from '../lib/settings';
import { useLibrary } from '../store';
import type { AppInfo } from '../types';
import { AiSection } from './settings/AiSection';
import { DataSection } from './settings/DataSection';
import { DisplaySection } from './settings/DisplaySection';
import { LibrarySection } from './settings/LibrarySection';
import { PlaybackSection } from './settings/PlaybackSection';
import { SubtitleSection } from './settings/SubtitleSection';
import { ThumbnailSection } from './settings/ThumbnailSection';

type Cat = 'display' | 'playback' | 'subtitle' | 'ai' | 'library' | 'thumbnail' | 'data';

/**
 * 左レールの並び(v1.38)。
 *
 * **「設定」と「管理」の 2 グループに割る。** 好みを決める設定と、破壊的に見える
 * 操作を含む管理メニューがここに同居しているのは v1.14 からの基準どおりだが、
 * 10 セクションを縦に積むと同じ重さに見えてしまっていた。混在を解消するのではなく、
 * 混ざっていることを見えるようにするのが狙い。
 */
const CATS: { key: Cat; label: string; group: '設定' | '管理' }[] = [
  { key: 'display', label: '表示', group: '設定' },
  { key: 'playback', label: '再生', group: '設定' },
  { key: 'subtitle', label: '字幕', group: '設定' },
  { key: 'ai', label: 'AI 連携', group: '設定' },
  { key: 'library', label: 'ライブラリ', group: '管理' },
  { key: 'thumbnail', label: 'サムネイルとコマ', group: '管理' },
  { key: 'data', label: 'データとバックアップ', group: '管理' },
];

/**
 * 設定モーダル(v1.38 で 2 ペイン化)。
 *
 * ここが持つのは外枠だけ —— 選択中のカテゴリ、複数カテゴリが見る `AppInfo`、
 * そして閉じ方の 3 経路(Escape / オーバーレイのクリック /「閉じる」)。
 * 設定の中身と、そのカテゴリでしか使わない一覧の取得は各セクションが自分で持つ。
 *
 * - 設定は**すべてその場保存**。「保存」ボタンは無い(hooks/useSetting.ts の説明を参照)
 * - **`get_app_info` はここで 1 回だけ呼ぶ** —— サムネイルフォルダを全走査するので、
 *   カテゴリごとに呼ばせるとタブを切り替えるたびに走ってしまう
 * - 逆にバックアップ一覧・ライブラリ一覧・除外一覧は各セクションが取る。選んだ
 *   カテゴリしか mount しないので、開かないカテゴリぶんの IPC が飛ばなくなる
 * - 選択中のカテゴリは**永続化しない**。モーダルは開くたび同じ場所から始まるほうが
 *   予測しやすい(常設のサイドバーと違って `sidebar_tab` のような記憶は要らない)
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cat, setCat] = useState<Cat>('display');
  const [info, setInfo] = useState<AppInfo | null>(null);

  const reloadInfo = useCallback(() => {
    api.getAppInfo().then(setInfo).catch(() => {});
  }, []);

  useEffect(reloadInfo, [reloadInfo]);

  /*
   * 右下を掴んで大きさを変えられる(v1.38)。既定は 7 カテゴリ中 6 つが収まる 780x720。
   *
   * **大きさはカテゴリで変えない。** 中身に合わせて伸縮させると、切り替えるたびに
   * モーダルごと動いて左レールの項目まで動く。入りきらないカテゴリ(AI 連携)は
   * 右ペインがスクロールする。
   *
   * 値は store から来る(App.tsx が起動時に読む)—— ここで読むと、既定の大きさで
   * 一瞬描いてから保存した大きさへ跳ねるのが見える。
   * ドラッグの作法は PaneResizer と同じ setPointerCapture 方式で、
   * **保存も離したときだけ**(動かすたびに set_setting を書かない)
   */
  const size = useLibrary((s) => s.settingsModalSize);
  const setSize = useLibrary((s) => s.setSettingsModalSize);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const applyDrag = (clientX: number, clientY: number) => {
    const d = drag.current;
    if (!d) return;
    /*
     * オーバーレイが中央寄せなので、幅を dW 広げても右端は dW/2 しか動かない。
     * ハンドルがカーソルに付いてくるよう 2 倍にする
     */
    const next = clampModalSize({
      w: d.w + (clientX - d.x) * 2,
      h: d.h + (clientY - d.y) * 2,
    });
    // 窓からはみ出させない(CSS の max-width/height と二重だが、保存する値も丸めたい)
    setSize({
      w: Math.max(Math.min(next.w, Math.round(window.innerWidth * 0.9)), SETTINGS_SIZE_MIN.w),
      h: Math.max(Math.min(next.h, Math.round(window.innerHeight * 0.85)), SETTINGS_SIZE_MIN.h),
    });
  };

  /** 丸められたあとの値を保存したいので、状態は store から読み直す(PaneResizer と同じ) */
  const commitSize = () => {
    const s = useLibrary.getState().settingsModalSize;
    void api.setSetting(SETTINGS_SIZE_KEY, serializeModalSize(s));
  };

  /*
   * Escape で閉じる。**window ではなく document に張って stopPropagation する** ——
   * App.tsx の Escape(選択解除)は window にいるので、ここで止めれば届かない。
   * IME の変換中は「変換の取り消し」なので拾わない(入力欄が 5 個ある)
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        style={{ width: size.w, height: size.h }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">設定</div>

        <div className="settings-panes">
          <div className="settings-nav">
            {CATS.map((c, i) => (
              <div key={c.key}>
                {/* グループの見出しは、そのグループの先頭でだけ出す */}
                {(i === 0 || CATS[i - 1].group !== c.group) && (
                  <div className="settings-nav-group">{c.group}</div>
                )}
                <button
                  className={cat === c.key ? 'settings-nav-item active' : 'settings-nav-item'}
                  onClick={() => setCat(c.key)}
                >
                  {c.label}
                </button>
              </div>
            ))}
          </div>

          <div className="settings-body">
            {cat === 'display' && <DisplaySection />}
            {cat === 'playback' && <PlaybackSection />}
            {cat === 'subtitle' && <SubtitleSection />}
            {cat === 'ai' && <AiSection info={info} />}
            {cat === 'library' && <LibrarySection info={info} />}
            {cat === 'thumbnail' && (
              <ThumbnailSection info={info} reloadInfo={reloadInfo} onClose={onClose} />
            )}
            {cat === 'data' && <DataSection info={info} reloadInfo={reloadInfo} />}
          </div>
        </div>

        {/* 設定はその場で保存済みなので「閉じる」だけ。primary にはしない(押さないと確定しない、と読ませないため) */}
        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>

        <div
          className="settings-resize"
          title="大きさを変更(ダブルクリックで既定に戻す)"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
          }}
          onPointerMove={(e) => applyDrag(e.clientX, e.clientY)}
          onPointerUp={(e) => {
            if (!drag.current) return;
            applyDrag(e.clientX, e.clientY);
            drag.current = null;
            commitSize();
          }}
          onDoubleClick={() => {
            setSize(SETTINGS_SIZE_DEFAULT);
            commitSize();
          }}
        />
      </div>
    </div>
  );
}
