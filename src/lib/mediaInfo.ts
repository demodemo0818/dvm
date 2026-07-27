import type { MediaInfo, MediaStream, MediaTag } from '../types';
import { fmtSize, fmtTime } from './format';

/**
 * 詳細ペインの「メディア情報」を組み立てる純関数(v1.15)。
 *
 * 画面表示とテキストコピーは**同じ InfoSection[] から作る**。
 * 整形コードが 2 つあると「表示中の内容をコピー」がいずれズレるため。
 *
 * 方針: ffprobe の識別子(h264 / yuv420p / bt709 / 5.1(side))は訳さず生のまま出す。
 * 変換テーブルは陳腐化するし、この情報を使う場面(ffmpeg のコマンド組み立て、
 * フォーラムでの質問)では生値のほうが役に立つ。
 * 変換するのは単位・時間・言語コード・真偽値と、生では意味が読めない数値だけ
 */

export interface InfoRow {
  label: string;
  value: string;
}

export interface InfoSection {
  title: string;
  rows: InfoRow[];
}

/** 値が無い行は作らない(null / 空文字を落とす) */
function push(rows: InfoRow[], label: string, value: string | null | undefined): void {
  if (value != null && value !== '') rows.push({ label, value });
}

export function fmtBitrate(bps: number): string {
  return bps >= 1_000_000
    ? `${(bps / 1_000_000).toFixed(2)} Mbps`
    : `${Math.round(bps / 1000)} kbps`;
}

export function fmtSampleRate(hz: number): string {
  return `${(hz / 1000).toFixed(1)} kHz`;
}

/**
 * codec によって基準が違う level の生値を読める形にする。
 * H.264 は 40 が L4.0、HEVC は 120 が L4.0。知らない codec は生値のまま出す(嘘を書かない)
 */
export function fmtLevel(codec: string | null, level: number): string {
  const c = (codec ?? '').toLowerCase();
  if (c === 'h264' || c === 'avc' || c === 'vp9') return `L${(level / 10).toFixed(1)}`;
  if (c === 'hevc' || c === 'h265') return `L${(level / 30).toFixed(1)}`;
  return `L${level}`;
}

const LANGUAGES: Record<string, string> = {
  jpn: '日本語', ja: '日本語',
  eng: '英語', en: '英語',
  chi: '中国語', zho: '中国語', zh: '中国語',
  kor: '韓国語', ko: '韓国語',
  fra: 'フランス語', fre: 'フランス語',
  deu: 'ドイツ語', ger: 'ドイツ語',
  spa: 'スペイン語', ita: 'イタリア語', rus: 'ロシア語', por: 'ポルトガル語',
};

/**
 * ISO 639 の 3 文字コードは一般には読めないので日本語名を添える。生値も必ず残す。
 * "und"(未定義)はほぼ全ての mp4 に入っていて情報量がゼロなので行ごと出さない
 */
export function fmtLanguage(code: string | null): string | null {
  if (!code) return null;
  const key = code.toLowerCase();
  if (key === 'und') return null;
  const name = LANGUAGES[key];
  return name ? `${name} (${code})` : code;
}

/** tv / pc は生では読めないので補う */
function fmtColorRange(range: string): string {
  if (range === 'tv') return '制限 (tv)';
  if (range === 'pc') return 'フル (pc)';
  return range;
}

function fmtFieldOrder(order: string): string {
  return order === 'progressive' ? 'プログレッシブ' : `インターレース (${order})`;
}

function fmtFrameRate(s: MediaStream): string | null {
  if (s.avgFrameRate == null) return null;
  const avg = `${s.avgFrameRate.toFixed(3)} fps`;
  // avg と r がズレるのは可変フレームレート。判断材料として書き添える
  const vfr = s.rFrameRate != null && Math.abs(s.rFrameRate - s.avgFrameRate) > 0.01;
  return vfr ? `${avg}(可変)` : avg;
}

/**
 * 別行で出している値と、中身の無いお決まりのタグを落とす。
 * mkv は "BPS-eng" のように言語サフィックスが付くので剥がしてから判定する
 */
const HIDDEN_TAGS = new Set([
  // 専用の行で出しているもの
  'language', 'title', 'duration', 'bps', 'number_of_frames', 'number_of_bytes', 'rotate',
  // 中身が常に同じで何も分からないもの
  'handler_name', 'vendor_id', 'minor_version', 'source_id',
]);

