/*
 * プロバイダの組み立て口(v1.43)。AiPanel はここしか見ない。
 */

import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';
import type { Provider, ProviderConfig } from './types';

export function createProvider(config: ProviderConfig): Provider {
  switch (config.id) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'gemini':
      return createGeminiProvider(config);
    // OpenAI 互換は方言の差だけなので同じアダプタ(差は buildRequest 内で吸収する)
    case 'openai':
    case 'openai_compat':
      return createOpenAiProvider(config);
  }
}

export { runToolLoop, type RunnerEvent } from './runner';
export * from './types';
