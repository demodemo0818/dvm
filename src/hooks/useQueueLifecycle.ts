import { useEffect } from 'react';
import { api } from '../api';
import { syncQueue } from '../lib/queue';
import { parseSnapshot, restoredQueue, serializeQueue } from '../lib/queueStorage';
import { useLibrary } from '../store';

/**
 * キューの寿命まわり(v1.40。自動保存・復元は v1.41 の C-2)。**App.tsx から 1 回だけ呼ぶ**。
 *
 * やることは 2 つ:
 *
 * 1. `library:changed` でキューの中身を引き直す(消えた動画を落とし、リネームに追従する)
 * 2. 編集のたびに library.db(session_state)へ自動保存し、起動時に黙って復元する
 *
 * v1.40 の「閉じるときに保存を尋ねる 3 択」は**廃止した** —— 常時保存になったことで
 * クラッシュ・強制終了・ライブラリ切り替えでもキューが失われなくなり、
 * 確認で守るものが無くなったため(DESIGN.md「キューは自動保存」節)。
 * プレイリストへの保存はパネルの「名前を付けて保存 / 上書き保存」だけになった
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
   * 自動保存と起動時復元(v1.41、C-2)。
   *
   * - 保存は queue が差し替わるたび。ドラッグ並べ替えもドロップで 1 回しか
   *   setQueue しないので、デバウンスは要らない。**再生の進行(currentId)だけの
   *   変化では書かない** —— serializeQueue が currentId を含まないので、
   *   直列化した文字列の比較(lastSaved)が自然にそれを吸収する
   * - **復元が終わるまで保存は動かさない**。起動直後の空キューで先に書くと、
   *   前回の中身をその場で消してしまう
   */
  useEffect(() => {
    let disposed = false;
    let ready = false;
    let lastSaved: string | null = null;

    const unsubscribe = useLibrary.subscribe((s, prev) => {
      if (!ready || s.queue === prev.queue) return;
      const value = serializeQueue(s.queue);
      if (value === lastSaved) return;
      lastSaved = value;
      void api.setQueueState(value).catch(() => {});
    });

    void (async () => {
      try {
        const snap = parseSnapshot(await api.getQueueState());
        if (disposed || !snap || snap.videoIds.length === 0) return;
        // StrictMode の再マウントや HMR で、組み立て済みのキューを上書きしない
        if (useLibrary.getState().queue.items.length > 0) return;
        // 引き直しで消えた動画は落ちる(順序は渡した id 順のまま返る)
        const rows = await api.getVideosByIds(snap.videoIds);
        if (disposed || rows.length === 0) return;
        const s = useLibrary.getState();
        if (s.queue.items.length > 0) return;
        s.setQueue(restoredQueue(snap, rows));
      } catch {
        // 読めなくても「前回のキューが空で始まる」だけ。保存側は動かす
      } finally {
        // 復元直後の状態を「保存済み」とみなす(直後に同じ内容を書き戻さない)
        lastSaved = serializeQueue(useLibrary.getState().queue);
        ready = true;
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}
