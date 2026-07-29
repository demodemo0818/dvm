import type { ViewEntry } from '../types';
import { fmtTime } from './format';

/**
 * 視聴履歴の表示用の純関数(v1.18)。
 *
 * 日付ごとのまとめは **Rust 側ではなくここでやる**。区切りの入れ方も「今日 / 昨日」の
 * 出し方も表示の都合でしかないので、SQL に持ち込まずテストできる場所に置く
 * (メディア情報を「Rust は生値、日本語化は TypeScript」に分けたのと同じ作法)。
 */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export interface ViewGroup {
  /** 'YYYY-MM-DD'。React の key に使う */
  date: string;
  /** 見出し。「今日」「昨日」「7月20日 (月)」 */
  label: string;
  entries: ViewEntry[];
}

/** 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD'。想定外の形式はそのまま返す(行を落とさない) */
export function dateOf(viewedAt: string): string {
  return viewedAt.slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' → 'HH:MM'。秒は要らない */
export function timeOf(viewedAt: string): string {
  return viewedAt.slice(11, 16);
}

/** 'YYYY-MM-DD' の差を日数で返す。パースできなければ null */
function daysBetween(a: string, b: string): number | null {
  const parse = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    // UTC で作る。ローカルタイムゾーンだと夏時間の日に 1 日ずれる
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  return Math.round((y - x) / 86_400_000);
}

/**
 * 日付の見出し。`today` は呼び出し側から渡す —— 純関数に現在時刻を持ち込まないため
 * (テストで「昨日」を作れるようにする)
 */
export function dateLabel(date: string, today: string): string {
  const diff = daysBetween(date, today);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const w = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${mo}月${d}日 (${w})`;
}

/**
 * 新しい順に並んだ行を日付でまとめる。
 * **並べ替えはしない** —— Rust が返した順序をそのまま保つ(ページングと矛盾させないため)
 */
export function groupByDate(entries: ViewEntry[], today: string): ViewGroup[] {
  const groups: ViewGroup[] = [];
  for (const e of entries) {
    const date = dateOf(e.viewedAt);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.entries.push(e);
    else groups.push({ date, label: dateLabel(date, today), entries: [e] });
  }
  return groups;
}

/**
 * 「どこまで観たか」の表示。watchedMs が null なのは外部プレイヤーか異常終了で、
 * **観ていないという意味ではない**ので 0 とは書き分ける
 */
export function progressLabel(entry: ViewEntry): string {
  const total = entry.durationMs != null && entry.durationMs > 0 ? fmtTime(entry.durationMs / 1000) : null;
  if (entry.watchedMs == null) return total ? `— / ${total}` : '—';
  const watched = fmtTime(entry.watchedMs / 1000);
  return total ? `${watched} / ${total}` : watched;
}

/** グリッドと同じ表示名の決め方(タイトルがあれば優先) */
export function displayName(entry: ViewEntry): string {
  return entry.title?.trim() || entry.filename;
}
