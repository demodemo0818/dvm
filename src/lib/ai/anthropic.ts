/*
 * Anthropic アダプタ(v1.43)。
 *
 * v1.42 まで `@anthropic-ai/sdk` の `toolRunner` がやっていたことを自前で書き直したもの。
 * SDK が実際に送っていたもの(`?beta=true` / `anthropic-version` /
 * `anthropic-dangerous-direct-browser-access`)をそのまま再現している。
 */

import { assembleSse } from './sse';
import { toAnthropicTools } from './schema';
import { streamLines, type WireRequest } from './transport';
import {
  AiError,
  type AiMessage,
  type ChatRequest,
  type Provider,
  type ProviderConfig,
  type StopReason,
  type StreamEvent,
  type ToolCall,
} from './types';

/** 会話履歴を Anthropic の messages に変換する */
export function toWireMessages(messages: AiMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      /*
       * **thinking を有効にしていると、生のブロックをそのまま戻す必要がある。**
       * signature 付きの thinking ブロックを落として組み直すと、次のターンで
       * 400 になる(SDK の toolRunner は msg.content を丸ごと積むので自動的に
       * 満たしていた)。raw があるときは verbatim に戻す
       */
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.blocks)) {
        out.push({ role: 'assistant', content: m.raw.blocks });
        continue;
      }
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : m.content });
    } else {
      // ツール結果は **user ロール**でまとめて 1 通(OpenAI と最も形が違うところ)
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

export function buildRequest(config: ProviderConfig, req: ChatRequest): WireRequest {
  return {
    url: `${config.baseUrl}/v1/messages?beta=true`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // ブラウザ直叩き用のヘッダ。Rust 経由になった今も付けたままにする(害はない)
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: req.system,
      messages: toWireMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      thinking: { type: 'adaptive' },
      stream: true,
    }),
  };
}

function mapStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** ストリームの途中状態。テストから触れるよう明示的に持つ */
export interface AnthropicState {
  /** 組み立て中の生ブロック(そのまま次のターンへ戻す) */
  blocks: Record<string, unknown>[];
  /** tool_use の input は partial_json の断片で届くので、確定するまで貯める */
  partialJson: Map<number, string>;
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

export function newState(): AnthropicState {
  return { blocks: [], partialJson: new Map(), text: '', toolCalls: [], stopReason: 'other' };
}

/** SSE のイベント 1 つを食わせて、UI に流すイベントを返す */
export function parseChunk(state: AnthropicState, json: Record<string, unknown>): StreamEvent[] {
  const out: StreamEvent[] = [];
  const type = json.type as string;

  if (type === 'message_start') {
    const usage = (json.message as Record<string, unknown> | undefined)?.usage as
      | Record<string, number>
      | undefined;
    if (usage) out.push({ type: 'usage', inputTokens: usage.input_tokens });
    return out;
  }

  if (type === 'content_block_start') {
    const idx = json.index as number;
    const block = { ...(json.content_block as Record<string, unknown>) };
    state.blocks[idx] = block;
    if (block.type === 'thinking') out.push({ type: 'thinking' });
    if (block.type === 'tool_use') state.partialJson.set(idx, '');
    return out;
  }

  if (type === 'content_block_delta') {
    const idx = json.index as number;
    const delta = json.delta as Record<string, unknown>;
    const block = state.blocks[idx] ?? {};
    switch (delta.type) {
      case 'text_delta': {
        const t = delta.text as string;
        state.text += t;
        block.text = ((block.text as string) ?? '') + t;
        out.push({ type: 'text', text: t });
        break;
      }
      case 'thinking_delta':
        block.thinking = ((block.thinking as string) ?? '') + (delta.thinking as string);
        break;
      case 'signature_delta':
        // これが無いと次のターンで 400 になる。必ず生ブロックに戻す
        block.signature = ((block.signature as string) ?? '') + (delta.signature as string);
        break;
      case 'input_json_delta':
        state.partialJson.set(idx, (state.partialJson.get(idx) ?? '') + (delta.partial_json as string));
        break;
    }
    state.blocks[idx] = block;
    return out;
  }

  if (type === 'content_block_stop') {
    const idx = json.index as number;
    const block = state.blocks[idx];
    if (block?.type === 'tool_use') {
      const raw = state.partialJson.get(idx) ?? '';
      const call: ToolCall = { id: block.id as string, name: block.name as string, input: {} };
      try {
        // 引数なしのツールは空文字で終わる
        call.input = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        call.parseError = `引数の JSON が壊れています: ${e instanceof Error ? e.message : String(e)}`;
      }
      block.input = call.input;
      state.toolCalls.push(call);
      out.push({ type: 'tool_call', call });
    }
    return out;
  }

  if (type === 'message_delta') {
    const delta = json.delta as Record<string, unknown> | undefined;
    if (delta?.stop_reason !== undefined) state.stopReason = mapStopReason(delta.stop_reason);
    const usage = json.usage as Record<string, number> | undefined;
    if (usage) out.push({ type: 'usage', outputTokens: usage.output_tokens });
    return out;
  }

  if (type === 'error') {
    const err = json.error as Record<string, unknown> | undefined;
    throw new AiError('api', `API エラー: ${(err?.message as string) ?? 'unknown'}`);
  }

  return out;
}

export function finish(state: AnthropicState): StreamEvent {
  return {
    type: 'end',
    stopReason: state.stopReason,
    assistant: {
      role: 'assistant',
      content: state.text,
      toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      raw: { provider: 'anthropic', blocks: state.blocks.filter(Boolean) },
    },
  };
}

export function createAnthropicProvider(config: ProviderConfig): Provider {
  return {
    id: 'anthropic',
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const state = newState();
      const wire = buildRequest(config, req);
      for await (const msg of assembleSse(streamLines(wire, req.signal))) {
        if (!msg.data) continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue; // 壊れた行は捨てる(keep-alive など)
        }
        for (const ev of parseChunk(state, json)) yield ev;
      }
      yield finish(state);
    },
  };
}
