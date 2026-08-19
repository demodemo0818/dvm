/*
 * OpenAI アダプタ(v1.43)。**Chat Completions** を使う(Responses API ではない)。
 *
 * OpenRouter / Ollama / LM Studio / Azure の互換パスがどれも Chat Completions 方言なので、
 * このアダプタ 1 本で `openai` と `openai_compat` の両方を賄える。
 * 互換サーバー向けには「余計なフィールドを送らない」方針をとる(未知のキーで 400 を返す
 * 実装が実在するため。どのフィールドを落とすかは buildRequest のコメント参照)。
 */

import { assembleSse } from './sse';
import { toOpenAITools } from './schema';
import { streamLines, type WireRequest } from './transport';
import {
  type AiMessage,
  type ChatRequest,
  type Provider,
  type ProviderConfig,
  type StopReason,
  type StreamEvent,
  type ToolCall,
} from './types';

/** 会話履歴を OpenAI の messages に変換する */
export function toWireMessages(system: string, messages: AiMessage[]): unknown[] {
  // system は独立したロールではなく messages の先頭に置く(developer は互換サーバーが知らない)
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        // ツールだけ呼んだターンは content が空。null にするのが仕様
        content: m.content || null,
      };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      out.push(msg);
    } else {
      // **ツール結果は 1 件 1 メッセージ**(Anthropic の「1 通にまとめる」と最も違うところ)
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

export function buildRequest(config: ProviderConfig, req: ChatRequest): WireRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // **キーが空なら Authorization ごと省く** —— Ollama / LM Studio は空の Bearer で 401 を返す
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: toWireMessages(req.system, req.messages),
    stream: true,
  };
  if (req.tools.length > 0) body.tools = toOpenAITools(req.tools);

  if (config.id === 'openai') {
    // 新しい推論モデルは max_tokens を拒否するので max_completion_tokens を使う。
    // 互換サーバーはどちらも知らないことがあるので **compat では上限を送らない**
    body.max_completion_tokens = config.maxTokens;
    body.stream_options = { include_usage: true };
  }
  return { url: `${config.baseUrl}/chat/completions`, headers, body: JSON.stringify(body) };
}

function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

export interface OpenAiState {
  text: string;
  /** index ごとに断片を貯める。**確定は finish_reason かストリーム終了時** */
  partial: Map<number, PartialCall>;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  emitted: boolean;
}

export function newState(): OpenAiState {
  return { text: '', partial: new Map(), toolCalls: [], stopReason: 'other', emitted: false };
}

/** 貯めた断片を ToolCall にする。壊れた JSON は投げずに parseError に落とす */
function settle(state: OpenAiState): StreamEvent[] {
  if (state.emitted) return [];
  state.emitted = true;
  const out: StreamEvent[] = [];
  for (const [, p] of [...state.partial.entries()].sort((a, b) => a[0] - b[0])) {
    const call: ToolCall = { id: p.id, name: p.name, input: {} };
    try {
      call.input = p.args.trim() === '' ? {} : (JSON.parse(p.args) as Record<string, unknown>);
    } catch (e) {
      call.parseError = `引数の JSON が壊れています: ${e instanceof Error ? e.message : String(e)}`;
    }
    state.toolCalls.push(call);
    out.push({ type: 'tool_call', call });
  }
  return out;
}

export function parseChunk(state: OpenAiState, json: Record<string, unknown>): StreamEvent[] {
  const out: StreamEvent[] = [];

  const usage = json.usage as Record<string, number> | null | undefined;
  if (usage) {
    out.push({
      type: 'usage',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    });
  }

  const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
  if (!choice) return out;

  const delta = choice.delta as Record<string, unknown> | undefined;
  if (delta) {
    if (typeof delta.content === 'string' && delta.content) {
      state.text += delta.content;
      out.push({ type: 'text', text: delta.content });
    }
    // 推論モデルは reasoning_content を返すことがある。中身は出さず合図だけ
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      out.push({ type: 'thinking' });
    }

    /*
     * **ツール呼び出しは index で結合する。**
     * 最初の断片だけが id と function.name を持ち、以降は arguments の断片しか来ない:
     *   {index:0, id:"call_abc", function:{name:"apply_filter", arguments:""}}
     *   {index:0, function:{arguments:"{\"min"}}
     *   {index:0, function:{arguments:"Rating\":4}"}}
     * **index を省く互換サーバーがある**ので、無ければ配列の位置で代用する
     */
    const calls = delta.tool_calls as Record<string, unknown>[] | undefined;
    if (calls) {
      calls.forEach((c, i) => {
        const idx = typeof c.index === 'number' ? c.index : i;
        const cur = state.partial.get(idx) ?? { id: '', name: '', args: '' };
        if (typeof c.id === 'string' && c.id) cur.id = c.id;
        const fn = c.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === 'string' && fn.name) cur.name = fn.name;
          if (typeof fn.arguments === 'string') cur.args += fn.arguments;
        }
        // id を返さない互換サーバー向け(結果を突き合わせられれば何でもよい)
        if (!cur.id) cur.id = `call_${idx}`;
        state.partial.set(idx, cur);
      });
    }
  }

  if (choice.finish_reason != null) {
    state.stopReason = mapFinishReason(choice.finish_reason);
    out.push(...settle(state));
  }
  return out;
}

export function finish(state: OpenAiState): StreamEvent[] {
  // finish_reason が来ないまま切れる互換サーバーへの保険
  const out = settle(state);
  if (state.stopReason === 'other' && state.toolCalls.length > 0) state.stopReason = 'tool_use';
  out.push({
    type: 'end',
    stopReason: state.stopReason,
    assistant: {
      role: 'assistant',
      content: state.text,
      toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    },
  });
  return out;
}

export function createOpenAiProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const state = newState();
      for await (const msg of assembleSse(streamLines(buildRequest(config, req), req.signal))) {
        if (!msg.data || msg.data === '[DONE]') continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const ev of parseChunk(state, json)) yield ev;
      }
      for (const ev of finish(state)) yield ev;
    },
  };
}
