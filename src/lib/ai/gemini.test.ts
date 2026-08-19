import { describe, expect, it } from 'vitest';
import { buildRequest, finish, newState, parseChunk, toContents } from './gemini';
import type { AiMessage, ChatRequest, ProviderConfig, StreamEvent } from './types';

const CFG: ProviderConfig = {
  id: 'gemini',
  apiKey: 'AIza-test',
  model: 'gemini-2.5-pro',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  maxTokens: 16000,
};

const REQ: ChatRequest = {
  system: 'システム',
  messages: [{ role: 'user', content: 'やあ' }],
  tools: [],
  signal: new AbortController().signal,
};

function run(chunks: Record<string, unknown>[]): StreamEvent[] {
  const state = newState();
  const out: StreamEvent[] = [];
  for (const c of chunks) out.push(...parseChunk(state, c));
  out.push(finish(state));
  return out;
}

describe('buildRequest', () => {
  it('**?alt=sse を付ける**(無いと SSE ではなく JSON 配列が返る)', () => {
    expect(buildRequest(CFG, REQ).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
  });

  it('キーはヘッダで渡す(URL にキーを載せない)', () => {
    const wire = buildRequest(CFG, REQ);
    expect(wire.headers['x-goog-api-key']).toBe('AIza-test');
    expect(wire.url).not.toContain('AIza-test');
  });

  it('system は systemInstruction に入れる', () => {
    const body = JSON.parse(buildRequest(CFG, REQ).body) as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'システム' }] });
  });
});

describe('toContents', () => {
  it('assistant は model ロールになる', () => {
    const out = toContents([{ role: 'assistant', content: 'はい' }]) as Record<string, unknown>[];
    expect(out[0]).toEqual({ role: 'model', parts: [{ text: 'はい' }] });
  });

  it('**ツール結果は user ロールの functionResponse**で、response はオブジェクト', () => {
    const msgs: AiMessage[] = [
      { role: 'tool', results: [{ id: 'list_tags#0', name: 'list_tags', content: '[]' }] },
    ];
    const out = toContents(msgs) as Record<string, unknown>[];
    expect(out[0]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'list_tags', response: { result: '[]' } } }],
    });
  });

  it('ツールだけ呼んだターンでも空の parts にしない', () => {
    const msgs: AiMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a#0', name: 'a', input: { x: 1 } }] },
    ];
    const out = toContents(msgs) as Record<string, { parts: unknown[] }>[];
    expect(out[0].parts).toEqual([{ functionCall: { name: 'a', args: { x: 1 } } }]);
  });
});

describe('parseChunk', () => {
  const textChunk = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

  it('parts のテキストを流す', () => {
    const events = run([textChunk('こん'), textChunk('にちは')]);
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'こん' },
      { type: 'text', text: 'にちは' },
    ]);
  });

  it('**functionCall の args は既にオブジェクト**(OpenAI のような JSON 文字列ではない)', () => {
    const events = run([
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'apply_filter', args: { minRating: 4 } } }] } },
        ],
      },
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'apply_filter#0', name: 'apply_filter', input: { minRating: 4 } } },
    ]);
  });

  it('呼び出し ID が無いので name#連番 で合成する(2 本呼ばれても衝突しない)', () => {
    const events = run([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'a', args: {} } },
                { functionCall: { name: 'a', args: {} } },
              ],
            },
          },
        ],
      },
    ]);
    const ids = events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: { id: string } }).call.id);
    expect(ids).toEqual(['a#0', 'a#1']);
  });

  it('text と functionCall が混ざったパートを両方拾う', () => {
    const events = run([
      {
        candidates: [
          { content: { parts: [{ text: '探します' }, { functionCall: { name: 'a', args: {} } }] } },
        ],
      },
    ]);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });

  it('args が無い functionCall でも落ちない', () => {
    const events = run([{ candidates: [{ content: { parts: [{ functionCall: { name: 'a' } }] } }] }]);
    expect(events.filter((e) => e.type === 'tool_call')[0]).toMatchObject({ call: { input: {} } });
  });

  it('SAFETY は refusal にする(本文が空でも無反応にしないため)', () => {
    expect(run([{ candidates: [{ finishReason: 'SAFETY' }] }]).slice(-1)[0]).toMatchObject({
      stopReason: 'refusal',
    });
  });

  it('ツールを呼んだターンは STOP でも tool_use として扱う(ループを続ける)', () => {
    const events = run([
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'a', args: {} } }] }, finishReason: 'STOP' },
        ],
      },
    ]);
    expect(events.slice(-1)[0]).toMatchObject({ stopReason: 'tool_use' });
  });

  it('usageMetadata を拾う', () => {
    const events = run([{ usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12 } }]);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 90, outputTokens: 12 });
  });

  it('思考パートは中身を出さず合図だけにする', () => {
    const events = run([{ candidates: [{ content: { parts: [{ text: '内緒', thought: true }] } }] }]);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'thinking' });
  });
});
