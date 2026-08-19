import { api } from '../api';
import { useLibrary } from '../store';
import { describeFilter, NO_MASTERS } from './filterChips';
import { DURATION_RANGES, toFilterState } from './query';
import type { AiTool, JsonSchemaProp, ToolSchema } from './ai/types';
import type { DurationBucket, SortKey, VideoQuery } from '../types';

/** ツール実行を UI(チャット内カード)へ通知するコールバック */
export type ToolNotify = (message: string) => void;

/**
 * 宣言と実行をまとめる小さなヘルパー(v1.43。SDK の `betaTool` の代わり)。
 *
 * `betaTool` は inputSchema から run の引数型を推論してくれたが、あれは Anthropic SDK
 * 固有の芸なので、**入力の型は呼び出し側が明示する**ことにした。AI が返す引数は
 * どのみち実行時に何が来るか分からないので、推論に頼りきらないほうが実態に合う
 */
function defineTool<T>(spec: {
  name: string;
  description: string;
  parameters: ToolSchema;
  run: (input: T) => Promise<string>;
}): AiTool {
  return {
    def: { name: spec.name, description: spec.description, parameters: spec.parameters },
    run: (input) => spec.run(input as T),
  };
}

/** Rust の order_clause() と types.ts の SortKey に合わせて手で同期する */
const SORT_ENUM = [
  'added_desc', 'added_asc', 'name_asc', 'name_desc',
  'size_desc', 'size_asc', 'duration_desc', 'duration_asc',
  'rating_desc', 'rating_asc', 'viewed_desc', 'viewed_asc',
  'views_desc', 'views_asc', 'res_desc', 'res_asc',
  'ext_asc', 'ext_desc', 'codec_asc', 'codec_desc', 'acodec_asc', 'acodec_desc',
  'folder_asc', 'folder_desc',
  'fmodified_desc', 'fmodified_asc', 'fcreated_desc', 'fcreated_asc',
  'fps_desc', 'fps_asc', 'bitrate_desc', 'bitrate_asc',
  'random', 'dup',
] as const;

/** search_videos と apply_filter で共通の絞り込み条件(スキーマがずれないよう 1 か所にまとめる) */
const FILTER_PROPS: Record<string, JsonSchemaProp> = {
  text: { type: 'string', description: 'ファイル名・タイトルの部分一致。空白区切りで複数語すべてを含むものに絞る' },
  searchPath: { type: 'boolean', description: 'text の検索対象にフォルダのパスも含める' },
  dirPath: { type: 'string', description: 'このフォルダ直下にある動画だけに絞る(サブフォルダは含まない)。絶対パスで指定する' },
  tags: { type: 'array', items: { type: 'string' }, description: 'タグ名(完全一致)で絞る。同じグループのタグ同士は OR、グループをまたぐと AND になる(例: ["ファンタジー","SF","アニメ"] = (ファンタジー または SF) かつ アニメ)。グループは list_tags で確認できる' },
  series: { type: 'string', description: 'シリーズ名(完全一致)' },
  searchComment: { type: 'boolean', description: 'text の検索対象にメモも含める' },
  dirPathRecursive: { type: 'boolean', description: 'true で dirPath をサブフォルダ込みで解釈する' },
  minRating: { type: 'integer', minimum: 1, maximum: 5 },
  unrated: { type: 'boolean', description: 'レーティングを付けていない動画だけ。minRating の 0 は「無条件」なので別物' },
  durationBucket: { type: 'string', enum: ['lt5', '5to20', '20to60', 'gt60'], description: '尺: 5分未満/5〜20分/20〜60分/60分以上' },
  minDurationSec: { type: 'integer', description: '尺の下限(秒)。durationBucket より細かく指定したいとき' },
  maxDurationSec: { type: 'integer', description: '尺の上限(秒)' },
  untagged: { type: 'boolean', description: 'タグが 1 つも付いていない動画だけ' },
  unwatched: { type: 'boolean', description: '一度も再生していない動画だけ' },
  resumedOnly: { type: 'boolean', description: '途中まで観て終わっていない動画だけ(アプリ内再生でのみ記録される)' },
  minViewCount: { type: 'integer', description: '再生回数の下限' },
  maxViewCount: { type: 'integer', description: '再生回数の上限。0 で未視聴のみ' },
  duplicatesOnly: { type: 'boolean', description: '内容が同一(サイズと先頭ハッシュが一致)の動画だけ。sort=dup と併せると同じものが隣り合う' },
  minSizeBytes: { type: 'integer', description: 'ファイルサイズの下限(バイト)' },
  maxSizeBytes: { type: 'integer', description: 'ファイルサイズの上限(バイト)' },
  extensions: { type: 'array', items: { type: 'string' }, description: '拡張子で絞る(例: ["mp4","mkv"])' },
  minHeight: { type: 'integer', description: '縦解像度の下限。1080 で FHD 以上、2160 で 4K 以上' },
  maxHeight: { type: 'integer', description: '縦解像度の上限。**その値未満**なので 720 で「720p 未満」' },
  orientation: { type: 'string', enum: ['portrait', 'landscape'], description: '画面の向き。portrait = 縦長、landscape = 横長(正方形を含む)' },
  videoCodecs: { type: 'array', items: { type: 'string' }, description: '映像コーデックで絞る(例: ["h264","hevc"])' },
  addedAfter: { type: 'string', description: 'ライブラリ追加日の下限(YYYY-MM-DD。その日を含む)' },
  addedBefore: { type: 'string', description: 'ライブラリ追加日の上限(YYYY-MM-DD。その日を含む)' },
  addedWithinDays: { type: 'integer', description: '過去 N 日以内に追加されたものだけ(7 で直近 1 週間)' },
  modifiedAfter: { type: 'string', description: 'ファイル更新日の下限(YYYY-MM-DD。その日を含む)' },
  modifiedBefore: { type: 'string', description: 'ファイル更新日の上限(YYYY-MM-DD。その日を含む)' },
  modifiedWithinDays: { type: 'integer', description: '過去 N 日以内に更新されたものだけ' },
  sort: { type: 'string', enum: [...SORT_ENUM] },
};

