/*
 * アプリ内 AI アシスタントの、プロバイダに依存しない共通型(v1.43)。
 *
 * v1.42 までは `@anthropic-ai/sdk` の型をそのまま使っていたが、OpenAI / Gemini /
 * OpenAI 互換エンドポイントを足すにあたって、ここに中立な形を 1 つ置いて
 * 各アダプタが自社形式との変換を受け持つ形にした。
 *
 * **このファイルは実装を持たない。** アダプタ(anthropic.ts / openai.ts / gemini.ts)が
 * この型に正規化し、runner.ts と AiPanel.tsx はここしか知らない。
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai_compat';

/**
 * Rust の `ai_stream` が Channel に流してくるもの(`commands/ai.rs` の `AiEvent` と対)。
 * **`done` は必ず最後に 1 回だけ届く**
 */
export type AiWireEvent =
  | { type: 'line'; data: string }
  | { type: 'http_error'; status: number; body: string }
  | { type: 'done' };

// ---------------------------------------------------------------- スキーマ

/**
 * ツールの入力スキーマに使ってよい JSON Schema の部分集合。
 *
 * DVM のツール 7 本が実際に使っているのは下記の 8 キーワードだけで、
 * `$ref` / `oneOf` / `anyOf` / `nullable` / `additionalProperties` / ネストした
 * オブジェクトは 1 つも使っていない。**この狭さが 3 社への素通しを可能にしている**ので、
 * 条件を足すときもここから外れないようにすること
 */
export interface JsonSchemaProp {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' | 'integer' };
  minimum?: number;
  maximum?: number;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: readonly string[];
}

/** ツールの宣言。**run を含めない**のが `betaTool` との違い(宣言と実行を分ける) */
export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolSchema;
}

/** 宣言 + 実行。`buildTools(notify)` が返す単位 */
export interface AiTool {
  def: ToolDef;
  run: (input: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------- メッセージ

export interface ToolCall {
  /** プロバイダの呼び出し ID。**Gemini には無い**ので `${name}#${index}` を合成する */
  id: string;
  name: string;
  /** パース済みの引数。壊れた JSON でも投げず、{} + parseError にする */
  input: Record<string, unknown>;
  /** 引数の JSON が壊れていたときの理由。**あるツールは実行しない** */
  parseError?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type AiMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /**
       * プロバイダ固有の生ブロック。**ターン内でだけ使い、ターンをまたぐ履歴には積まない**。
       *
       * Anthropic は thinking を有効にしたまま tool_use を返したとき、tool_result を
       * 返すターンで thinking ブロックを `signature` 付きのまま戻さないと 400 になる。
       * テキストと tool_use だけ組み直すと壊れるので、生のブロック配列をここに持って
       * 次のリクエストへ verbatim に戻す。provider が食い違うアダプタは黙って無視して
       * content から組み直す
       */
      raw?: { provider: ProviderId; blocks: unknown };
    }
  | { role: 'tool'; results: ToolResult[] };

// ---------------------------------------------------------------- ストリーム

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type StreamEvent =
  | { type: 'text'; text: string }
  /** 思考が始まった合図。**中身は出さない**(表示するのは「考え中…」だけ) */
  | { type: 'thinking' }
  /** ツール呼び出しが 1 本確定した時点で 1 回 */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | {
      type: 'end';
      stopReason: StopReason;
      assistant: Extract<AiMessage, { role: 'assistant' }>;
    };

// ---------------------------------------------------------------- エラー

export type AiErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'model_not_found'
  | 'context_length'
  | 'network'
  | 'aborted'
  | 'api'
  | 'parse';

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
    /** サーバーが返した本文。**握り潰さない** —— 互換サーバーの方言エラーはここにしか出ない */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// ---------------------------------------------------------------- プロバイダ

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  model: string;
  /** 末尾の / を落として正規化済み。openai_compat のときだけユーザー入力 */
  baseUrl: string;
  maxTokens: number;
}

export interface ChatRequest {
  system: string;
  messages: AiMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
}

export interface Provider {
  readonly id: ProviderId;
  /** 1 ターン分。ネットワーク I/O はここだけ */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}
