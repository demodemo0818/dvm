import type { SortKey, VideoRow } from '../types';
import { fmtTime } from './format';

/**
 * 詳細リスト表示の列定義(v1.16)。列に関する知識はすべてここに置き、
 * コンポーネントは受け取った定義を描くだけにする。
 *
 * ソート状態はグリッドと共有の 1 つ(store の `sort`)。列ヘッダはそれを
 * 書き換えるだけで、リスト専用の並び順は持たない
 */

export type ColumnKey =
  | 'thumb'
  | 'duration'
  | 'size'
  | 'resolution'
  | 'rating'
  | 'added'
  | 'views'
  | 'lastViewed'
  | 'ext'
  | 'videoCodec'
  | 'audioCodec'
  | 'folder'
  | 'fileModified'
  | 'fileCreated'
  | 'fps'
  | 'bitrate';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** px。名前列だけは可変なのでここには出てこない */
  width: number;
  align: 'left' | 'right';
  sort: { asc: SortKey; desc: SortKey };
  /**
   * ヘッダを最初に押したときの向き。
   * 追加日を古い順から見たい場面はまず無いので、日付・数量系は降順から始める
   */
  first: 'asc' | 'desc';
  /**
   * セルに出す文字列。値が無ければ null(呼び出し側が '—' にする)。
   * thumb だけは画像なのでこれを使わず、コンポーネントが特別扱いする
   */
  text: (v: VideoRow) => string | null;
}

/**
 * lib/format.ts の fmtSize とはわざと別実装。
 * サイズ列が狭いので KB を出さず、MB も小数を落として桁を短く保つ
 */
function fmtListSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${(bytes / MB).toFixed(0)} MB`;
}

/** "2026-07-27 11:52:06" → "2026-07-27"。列が狭いので時刻は落とす */
function dateOnly(v: string | null): string | null {
  return v ? v.slice(0, 10) : null;
}

/** ファイル名から拡張子を取り出す(ドットなし小文字)。Rust の ext_expr() と同じ規則 */
export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return filename.slice(dot + 1).toLowerCase() || null;
}

/** パスから親フォルダ名だけを取り出す(フルパスは列に収まらない) */
export function folderOf(path: string): string | null {
  const parts = path.replace(/\//g, '\\').split('\\').filter(Boolean);
  // 末尾はファイル名なので 1 つ手前
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

export const COLUMNS: Record<ColumnKey, ColumnDef> = {
  thumb: {
    key: 'thumb', label: 'サムネイル', width: 64, align: 'left',
    sort: { asc: 'name_asc', desc: 'name_desc' }, first: 'asc',
    text: () => null,
  },
  duration: {
    key: 'duration', label: '長さ', width: 60, align: 'right',
    sort: { asc: 'duration_asc', desc: 'duration_desc' }, first: 'desc',
    text: (v) => (v.durationMs != null ? fmtTime(v.durationMs / 1000) : null),
  },
  size: {
    key: 'size', label: 'サイズ', width: 70, align: 'right',
    sort: { asc: 'size_asc', desc: 'size_desc' }, first: 'desc',
    text: (v) => fmtListSize(v.size),
  },
  resolution: {
    key: 'resolution', label: '解像度', width: 84, align: 'right',
    sort: { asc: 'res_asc', desc: 'res_desc' }, first: 'desc',
    text: (v) => (v.width && v.height ? `${v.width}×${v.height}` : null),
  },
  rating: {
    key: 'rating', label: '評価', width: 70, align: 'left',
    sort: { asc: 'rating_asc', desc: 'rating_desc' }, first: 'desc',
    // 0 は空欄。'☆☆☆☆☆' を並べると列がうるさくなる
    text: (v) => (v.rating > 0 ? '★'.repeat(v.rating) : ''),
  },
  added: {
    key: 'added', label: '追加日', width: 82, align: 'right',
    sort: { asc: 'added_asc', desc: 'added_desc' }, first: 'desc',
    text: (v) => dateOnly(v.addedAt),
  },
  views: {
    key: 'views', label: '視聴', width: 44, align: 'right',
    sort: { asc: 'views_asc', desc: 'views_desc' }, first: 'desc',
    text: (v) => String(v.viewCount),
  },
  lastViewed: {
    key: 'lastViewed', label: '最終視聴', width: 82, align: 'right',
    sort: { asc: 'viewed_asc', desc: 'viewed_desc' }, first: 'desc',
    text: (v) => dateOnly(v.lastViewedAt),
  },
  ext: {
    key: 'ext', label: '拡張子', width: 56, align: 'left',
    sort: { asc: 'ext_asc', desc: 'ext_desc' }, first: 'asc',
    text: (v) => extensionOf(v.filename),
  },
  videoCodec: {
    key: 'videoCodec', label: '映像', width: 64, align: 'left',
    sort: { asc: 'codec_asc', desc: 'codec_desc' }, first: 'asc',
    text: (v) => v.videoCodec,
  },
  audioCodec: {
    key: 'audioCodec', label: '音声', width: 64, align: 'left',
    sort: { asc: 'acodec_asc', desc: 'acodec_desc' }, first: 'asc',
    text: (v) => v.audioCodec,
  },
  folder: {
    key: 'folder', label: 'フォルダ', width: 120, align: 'left',
    sort: { asc: 'folder_asc', desc: 'folder_desc' }, first: 'asc',
    text: (v) => folderOf(v.path),
  },
  fileModified: {
    key: 'fileModified', label: 'ファイル更新日', width: 96, align: 'right',
    sort: { asc: 'fmodified_asc', desc: 'fmodified_desc' }, first: 'desc',
    text: (v) => dateOnly(v.fileModifiedAt),
  },
  fileCreated: {
    key: 'fileCreated', label: 'ファイル作成日', width: 96, align: 'right',
    sort: { asc: 'fcreated_asc', desc: 'fcreated_desc' }, first: 'desc',
    text: (v) => dateOnly(v.fileCreatedAt),
  },
  fps: {
    key: 'fps', label: 'fps', width: 52, align: 'right',
    sort: { asc: 'fps_asc', desc: 'fps_desc' }, first: 'desc',
    // 29.97 は小数が要るが 30.00 と出したくないので、整数なら小数を落とす
    text: (v) =>
      v.fps == null ? null : Number.isInteger(v.fps) ? String(v.fps) : v.fps.toFixed(2),
  },
  bitrate: {
    key: 'bitrate', label: 'ビットレート', width: 84, align: 'right',
    sort: { asc: 'bitrate_asc', desc: 'bitrate_desc' }, first: 'desc',
    text: (v) =>
      v.bitrate == null
        ? null
        : v.bitrate >= 1_000_000
          ? `${(v.bitrate / 1_000_000).toFixed(2)} Mbps`
          : `${Math.round(v.bitrate / 1000)} kbps`,
  },
};

/** ポップオーバーに並べる順(チェックを付けたとき既定でこの位置に入る) */
export const COLUMN_ORDER: ColumnKey[] = [
  'thumb', 'duration', 'size', 'resolution', 'rating', 'ext',
  'videoCodec', 'audioCodec', 'fps', 'bitrate', 'folder',
  'views', 'lastViewed', 'added', 'fileModified', 'fileCreated',
];

/** 既定の列構成。v1.15 までのリスト表示と同じ見た目になる */
export const DEFAULT_COLUMNS: ColumnKey[] = [
  'thumb', 'duration', 'size', 'resolution', 'rating', 'added',
];

/**
 * 設定 `list_columns` の JSON を読む。settings 初の JSON なので、
 * 壊れていても必ず既定に落として起動できるようにする
 * (未知のキーは黙って捨てる。旧バージョンで保存した構成をそのまま読めるようにするため)
 */
export function parseColumns(json: string | null): ColumnKey[] {
  if (!json) return DEFAULT_COLUMNS;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return DEFAULT_COLUMNS;
  }
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS;
  const seen = new Set<string>();
  const cols = raw.filter(
    (k): k is ColumnKey =>
      typeof k === 'string' && k in COLUMNS && !seen.has(k) && !!seen.add(k),
  );
  // 名前列は固定なので、それ以外が全部消えた構成は「壊れている」とみなす
  return cols.length > 0 ? normalize(cols) : DEFAULT_COLUMNS;
}

/**
 * サムネイルは必ず先頭に寄せる。エクスプローラーと同じく
 * 「アイコン → 名前 → 残り」の並びを崩さないため(並べ替えの対象外)
 */
function normalize(cols: ColumnKey[]): ColumnKey[] {
  const { thumb, rest } = layout(cols);
  return thumb ? ['thumb', ...rest] : rest;
}

/**
 * 描画順の分解。サムネイルは常に先頭、名前はその次。
 * 名前は固定列なので `cols` には含まれない
 */
export function layout(cols: ColumnKey[]): { thumb: boolean; rest: ColumnKey[] } {
  return { thumb: cols.includes('thumb'), rest: cols.filter((k) => k !== 'thumb') };
}

/**
 * 末尾に空けておく幅(px)。ヘッダの列選択ボタンがここに収まる。
 * 行側はこのトラックを埋めないので、最後の列とスクロールバーの間の余白にもなる
 */
export const GUTTER_W = 22;

/**
 * 名前列がこれ以上は縮まない幅(px)。
 * 0 まで縮ませると、列を増やしたときに名前が消えて行を識別できなくなる。
 * ここを下回るときは横スクロールに逃がす(最大化した窓なら全列出しても届かない)
 */
export const NAME_MIN_W = 160;

/**
 * grid-template-columns の値。名前列だけが伸縮する。
 * ヘッダ行・動画行・フォルダ行がこれを共有するので列がずれない
 */
export function gridTemplate(cols: ColumnKey[]): string {
  return trackWidths(cols)
    .map((w, i) => (i === nameTrackIndex(cols) ? `minmax(${w}px, 1fr)` : `${w}px`))
    .join(' ');
}

/** 名前列は「サムネイルがあればその次」に入る */
function nameTrackIndex(cols: ColumnKey[]): number {
  return layout(cols).thumb ? 1 : 0;
}

function trackWidths(cols: ColumnKey[]): number[] {
  const { thumb, rest } = layout(cols);
  return [
    ...(thumb ? [COLUMNS.thumb.width] : []),
    NAME_MIN_W,
    ...rest.map((k) => COLUMNS[k].width),
    GUTTER_W,
  ];
}

/** 列と列の隙間、および行の左右の余白(App.css の .list-row と合わせる) */
const GAP_W = 10;
const ROW_PADDING_W = 16;

/**
 * 名前列が下限まで縮んだときの行の幅(px)。
 *
 * 可視幅がこれを下回ると横スクロールになる。**行の幅は max-content で決めてはいけない** —
 * ファイル名の長さで行ごとに幅が変わり、スクロールしたとき列が揃わなくなる
 */
export function totalWidth(cols: ColumnKey[]): number {
  const tracks = trackWidths(cols);
  return tracks.reduce((a, b) => a + b, 0) + GAP_W * (tracks.length - 1) + ROW_PADDING_W;
}

/** ヘッダを押したときの遷移。同じ列なら反転、別の列ならその列の既定の向き */
export function nextSort(col: ColumnDef, current: SortKey): SortKey {
  if (current === col.sort.asc) return col.sort.desc;
  if (current === col.sort.desc) return col.sort.asc;
  return col.sort[col.first];
}

/** 今の並び順がこの列によるものなら向きを返す。違う列なら null(矢印を出さない) */
export function sortDirOf(col: ColumnDef, current: SortKey): 'asc' | 'desc' | null {
  if (current === col.sort.asc) return 'asc';
  if (current === col.sort.desc) return 'desc';
  return null;
}

/**
 * ツールバーの select に常に並べる並び順。
 * ここに無いキーは列ヘッダからしか選べないが、選ばれている間だけ option を注入する
 */
export const CURATED_SORTS: SortKey[] = [
  'added_desc', 'added_asc', 'name_asc', 'name_desc', 'size_desc', 'duration_desc',
  'rating_desc', 'viewed_desc', 'views_desc', 'random',
];

const SORT_LABELS: Record<SortKey, string> = {
  added_desc: '追加日時(新しい順)',
  added_asc: '追加日時(古い順)',
  name_asc: '名前(昇順)',
  name_desc: '名前(降順)',
  size_asc: 'サイズ(小さい順)',
  size_desc: 'サイズ(大きい順)',
  duration_asc: '長さ(短い順)',
  duration_desc: '長さ(長い順)',
  rating_asc: 'レーティング(低い順)',
  rating_desc: 'レーティング順',
  viewed_asc: '最終視聴(古い順)',
  viewed_desc: '最近見た順',
  views_asc: '視聴回数(少ない順)',
  views_desc: 'よく見た順',
  res_asc: '解像度(低い順)',
  res_desc: '解像度(高い順)',
  ext_asc: '拡張子(昇順)',
  ext_desc: '拡張子(降順)',
  codec_asc: '映像コーデック(昇順)',
  codec_desc: '映像コーデック(降順)',
  acodec_asc: '音声コーデック(昇順)',
  acodec_desc: '音声コーデック(降順)',
  folder_asc: 'フォルダ(昇順)',
  folder_desc: 'フォルダ(降順)',
  fmodified_asc: 'ファイル更新日(古い順)',
  fmodified_desc: 'ファイル更新日(新しい順)',
  fcreated_asc: 'ファイル作成日(古い順)',
  fcreated_desc: 'ファイル作成日(新しい順)',
  fps_asc: 'fps(低い順)',
  fps_desc: 'fps(高い順)',
  bitrate_asc: 'ビットレート(低い順)',
  bitrate_desc: 'ビットレート(高い順)',
  series_asc: 'シリーズ順',
  dup: '重複をまとめる',
  random: 'ランダム',
};

export function sortLabel(key: SortKey): string {
  return SORT_LABELS[key];
}

/**
 * 並び順の選択肢。ツールバーの select と、グリッド余白の右クリックメニュー(v1.20)で共有する。
 *
 * シリーズ順・重複順はその絞り込みが効いている間だけ意味を持つので、そのときだけ足す。
 * CURATED_SORTS に無いキー(列ヘッダから選んだもの)は、選ばれている間だけ末尾に足す —
 * 足さないと select / メニューが現在値を表現できず、開いた瞬間に別の並びへ飛ぶ
 */
export function sortOptions(
  s: { sort: SortKey; seriesId: number | null; duplicatesOnly: boolean },
): SortKey[] {
  const keys = [...CURATED_SORTS];
  if (s.seriesId !== null) keys.push('series_asc');
  if (s.duplicatesOnly) keys.push('dup');
  if (!keys.includes(s.sort)) keys.push(s.sort);
  return keys;
}
