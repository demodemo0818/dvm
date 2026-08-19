/*
 * Google Gemini アダプタ(v1.43)。
 *
 * 3 社のなかで形がいちばん違う:
 * - ロールが `user` / `model` の 2 つだけ(system も tool も無い)
 * - ツール結果は **user ロールの functionResponse パート**
 * - 呼び出し ID が無いので、名前で突き合わせる(こちらで合成する)
 * - `?alt=sse` を付けないと SSE ではなく JSON 配列が返る
 */

import { assembleSse } from './sse';
import { toGeminiTools } from './schema';
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

/** 会話履歴を Gemini の contents に変換する */
export function toContents(messages: AiMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: c.name, args: c.input } });
      }
      // 空の parts は弾かれるので、何も無ければ空文字を 1 つ入れる
      out.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    } else {
      out.push({
        // ツール結果も **user ロール**。response は**オブジェクト必須**で、
        // 文字列を直に入れると 400 になる
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.content } },
        })),
      });
    }
  }
  return out;
}

export function buildRequest(config: ProviderConfig, req: ChatRequest): WireRequest {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toContents(req.messages),
    generationConfig: { maxOutputTokens: config.maxTokens },
  };
  if (req.tools.length > 0) {
    body.tools = toGeminiTools(req.tools);
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return {
    // ?alt=sse が無いと SSE にならない(JSON 配列が一括で返る)
    url: `${config.baseUrl}/models/${config.model}:streamGenerateContent?alt=sse`,
    headers: {
      'content-type': 'application/json',
      // クエリの ?key= ではなくヘッダで渡す(URL にキーを載せない)
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify(body),
  };
}

function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'refusal';
    default:
      return 'other';
  }
}

export interface GeminiState {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** 呼び出し ID が無いので通し番号で作る */
  callSeq: number;
}

export function newState(): GeminiState {
  return { text: '', toolCalls: [], stopReason: 'other', callSeq: 0 };
}

export function parseChunk(state: GeminiState, json: Record<string, unknown>): StreamEvent[] {
  const out: StreamEvent[] = [];

  const usage = json.usageMetadata as Record<string, number> | undefined;
  if (usage) {
    out.push({
      type: 'usage',
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
    });
  }

  const cand = (json.candidates as Record<string, unknown>[] | undefined)?.[0];
  if (!cand) return out;

  const content = cand.content as Record<string, unknown> | undefined;
  for (const part of (content?.parts as Record<string, unknown>[] | undefined) ?? []) {
    // 思考パートは中身を出さない(合図だけ)
    if (part.thought === true) {
      out.push({ type: 'thinking' });
      continue;
    }
    if (typeof part.text === 'string' && part.text) {
      state.text += part.text;
      out.push({ type: 'text', text: part.text });
    }
    const fc = part.functionCall as Record<string, unknown> | undefined;
    if (fc) {
      // **args は既にオブジェクト**(OpenAI のような JSON 文字列ではない)
      const call: ToolCall = {
        id: `${fc.name as string}#${state.callSeq++}`,
        name: fc.name as string,
        input: (fc.args as Record<string, unknown>) ?? {},
      };
      state.toolCalls.push(call);
      out.push({ type: 'tool_call', call });
    }
  }

  if (cand.finishReason != null) state.stopReason = mapFinishReason(cand.finishReason);
  return out;
}

export function finish(state: GeminiState): StreamEvent {
  // ツールを呼んだターンは STOP で終わるが、ループを続ける必要がある
  const stopReason = state.toolCalls.length > 0 && state.stopReason === 'end' ? 'tool_use' : state.stopReason;
  return {
    type: 'end',
    stopReason,
    assistant: {
      role: 'assistant',
      content: state.text,
      toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    },
  };
}

export function createGeminiProvider(config: ProviderConfig): Provider {
  return {
    id: 'gemini',
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const state = newState();
      for await (const msg of assembleSse(streamLines(buildRequest(config, req), req.signal))) {
        if (!msg.data) continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const ev of parseChunk(state, json)) yield ev;
      }
      yield finish(state);
    },
  };
}
