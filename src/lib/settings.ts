/*
 * 設定値(app.db の settings 表)を読み書きするときの純関数(v1.38)。
 *
 * settings の値はすべて TEXT なので、キーごとの判断は「**未設定(null)をどの既定値に
 * 落とすか**」と「壊れた値をどう丸めるか」に集約される。設定モーダルをカテゴリごとの
 * ファイルに割ったあとも既定値がバラけないよう、ここに集めてテストしておく。
 */

/**
 * '1' / '0' で持つ真偽の設定。未設定(null)は `def` を返す。
 *
 * 既存のコードは既定 ON を `v !== '0'`、既定 OFF を `v === '1'` と書き分けていたが、
 * どちらも「未設定なら既定・'0' なら false・それ以外は true」と同じ意味になる
 */
export function parseFlag(raw: string | null, def: boolean): boolean {
  if (raw == null) return def;
  return raw !== '0';
}

export function serializeFlag(v: boolean): string {
  return v ? '1' : '0';
}

/** 再生用の変換キャッシュの上限(GB) */
export const CACHE_GB_DEFAULT = 20;
export const CACHE_GB_MIN = 1;
export const CACHE_GB_MAX = 1000;

/**
 * 変換キャッシュの上限 GB(v1.38)。
 *
 * **0 を通してはいけない** —— `core/playback.rs` の `purge_cache` は parse に成功した
 * 値をそのまま上限に使うので、0 だと変換のたびにキャッシュが全消しになる。
 * 空欄・壊れた値は既定に落とし、範囲外は上下限に丸める(入力欄の min/max だけに
 * 頼らない —— 手で DB を書いた値もここを通る)
 */
export function parseCacheGb(raw: string | null): number {
  if (raw == null || raw.trim() === '') return CACHE_GB_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CACHE_GB_DEFAULT;
  return Math.min(Math.max(Math.round(n), CACHE_GB_MIN), CACHE_GB_MAX);
}

/*
 * サイドバー(ライブラリタブ)の折りたたみ(v1.42)。
 *
 * **`tag_groups` の折りたたみ(localStorage)とは持ち方が違う**。あちらは中身が
 * ライブラリごとに別物の id なのでライブラリ単位に分けているが、こちらのキーは
 * ライブラリに依存しない固定文字列なので `sidebar_tab` / `sidebar_collapsed` と
 * 同じく app.db の settings に置く
 */
export const SECTION_KEYS = ['smart', 'playlist', 'watched', 'series', 'tag'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * 畳んでいるセクション。**未設定・壊れた値はすべて「全部開く」に落とす** ——
 * 読めない値のせいで項目が消えたように見えるより、余分に開いているほうが害が無い。
 * 知らないキー(将来消したセクションの残り)は捨てる
 */
export function parseCollapsedSections(raw: string | null): Set<SectionKey> {
  const known = new Set<string>(SECTION_KEYS);
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is SectionKey => known.has(s)),
  );
}

/** 並びは SECTION_KEYS の順に揃える(集合の反復順で値が揺れないようにする) */
export function serializeCollapsedSections(keys: Set<SectionKey>): string {
  return SECTION_KEYS.filter((k) => keys.has(k)).join(',');
}

/** 設定モーダルの大きさ(v1.38) */
export type ModalSize = { w: number; h: number };

export const SETTINGS_SIZE_KEY = 'settings_modal_size';
/** 既定。7 カテゴリ中 6 つがスクロールせずに収まる大きさ */
export const SETTINGS_SIZE_DEFAULT: ModalSize = { w: 780, h: 720 };
/** 下限は左レール(168px)+ 右ペインが読める幅と、見出し + 数行が出る高さ */
export const SETTINGS_SIZE_MIN: ModalSize = { w: 560, h: 360 };
export const SETTINGS_SIZE_MAX: ModalSize = { w: 1600, h: 1400 };

export function clampModalSize({ w, h }: ModalSize): ModalSize {
  return {
    w: Math.min(Math.max(Math.round(w), SETTINGS_SIZE_MIN.w), SETTINGS_SIZE_MAX.w),
    h: Math.min(Math.max(Math.round(h), SETTINGS_SIZE_MIN.h), SETTINGS_SIZE_MAX.h),
  };
}

/**
 * `"780x720"` 形式で持つ(幅と高さで設定キーを 2 本にしない)。
 * 壊れた値・未設定は既定に落とし、範囲外は上下限に丸める —— 手で DB を書いた値や、
 * 前に大きな画面で広げたまま小さな画面で開いた場合もここを通る
 */
export function parseModalSize(raw: string | null): ModalSize {
  const m = /^(\d+)x(\d+)$/.exec((raw ?? '').trim());
  if (!m) return SETTINGS_SIZE_DEFAULT;
  return clampModalSize({ w: Number(m[1]), h: Number(m[2]) });
}

export function serializeModalSize({ w, h }: ModalSize): string {
  return `${Math.round(w)}x${Math.round(h)}`;
}
