import { useTextSetting } from '../../hooks/useSetting';
import { apiKeyKey, BASE_URL_KEY, modelKey } from '../../lib/ai/config';
import { COMPAT_PRESETS, normalizeBaseUrl, PROVIDERS } from '../../lib/ai/providers';
import type { ProviderId } from '../../lib/ai/types';

/**
 * 選んだプロバイダの入力欄(v1.43)。
 *
 * **呼び出し側で `key={provider}` を付けて mount し直すこと。**
 * `useTextSetting` はキーが変わっても `dirty` / `saved` の ref をリセットしないので
 * (hooks/useSetting.ts:98-101, 131)、同じインスタンスのままキーだけ差し替えると
 * 前のプロバイダの入力が次のプロバイダのキーに書かれてしまう。
 * mount し直せば unmount の cleanup が走るので、**切り替えた瞬間に前のプロバイダの
 * 未確定の入力が保存される**という利点もある。
 */
export function AiProviderFields({ provider }: { provider: ProviderId }) {
  const info = PROVIDERS[provider];
  const apiKey = useTextSetting(apiKeyKey(provider));
  const model = useTextSetting(modelKey(provider));
  const baseUrl = useTextSetting(BASE_URL_KEY, { normalize: normalizeBaseUrl });
  const isCompat = provider === 'openai_compat';
  const listId = `ai-models-${provider}`;

  return (
    <>
      {isCompat && (
        <>
          <label className="modal-label">ベース URL</label>
          <div className="modal-row">
            <input
              value={baseUrl.value}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => baseUrl.edit(e.target.value)}
              onBlur={baseUrl.commit}
            />
          </div>
          <div className="mcp-tabs">
            {COMPAT_PRESETS.map((p) => (
              <button key={p.label} className="mcp-tab" onClick={() => baseUrl.save(p.baseUrl)}>
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="modal-label">
        API キー{isCompat ? '(ローカル LLM なら空欄のままで動きます)' : ''}
      </label>
      <div className="modal-row">
        <input
          type="password"
          value={apiKey.value}
          placeholder={info.keyPlaceholder}
          onChange={(e) => apiKey.edit(e.target.value)}
          onBlur={apiKey.commit}
        />
      </div>

      <label className="modal-label">
        モデル{info.defaultModel ? `(空欄なら ${info.defaultModel})` : ''}
      </label>
      <div className="modal-row">
        <input
          value={model.value}
          list={listId}
          placeholder={info.defaultModel || 'モデル名を入力'}
          onChange={(e) => model.edit(e.target.value)}
          onBlur={model.commit}
        />
        {/* 候補は出すが強制しない —— モデル名は数か月で古くなるので手打ちも通す */}
        <datalist id={listId}>
          {info.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div className="settings-note">{info.keyHint}</div>
    </>
  );
}
