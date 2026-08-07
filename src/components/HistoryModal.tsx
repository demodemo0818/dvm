import { convertFileSrc } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { thumbSrc } from '../lib/thumbs';
import {
  displayName, groupByDate, PERIOD_LABELS, periodRange, progressLabel, statsLabel, timeOf,
} from '../lib/viewHistory';
import type { ViewPeriod, ViewRange } from '../lib/viewHistory';
import { useShallow } from 'zustand/react/shallow';
import { pickState, useLibrary } from '../store';
import type { OpEntry, ViewEntry, ViewStats } from '../types';

const PAGE = 100;

/** 「履歴」は 2 種類ある(観た記録 / 操作の記録)。同じ箱のタブにして混同を防ぐ */
type Tab = 'views' | 'ops';

/** action を日本語の見出しにする(未知の action はそのまま出す) */
const ACTION_LABEL: Record<string, string> = {
  tag_videos: 'タグを付けた',
  untag_videos: 'タグを外した',
  add_to_series: 'シリーズに追加した',
  remove_from_series: 'シリーズから外した',
  set_rating: 'レーティングを変更した',
  set_video_info: 'タイトル・コメントを変更した',
  create_tag: 'タグを作成した',
  rename_tag: 'タグ名を変更した',
  delete_tag: 'タグを削除した',
  delete_series: 'シリーズを削除した',
  set_tag_color: 'タグの色を変更した',
  set_tag_group: 'タグのグループを変更した',
  create_tag_group: 'タググループを作成した',
  rename_tag_group: 'タググループ名を変更した',
  delete_tag_group: 'タググループを削除した',
  remove_videos: 'ライブラリから削除した',
  trash_file: 'ファイルをごみ箱へ送った',
  move_file: 'ファイルを移動した',
  rename_file: 'ファイル名を変更した',
  relink: 'パスを再リンクした',
  undo: '操作を取り消した',
  drive_remap: 'ドライブレターを再マップした',
  move_detected: '移動を検出した',
  backup_db: 'バックアップを作成した',
  request_restore: '復元を予約した',
  regenerate_thumbnails: 'サムネイルを再生成した',
  purge_orphan_thumbnails: '孤児サムネイルを掃除した',
  create_smart_folder: 'スマートフォルダを作成した',
  update_smart_folder: 'スマートフォルダを更新した',
  delete_smart_folder: 'スマートフォルダを削除した',
};

/** payload の JSON から一行の要約を作る。読めなければそのまま返す */
function summarize(entry: OpEntry): string {
  if (!entry.payload) return '';
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(entry.payload);
  } catch {
    return entry.payload; // v1.9 より前の自由文字列
  }
  const count = (key: string) => (Array.isArray(p[key]) ? (p[key] as unknown[]).length : 0);
  switch (entry.action) {
    case 'tag_videos':
      return `「${p.tag}」を ${count('added')} 件に`;
    case 'untag_videos':
      return `「${p.tag}」を ${count('removed')} 件から`;
    case 'add_to_series':
      return `「${p.series}」に ${count('added')} 件`;
    case 'remove_from_series':
      return `「${p.series}」から ${count('removed')} 件`;
    case 'set_rating':
      return `★${p.rating} を ${count('before')} 件に`;
    case 'rename_tag':
    case 'rename_tag_group':
      return `${p.before} → ${p.after}`;
    case 'create_tag':
    case 'delete_tag':
      return String(p.tag ?? '');
    case 'create_tag_group':
    case 'delete_tag_group':
      return String(p.group ?? '');
    case 'relink':
      return `${count('items')} 件のパス`;
    case 'move_file':
    case 'rename_file':
    case 'trash_file':
      return String(p.path ?? p.to ?? '');
    case 'remove_videos':
      return `${count('videos')} 件`;
    default:
      return entry.payload.length > 90 ? `${entry.payload.slice(0, 90)}…` : entry.payload;
  }
}

/**
 * 履歴モーダル。**「観た記録」と「操作の記録」を 1 つの箱のタブに収める**(v1.18)。
 * ツールバーのボタンを増やさずに済み、「履歴」という語が 2 つあることも
 * 見た瞬間に分かる(v1.9 は操作履歴だけだった)
 */
