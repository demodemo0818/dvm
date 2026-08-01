/**
 * 字幕の見た目(v1.24、mpv のみ)。
 *
 * 字幕に関する知識はすべてここに置き、UI は `SUB_STYLE_FIELDS` を描くだけにする
 * (listColumns.ts の COLUMNS と ColumnPicker の関係と同じ)。
 *
 * 値は mpv の `sub-*` プロパティに 1 対 1 で対応する。これらは loadfile を跨いで残る
 * グローバルプロパティなので、useMpvPlayer は「変わるたび押し込む」だけでよい。
 *
 * **mpv 側の失敗は握り潰される**(useMpvPlayer の run())。プロパティ名を 1 文字
 * 間違えても何も起きず UI だけ動いて見えるので、名前は subtitleStyle.test.ts で
 * リテラルとして固定してある。名前を変えるときは必ずテストも直すこと
 */

/** 設定 settings のキー(値は既定との差分だけを入れた JSON) */
export const SUB_STYLE_KEY = 'subtitle_style';

export interface SubStyle {
  // ---- すべての字幕に効く(ASS/SSA を含む) ----
  /** sub-scale。1 = 等倍 */
  scale: number;
  /** sub-pos。100 = 画面下端、小さいほど上へ */
  pos: number;

  // ---- 装飾を持たない字幕(SRT など)にだけ効く ----
  /** sub-font。空なら mpv の既定(sans-serif)に任せる */
  font: string;
  /** sub-font-size。高さ 720px のウィンドウを基準にした大きさ */
  fontSize: number;
  /** sub-bold */
  bold: boolean;
  /** sub-color の RGB 部分 */
  color: string;
  /** sub-color のアルファ(0〜1) */
  colorAlpha: number;
  /** sub-outline-color(縁取り)。sub-border-color は非推奨エイリアスなので使わない */
  outlineColor: string;
  outlineAlpha: number;
  /** sub-outline-size */
  outlineSize: number;
  /** sub-shadow-color */
  shadowColor: string;
  shadowAlpha: number;
  /** sub-shadow-offset。0 = 影なし */
  shadowOffset: number;
  /** sub-back-color(文字の後ろに敷く帯)。既定は不透明度 0 = 帯なし */
  backColor: string;
  backAlpha: number;

  // ---- ASS/SSA の扱い ----
  /**
   * sub-ass-override。false = `scale`(制作者のスタイルを尊重し、拡大率と縦位置だけ効く)、
   * true = `force`(色やフォントも上書きする)
   */
  assOverride: boolean;
}

export const DEFAULT_SUB_STYLE: SubStyle = {
  scale: 1,
  pos: 100,
  font: '',
  fontSize: 55,
  bold: false,
  color: '#FFFFFF',
  colorAlpha: 1,
  outlineColor: '#000000',
  outlineAlpha: 1,
  outlineSize: 3,
  shadowColor: '#000000',
  shadowAlpha: 1,
  shadowOffset: 0,
  backColor: '#000000',
  backAlpha: 0,
  assOverride: false,
};

export type SubStyleGroup = 'all' | 'plain' | 'ass';

type NumKey = 'scale' | 'pos' | 'fontSize' | 'outlineSize' | 'shadowOffset';
type BoolKey = 'bold' | 'assOverride';
type ColorKey = 'color' | 'outlineColor' | 'shadowColor' | 'backColor';
type AlphaKey = 'colorAlpha' | 'outlineAlpha' | 'shadowAlpha' | 'backAlpha';

export type SubStyleField =
  | { kind: 'font'; group: SubStyleGroup; key: 'font'; label: string; hint?: string }
  | { kind: 'check'; group: SubStyleGroup; key: BoolKey; label: string; hint?: string }
  | {
      kind: 'slider';
      group: SubStyleGroup;
      key: NumKey;
      label: string;
      min: number;
      max: number;
      step: number;
      /** つまみの右に出す表示。値そのものを出すと 0.05 刻みで桁が揺れる */
      format: (v: number) => string;
      hint?: string;
    }
  | {
      kind: 'color';
      group: SubStyleGroup;
      key: ColorKey;
      alphaKey: AlphaKey;
      label: string;
      hint?: string;
    };

/**
 * UI に並べる順と、それぞれの入力の性質。
 *
 * `scale` と `fontSize` は**効く対象が違う**ので group を分けてある。
 * 「大きさのスライダーが 2 本あってどっちを動かせばいいのか分からない」を避けるため、
 * 見出しの側で説明を切ること(SubtitleStyleEditor の GROUP_LABELS)
 */
