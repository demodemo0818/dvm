import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useCallback } from 'react';
import { api } from '../../api';
import { useContextMenu } from '../../hooks/useContextMenu';
import { buildPlayerMenu } from '../../lib/contextMenu';
import { useLibrary } from '../../store';
import type { VideoRow } from '../../types';

/**
 * プレイヤーの右クリックメニュー(v1.20)。2 つのエンジンで中身が同じなので
 * `usePlayerShortcuts` と同じ作法で共有する。
 *
 * **描く場所だけはエンジンごとに違う**。返した `menu` を使って
 * `.player-inner` / `.mpv-overlay` の**内側**に `<ContextMenu>` を置くこと —
 * 外に出すと全画面(トップレイヤー)と z-index と mpv の透過で消える
 */
export function usePlayerMenu(
  video: VideoRow,
  opts: {
    /** コントロールを起こす。隠れている間は親が cursor: none なので、出す前に呼ぶ */
    wake: () => void;
    onSetThumbnail: () => void;
    onClose: () => void;
  },
) {
  const { wake, onSetThumbnail, onClose } = opts;
  const { menu, open, close } = useContextMenu<null>();

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      wake();
      open(e, buildPlayerMenu(video), null);
    },
    [wake, open, video],
  );

  const run = useCallback(
    async (id: string) => {
      const s = useLibrary.getState();

      if (id.startsWith('rating:')) {
        await api.setRating([video.id], Number(id.slice('rating:'.length)));
        s.bumpVersion();
        return;
      }

      switch (id) {
        case 'player:setThumb':
          onSetThumbnail();
          break;
        case 'player:reveal':
          try {
            await revealItemInDir(video.path);
          } catch {
            s.pushToast('エクスプローラーで表示できませんでした');
          }
          break;
        case 'player:copyPath':
          try {
            await navigator.clipboard.writeText(video.path);
            s.pushToast('パスをコピーしました', 'info');
          } catch {
            s.pushToast('クリップボードにコピーできませんでした');
          }
          break;
        case 'player:close':
          onClose();
          break;
        default:
      }
    },
    [video, onSetThumbnail, onClose],
  );

  return { menu, onContextMenu, close, run };
}