/** FILTER_PROPS に対応する入力(betaTool が推論する型と同じ形) */
interface FilterInput {
  text?: string;
  searchPath?: boolean;
  searchComment?: boolean;
  dirPath?: string;
  dirPathRecursive?: boolean;
  tags?: string[];
  series?: string;
  minRating?: number;
  unrated?: boolean;
  durationBucket?: string;
  minDurationSec?: number;
  maxDurationSec?: number;
  untagged?: boolean;
  unwatched?: boolean;
  resumedOnly?: boolean;
  minViewCount?: number;
  maxViewCount?: number;
  duplicatesOnly?: boolean;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  extensions?: string[];
  minHeight?: number;
  maxHeight?: number;
  orientation?: string;
  videoCodecs?: string[];
  addedAfter?: string;
  addedBefore?: string;
  addedWithinDays?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
  modifiedWithinDays?: number;
  sort?: string;
  missingOnly?: boolean;
}

/** ツール入力を VideoQuery に変換する。タグ・シリーズ名は id へ解決する */
async function toQuery(input: FilterInput): Promise<VideoQuery> {
  const range = input.durationBucket
    ? DURATION_RANGES[input.durationBucket as DurationBucket]
    : undefined;
  const sec = (s: number | undefined) => (s === undefined ? undefined : s * 1000);
  return {
    text: input.text || undefined,
    sort: input.sort as SortKey | undefined,
    tagIds: input.tags?.length ? await resolveTagIds(input.tags) : undefined,
    seriesId: input.series ? await resolveSeriesId(input.series) : undefined,
    minRating: input.minRating,
    // 秒指定はプリセットより細かいので、両方来たら秒のほうを採る
    minDurationMs: sec(input.minDurationSec) ?? range?.min,
    maxDurationMs: sec(input.maxDurationSec) ?? range?.max,
    missing: input.missingOnly ? true : undefined,
    searchPath: input.searchPath || undefined,
    dirPath: input.dirPath || undefined,
    untagged: input.untagged || undefined,
    unwatched: input.unwatched || undefined,
    duplicatesOnly: input.duplicatesOnly || undefined,
    minHeight: input.minHeight || undefined,
    videoCodecs: input.videoCodecs?.length ? input.videoCodecs : undefined,
    addedAfter: input.addedAfter || undefined,
    addedBefore: input.addedBefore || undefined,
    // --- v1.35 ---
    searchComment: input.searchComment || undefined,
    dirPathRecursive: input.dirPathRecursive || undefined,
    unrated: input.unrated || undefined,
    resumedOnly: input.resumedOnly || undefined,
    minViewCount: input.minViewCount,
    maxViewCount: input.maxViewCount,
    minSizeBytes: input.minSizeBytes,
    maxSizeBytes: input.maxSizeBytes,
    extensions: input.extensions?.length ? input.extensions : undefined,
    maxHeight: input.maxHeight || undefined,
    orientation: (input.orientation as VideoQuery['orientation']) || undefined,
    addedWithinDays: input.addedWithinDays,
    modifiedAfter: input.modifiedAfter || undefined,
    modifiedBefore: input.modifiedBefore || undefined,
    modifiedWithinDays: input.modifiedWithinDays,
  };
}

