/*
 * AI プロバイダへの唯一の出入口(v1.43)。
 *
 * **なぜ fetch ではなく Rust 経由なのか** —— OpenAI はプリフライトの応答に
 * Access-Control-Allow-Origin を返さないので、Authorization を付けた POST が
 * WebView から一切通らない(実測。詳細は src-tauri/src/core/ai_http.rs)。
 * Anthropic と Gemini は fetch でも通るが、2 経路を保守するのと、dev
 * (http://localhost:1420)と配布版(http://tauri.localhost)で origin が変わる
 * のを避けたいので **3 社ともここを通す**。
 *
 * ここは行を流すだけで、SSE の解釈もプロバイダの方言も知らない。
 */

import { Channel } from '@tauri-apps/api/core';
import { api } from '../../api';
import { classifyHttpError } from './errors';
import { AiError, type AiWireEvent } from './types';

export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  /** そのまま送る JSON 文字列 */
  body: string;
}

/** Rust 側の中断に使う id。プロセス内で一意なら十分 */
let nextRequestId = 1;

/**
 * POST して SSE の行を流す。`signal` で中断できる。
 *
 * 失敗は AiError で投げる(HTTP エラーは分類済み、通信断は 'network'、中断は 'aborted')
 */
export async function* streamLines(
  req: WireRequest,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (signal.aborted) throw new AiError('aborted', '中断しました');

  const requestId = nextRequestId++;
  const queue: string[] = [];
  let failure: AiError | null = null;
  let finished = false;
  /** 次の行が届く(か終わる)まで眠るための起こし役 */
  let wake: (() => void) | null = null;
  const bump = () => {
    wake?.();
    wake = null;
  };

  const channel = new Channel<AiWireEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === 'line') {
      queue.push(ev.data);
    } else if (ev.type === 'http_error') {
      failure = classifyHttpError(ev.status, ev.body);
      finished = true;
    } else {
      finished = true;
    }
    bump();
  };

  const onAbort = () => {
    void api.aiCancel(requestId);
    bump();
  };
  signal.addEventListener('abort', onAbort);

  void api
    .aiStream(requestId, req.url, req.headers, req.body, channel)
    .catch((e: unknown) => {
      // HTTP エラーは http_error で来るので、ここに来るのは接続断・DNS・中断
      if (!failure) {
        failure = signal.aborted
          ? new AiError('aborted', '中断しました')
          : new AiError('network', `接続できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
    .finally(() => {
      finished = true;
      bump();
    });

  try {
    for (;;) {
      // 溜まっている行を先に吐き切る(終了フラグより優先。取りこぼさないため)
      while (queue.length > 0) yield queue.shift() as string;
      if (failure) throw failure;
      // 中断は正常終了と区別する。Rust 側は中断でも Ok(()) を返すのでここで判定する
      if (signal.aborted) throw new AiError('aborted', '中断しました');
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // 消費側が途中で break したときに Rust を走らせっぱなしにしない
    if (!finished) void api.aiCancel(requestId);
  }
}
