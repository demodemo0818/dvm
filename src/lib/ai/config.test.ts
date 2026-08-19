import { describe, expect, it } from 'vitest';
import { apiKeyKey, MAX_TOKENS_DEFAULT, modelKey, parseMaxTokens, planMigration } from './config';
import { classifyHttpError, extractMessage } from './errors';
import { normalizeBaseUrl, parseProviderId } from './providers';

describe('設定キーの組み立て', () => {
  it('プロバイダごとに別のキーになる(切り替えてもキーを失わない)', () => {
    expect(apiKeyKey('anthropic')).toBe('ai_api_key_anthropic');
    expect(apiKeyKey('openai')).toBe('ai_api_key_openai');
    expect(modelKey('gemini')).toBe('ai_model_gemini');
    expect(modelKey('openai_compat')).toBe('ai_model_openai_compat');
  });
});

describe('parseProviderId', () => {
  it('未設定なら anthropic', () => {
    expect(parseProviderId(null)).toBe('anthropic');
  });

  it('**知らない値は anthropic に落とす**(手で DB を書いた値や消えたプロバイダの残骸に備える)', () => {
    expect(parseProviderId('llama-inc')).toBe('anthropic');
    expect(parseProviderId('')).toBe('anthropic');
  });

  it('知っている値はそのまま', () => {
    expect(parseProviderId('openai')).toBe('openai');
    expect(parseProviderId('openai_compat')).toBe('openai_compat');
  });
});

describe('normalizeBaseUrl', () => {
  it('末尾の / を落とす(URL が二重スラッシュにならないように)', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://localhost:11434/v1///')).toBe('http://localhost:11434/v1');
  });

  it('前後の空白を落とす(貼り付けたときに混ざる)', () => {
    expect(normalizeBaseUrl('  https://openrouter.ai/api/v1  ')).toBe('https://openrouter.ai/api/v1');
  });
});

describe('parseMaxTokens', () => {
  it('未設定・空・壊れた値は既定に落とす', () => {
    expect(parseMaxTokens(null)).toBe(MAX_TOKENS_DEFAULT);
    expect(parseMaxTokens('  ')).toBe(MAX_TOKENS_DEFAULT);
    expect(parseMaxTokens('たくさん')).toBe(MAX_TOKENS_DEFAULT);
  });

  it('範囲外は丸める(0 を通すと応答が返らなくなる)', () => {
    expect(parseMaxTokens('0')).toBe(256);
    expect(parseMaxTokens('999999999')).toBe(200000);
  });

  it('妥当な値はそのまま', () => {
    expect(parseMaxTokens('8000')).toBe(8000);
  });
});

describe('planMigration(v1.42 の anthropic_* からの移行)', () => {
  it('新キーが空なら旧キーを写す', () => {
    expect(
      planMigration({ key: 'sk-ant-old', model: 'claude-opus-5' }, { key: null, model: null }),
    ).toEqual({ key: 'sk-ant-old', model: 'claude-opus-5' });
  });

  it('**新キーが既にあれば上書きしない**(冪等。何度呼んでも壊れない)', () => {
    expect(
      planMigration({ key: 'sk-ant-old', model: 'old-model' }, { key: 'sk-ant-new', model: 'new-model' }),
    ).toEqual({});
  });

  it('旧キーが無ければ何もしない(空文字の行を作らない)', () => {
    expect(planMigration({ key: null, model: null }, { key: null, model: null })).toEqual({});
  });

  it('片方だけの移行もできる(モデルだけ設定していた人)', () => {
    expect(planMigration({ key: null, model: 'claude-sonnet-5' }, { key: 'sk-new', model: null })).toEqual({
      model: 'claude-sonnet-5',
    });
  });
});

describe('extractMessage', () => {
  it('3 社共通の {error:{message}} を取り出す', () => {
    expect(extractMessage('{"error":{"message":"API key is invalid."}}')).toBe('API key is invalid.');
  });

  it('Ollama 系の {error: "..."} も読む', () => {
    expect(extractMessage('{"error":"model not found"}')).toBe('model not found');
  });

  it('JSON でない本文はそのまま返す(方言エラーを握り潰さない)', () => {
    expect(extractMessage('Bad Gateway')).toBe('Bad Gateway');
  });

  it('空なら空', () => {
    expect(extractMessage('  ')).toBe('');
  });
});

describe('classifyHttpError', () => {
  it('401 / 403 は auth', () => {
    expect(classifyHttpError(401, '{}').kind).toBe('auth');
    expect(classifyHttpError(403, '{}').kind).toBe('auth');
  });

  it('429 は rate_limit', () => {
    expect(classifyHttpError(429, '{}').kind).toBe('rate_limit');
  });

  it('404 と、model を含む 400 は model_not_found', () => {
    expect(classifyHttpError(404, '{}').kind).toBe('model_not_found');
    expect(classifyHttpError(400, '{"error":{"message":"model gpt-9 does not exist"}}').kind).toBe(
      'model_not_found',
    );
  });

  it('文脈長の超過を見分ける', () => {
    expect(
      classifyHttpError(400, '{"error":{"message":"maximum context length is 200000 tokens"}}').kind,
    ).toBe('context_length');
  });

  it('その他は api にして、**本文をメッセージに残す**', () => {
    const e = classifyHttpError(500, '{"error":{"message":"internal"}}');
    expect(e.kind).toBe('api');
    expect(e.message).toContain('internal');
    expect(e.body).toBe('{"error":{"message":"internal"}}');
  });
});
