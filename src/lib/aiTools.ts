import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { api } from '../api';
import { useLibrary } from '../store';
import type { DurationBucket, SortKey, VideoQuery } from '../types';

/** ツール実行を UI(チャット内カード)へ通知するコールバック */
export type ToolNotify = (message: string) => void;

const DURATION_RANGES: Record<DurationBucket, { min?: number; max?: number }> = {
  lt5: { max: 5 * 60_000 },
  '5to20': { min: 5 * 60_000, max: 20 * 60_000 },
  '20to60': { min: 20 * 60_000, max: 60 * 60_000 },
  gt60: { min: 60 * 60_000 },
};

const SORT_ENUM = [
  'added_desc', 'added_asc', 'name_asc', 'name_desc',
  'size_desc', 'duration_desc', 'rating_desc', 'viewed_desc',
] as const;

async function resolveTagId(name: string): Promise<number> {
  const tags = await api.listTags();
  const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) throw new Error(`タグ「${name}」が見つかりません`);
  return tag.id;
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
export function buildTools(notify: ToolNotify) {
  const searchVideos = betaTool({
    name: 'search_videos',
    description:
      '動画ライブラリを検索して結果を JSON で返す(画面は変わらない)。結果を画面に表示したいときは apply_filter を使うこと。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'ファイル名・タイトルの部分一致' },
        tag: { type: 'string', description: 'タグ名(完全一致)' },
        series: { type: 'string', description: 'シリーズ名(完全一致)' },
        minRating: { type: 'integer', minimum: 1, maximum: 5 },
        durationBucket: { type: 'string', enum: ['lt5', '5to20', '20to60', 'gt60'], description: '尺: 5分未満/5〜20分/20〜60分/60分以上' },
        sort: { type: 'string', enum: [...SORT_ENUM] },
        limit: { type: 'integer', description: '最大件数(既定 20)' },
      },
    } as const,
    run: async (input) => {
      const query: VideoQuery = {
        text: input.text || undefined,
        sort: input.sort as SortKey | undefined,
        minRating: input.minRating,
      };
      if (input.tag) query.tagIds = [await resolveTagId(input.tag)];
      if (input.series) query.seriesId = await resolveSeriesId(input.series);
      if (input.durationBucket) {
        const range = DURATION_RANGES[input.durationBucket as DurationBucket];
        query.minDurationMs = range.min;
        query.maxDurationMs = range.max;
      }
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

  const listTags = betaTool({
    name: 'list_tags',
    description: '全タグと各タグの動画数を一覧する',
    inputSchema: { type: 'object', properties: {} } as const,
    run: async () => JSON.stringify(await api.listTags()),
  });

  const listSeries = betaTool({
    name: 'list_series',
    description: '全シリーズと各シリーズの動画数を一覧する',
    inputSchema: { type: 'object', properties: {} } as const,
    run: async () => JSON.stringify(await api.listSeries()),
  });

  const applyFilter = betaTool({
    name: 'apply_filter',
    description:
      'アプリのグリッド表示を絞り込む(ユーザーに結果を見せる)。省略した条件は解除される。全条件を省略すると絞り込み解除。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'ファイル名・タイトルの部分一致' },
        tag: { type: 'string', description: 'タグ名(完全一致)' },
        series: { type: 'string', description: 'シリーズ名(完全一致)' },
        minRating: { type: 'integer', minimum: 1, maximum: 5 },
        durationBucket: { type: 'string', enum: ['lt5', '5to20', '20to60', 'gt60'] },
        missingOnly: { type: 'boolean' },
        sort: { type: 'string', enum: [...SORT_ENUM] },
      },
    } as const,
    run: async (input) => {
      const tagIds = input.tag ? [await resolveTagId(input.tag)] : undefined;
      const seriesId = input.series ? await resolveSeriesId(input.series) : undefined;
      useLibrary.getState().applyFilter({
        text: input.text,
        tagIds,
        seriesId,
        minRating: input.minRating,
        durationBucket: input.durationBucket as DurationBucket | undefined,
        missingOnly: input.missingOnly,
        sort: input.sort as SortKey | undefined,
      });
      // 適用後の件数を返す(UI と同じクエリ条件)
      const range = input.durationBucket
        ? DURATION_RANGES[input.durationBucket as DurationBucket]
        : undefined;
      const count = await api.countVideos({
        text: input.text || undefined,
        tagIds,
        seriesId,
        minRating: input.minRating,
        minDurationMs: range?.min,
        maxDurationMs: range?.max,
        missing: input.missingOnly ? true : undefined,
        sort: input.sort as SortKey | undefined,
      });
      notify(`🔍 グリッドを絞り込みました(${count} 件)`);
      return `絞り込みを適用しました。該当 ${count} 件`;
    },
  });

  const tagVideos = betaTool({
    name: 'tag_videos',
    description: '動画にタグを付ける(タグが無ければ作成される)',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        tag: { type: 'string' },
      },
      required: ['videoIds', 'tag'],
    } as const,
    run: async (input) => {
      await api.tagVideos(input.videoIds, input.tag, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`🏷 ${input.videoIds.length} 件にタグ「${input.tag}」を付けました`);
      return `${input.videoIds.length} 件にタグ「${input.tag}」を付けました`;
    },
  });

  const setRating = betaTool({
    name: 'set_rating',
    description: '動画のレーティングを設定する(0 で解除)',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        rating: { type: 'integer', minimum: 0, maximum: 5 },
      },
      required: ['videoIds', 'rating'],
    } as const,
    run: async (input) => {
      await api.setRating(input.videoIds, input.rating, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`⭐ ${input.videoIds.length} 件のレーティングを ${input.rating} にしました`);
      return `${input.videoIds.length} 件のレーティングを ${input.rating} にしました`;
    },
  });

  const addToSeries = betaTool({
    name: 'add_to_series',
    description: '動画をシリーズに追加する(シリーズが無ければ作成される)',
    inputSchema: {
      type: 'object',
      properties: {
        videoIds: { type: 'array', items: { type: 'integer' } },
        series: { type: 'string' },
      },
      required: ['videoIds', 'series'],
    } as const,
    run: async (input) => {
      await api.addToSeries(input.videoIds, input.series, 'ai');
      useLibrary.getState().bumpVersion();
      notify(`📚 ${input.videoIds.length} 件をシリーズ「${input.series}」に追加しました`);
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
  const filters: string[] = [];
  if (s.text) filters.push(`テキスト「${s.text}」`);
  if (s.tagIds.length > 0) filters.push(`タグ ${s.tagIds.length} 件`);
  if (s.seriesId != null) filters.push('シリーズ');
  if (s.minRating > 0) filters.push(`★${s.minRating} 以上`);
  if (s.durationBucket) filters.push(`尺 ${s.durationBucket}`);
  if (s.missingOnly) filters.push('missing のみ');

  return `あなたは Windows 向け動画管理ソフト「VideoShelf」のアシスタントです。ユーザーの動画ライブラリの検索・整理(タグ付け・レーティング・シリーズ管理)を手伝います。

指針:
- 検索結果をユーザーに見せたいときは apply_filter を使う(グリッドが絞り込まれる)。データとして参照したいだけなら search_videos を使う
- タグ提案はファイル名・タイトルから内容を推測し、既存タグ(list_tags)を優先して提案する。新しいタグを付けるのはユーザーが同意してからにする
- 書き込み(tag_videos / set_rating / add_to_series)は実行前にユーザーの意図が明確な場合のみ行う。曖昧なら先に提案して確認する
- 回答は簡潔な日本語で

現在ユーザーが選択している動画:
${selectionBlock}

現在のグリッド絞り込み: ${filters.length > 0 ? filters.join('、') : '(なし)'}`;
}
