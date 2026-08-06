import type { ViewEntry, ViewStats } from '../types';
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

/**
 * 視聴履歴の期間プリセット(v1.36)。
 *
 * **「今週」は入れていない** —— 週の始まりが月曜か日曜かで結果が変わり、
 * どちらを選んでも半分の人には合わない。詳細検索の相対日数(v1.35)と同じ
 * 「過去 N 日」に揃えれば、誰が読んでも同じ意味になる
 */
export type ViewPeriod = 'all' | 'today' | 'last7' | 'thisMonth' | 'custom';

export const PERIOD_LABELS: Record<ViewPeriod, string> = {
  all: 'すべて',
  today: '今日',
  last7: '過去 7 日',
  thisMonth: '今月',
  custom: '期間を指定',
};

/** Rust に渡す期間。空文字は「指定なし」(core/history.rs の ViewRange と対) */
export interface ViewRange {
  after: string;
  before: string;
}

/** 'YYYY-MM-DD' に N 日足す(負でもよい)。UTC で計算して夏時間のずれを避ける */
function addDays(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * プリセット → 期間。`today`('YYYY-MM-DD')は呼び出し側から渡す ——
 * 純関数に現在時刻を持ち込まないため(`dateLabel` と同じ作法)。
 * `custom` は呼び出し側が持っている入力値をそのまま使うので、ここでは何も決めない
 */
export function periodRange(period: ViewPeriod, today: string): ViewRange {
  switch (period) {
    case 'today':
      return { after: today, before: today };
    // 「過去 7 日」は今日を含めて 7 日ぶん(6 日前 〜 今日)
    case 'last7':
      return { after: addDays(today, -6), before: today };
    case 'thisMonth':
      return { after: `${today.slice(0, 7)}-01`, before: today };
    default:
      return { after: '', before: '' };
  }
}

/**
 * 期間の集計の 1 行。合計時間は**到達位置の合計**であって実視聴時間ではない
 * (シークで飛ばすと実態より大きく出る)。不明な行があればその件数も断る
 */
export function statsLabel(s: ViewStats): string {
  if (s.count === 0) return 'この期間の記録はありません';
  const hours = s.watchedMs / 3_600_000;
  // 1 時間未満は分で出す(「0.2 時間」より「12 分」のほうが読める)
  const time = hours >= 1
    ? `${hours.toFixed(1)} 時間`
    : `${Math.round(s.watchedMs / 60_000)} 分`;
  const base = `${s.count.toLocaleString()} 回 / ${s.videoCount.toLocaleString()} 本 ・ 合計 ${time}`;
  return s.unknownCount > 0 ? `${base}(うち ${s.unknownCount} 回は位置不明)` : base;
}