export const SUB_STYLE_FIELDS: SubStyleField[] = [
  {
    kind: 'slider', group: 'all', key: 'scale', label: '拡大率',
    min: 0.5, max: 3, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    kind: 'slider', group: 'all', key: 'pos', label: '縦位置',
    min: 0, max: 150, step: 1, format: (v) => String(Math.round(v)),
    hint: '大きいほど下。100 が既定の位置',
  },
  {
    kind: 'font', group: 'plain', key: 'font', label: 'フォント',
    hint: '反映されないときは英語名(例: Meiryo)を入れてください',
  },
  {
    kind: 'slider', group: 'plain', key: 'fontSize', label: '文字サイズ',
    min: 20, max: 120, step: 1, format: (v) => String(Math.round(v)),
    hint: '高さ 720px の画面を基準にした大きさ。ウィンドウの大きさで見え方が変わります',
  },
  { kind: 'check', group: 'plain', key: 'bold', label: '太字にする' },
  { kind: 'color', group: 'plain', key: 'color', alphaKey: 'colorAlpha', label: '文字の色' },
  {
    kind: 'color', group: 'plain', key: 'outlineColor', alphaKey: 'outlineAlpha',
    label: '縁取りの色',
  },
  {
    kind: 'slider', group: 'plain', key: 'outlineSize', label: '縁取りの太さ',
    min: 0, max: 10, step: 0.5, format: (v) => v.toFixed(1),
  },
  {
    kind: 'color', group: 'plain', key: 'shadowColor', alphaKey: 'shadowAlpha',
    label: '影の色',
  },
  {
    kind: 'slider', group: 'plain', key: 'shadowOffset', label: '影の距離',
    min: 0, max: 10, step: 0.5, format: (v) => v.toFixed(1),
    hint: '0 で影なし',
  },
  {
    kind: 'color', group: 'plain', key: 'backColor', alphaKey: 'backAlpha',
    label: '背景の帯',
    hint: '不透明度を上げると文字の後ろに帯が敷かれます(明るい映像で読みやすくなります)',
  },
  {
    kind: 'check', group: 'ass', key: 'assOverride',
    label: 'ASS/SSA 字幕にもこの見た目を適用する',
    hint: 'アニメなどで制作者が付けた色・位置・タイミング演出は失われます',
  },
];

/** そのフィールドが担当する SubStyle のキー(色は不透明度とセットで 1 行) */
export function fieldKeys(f: SubStyleField): (keyof SubStyle)[] {
  return f.kind === 'color' ? [f.key, f.alphaKey] : [f.key];
}

/** カラーピッカーを開かずに済ませるための定番色(スウォッチ) */
export const SUB_COLOR_PRESETS = ['#FFFFFF', '#000000', '#FFFF00', '#00FFFF', '#FF8080'];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** '#rrggbb' を大文字に正規化する。読めない値は fallback に落とす */
function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

/**
 * 色 + 不透明度 → mpv の色表記 `#AARRGGBB`(**FF = 不透明、00 = 透明**)。
 *
 * <input type="color"> が返すのは #rrggbb だけなので、不透明度は別のスライダーで持ち、
 * mpv へ渡す直前にここで合成する。アルファの向きの前提はこの 1 関数に閉じている
 */
export function toMpvColor(hex: string, alpha: number): string {
  const rgb = normalizeHex(hex, '#000000').slice(1);
  const a = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `#${a}${rgb}`;
}

/** toMpvColor の逆。アルファ無し(#RRGGBB)は不透明として読む */
export function splitMpvColor(value: string): { hex: string; alpha: number } {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value ?? '').trim());
  if (!m) return { hex: '#000000', alpha: 1 };
  const body = m[1].toUpperCase();
  if (body.length === 6) return { hex: `#${body}`, alpha: 1 };
  return { hex: `#${body.slice(2)}`, alpha: parseInt(body.slice(0, 2), 16) / 255 };
}

/** スライダーの値域(parse 側の clamp と UI の min/max を 1 か所から引く) */
const NUM_RANGE = Object.fromEntries(
  SUB_STYLE_FIELDS.filter((f) => f.kind === 'slider').map((f) => [f.key, f]),
) as Record<NumKey, Extract<SubStyleField, { kind: 'slider' }>>;