/** タグ名を id に解決する。1 つでも見つからなければエラーにする(黙って無視すると条件が緩む) */
async function resolveTagIds(names: string[]): Promise<number[]> {
  const tags = await api.listTags();
  return names.map((name) => {
    const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) throw new Error(`タグ「${name}」が見つかりません`);
    return tag.id;
  });
}

async function resolveSeriesId(name: string): Promise<number> {
  const list = await api.listSeries();
  const s = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`シリーズ「${name}」が見つかりません`);
  return s.id;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '不明';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分${s % 60}秒`;
}

/** AI アシスタントのツール一式を作る。notify はツール実行カードの表示用 */
export function buildTools(notify: ToolNotify): AiTool[] {
  const searchVideos = defineTool<FilterInput & { limit?: number }>({
    name: 'search_videos',
    description:
      '動画ライブラリを検索して結果を JSON で返す(画面は変わらない)。結果を画面に表示したいときは apply_filter を使うこと。',
    parameters: {
      type: 'object',
      properties: {
        ...FILTER_PROPS,
        limit: { type: 'integer', description: '最大件数(既定 20)' },
      },
    },
    run: async (input) => {
      const query = await toQuery(input);
      const total = await api.countVideos(query);
      const rows = await api.queryVideos(query, Math.min(input.limit ?? 20, 100), 0);
      return JSON.stringify({
        total,
        returned: rows.length,
        videos: rows.map((v) => ({
          id: v.id,
          filename: v.filename,
          title: v.title,
          rating: v.rating,
          durationMs: v.durationMs,
          viewCount: v.viewCount,
          isMissing: v.isMissing,
        })),
      });
    },
  });

  const listTags = defineTool<Record<string, never>>({
    name: 'list_tags',
    description:
      '全タグと各タグの動画数、所属グループ(groupName)を一覧する。グループは分類の軸(例:「ジャンル」「メディア種別」)で、検索では同じグループのタグ同士が OR になる',
    parameters: { type: 'object', properties: {} },
    run: async () => JSON.stringify(await api.listTags()),
  });

  const listSeries = defineTool<Record<string, never>>({
    name: 'list_series',
    description: '全シリーズと各シリーズの動画数を一覧する',
    parameters: { type: 'object', properties: {} },
    run: async () => JSON.stringify(await api.listSeries()),
  });

  const applyFilter = defineTool<FilterInput>({
    name: 'apply_filter',
    description:
      'アプリのグリッド表示を絞り込む(ユーザーに結果を見せる)。省略した条件は解除される。全条件を省略すると絞り込み解除。',
    parameters: {
      type: 'object',
      properties: {
        ...FILTER_PROPS,
        missingOnly: { type: 'boolean', description: 'ファイルが見つからない動画だけ' },
      },
    },
    run: async (input) => {
      const query = await toQuery(input);
      // 画面に反映する条件は toQuery の結果から機械的に戻す(スマートフォルダと同じ経路)。
      // ここで項目を並べ直すと、条件が増えたときに片方だけ落ちる
      useLibrary.getState().applyFilter(toFilterState(query));
      // 適用後の件数を返す(グリッドと同じクエリ条件)
      const count = await api.countVideos(query);
      notify(`グリッドを絞り込みました(${count} 件)`);
      return `絞り込みを適用しました。該当 ${count} 件`;
    },
  });

  const tagVideos = defineTool<{ videoIds: number[]; tag: string }>({
    name: 'tag_videos',
    description: '動画にタグを付ける(タグが無ければ作成される)',
    parameters: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        tag: { type: 'string' },
      },
      required: ['videoIds', 'tag'],
    },
    run: async (input) => {
      await api.tagVideos(input.videoIds, input.tag, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`${input.videoIds.length} 件にタグ「${input.tag}」を付けました`);
      return `${input.videoIds.length} 件にタグ「${input.tag}」を付けました`;
    },
  });

  const setRating = defineTool<{ videoIds: number[]; rating: number }>({
    name: 'set_rating',
    description: '動画のレーティングを設定する(0 で解除)',
    parameters: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        rating: { type: 'integer', minimum: 0, maximum: 5 },
      },
      required: ['videoIds', 'rating'],
    },
    run: async (input) => {
      await api.setRating(input.videoIds, input.rating, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`${input.videoIds.length} 件のレーティングを ★${input.rating} にしました`);
      return `${input.videoIds.length} 件のレーティングを ${input.rating} にしました`;
    },
  });

  const addToSeries = defineTool<{ videoIds: number[]; series: string }>({
    name: 'add_to_series',
    description: '動画をシリーズに追加する(シリーズが無ければ作成される)',
    parameters: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        series: { type: 'string' },
      },
      required: ['videoIds', 'series'],
    },
    run: async (input) => {
      await api.addToSeries(input.videoIds, input.series, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`${input.videoIds.length} 件をシリーズ「${input.series}」に追加しました`);
      return `${input.videoIds.length} 件をシリーズ「${input.series}」に追加しました`;
    },
  });

  return [searchVideos, listTags, listSeries, applyFilter, tagVideos, setRating, addToSeries];
}

/** 選択中の動画・現在のフィルタをコンテキストとして注入したシステムプロンプトを作る */
export async function buildSystemPrompt(): Promise<string> {
  const s = useLibrary.getState();
  let selectionBlock = '(なし)';
  if (s.selection.length > 0) {
    const tags = await api.tagsForVideos(s.selection.map((v) => v.id)).catch(() => []);
    const lines = s.selection.slice(0, 20).map((v) => {
      const parts = [
        `id=${v.id}`,
        `ファイル名: ${v.filename}`,
        v.title && v.title !== v.filename ? `タイトル: ${v.title}` : null,
        `尺: ${fmtDuration(v.durationMs)}`,
        v.rating > 0 ? `★${v.rating}` : null,
        v.width && v.height ? `${v.width}×${v.height}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' / ')}`;
    });
    selectionBlock = lines.join('\n');
    if (tags.length > 0) {
      selectionBlock += `\n共通タグ: ${tags.map((t) => t.name).join(', ')}`;
    }
    if (s.selection.length > 20) {
      selectionBlock += `\n(ほか ${s.selection.length - 20} 件)`;
    }
  }
  /*
   * 効いている条件は**絞り込み帯と同じ describeFilter から組み立てる**(v1.35)。
   * 手書きで並べていた頃は条件を足すたびにここも直す必要があり、
   * 忘れると「画面では絞れているのに AI は知らない」がすれ違いのまま残った。
   *
   * 名前を引くのにマスタが要るもの(タグ・シリーズ・フォルダ)だけは
   * ここでは解決できない(この関数は同期で、tags を持っていない)ので従来どおり件数で出す
   */
  const NEEDS_MASTERS = ['folder', 'dirPath', 'series'];
  const filters: string[] = [];
  if (s.tagIds.length > 0) filters.push(`タグ ${s.tagIds.length} 件`);
  if (s.seriesId != null) filters.push('シリーズ');
  if (s.folderId != null || s.dirPath != null) filters.push('フォルダ');
  for (const t of describeFilter(s, NO_MASTERS)) {
    if (t.key.startsWith('tags:') || NEEDS_MASTERS.includes(t.key)) continue;
    // 箱の中は OR。帯の見た目と同じ読み方になるように繋ぐ
    filters.push(t.chips.map((c) => c.label).join(' または '));
  }

  return `あなたは Windows 向け動画管理ソフト「DVM」のアシスタントです。ユーザーの動画ライブラリの検索・整理(タグ付け・レーティング・シリーズ管理)を手伝います。

指針:
- 検索結果をユーザーに見せたいときは apply_filter を使う(グリッドが絞り込まれる)。データとして参照したいだけなら search_videos を使う
- タグ提案はファイル名・タイトルから内容を推測し、既存タグ(list_tags)を優先して提案する。新しいタグを付けるのはユーザーが同意してからにする
- タグにはグループ(分類の軸)がある。軸が違うタグは同時に付けてよい(例: メディア種別「アニメ」とジャンル「ファンタジー」)。グループの作成・変更はユーザーの担当なので、AI からは行わない
- 書き込み(tag_videos / set_rating / add_to_series)は実行前にユーザーの意図が明確な場合のみ行う。曖昧なら先に提案して確認する
- 回答は簡潔な日本語で

現在ユーザーが選択している動画:
${selectionBlock}

現在のグリッド絞り込み: ${filters.length > 0 ? filters.join('、') : '(なし)'}`;
}
