/*
 * ツールループ(v1.43)。
 *
 * v1.42 まで `client.beta.messages.toolRunner`(SDK 内の BetaToolRunner)がやっていた
 * 「呼び出しを取り出す → 実行する → 結果を戻して再送」を自前で書いたもの。
 * SDK と同じく**ツールは並列実行**する。
 *
 * v1.42 に無かったものを 2 つ足している:
 * - **反復上限**(既定 8)。以前は上限が無く、モデルが往復し続けると止まらなかった
 * - **中断**(AbortSignal)。受信の途中でも止まる
 */

import type { AiMessage, AiTool, Provider, ToolResult } from './types';
import { AiError } from './types';

export type RunnerEvent =
  | { type: 'text'; text: string }
  /** ツール実行を挟むターンの区切り(表示上の改行) */
  | { type: 'turn_break' }
  /** チャット内に出すカード(ツールの実行結果・エラー) */
  | { type: 'card'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finalText: string };

export interface RunOptions {
  provider: Provider;
  system: string;
  /** ターンをまたぐ履歴(テキストのみ)。呼び出し側が持つ配列のコピーを渡す */
  history: AiMessage[];
  userText: string;
  tools: AiTool[];
  signal: AbortSignal;
  /** ツール実行を挟む往復の上限。既定 8 */
  maxIterations?: number;
}

export async function* runToolLoop(opts: RunOptions): AsyncGenerator<RunnerEvent> {
  const { provider, system, tools, signal } = opts;
  const maxIterations = opts.maxIterations ?? 8;
  const byName = new Map(tools.map((t) => [t.def.name, t]));

  const working: AiMessage[] = [...opts.history, { role: 'user', content: opts.userText }];
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (signal.aborted) throw new AiError('aborted', '中断しました');

    let assistant: Extract<AiMessage, { role: 'assistant' }> | null = null;

    for await (const ev of provider.stream({
      system,
      messages: working,
      tools: tools.map((t) => t.def),
      signal,
    })) {
      if (ev.type === 'text') {
        yield { type: 'text', text: ev.text };
      } else if (ev.type === 'usage') {
        inputTokens += ev.inputTokens ?? 0;
        outputTokens += ev.outputTokens ?? 0;
      } else if (ev.type === 'end') {
        assistant = ev.assistant;
        // Gemini の安全フィルタなどで本文が空のまま終わることがある。無反応にしない
        if (ev.stopReason === 'refusal') {
          yield { type: 'card', text: 'モデルが応答を拒否しました' };
        } else if (ev.stopReason === 'max_tokens' && !ev.assistant.toolCalls?.length) {
          yield { type: 'card', text: '応答が長すぎて途中で切れました' };
        }
      }
    }

    if (!assistant) throw new AiError('parse', '応答が空のまま終わりました');
    if (assistant.content) finalText += (finalText ? '\n' : '') + assistant.content;
    working.push(assistant);

    const calls = assistant.toolCalls ?? [];
    if (calls.length === 0) break;

    yield { type: 'turn_break' };
    if (signal.aborted) throw new AiError('aborted', '中断しました');

    /*
     * **失敗をループの外へ投げない。** ツールが throw しても is_error として結果に載せ、
     * モデルに見せる。タグ名の解決に失敗したときなど、モデルは言い直せることが多い
     * (投げてしまうと会話ごと落ちる)
     */
    const results: ToolResult[] = await Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        if (call.parseError) {
          return { id: call.id, name: call.name, content: call.parseError, isError: true };
        }
        const tool = byName.get(call.name);
        if (!tool) {
          return {
            id: call.id,
            name: call.name,
            content: `そのツールはありません: ${call.name}`,
            isError: true,
          };
        }
        try {
          return { id: call.id, name: call.name, content: await tool.run(call.input) };
        } catch (e) {
          return {
            id: call.id,
            name: call.name,
            content: `エラー: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
          };
        }
      }),
    );

    for (const r of results) {
      if (r.isError) yield { type: 'card', text: r.content };
    }
    working.push({ role: 'tool', results });

    if (i === maxIterations - 1) {
      yield { type: 'card', text: `ツールの実行が上限(${maxIterations} 回)に達しました` };
    }
  }

  if (inputTokens > 0 || outputTokens > 0) yield { type: 'usage', inputTokens, outputTokens };
  yield { type: 'done', finalText };
}