function num(value: unknown, key: NumKey): number {
  const r = NUM_RANGE[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, r.min, r.max)
    : DEFAULT_SUB_STYLE[key];
}

function alpha(value: unknown, key: AlphaKey): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : DEFAULT_SUB_STYLE[key];
}

function bool(value: unknown, key: BoolKey): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_SUB_STYLE[key];
}

/**
 * 設定 `subtitle_style` の JSON を読む。
 * **壊れていても必ず既定に落として起動できること**(parseColumns と同じ作法)。
 * 未知のキーは黙って捨て、範囲外の数値はスライダーの値域へ丸める
 */
export function parseSubStyle(json: string | null | undefined): SubStyle {
  if (!json) return { ...DEFAULT_SUB_STYLE };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ...DEFAULT_SUB_STYLE };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_SUB_STYLE };
  }
  const r = raw as Record<string, unknown>;
  return {
    scale: num(r.scale, 'scale'),
    pos: num(r.pos, 'pos'),
    font: typeof r.font === 'string' ? r.font : DEFAULT_SUB_STYLE.font,
    fontSize: num(r.fontSize, 'fontSize'),
    bold: bool(r.bold, 'bold'),
    color: normalizeHex(r.color, DEFAULT_SUB_STYLE.color),
    colorAlpha: alpha(r.colorAlpha, 'colorAlpha'),
    outlineColor: normalizeHex(r.outlineColor, DEFAULT_SUB_STYLE.outlineColor),
    outlineAlpha: alpha(r.outlineAlpha, 'outlineAlpha'),
    outlineSize: num(r.outlineSize, 'outlineSize'),
    shadowColor: normalizeHex(r.shadowColor, DEFAULT_SUB_STYLE.shadowColor),
    shadowAlpha: alpha(r.shadowAlpha, 'shadowAlpha'),
    shadowOffset: num(r.shadowOffset, 'shadowOffset'),
    backColor: normalizeHex(r.backColor, DEFAULT_SUB_STYLE.backColor),
    backAlpha: alpha(r.backAlpha, 'backAlpha'),
    assOverride: bool(r.assOverride, 'assOverride'),
  };
}

/**
 * 保存する JSON。**既定と違うフィールドだけ**を書く。
 * こうすると「既定に戻す」は '{}' を書くだけで済み(settings には削除コマンドが無い)、
 * 将来アプリ側の既定を変えたとき、明示的に触っていないユーザーは新しい既定に乗る
 */
export function serializeSubStyle(s: SubStyle): string {
  const diff: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_SUB_STYLE) as (keyof SubStyle)[]) {
    if (s[k] !== DEFAULT_SUB_STYLE[k]) diff[k] = s[k];
  }
  return JSON.stringify(diff);
}

/** 「既定に戻す」ボタンを disabled にしてよいか */
export function isDefaultSubStyle(s: SubStyle): boolean {
  return serializeSubStyle(s) === '{}';
}

/**
 * mpv に押し込むプロパティ一式。
 * **キー名のタイポは実行時に検出できない**(run() が握り潰す)ので、
 * subtitleStyle.test.ts がキー集合をリテラルで固定している
 */
export function mpvSubProps(s: SubStyle): Record<string, string | number> {
  return {
    'sub-scale': s.scale,
    'sub-pos': s.pos,
    // 空欄は mpv の既定に戻す(''を渡すとフォント解決が壊れる)
    'sub-font': s.font.trim() || 'sans-serif',
    'sub-font-size': s.fontSize,
    'sub-bold': s.bold ? 'yes' : 'no',
    'sub-color': toMpvColor(s.color, s.colorAlpha),
    'sub-outline-color': toMpvColor(s.outlineColor, s.outlineAlpha),
    'sub-outline-size': s.outlineSize,
    'sub-shadow-color': toMpvColor(s.shadowColor, s.shadowAlpha),
    'sub-shadow-offset': s.shadowOffset,
    'sub-back-color': toMpvColor(s.backColor, s.backAlpha),
    // scale = 制作者のスタイルを尊重(拡大率と縦位置だけ効く)
    'sub-ass-override': s.assOverride ? 'force' : 'scale',
  };
}

/**
 * その字幕トラックが自前のスタイルを持っているか(mpv の track-list の codec)。
 * 真なら「色を変えても効かない」ので、パネルに注意書きを出す
 */
export function isAssCodec(codec: string | undefined): boolean {
  const c = (codec ?? '').toLowerCase();
  return c === 'ass' || c === 'ssa';
}
