import { describe, expect, it } from 'vitest';
import { buildRequest, finish, newState, parseChunk, toWireMessages } from './anthropic';
import type { AiMessage, ChatRequest, ProviderConfig, StreamEvent } from './types';

const CFG: ProviderConfig = {
  id: 'anthropic',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
  baseUrl: 'https://api.anthropic.com',
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
  it('SDK が送っていたのと同じ URL とヘッダを送る', () => {
    const wire = buildRequest(CFG, REQ);
    expect(wire.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(wire.headers['anthropic-version']).toBe('2023-06-01');
    expect(wire.headers['x-api-key']).toBe('sk-ant-test');
    // ブラウザ直叩きを通していたヘッダ。実測でこれが無いと CORS で落ちた
    expect(wire.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('system はトップレベル、thinking は adaptive(v1.42 と同じ)', () => {
    const body = JSON.parse(buildRequest(CFG, REQ).body) as Record<string, unknown>;
    expect(body.system).toBe('システム');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(16000);
  });
});

describe('toWireMessages', () => {
  it('**raw があれば生ブロックをそのまま戻す**(thinking の署名を落とすと次のターンで 400 になる)', () => {
    const blocks = [
      { type: 'thinking', thinking: '考えた', signature: 'sig-abc' },
      { type: 'tool_use', id: 'c1', name: 'a', input: {} },
    ];
    const msgs: AiMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', input: {} }], raw: { provider: 'anthropic', blocks } },
    ];
    expect(toWireMessages(msgs)).toEqual([{ role: 'assistant', content: blocks }]);
  });

  it('他プロバイダの raw は無視して content から組み直す', () => {
    const msgs: AiMessage[] = [
      { role: 'assistant', content: 'はい', raw: { provider: 'openai', blocks: [{ nonsense: true }] } },
    ];
    expect(toWireMessages(msgs)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'はい' }] }]);
  });

  it('**ツール結果は user ロールに複数ブロックでまとめる**(OpenAI と逆)', () => {
    const msgs: AiMessage[] = [
      {
        role: 'tool',
        results: [
          { id: 'c1', name: 'a', content: 'A' },
          { id: 'c2', name: 'b', content: 'B', isError: true },
        ],
      },
    ];
    expect(toWireMessages(msgs)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'A' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'B', is_error: true },
        ],
      },
    ]);
  });
});

describe('parseChunk', () => {
  it('text_delta を流し、生ブロックにも積む', () => {
    const events = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'こん' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'にちは' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
    ]);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
    const end = events.slice(-1)[0] as { assistant: { content: string; raw: { blocks: unknown[] } } };
    expect(end.assistant.content).toBe('こんにちは');
    expect(end.assistant.raw.blocks).toEqual([{ type: 'text', text: 'こんにちは' }]);
  });

  it('**thinking の signature_delta を生ブロックに積む**(これが無いと次のターンで 400)', () => {
    const events = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '考え中' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(events).toContainEqual({ type: 'thinking' });
    const end = events.slice(-1)[0] as { assistant: { raw: { blocks: Record<string, unknown>[] } } };
    expect(end.assistant.raw.blocks[0]).toEqual({
      type: 'thinking',
      thinking: '考え中',
      signature: 'sig-abc',
    });
  });

  it('**input_json_delta の断片を連結してから JSON にする**', () => {
    const events = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'apply_filter' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"min' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'Rating"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':4}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'c1', name: 'apply_filter', input: { minRating: 4 } } },
    ]);
    expect(events.slice(-1)[0]).toMatchObject({ stopReason: 'tool_use' });
  });

  it('引数なしのツール(空文字)は {} にする', () => {
    const events = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'list_tags' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(events.filter((e) => e.type === 'tool_call')[0]).toMatchObject({ call: { input: {} } });
  });

  it('壊れた JSON は投げずに parseError にする', () => {
    const events = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x"' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    const call = events.filter((e) => e.type === 'tool_call')[0] as { call: { parseError?: string } };
    expect(call.call.parseError).toMatch(/壊れています/);
  });

  it('usage を message_start と message_delta の両方から拾う', () => {
    const events = run([
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
    ]);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 100 });
    expect(events).toContainEqual({ type: 'usage', outputTokens: 25 });
  });

  it('stop_reason を写す', () => {
    expect(run([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]).slice(-1)[0]).toMatchObject({
      stopReason: 'max_tokens',
    });
    expect(run([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]).slice(-1)[0]).toMatchObject({
      stopReason: 'refusal',
    });
  });

  it('error イベントは AiError にする', () => {
    const state = newState();
    expect(() => parseChunk(state, { type: 'error', error: { message: 'overloaded' } })).toThrow(
      /overloaded/,
    );
  });
});
