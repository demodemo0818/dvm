import { GripVertical, ListVideo, Save, SaveAll, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../api';
import { fmtTime } from '../../lib/format';
import {
  clearQueue, moveInQueue, QUEUE_LIMIT, queueIndex, removeFromQueue, savedQueue,
} from '../../lib/queue';
import { useLibrary } from '../../store';
import type { VideoRow } from '../../types';

/**
 * ドラッグとみなすまでの移動量(px)。これ未満はクリック(= その位置から再生)。
 * **HTML5 の D&D は使えない**ので TagTree と同じくポインタイベントで自前実装する
 * (理由は DESIGN.md「タグのグループ移動は D&D」節)
 */
const DRAG_THRESHOLD = 4;

/**
 * 再生キューのパネル(v1.40)。
 *
 * **同じコンポーネントを 2 か所にマウントする** —— 右ペインのキュータブと、
 * プレイヤーのコントロールバーから開くポップオーバー。再生中は
 * `html.mpv-active .app { display: none }` で `.app` ごと消えるので、
 * 再生中も編集するには `.mpv-overlay` の内側にもいる必要がある
 * (字幕スタイルパネルと同じ制約)。
 *
 * **仮想化しない。** 上限 500 件(lib/queue.ts)がその根拠 —— 自前 D&D と仮想化を
 * 組み合わせると「掴んだ行がスクロールで DOM から消える」問題を自分で作り込むことになる。
 */
export function QueuePanel({ compact = false }: { compact?: boolean }) {
  const queue = useLibrary((s) => s.queue);
  const setQueue = useLibrary((s) => s.setQueue);
  const playFromQueue = useLibrary((s) => s.playFromQueue);
  const pushToast = useLibrary((s) => s.pushToast);
  const bumpVersion = useLibrary((s) => s.bumpVersion);

  /** 掴んだ瞬間の位置。ここから DRAG_THRESHOLD 動いて初めてドラッグになる */
  const dragStart = useRef<{ index: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ index: number; insertAt: number } | null>(null);
  // ドラッグで終わった pointerup の直後に click が来るので、再生を 1 回だけ抑える
  const suppressClick = useRef(false);

  const current = queueIndex(queue);

  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    dragStart.current = { index, x: e.clientX, y: e.clientY };
    // capture しておくと、行の外にカーソルが出ても move/up を取りこぼさない
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return;
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
    // capture 中は pointerenter が飛ばないので、座標からドロップ先を引く
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-queue-index]');
    let insertAt = dragging?.insertAt ?? start.index;
    if (el instanceof HTMLElement) {
      const idx = Number(el.dataset.queueIndex);
      const r = el.getBoundingClientRect();
      // 行の上半分なら手前、下半分なら次の位置に入る
      insertAt = e.clientY < r.top + r.height / 2 ? idx : idx + 1;
    }
    setDragging({ index: start.index, insertAt });
  };

  const onPointerUp = () => {
    const start = dragStart.current;
    const drop = dragging;
    dragStart.current = null;
    setDragging(null);
    if (!start || !drop) return; // 動かしていない = ただのクリック
    suppressClick.current = true;
    // click が来なかったときにフラグが残って次のクリックを食べないよう、必ず戻す
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    // 自分を配列から抜くぶん、後ろへ動かすときは挿入位置が 1 つ手前にずれる
    const to = drop.insertAt > start.index ? drop.insertAt - 1 : drop.insertAt;
    setQueue(moveInQueue(queue, start.index, to));
  };

  /**
   * ドラッグ中の右クリック・フォーカス喪失で掴んだ状態が宙に浮かないようにする。
   *
   * **`pointerleave` では呼ばないこと** —— `setPointerCapture` しているので
   * リストの外へ出ても `pointerup` は必ず届く。leave で落とすと、
   * 少しはみ出しただけで並べ替えが無かったことになる
   */
  const cancelDrag = () => {
    dragStart.current = null;
    setDragging(null);
  };

  const play = (v: VideoRow) => {
    if (suppressClick.current) return;
    if (v.isMissing || v.isOffline) {
      pushToast(`${v.filename} は見つかりません`, 'info');
      return;
    }
    playFromQueue(v);
  };

  /**
   * 名前を付けて保存。同名があれば**上書きするかを尋ねる**(弾かない) ——
   * 同じ名前を打つ人の意図はほぼ「そのリストを更新したい」なので、
   * 名前を考え直させるより上書きを確認するほうが早い
   */
  const saveAs = async () => {
    const name = window.prompt('プレイリストの名前', queue.sourceName || '')?.trim();
    if (!name) return;
    const ids = queue.items.map((v) => v.id);
    try {
      const existing = await api.findPlaylistByName(name);
      if (existing !== null) {
        const ok = window.confirm(`「${name}」はすでにあります。上書きしますか?`);
        if (!ok) return;
        await api.replacePlaylist(existing, ids);
        setQueue(savedQueue(queue, existing, name));
      } else {
        const id = await api.createPlaylist(name, ids);
        setQueue(savedQueue(queue, id, name));
      }
      pushToast(`「${name}」に保存しました`, 'info');
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  /** 出所のリストへ書き戻す。「変更あり」のときだけ押せる */
  const overwrite = async () => {
    if (queue.sourceId === null) return;
    try {
      await api.replacePlaylist(queue.sourceId, queue.items.map((v) => v.id));
      setQueue(savedQueue(queue, queue.sourceId, queue.sourceName));
      pushToast(`「${queue.sourceName}」を上書きしました`, 'info');
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  const empty = queue.items.length === 0;

  return (
    <div className={`queue-panel ${compact ? 'compact' : ''}`}>
      <div className="queue-head">
        <span className="queue-title">
          <ListVideo />
          {queue.sourceId !== null ? queue.sourceName : 'キュー'}
          {/* 「変更あり」はバナーやトーストではなく点 1 つで出す */}
          {queue.dirty && queue.sourceId !== null && <span className="queue-dot" title="変更あり">●</span>}
        </span>
        <span className="queue-count">{queue.items.length} / {QUEUE_LIMIT}</span>
      </div>

      <div className="queue-actions">
        <button onClick={saveAs} disabled={empty} title={empty ? 'キューが空です' : undefined}>
          <Save /> 名前を付けて保存
        </button>
        <button
          onClick={overwrite}
          disabled={queue.sourceId === null || !queue.dirty}
          title={
            queue.sourceId === null
              ? '保存リストから読み込んだキューではありません'
              : !queue.dirty
                ? '保存した内容から変わっていません'
                : undefined
          }
        >
          <SaveAll /> 上書き保存
        </button>
        <button
          onClick={() => setQueue(clearQueue(queue))}
          disabled={empty}
          title={empty ? 'キューが空です' : '再生中の動画はそのまま続きます'}
        >
          <Trash2 /> すべて外す
        </button>
      </div>

      {empty ? (
        <div className="queue-empty">
          一覧で動画を選んで右クリック →「キュー」から追加するか、<kbd>Q</kbd> を押してください。
        </div>
      ) : (
        <div className="queue-list">
          {queue.items.map((v, i) => (
            <div
              key={v.id}
              data-queue-index={i}
              className={[
                'queue-item',
                i === current ? 'current' : '',
                dragging?.index === i ? 'dragging' : '',
                v.isMissing || v.isOffline ? 'unavailable' : '',
                // 挿入位置の線。動かない位置(自分のすぐ前後)には出さない
                dragging && dragging.insertAt === i && dragging.index !== i && dragging.index !== i - 1
                  ? 'drop-before'
                  : '',
              ].join(' ')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={cancelDrag}
              onContextMenu={cancelDrag}
            >
              <span
                className="queue-grip"
                title="ドラッグで並べ替え"
                onPointerDown={(e) => onPointerDown(e, i)}
              >
                <GripVertical />
              </span>
              <button className="queue-name" onClick={() => play(v)} title={v.path}>
                <span className="queue-no">{i + 1}</span>
                <span className="queue-file">{v.title || v.filename}</span>
              </button>
              <span className="queue-dur">{v.durationMs ? fmtTime(v.durationMs / 1000) : ''}</span>
              <button
                className="queue-remove"
                title="キューから外す"
                onClick={() => setQueue(removeFromQueue(queue, v.id))}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
