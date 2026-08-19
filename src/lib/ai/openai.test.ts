import { describe, expect, it } from 'vitest';
import { buildRequest, finish, newState, parseChunk, toWireMessages } from './openai';
import type { AiMessage, ChatRequest, ProviderConfig, StreamEvent } from './types';

const CFG: ProviderConfig = {
  id: 'openai',
  apiKey: 'sk-test',
  model: 'gpt-5',
  baseUrl: 'https://api.openai.com/v1',
  maxTokens: 16000,
};

const REQ: ChatRequest = {
  system: 'あなたは DVM のアシスタントです',
  messages: [{ role: 'user', content: 'こんにちは' }],
  tools: [],
  signal: new AbortController().signal,
};

/** チャンクを順に食わせて、出てきたイベントを集める */
function run(chunks: Record<string, unknown>[]): StreamEvent[] {
  const state = newState();
  const out: StreamEvent[] = [];
  for (const c of chunks) out.push(...parseChunk(state, c));
  out.push(...finish(state));
  return out;
}

const delta = (d: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ delta: d, finish_reason }],
});

describe('buildRequest', () => {
  it('Chat Completions のエンドポイントを組み立てる', () => {
    expect(buildRequest(CFG, REQ).url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('キーがあれば Bearer で送る', () => {
    expect(buildRequest(CFG, REQ).headers.authorization).toBe('Bearer sk-test');
  });

  it('**キーが空なら Authorization ごと省く**(Ollama / LM Studio が空 Bearer で 401 を返すため)', () => {
    const h = buildRequest({ ...CFG, id: 'openai_compat', apiKey: '' }, REQ).headers;
    expect(h.authorization).toBeUndefined();
  });

  it('openai では max_completion_tokens を使う(新しい推論モデルが max_tokens を拒否する)', () => {
    const body = JSON.parse(buildRequest(CFG, REQ).body) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(16000);
    expect(body.max_tokens).toBeUndefined();
  });

  it('**互換サーバーには上限も stream_options も送らない**(未知のキーで 400 になるのを避ける)', () => {
    const body = JSON.parse(
      buildRequest({ ...CFG, id: 'openai_compat', baseUrl: 'http://localhost:11434/v1' }, REQ).body,
    ) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  it('ツールが無いときは tools を送らない', () => {
    const body = JSON.parse(buildRequest(CFG, REQ).body) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });
});

describe('toWireMessages', () => {
  it('system を messages の先頭に置く', () => {
    const out = toWireMessages('sys', []) as Record<string, unknown>[];
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('ツールだけ呼んだターンは content を null にする', () => {
    const msgs: AiMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', input: { x: 1 } }] },
    ];
    const out = toWireMessages('s', msgs) as Record<string, unknown>[];
    expect(out[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } }],
    });
  });

  it('**ツール結果は 1 件 1 メッセージ**(Anthropic は 1 通にまとめるのでここが最も違う)', () => {
    const msgs: AiMessage[] = [
      {
        role: 'tool',
        results: [
          { id: 'c1', name: 'a', content: 'A' },
          { id: 'c2', name: 'b', content: 'B' },
        ],
      },
    ];
    const out = toWireMessages('s', msgs) as Record<string, unknown>[];
    expect(out.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'tool', tool_call_id: 'c2', content: 'B' },
    ]);
  });
});

describe('parseChunk — テキスト', () => {
  it('delta.content を text として流す', () => {
    const events = run([delta({ content: 'こん' }), delta({ content: 'にちは' }, 'stop')]);
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'こん' },
      { type: 'text', text: 'にちは' },
    ]);
    const end = events.slice(-1)[0];
    expect(end).toMatchObject({ type: 'end', stopReason: 'end' });
    expect((end as { assistant: { content: string } }).assistant.content).toBe('こんにちは');
  });

  it('finish_reason を StopReason に写す', () => {
    expect(run([delta({}, 'length')]).slice(-1)[0]).toMatchObject({ stopReason: 'max_tokens' });
    expect(run([delta({}, 'tool_calls')]).slice(-1)[0]).toMatchObject({ stopReason: 'tool_use' });
    expect(run([delta({}, 'content_filter')]).slice(-1)[0]).toMatchObject({ stopReason: 'refusal' });
  });
});

describe('parseChunk — tool_calls の断片を index で結合する', () => {
  it('id と name は最初の断片だけ、arguments は分割されて届く', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'apply_filter', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"min' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'Rating"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':4}' } }] }),
      delta({}, 'tool_calls'),
    ]);
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toEqual([
      { type: 'tool_call', call: { id: 'call_abc', name: 'apply_filter', input: { minRating: 4 } } },
    ]);
  });

  it('2 本同時に呼ばれても index で混ざらない', () => {
    const events = run([
      delta({
        tool_calls: [
          { index: 0, id: 'c0', function: { name: 'a', arguments: '{"x"' } },
          { index: 1, id: 'c1', function: { name: 'b', arguments: '{"y"' } },
        ],
      }),
      delta({
        tool_calls: [
          { index: 1, function: { arguments: ':2}' } },
          { index: 0, function: { arguments: ':1}' } },
        ],
      }),
      delta({}, 'tool_calls'),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'c0', name: 'a', input: { x: 1 } } },
      { type: 'tool_call', call: { id: 'c1', name: 'b', input: { y: 2 } } },
    ]);
  });

  it('**index を省く互換サーバー**では配列の位置で代用する', () => {
    const events = run([
      delta({ tool_calls: [{ id: 'c0', function: { name: 'a', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'c0', name: 'a', input: {} } },
    ]);
  });

  it('id を返さない互換サーバーでも突き合わせ用の id を作る', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, function: { name: 'a', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')[0]).toMatchObject({
      call: { id: 'call_0', name: 'a' },
    });
  });

  it('引数が空文字で終わっても {} にする', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'list_tags', arguments: '' } }] }),
      delta({}, 'tool_calls'),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')[0]).toMatchObject({ call: { input: {} } });
  });

  it('壊れた JSON は投げずに parseError に落とす', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x"' } }] }),
      delta({}, 'tool_calls'),
    ]);
    const call = events.filter((e) => e.type === 'tool_call')[0] as { call: { parseError?: string } };
    expect(call.call.parseError).toMatch(/壊れています/);
  });

  it('**finish_reason が来ないまま切れても**確定させる(互換サーバーへの保険)', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }] }),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(events.slice(-1)[0]).toMatchObject({ stopReason: 'tool_use' });
  });

  it('同じツールを二重に確定させない', () => {
    const events = run([
      delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });
});

describe('parseChunk — usage', () => {
  it('stream_options で最後に届く usage を拾う', () => {
    const events = run([{ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }]);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 120, outputTokens: 30 });
  });

  it('usage: null(途中のチャンク)で落ちない', () => {
    expect(() => run([{ choices: [], usage: null }])).not.toThrow();
  });
});