export function visibleTags(tags: MediaTag[]): MediaTag[] {
  return tags.filter((t) => {
    const key = t.key.toLowerCase().replace(/-[a-z]{2,3}$/, '');
    return !key.startsWith('_statistics') && !HIDDEN_TAGS.has(key);
  });
}

function pushTags(rows: InfoRow[], tags: MediaTag[]): void {
  for (const t of visibleTags(tags)) push(rows, t.key, t.value);
}

/** 「言語 / タイトル / フラグ / タグ」は映像・音声・字幕で共通 */
function pushCommonRows(rows: InfoRow[], s: MediaStream, containerMs: number | null): void {
  // 尺は普通コンテナ全体と同じなので、ズレているときだけ出す(音声だけ短い等の発見用)
  if (s.durationMs != null && (containerMs == null || Math.abs(s.durationMs - containerMs) > 1000)) {
    push(rows, '長さ', fmtTime(s.durationMs / 1000));
  }
  push(rows, '言語', fmtLanguage(s.language));
  push(rows, 'タイトル', s.title);
  const flags = [s.isDefault ? '既定' : null, s.isForced ? '強制' : null].filter(Boolean);
  push(rows, 'フラグ', flags.join(' / '));
  pushTags(rows, s.tags);
}

/** "h264 (High) @ L4.0" を組み立てる */
function codecLine(s: MediaStream): string | null {
  if (!s.codecName) return null;
  let line = s.codecName;
  if (s.profile) line += ` (${s.profile})`;
  if (s.level != null) line += ` @ ${fmtLevel(s.codecName, s.level)}`;
  return line;
}

function videoRows(s: MediaStream, containerMs: number | null): InfoRow[] {
  const rows: InfoRow[] = [];
  push(rows, 'コーデック', codecLine(s));
  push(rows, '詳細', s.codecLongName);
  if (s.width && s.height) push(rows, '解像度', `${s.width}×${s.height}`);
  push(rows, 'アスペクト比', s.displayAspectRatio);
  // 正方形ピクセルなら書く意味が無い
  if (s.sampleAspectRatio && s.sampleAspectRatio !== '1:1') {
    push(rows, 'ピクセル比', s.sampleAspectRatio);
  }
  push(rows, 'フレームレート', fmtFrameRate(s));
  push(rows, 'ピクセル形式', s.pixFmt);
  if (s.bitDepth != null) push(rows, 'ビット深度', `${s.bitDepth} bit`);
  push(rows, 'HDR', s.hdr);
  push(rows, 'カラースペース', s.colorSpace);
  push(rows, '色域', s.colorPrimaries);
  push(rows, '転送特性', s.colorTransfer);
  if (s.colorRange) push(rows, '色範囲', fmtColorRange(s.colorRange));
  if (s.fieldOrder) push(rows, '走査方式', fmtFieldOrder(s.fieldOrder));
  if (s.rotation != null && s.rotation !== 0) push(rows, '回転', `${s.rotation}°`);
  if (s.bitrate != null) push(rows, 'ビットレート', fmtBitrate(s.bitrate));
  if (s.frameCount != null) push(rows, 'フレーム数', s.frameCount.toLocaleString('ja-JP'));
  push(rows, 'コーデックタグ', s.codecTag);
  pushCommonRows(rows, s, containerMs);
  return rows;
}

function audioRows(s: MediaStream, containerMs: number | null): InfoRow[] {
  const rows: InfoRow[] = [];
  push(rows, 'コーデック', codecLine(s));
  push(rows, '詳細', s.codecLongName);
  if (s.channels != null) {
    push(rows, 'チャンネル', s.channelLayout ? `${s.channels} ch (${s.channelLayout})` : `${s.channels} ch`);
  }
  if (s.sampleRate != null) push(rows, 'サンプルレート', fmtSampleRate(s.sampleRate));
  push(rows, 'サンプル形式', s.sampleFmt);
  if (s.bitDepth != null) push(rows, 'ビット深度', `${s.bitDepth} bit`);
  if (s.bitrate != null) push(rows, 'ビットレート', fmtBitrate(s.bitrate));
  push(rows, 'コーデックタグ', s.codecTag);
  pushCommonRows(rows, s, containerMs);
  return rows;
}

function subtitleRows(s: MediaStream, containerMs: number | null): InfoRow[] {
  const rows: InfoRow[] = [];
  push(rows, 'コーデック', s.codecName);
  push(rows, '詳細', s.codecLongName);
  pushCommonRows(rows, s, containerMs);
  return rows;
}

