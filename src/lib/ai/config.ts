/*
 * AI 設定の読み書き(v1.43)。
 *
 * **プロバイダごとに別のキーで持つ。** 切り替えるたびに API キーを入れ直させないため。
 * Rust 側は汎用の key-value(`core/settings.rs` の 15 行)なので、ここはキー名の
 * 決め方と既定値の話だけになる。
 *
 * 既定値と正規化を 1 か所に集めてテストするのは `lib/settings.ts` の作法に倣ったもの
 * (v1.42 までは AI の既定値だけが AiPanel.tsx の中に孤立していた)。
 */

import { api } from '../../api';
import { normalizeBaseUrl, parseProviderId, PROVIDERS } from './providers';
import type { ProviderConfig, ProviderId } from './types';

export const PROVIDER_KEY = 'ai_provider';
export const MAX_TOKENS_KEY = 'ai_max_tokens';
/** ベース URL を持つのは openai_compat だけ(他は PROVIDERS の既定で足りる) */
export const BASE_URL_KEY = 'ai_base_url_openai_compat';

/** v1.42 までのキー。**消さない** —— 切り戻しても動くようにしておく */
export const LEGACY_KEY = 'anthropic_api_key';
export const LEGACY_MODEL = 'anthropic_model';

export function apiKeyKey(id: ProviderId): string {
  return `ai_api_key_${id}`;
}

export function modelKey(id: ProviderId): string {
  return `ai_model_${id}`;
}

export const MAX_TOKENS_DEFAULT = 16000;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 200000;

/** UI に出さない隠し設定。手で DB を書いた壊れた値もここを通る */
export function parseMaxTokens(raw: string | null): number {
  if (raw == null || raw.trim() === '') return MAX_TOKENS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MAX_TOKENS_DEFAULT;
  return Math.min(Math.max(Math.round(n), MAX_TOKENS_MIN), MAX_TOKENS_MAX);
}

/**
 * v1.42 の `anthropic_api_key` / `anthropic_model` を新キーへ写す値を決める(純関数)。
 *
 * **新キーが空のときだけ写す**(冪等)。旧キーは残したままにするので、
 * 何度呼んでも、古いバージョンに戻しても壊れない
 */
export function planMigration(
  legacy: { key: string | null; model: string | null },
  current: { key: string | null; model: string | null },
): { key?: string; model?: string } {
  const out: { key?: string; model?: string } = {};
  if (!current.key && legacy.key) out.key = legacy.key;
  if (!current.model && legacy.model) out.model = legacy.model;
  return out;
}

/** 設定を読んで、いま使うプロバイダの設定を組み立てる。必要なら旧キーの移行もする */
export async function loadAiConfig(): Promise<ProviderConfig> {
  const id = parseProviderId(await api.getSetting(PROVIDER_KEY));

  let apiKey = (await api.getSetting(apiKeyKey(id)))?.trim() ?? '';
  let model = (await api.getSetting(modelKey(id)))?.trim() ?? '';

  if (id === 'anthropic') {
    const plan = planMigration(
      {
        key: (await api.getSetting(LEGACY_KEY))?.trim() ?? null,
        model: (await api.getSetting(LEGACY_MODEL))?.trim() ?? null,
      },
      { key: apiKey || null, model: model || null },
    );
    if (plan.key) {
      apiKey = plan.key;
      await api.setSetting(apiKeyKey(id), plan.key);
    }
    if (plan.model) {
      model = plan.model;
      await api.setSetting(modelKey(id), plan.model);
    }
  }

  const info = PROVIDERS[id];
  const baseUrl =
    id === 'openai_compat'
      ? normalizeBaseUrl((await api.getSetting(BASE_URL_KEY)) ?? '')
      : info.baseUrl;

  return {
    id,
    apiKey,
    model: model || info.defaultModel,
    baseUrl,
    maxTokens: parseMaxTokens(await api.getSetting(MAX_TOKENS_KEY)),
  };
}

/** 設定が足りていないときの案内文。null なら送信できる */
export function missingSettingMessage(config: ProviderConfig): string | null {
  const label = PROVIDERS[config.id].label;
  if (config.id === 'openai_compat') {
    if (!config.baseUrl) return 'ベース URL が未設定です。設定 > AI 連携 で入力してください';
    if (!config.model) return 'モデル名が未設定です。設定 > AI 連携 で入力してください';
    return null;
  }
  // 互換サーバー以外はキーが要る
  if (!config.apiKey) {
    return `${label} の API キーが未設定です。ツールバーの設定ボタンから「AI 連携」で保存してください`;
  }
  return null;
}