export function HistoryModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('views');

  /*
   * Escape で閉じる。**window ではなく document に張って stopPropagation する** ——
   * App.tsx の Escape(選択解除)は window にいるので、ここで止めれば届かない
   * (SettingsModal と同じ理由)。IME の変換中は「変換の取り消し」なので拾わない
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
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">履歴</div>
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${tab === 'views' ? 'active' : ''}`}
            onClick={() => setTab('views')}
            title="いつ何を観たかの記録"
          >
            視聴
          </button>
          <button
            className={`sidebar-tab ${tab === 'ops' ? 'active' : ''}`}
            onClick={() => setTab('ops')}
            title="タグ・レーティング・ファイル操作の記録(取り消せるものもあります)"
          >
            操作
          </button>
        </div>

        {tab === 'views' ? <ViewTab onClose={onClose} /> : <OpsTab />}

        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 視聴履歴(v1.18)。1 視聴 = 1 行なので同じ動画が何度も出る —— そこが要点なので畳まない。
 * 日付ごとのまとめと表示文言は lib/viewHistory.ts の純関数が決める
 */
function ViewTab({ onClose }: { onClose: () => void }) {
  const { setPlayingVideo, playerPath, pushToast, thumbVersion } = useLibrary(
    useShallow(pickState('setPlayingVideo', 'playerPath', 'pushToast', 'thumbVersion')),
  );
  const [entries, setEntries] = useState<ViewEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 最後のページが満杯だったか。総件数がちょうど PAGE の倍数でも空振りボタンを残さない */
  const [hasMore, setHasMore] = useState(false);
  /** 期間切り替えの古いレスポンスを捨てる世代カウンタ(Inspector の alive ガードと同じ発想) */
  const genRef = useRef(0);
  const [stats, setStats] = useState<ViewStats | null>(null);
  const [period, setPeriod] = useState<ViewPeriod>('all');
  /** 「期間を指定」で使う入力値。プリセットに戻しても消さない(往復しやすいように) */
  const [custom, setCustom] = useState<ViewRange>({ after: '', before: '' });
  // 「今日 / 昨日」と期間プリセットの基準。純関数に現在時刻を持ち込まないよう 1 回だけ求める
  const [today] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  const range = period === 'custom' ? custom : periodRange(period, today);

  /*
   * 期間が変わったら先頭から読み直す。**依存に range をそのまま置かない** ——
   * 毎レンダーで別オブジェクトになって無限に取り直す。中身の文字列を見る
   */
  const load = useCallback(async (off: number, r: ViewRange) => {
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const rows = await api.listViewHistory(r, PAGE, off);
      // 期間を速く切り替えたときの古い便。新しい load が走っているので何も触らない
      if (gen !== genRef.current) return;
      setEntries((cur) => (off === 0 ? rows : [...cur, ...rows]));
      setOffset(off + rows.length);
      setHasMore(rows.length === PAGE);
    } catch {
      // api 側でトースト済み
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const r = { after: range.after, before: range.before };
    void load(0, r);
    // 集計は一覧と同じ期間で別便に引く(行を全部読まずに数えるため)
    let alive = true;
    api.viewStats(r).then((s) => { if (alive) setStats(s); }).catch(() => {});
    return () => { alive = false; };
  }, [load, range.after, range.before]);

  /** 履歴からその動画を再生する。外部プレイヤー設定時は一覧と同じく外部起動 */
  const play = async (entry: ViewEntry) => {
    if (entry.isMissing) return;
    if (playerPath.trim() !== '') {
      void api.openVideo(entry.videoId);
      return;
    }
    try {
      const row = await api.getVideo(entry.videoId);
      if (!row) {
        pushToast('この動画はライブラリにありません');
        return;
      }
      onClose();
      // 履歴からの再生は単発。連続再生のキューは持たせない(何の続きか決められないため)
      setPlayingVideo(row);
    } catch {
      // api 側でトースト済み
    }
  };

  const groups = groupByDate(entries, today);

  return (
    <>
      <div className="settings-note">
        観るたびに 1 行ずつ記録します。同じ動画を何度も観ればその回数ぶん並びます
      </div>

      {/*
        期間の指定と、その期間の集計(v1.36)。期間を絞る動機は「どれだけ観たか」なので、
        数字が無いと半分しか答えられない。集計は一覧と同じ条件を Rust 側で共有している
      */}
      <div className="view-period">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as ViewPeriod)}
          title="集計と一覧の期間"
        >
          {(Object.keys(PERIOD_LABELS) as ViewPeriod[]).map((k) => (
            <option key={k} value={k}>{PERIOD_LABELS[k]}</option>
          ))}
        </select>
        {period === 'custom' && (
          <>
            <input
              type="date"
              value={custom.after}
              onChange={(e) => setCustom((c) => ({ ...c, after: e.target.value }))}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="date"
              value={custom.before}
              onChange={(e) => setCustom((c) => ({ ...c, before: e.target.value }))}
            />
          </>
        )}
        <span className="view-stats">{stats ? statsLabel(stats) : '集計中…'}</span>
      </div>

      <div className="history-list">
        {/* 期間を絞っているときは右上の集計が同じことを言うので、ここでは繰り返さない */}
        {entries.length === 0 && !loading && period === 'all' && !range.after && !range.before && (
          <div className="stats-empty">まだ記録がありません</div>
        )}
        {groups.map((g) => (
          <div key={g.date}>
            <div className="side-section">{g.label}</div>
            {g.entries.map((e) => (
              <div
                key={e.id}
                className={`history-row view-row ${e.isMissing ? 'missing' : ''}`}
                onDoubleClick={() => void play(e)}
                title={e.isMissing ? 'ファイルが見つかりません' : `${e.filename}(ダブルクリックで再生)`}
              >
                <span className="history-time">{timeOf(e.viewedAt)}</span>
                {e.thumbPath ? (
                  <img
                    className="view-thumb"
                    src={thumbSrc(convertFileSrc(e.thumbPath), thumbVersion)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onError={(ev) => {
                      ev.currentTarget.style.visibility = 'hidden';
                    }}
                    // 再生成に成功して読めるようになったら戻す(onError で隠しっぱなしにしない)
                    onLoad={(ev) => {
                      ev.currentTarget.style.visibility = '';
                    }}
                  />
                ) : (
                  <span className="view-thumb" />
                )}
                <span className="history-action view-name">{displayName(e)}</span>
                <span className="history-detail">{progressLabel(e)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {hasMore && (
        <div className="modal-actions">
          <button onClick={() => load(offset, range)} disabled={loading}>
            さらに読み込む
          </button>
        </div>
      )}
    </>
  );
}

/**
 * 操作履歴(v1.9)。operations_log を読んで表示し、可逆な操作だけ取り消せる。
 * ファイルを動かす操作は履歴には出すが取り消しは拒否する(理由を出す)
 */
function OpsTab() {
  const { bumpVersion, pushToast } = useLibrary(useShallow(pickState('bumpVersion', 'pushToast')));
  const [entries, setEntries] = useState<OpEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // ViewTab と同じ空振り対策。取り消し後の load(0) が古い便に負けないよう世代も見る
  const [hasMore, setHasMore] = useState(false);
  const genRef = useRef(0);

  const load = useCallback(
    async (off: number) => {
      const gen = ++genRef.current;
      setLoading(true);
      try {
        const rows = await api.listOperations(PAGE, off);
        if (gen !== genRef.current) return;
        setEntries((cur) => (off === 0 ? rows : [...cur, ...rows]));
        setOffset(off + rows.length);
        setHasMore(rows.length === PAGE);
      } catch {
        // api 側でトースト済み
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const undo = async (entry: OpEntry) => {
    try {
      const msg = await api.undoOperation(entry.id);
      pushToast(msg, 'info');
      bumpVersion();
      void load(0);
    } catch {
      // api 側でトースト済み
    }
  };

  return (
    <>
      <div className="settings-note">
        タグ・レーティング・シリーズ・再リンクは取り消せます。ファイルを動かした操作
        (ごみ箱送り・移動・リネーム)と登録削除は取り消せません
      </div>

      <div className="history-list">
        {entries.length === 0 && !loading && <div className="stats-empty">履歴がありません</div>}
        {entries.map((e) => (
          <div key={e.id} className={`history-row ${e.undoneAt ? 'undone' : ''}`}>
            <span className="history-time">{e.timestamp}</span>
            <span className={`history-actor ${e.actor}`}>{e.actor}</span>
            <span className="history-action">{ACTION_LABEL[e.action] ?? e.action}</span>
            <span className="history-detail" title={e.payload ?? ''}>{summarize(e)}</span>
            {e.undoable ? (
              <button className="history-undo" onClick={() => undo(e)}>
                取り消す
              </button>
            ) : (
              <span className="history-reason" title={e.reason ?? ''}>
                {e.undoneAt ? '取り消し済み' : ''}
              </span>
            )}
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="modal-actions">
          <button onClick={() => load(offset)} disabled={loading}>
            さらに読み込む
          </button>
        </div>
      )}
    </>
  );
}