const KIND_LABEL: Record<string, string> = {
  video: '映像',
  audio: '音声',
  subtitle: '字幕',
  cover: 'カバー画像',
};

/**
 * 同じ種別が 1 本だけなら番号を振らない(「映像」)。
 * 複数あるときだけ「音声 #1 / 音声 #2」にする
 */
function sectionTitle(kind: string, ordinal: number, total: number): string {
  const label = KIND_LABEL[kind] ?? kind;
  return total > 1 ? `${label} #${ordinal}` : label;
}

export function buildMediaSections(info: MediaInfo): InfoSection[] {
  const { format, streams, chapters } = info;
  const byKind = (kind: string) => streams.filter((s) => s.kind === kind);
  // 埋め込みのカバー画像は codec_type が video だが本編ではない。
  // 一緒に数えると YouTube 由来の mp4 が「映像 2」に見えてしまう
  const videos = byKind('video').filter((s) => !s.isAttachedPic);
  const covers = byKind('video').filter((s) => s.isAttachedPic);
  const audios = byKind('audio');
  const subtitles = byKind('subtitle');
  // 添付(mkv のフォントは 20 本入ることがある)とデータは 1 行にまとめる。
  // 1 本ずつブロックにすると詳細ペインが埋まって肝心の映像・音声が見えなくなる
  const attachments = streams.filter((s) => s.kind === 'attachment');
  const others = streams.filter(
    (s) => !['video', 'audio', 'subtitle', 'attachment'].includes(s.kind),
  );

  const general: InfoRow[] = [];
  push(
    general,
    'コンテナ',
    format.formatLongName && format.formatName
      ? `${format.formatLongName} (${format.formatName})`
      : (format.formatLongName ?? format.formatName),
  );
  if (format.durationMs != null) push(general, '再生時間', fmtTime(format.durationMs / 1000));
  if (format.size != null) push(general, 'ファイルサイズ', fmtSize(format.size));
  if (format.bitrate != null) push(general, '総ビットレート', fmtBitrate(format.bitrate));
  const counts = [
    videos.length ? `映像 ${videos.length}` : null,
    audios.length ? `音声 ${audios.length}` : null,
    subtitles.length ? `字幕 ${subtitles.length}` : null,
    others.length ? `その他 ${others.length}` : null,
  ].filter(Boolean);
  push(general, 'ストリーム', counts.join(' / '));
  if (attachments.length) push(general, '添付ファイル', `${attachments.length} 個`);
  if (covers.length) push(general, 'カバー画像', `${covers.length} 個`);
  pushTags(general, format.tags);

  const sections: InfoSection[] = [{ title: '全般', rows: general }];

  videos.forEach((s, i) => {
    sections.push({
      title: sectionTitle('video', i + 1, videos.length),
      rows: videoRows(s, format.durationMs),
    });
  });
  audios.forEach((s, i) => {
    sections.push({
      title: sectionTitle('audio', i + 1, audios.length),
      rows: audioRows(s, format.durationMs),
    });
  });
  subtitles.forEach((s, i) => {
    sections.push({
      title: sectionTitle('subtitle', i + 1, subtitles.length),
      rows: subtitleRows(s, format.durationMs),
    });
  });
  // カバー画像は本編の後ろ。尺もフレームレートも無いので映像用の行をそのまま使う
  covers.forEach((s, i) => {
    sections.push({
      title: sectionTitle('cover', i + 1, covers.length),
      rows: videoRows(s, format.durationMs),
    });
  });

  if (chapters.length) {
    sections.push({
      title: 'チャプター',
      rows: chapters.map((c, i) => ({
        label: fmtTime(c.startMs / 1000),
        value: c.title ?? `チャプター ${i + 1}`,
      })),
    });
  }

  // 中身が 1 行も無いセクションは出さない(壊れたファイルで空の枠だけ並ぶのを防ぐ)
  return sections.filter((s) => s.rows.length > 0);
}

/** 表示中のセクションをそのままテキストにする(コピーボタン) */
export function mediaSectionsToText(header: string, sections: InfoSection[]): string {
  const body = sections
    .map((s) => [`[${s.title}]`, ...s.rows.map((r) => `${r.label}: ${r.value}`)].join('\n'))
    .join('\n\n');
  return `${header}\n\n${body}\n`;
}
