import type { QueueState, VideoRow } from '../types';

/**
 * 再生キューの純関数(v1.40)。**判断はすべてここに置き、store は結果を入れるだけ**にする。
 * 「再生中のものを消した」「並べ替えた」「上限に当たった」の 3 つはどれも
 * 目で確かめきれないので、テストできる場所に閉じ込める(lib/chapters.ts と同じ作法)。
 */

/**
 * キューに入る上限。
 *
 * `Ctrl+A` で全選択して追加できる以上、無防備にするとパフォーマンス原則 4
 * (フロントに全件データを一括で渡さない)に正面から反する。500 本は 1 本 5 分でも
 * 40 時間ぶんで、手で選んで並べる対象としては十分に過剰。
 * **パネルを仮想化しない根拠でもある**(仮想化 + 自前 D&D は掴んだ行が DOM から
 * 消える問題を自分で作り込むことになる)
 */
export const QUEUE_LIMIT = 500;

export const EMPTY_QUEUE: QueueState = {
  items: [],
  currentId: null,
  orphanIndex: null,
  sourceId: null,
  sourceName: '',
  dirty: false,
};

/** 追加位置。末尾か、いま再生している次か */
export type AddMode = 'end' | 'next';

export interface AddResult {
  queue: QueueState;
  /** 実際に増えた件数(すでに入っていたものは数えない) */
  added: number;
  /** 上限に当たって 1 件も入れなかった */
  overflow: boolean;
}

/**
 * キューに足す。**すでに入っているものは無視する(冪等)** ——
 * 「選択して追加」を 2 回押してもキューが倍にならない。
 *
 * 上限を超えるときは**部分的に入れず全部断る**。中途半端に入ると
 * 何が入って何が入らなかったのか画面から読み取れない
 */
export function addToQueue(q: QueueState, videos: VideoRow[], mode: AddMode = 'end'): AddResult {
  const have = new Set(q.items.map((v) => v.id));
  // 渡された配列の中の重複もここで潰す(複数選択に同じ行が混ざることはないが、
  // 呼び出し側の都合に依存しないでおく)
  const fresh: VideoRow[] = [];
  const seen = new Set<number>();
  for (const v of videos) {
    if (have.has(v.id) || seen.has(v.id)) continue;
    seen.add(v.id);
    fresh.push(v);
  }
  if (fresh.length === 0) return { queue: q, added: 0, overflow: false };
  if (q.items.length + fresh.length > QUEUE_LIMIT) {
    return { queue: q, added: 0, overflow: true };
  }

  let items: VideoRow[];
  if (mode === 'next' && q.currentId != null) {
    const at = q.items.findIndex((v) => v.id === q.currentId);
    // 再生中のものがキューから外れているときは、外した位置に挿す
    const insert = at >= 0 ? at + 1 : (q.orphanIndex ?? q.items.length);
    items = [...q.items.slice(0, insert), ...fresh, ...q.items.slice(insert)];
  } else {
    items = [...q.items, ...fresh];
  }
  return { queue: { ...q, items, dirty: true }, added: fresh.length, overflow: false };
}

/**
 * キューから 1 件外す。
 *
 * **再生中のものを外しても再生は止めない**(「このリストからは外す」と
 * 「今観るのをやめる」は別の意思)。代わりに外した位置を `orphanIndex` に覚えて、
 * 次へ進んだときにそこの要素が来るようにする
 */
export function removeFromQueue(q: QueueState, videoId: number): QueueState {
  const at = q.items.findIndex((v) => v.id === videoId);
  if (at < 0) return q;
  const items = q.items.filter((v) => v.id !== videoId);
  const orphanIndex = q.currentId === videoId ? at : shiftOrphan(q.orphanIndex, at);
  return { ...q, items, orphanIndex, dirty: true };
}

/** 自分より前が消えたら、覚えている位置も 1 つ前へ詰める */
function shiftOrphan(orphan: number | null, removedAt: number): number | null {
  if (orphan === null) return null;
  return removedAt < orphan ? orphan - 1 : orphan;
}

