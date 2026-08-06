import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { useState } from 'react';
import { api } from '../../api';
import { useFlagSetting, useTextSetting } from '../../hooks/useSetting';
import { fmtSize } from '../../lib/format';
import type { AppInfo } from '../../types';

/**
 * サムネイルとコマ(v1.38 で「サムネイル」と「コマの保存」を 1 カテゴリにまとめた)。
 *
 * どちらも「動画から静止画を作る」機能。カバー画像の設定と「すべて再生成」は
 * **切り離さない** —— カバー画像の設定は次に作るぶんからしか効かないので、
 * 既存分に反映する手段が隣に無いと意味が通らない(DESIGN.md 参照)。
 */
export function ThumbnailSection({
  info,
  reloadInfo,
  onClose,
}: {
  info: AppInfo | null;
  reloadInfo: () => void;
  /** 再生成は進捗をステータスバーに出すので、始めたらモーダルを閉じる */
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /** 次にサムネイルを作るときから効く(既存のサムネイルは「すべて再生成」で作り直す) */
  const [useEmbeddedCover, setUseEmbeddedCover] = useFlagSetting('use_embedded_cover', true);
  /** コマの画像の保存先(v1.26)。空欄なら AppInfo.framesDir(ピクチャ\DVM) */
  const frameSaveDir = useTextSetting('frame_save_dir');

  const regenerate = async (onlyFailed: boolean) => {
    const yes = await ask(
      onlyFailed
        ? '生成に失敗したサムネイルだけを作り直しますか?'
        : 'すべてのサムネイルを作り直しますか?件数が多いと時間がかかります。',
      { title: 'サムネイル再生成' },
    );
    if (!yes) return;
    const count = await api.regenerateThumbnails(onlyFailed);
    if (count === 0) {
      await message('対象のサムネイルはありませんでした', { title: 'サムネイル再生成' });
    }
    // 進捗は画面下部のステータスバーに表示される
    onClose();
  };

  /** ライブラリから外した動画のサムネイルが残っていたら消す */
  const purgeOrphans = async () => {
    setBusy(true);
    try {
      const r = await api.purgeOrphanThumbnails();
      await message(
        r.removed === 0
          ? '不要なサムネイルはありませんでした'
          : `${r.removed} 件(${fmtSize(r.freedBytes)})を削除しました`,
        { title: '孤児サムネイルの掃除' },
      );
      reloadInfo();
    } finally {
      setBusy(false);
    }
  };

  const browseFrameDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'コマの画像の保存先フォルダ',
    });
    // ダイアログで選んだ値は確定済みなので、blur を待たずに書く
    if (typeof selected === 'string') frameSaveDir.save(selected);
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-heading">サムネイル</div>
        <div className="modal-row">
          <button onClick={() => regenerate(true)}>失敗した分を再生成</button>
          <button onClick={() => regenerate(false)}>すべて再生成</button>
          <button onClick={purgeOrphans} disabled={busy}>
            孤児サムネイルを掃除
          </button>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={useEmbeddedCover}
            onChange={(e) => setUseEmbeddedCover(e.target.checked)}
          />
          動画にカバー画像が埋め込まれていればサムネイルに使う(生成が速く、絵も的確になります)
        </label>
        <div className="settings-note">
          この設定は次に作るサムネイルから効きます。今あるサムネイルにも反映するなら
          「すべて再生成」を押してください。
          再生中にサムネイルのボタン(T キー)を押すと、その位置を個別にサムネイルにできます。
          手動で指定したコマはカバー画像より優先されます
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-heading">コマの保存</div>
        <label className="modal-label">
          保存先フォルダ(空欄なら {info?.framesDir ?? 'ピクチャ\\DVM'})
        </label>
        <div className="modal-row">
          <input
            value={frameSaveDir.value}
            placeholder={info?.framesDir ?? ''}
            onChange={(e) => frameSaveDir.edit(e.target.value)}
            onBlur={frameSaveDir.commit}
          />
          <button onClick={browseFrameDir}>参照...</button>
        </div>
        <div className="modal-row">
          <button onClick={() => api.openFrameDir()}>保存先を開く</button>
          <button onClick={() => frameSaveDir.save('')} disabled={frameSaveDir.value === ''}>
            既定に戻す
          </button>
        </div>
        <div className="settings-note">
          再生中にカメラのボタン(S キー)を押すと、そのコマを PNG で保存します。
          元の動画から原寸のまま取り出すので、字幕やコントロールバーは写りません。
          同じ名前があれば上書きせず連番を付けます
        </div>
      </div>
    </>
  );
}
