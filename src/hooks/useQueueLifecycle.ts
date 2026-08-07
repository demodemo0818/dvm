import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { useEffect } from 'react';
import { api } from '../api';
import { needsSavePrompt, savedQueue, syncQueue } from '../lib/queue';
import { useLibrary } from '../store';

/**
 * キューの寿命まわり(v1.40)。**App.tsx から 1 回だけ呼ぶ**。
 *
 * やることは 2 つ:
 *
 * 1. `library:changed` でキューの中身を引き直す(消えた動画を落とし、リネームに追従する)
 * 2. ウィンドウを閉じるときに「保存しますか?」を尋ねる
 */
export function useQueueLifecycle(version: number) {
  /*
   * キューの引き直し。キューは VideoRow のスナップショットなので、放っておくと
   * ライブラリから削除した動画が残り、リネームしても古い名前が出る。
   * 上限 500 件なので `id IN (...)` の 1 クエリで済み、原則 7(行ごとの I/O をしない)
   * にも触れない。**version が変わったときだけ**走る
   */
  useEffect(() => {
    const items = useLibrary.getState().queue.items;
    if (items.length === 0) return;
    let alive = true;
    api
      .getVideosByIds(items.map((v) => v.id))
      .then((rows) => {
        // 引き直しの往復中にユーザーが編集していることがあるので、最新の状態に当てる
        if (!alive) return;
        const s = useLibrary.getState();
        s.setQueue(syncQueue(s.queue, rows));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);

  /*
   * 閉じるときの確認。
   *
   * **聞くのはキューに中身があって、かつ保存済みと内容が違うときだけ**(needsSavePrompt)。
   * 開発中はキューが空なのが普通なので、`stop.ps1`(× ボタンと同じ WM_CLOSE を送って
   * 終了を待つ)はほとんど止まらずに済む。
   *
   * **`CloseRequested` を通らない終わり方では聞けない** —— タスクマネージャ・
   * OS のシャットダウン・クラッシュ、そして `switch_library` の再起動
   * (あちらは Sidebar 側で別に尋ねている)。「必ず聞く」ではなく
   * 「× ボタンで閉じたときは聞く」であることは DESIGN.md に書いてある
   */
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested(async (event) => {
        if (!needsSavePrompt(useLibrary.getState().queue)) return;
        event.preventDefault();
        const answer = await confirmSaveQueue();
        if (answer === 'cancel') return;
        if (answer === 'save' && !(await saveQueueByName())) return; // 保存に失敗 / 名前を入れずに閉じた
        // preventDefault したぶん、自分で閉じ直す。destroy でも RunEvent::Exit は届くので
        // ウィンドウ位置(tauri-plugin-window-state)は保存される
        await win.destroy();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);
}

export type SaveAnswer = 'save' | 'discard' | 'cancel';

/**
 * 3 択を出す。`@tauri-apps/plugin-dialog` の `ask` は 2 択しか出せないので、
 * 「キャンセル」を別の質問に分けている(1 枚目で「保存する?」、
 * いいえなら 2 枚目で「保存せずに終了する?」)
 */
async function confirmSaveQueue(): Promise<SaveAnswer> {
  const q = useLibrary.getState().queue;
  const what = q.sourceId !== null
    ? `「${q.sourceName}」から変更したキュー(${q.items.length} 件)`
    : `名前を付けていないキュー(${q.items.length} 件)`;
  const save = await ask(`${what}があります。\n名前を付けて保存しますか?`, {
    title: 'キューの保存',
    kind: 'warning',
  });
  if (save) return 'save';
  const discard = await ask('保存せずに終了しますか?\n(キューは失われます)', {
    title: 'キューの保存',
    kind: 'warning',
  });
  return discard ? 'discard' : 'cancel';
}

/** 名前を尋ねて保存する。保存できたら true。空・キャンセル・失敗なら false */
async function saveQueueByName(): Promise<boolean> {
  const q = useLibrary.getState().queue;
  const name = window.prompt('プレイリストの名前', q.sourceName || '')?.trim();
  if (!name) return false;
  try {
    const ids = q.items.map((v) => v.id);
    const existing = await api.findPlaylistByName(name);
    if (existing !== null) {
      if (!window.confirm(`「${name}」はすでにあります。上書きしますか?`)) return false;
      await api.replacePlaylist(existing, ids);
      useLibrary.getState().setQueue(savedQueue(q, existing, name));
    } else {
      const id = await api.createPlaylist(name, ids);
      useLibrary.getState().setQueue(savedQueue(q, id, name));
    }
    return true;
  } catch {
    // トーストは call() の担当。保存できていないので閉じない
    return false;
  }
}