/**
 * ドラッグで並べ替える。`from` の要素を `to` の位置へ差し込む。
 *
 * **`currentId` は触らない** —— 現在位置を video_id で指しているので、
 * どこへ動かしても再生中のものは追随する(これが Q10 で重複を許さなかった見返り)
 */
export function moveInQueue(q: QueueState, from: number, to: number): QueueState {
  if (from === to || from < 0 || from >= q.items.length) return q;
  const clamped = Math.min(Math.max(to, 0), q.items.length - 1);
  if (from === clamped) return q;
  const items = [...q.items];
  const [moved] = items.splice(from, 1);
  items.splice(clamped, 0, moved);
  return { ...q, items, dirty: true };
}

export function clearQueue(q: QueueState): QueueState {
  if (q.items.length === 0) return q;
  // 中身が空になっても再生は続く。currentId はそのまま残す
  return { ...q, items: [], orphanIndex: null, dirty: true };
}

/**
 * `library:changed` で引き直した行で中身を差し替える(v1.40)。
 * 消えた動画は `rows` に入って来ないので、これで自然に落ちる。
 *
 * **`dirty` は変えない** —— ライブラリ側の都合で消えただけなのに
 * 「変更あり」が点くと、ユーザーが触っていないのに上書き保存を促すことになる
 */
export function syncQueue(q: QueueState, rows: VideoRow[]): QueueState {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = q.items.map((v) => byId.get(v.id)).filter((v): v is VideoRow => v !== undefined);
  if (items.length === q.items.length && items.every((v, i) => v === q.items[i])) return q;
  return { ...q, items };
}

/** 保存リストを読み込んだ直後の状態。ここが「複写」の実体 */
export function loadedQueue(items: VideoRow[], sourceId: number, sourceName: string): QueueState {
  return { items, currentId: null, orphanIndex: null, sourceId, sourceName, dirty: false };
}

/** 保存した直後。中身は変えず、出所と `dirty` だけ付け替える */
export function savedQueue(q: QueueState, sourceId: number, sourceName: string): QueueState {
  return { ...q, sourceId, sourceName, dirty: false };
}

/**
 * いま再生している位置(0 始まり)。キューに居なければ -1。
 * 表示の「3 / 12」とボタンの活性がここから決まる
 */
export function queueIndex(q: QueueState): number {
  if (q.currentId === null) return -1;
  return q.items.findIndex((v) => v.id === q.currentId);
}

/**
 * `delta` ぶん進んだ先の動画。端なら null。
 *
 * 再生中のものがキューから外れているとき(`orphanIndex`)は、
 * 「外した位置の 1 つ前に居る」とみなして数える —— 次へ進むと外した位置の要素が来る
 */
export function queueStep(q: QueueState, delta: 1 | -1): VideoRow | null {
  const at = queueIndex(q);
  /*
   * キューに居ないとき(外した直後 / まだキューで再生していない)は、
   * **行の上ではなく行と行の「あいだ」にいる**。だから前と後ろで解決が違う ——
   * 「次」は隙間のうしろ、「前」は隙間の手前。1 つの base に足し引きすると、
   * 外した直後の ⏮ が 1 つ飛び越してしまう
   */
  const next = at >= 0
    ? at + delta
    : delta > 0
      ? (q.orphanIndex ?? 0)
      : (q.orphanIndex ?? 0) - 1;
  if (next < 0 || next >= q.items.length) return null;
  return q.items[next];
}

/** キューモードで 1 件を再生し始めたときの状態(orphan は解消する) */
export function playingInQueue(q: QueueState, videoId: number): QueueState {
  return { ...q, currentId: videoId, orphanIndex: null };
}

/**
 * 終了時に「保存しますか?」を尋ねるか(v1.40)。
 *
 * **空のとき・保存済みと同じ内容のときは尋ねない**。開発中はキューが空なのが普通なので、
 * これで `stop.ps1`(× ボタンと同じ WM_CLOSE を送って終了を待つ)がほぼ止まらずに済む
 */
export function needsSavePrompt(q: QueueState): boolean {
  return q.items.length > 0 && q.dirty;
}
