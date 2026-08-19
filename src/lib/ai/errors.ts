/*
 * HTTP エラーを共通の AiError に分類する(v1.43)。
 *
 * v1.42 までは `e instanceof Anthropic.AuthenticationError` で見ていたが、
 * プロバイダが増えると SDK の例外型に頼れないのでステータスと本文から判断する。
 * **本文は必ず持ち回す** —— OpenAI 互換サーバー(Ollama / LM Studio / OpenRouter)の
 * 方言エラーはここにしか出ないので、握り潰すと原因が分からなくなる
 */

import { AiError } from './types';

/**
 * エラー本文から人が読む 1 行を取り出す。
 * 3 社とも `{"error": {"message": ...}}` の形だが、互換サーバーは素の文字列を返すこともある
 */
export function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const err = j.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
    // Ollama は {"error": "..."} ではなく {"message": "..."} を返すことがある
    if (typeof j.message === 'string') return j.message;
    return trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

export function classifyHttpError(status: number, body: string): AiError {
  const detail = extractMessage(body);
  const lower = detail.toLowerCase();

  if (status === 401 || status === 403) {
    return new AiError('auth', 'API キーが無効です。設定 > AI 連携 を確認してください', status, body);
  }
  if (status === 429) {
    return new AiError(
      'rate_limit',
      `レート制限に達しました。少し待ってから試してください${detail ? `(${detail})` : ''}`,
      status,
      body,
    );
  }
  // モデル名の打ち間違いは頻出なので専用の文言にする(404 のほか 400 でも来る)
  if (status === 404 || (status === 400 && /model/.test(lower))) {
    return new AiError(
      'model_not_found',
      `モデルが見つかりません。設定 > AI 連携 のモデル名を確認してください(${detail || status})`,
      status,
      body,
    );
  }
  if (/context length|too many tokens|maximum context|token count/.test(lower)) {
    return new AiError(
      'context_length',
      `会話が長くなりすぎました。ゴミ箱ボタンで会話をクリアしてください(${detail})`,
      status,
      body,
    );
  }
  return new AiError('api', `API エラー (${status})${detail ? `: ${detail}` : ''}`, status, body);
}
