import { ask } from '@tauri-apps/plugin-dialog';
import { composedQueue, loadedQueue, needsSavePrompt, QUEUE_LIMIT } from './queue';
import { useLibrary } from '../store';
import type { VideoRow } from '../types';

/**
 * 行の列でキューを丸ごと置き換えて再生を始める(v1.41)。
 * プレイリストの「キューに読み込んで再生」と、スマートフォルダ / 絞り込み結果の
 * 読み込み(C-4)が共用する。**判断の順序が要点**:
 *
 * 1. 空なら何もしない(既存のキューにも触らない)
 * 2. 手で編集したキューを黙って捨てない(A-29 と同じ確認)
 * 3. 上限超過は**先頭 500 件に切り詰めて断る**。「全部断る」(addToQueue)と違うのは、
 *    こちらが「条件に合うものを流す」入口で、800 件ヒットしたから 1 件も流れない、では
 *    目的を果たさないため
 * 4. 切り詰めたときは出所(source)を持たせない —— 500 件に減った中身で
 *    「上書き保存」されると、元のリストが黙って縮む
 */
export async function replaceQueueWith(
  all: VideoRow[],
  source: { id: number; name: string } | null,
  opts: { label: string; emptyMessage: string },
): Promise<void> {
  const s = useLibrary.getState();
  if (all.length === 0) {
    s.pushToast(opts.emptyMessage, 'info');
    return;
  }
  if (needsSavePrompt(s.queue)) {
    const yes = await ask(
      `保存していないキュー(${s.queue.items.length} 件)を捨てて、\n${opts.label}を読み込みますか?`,
      { title: 'キューの置き換え', kind: 'warning' },
    );
    if (!yes) return;
  }
  const rows = all.slice(0, QUEUE_LIMIT);
  const truncated = all.length > rows.length;
  // ask の間にキューが変わっていることがあるので、入れ直す直前に取り直す
  const st = useLibrary.getState();
  st.setQueue(source !== null && !truncated
    ? loadedQueue(rows, source.id, source.name)
    : composedQueue(rows));
  st.setQueueTabOpen(true);
  if (truncated) {
    st.pushToast(
      `キューの上限は ${QUEUE_LIMIT} 件のため、先頭 ${QUEUE_LIMIT} 件だけを読み込みました`,
      'info',
    );
  }
  // 先頭から再生。見つからない動画なら開かず、送りに任せて飛ばさせる
  const first = rows.find((v) => !v.isMissing && !v.isOffline);
  if (first) st.playFromQueue(first);
  else st.pushToast(`${opts.label}の動画はどれも見つかりませんでした`);
}
