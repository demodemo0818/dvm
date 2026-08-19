import { describe, expect, it } from 'vitest';
import { toAnthropicTools, toGeminiTools, toOpenAITools } from './schema';
import type { ToolDef } from './types';

const SEARCH: ToolDef = {
  name: 'search_videos',
  description: '検索する',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'ファイル名' },
      minRating: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { type: 'string' } },
      sort: { type: 'string', enum: ['added_desc', 'name_asc', 'random'] },
    },
  },
};

/** 引数を取らないツール。Gemini だけ特別扱いが要る */
const LIST_TAGS: ToolDef = {
  name: 'list_tags',
  description: 'タグ一覧',
  parameters: { type: 'object', properties: {} },
};

const TAG_VIDEOS: ToolDef = {
  name: 'tag_videos',
  description: 'タグを付ける',
  parameters: {
    type: 'object',
    properties: { videoIds: { type: 'array', items: { type: 'integer' } }, tag: { type: 'string' } },
    required: ['videoIds', 'tag'],
  },
};

describe('toAnthropicTools', () => {
  it('input_schema というキー名で、スキーマはそのまま通す', () => {
    const [t] = toAnthropicTools([SEARCH]) as Record<string, unknown>[];
    expect(Object.keys(t)).toEqual(['name', 'description', 'input_schema']);
    expect(t.input_schema).toEqual(SEARCH.parameters);
  });

  it('required をそのまま持っていく', () => {
    const [t] = toAnthropicTools([TAG_VIDEOS]) as Record<string, unknown>[];
    expect((t.input_schema as Record<string, unknown>).required).toEqual(['videoIds', 'tag']);
  });
});

describe('toOpenAITools', () => {
  it('function で包み、parameters というキー名にする', () => {
    const [t] = toOpenAITools([SEARCH]) as Record<string, unknown>[];
    expect(t.type).toBe('function');
    const fn = t.function as Record<string, unknown>;
    expect(Object.keys(fn)).toEqual(['name', 'description', 'parameters']);
    expect(fn.parameters).toEqual(SEARCH.parameters);
  });

  it('strict を送らない(全条件が任意なので strict と相性が悪い)', () => {
    const [t] = toOpenAITools([SEARCH]) as Record<string, unknown>[];
    expect((t.function as Record<string, unknown>).strict).toBeUndefined();
  });

  it('引数なしのツールでも parameters を残す(OpenAI は空 properties を受け付ける)', () => {
    const [t] = toOpenAITools([LIST_TAGS]) as Record<string, unknown>[];
    expect((t.function as Record<string, unknown>).parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('toGeminiTools', () => {
  it('functionDeclarations の配列 1 個にまとめる', () => {
    const tools = toGeminiTools([SEARCH, LIST_TAGS]) as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect((tools[0].functionDeclarations as unknown[])).toHaveLength(2);
  });

  it('**引数なしのツールは parameters ごと落とす**(Gemini が空 properties を弾くため)', () => {
    const [t] = toGeminiTools([LIST_TAGS]) as Record<string, unknown>[];
    const decl = (t.functionDeclarations as Record<string, unknown>[])[0];
    expect(decl.parameters).toBeUndefined();
    expect(Object.keys(decl)).toEqual(['name', 'description']);
  });

  it('引数があるツールは parameters を付ける', () => {
    const [t] = toGeminiTools([SEARCH]) as Record<string, unknown>[];
    const decl = (t.functionDeclarations as Record<string, unknown>[])[0];
    expect(decl.parameters).toEqual(SEARCH.parameters);
  });

  it('enum を落とさない(sort の候補が消えると並び替えを指示できなくなる)', () => {
    const [t] = toGeminiTools([SEARCH]) as Record<string, unknown>[];
    const decl = (t.functionDeclarations as Record<string, unknown>[])[0];
    const props = (decl.parameters as Record<string, Record<string, Record<string, unknown>>>).properties;
    expect(props.sort.enum).toEqual(['added_desc', 'name_asc', 'random']);
  });
});
