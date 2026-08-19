import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useFlagSetting } from '../../hooks/useSetting';
import { loadAiConfig, PROVIDER_KEY } from '../../lib/ai/config';
import { PROVIDERS } from '../../lib/ai/providers';
import type { ProviderId } from '../../lib/ai/types';
import type { AppInfo } from '../../types';
import { AiProviderFields } from './AiProviderFields';
import { McpSettings } from './McpSettings';

const ORDER: ProviderId[] = ['anthropic', 'openai', 'gemini', 'openai_compat'];

/**
 * AI 連携(v1.38 で「AI アシスタント」と「MCP 連携」を 1 カテゴリにまとめた)。
 *
 * **2 つを並べたままにする** —— アプリ内のアシスタント(自分の API キーで動く)と
 * MCP(外部の AI アプリからライブラリを触らせる)は別物なので、隣に置いて
 * 違いが分かるようにする、というのが v1.21 からの判断(DESIGN.md 参照)。
 *
 * v1.43 でアシスタント側が複数プロバイダに対応した。**2 つの違いは「課金形態」ではなく
 * 「どこで動くか」で説明する** —— 以前は「アプリ内 = 従量課金 API / MCP = サブスク」と
 * 説明していたが、プロバイダが増えて(ローカル LLM も使える)その対比が成り立たなくなった
 */
export function AiSection({ info }: { info: AppInfo | null }) {
  const [provider, setProvider] = useState<ProviderId | null>(null);
  /** MCP の設定スニペットに DVM_ALLOW_WRITE を含めるか。表示用だが次回も同じ内容を出せるよう保存する */
  const [mcpAllowWrite, setMcpAllowWrite] = useFlagSetting('mcp_allow_write', false);

  /*
   * **先に loadAiConfig を通してから入力欄を出す。** v1.42 の anthropic_api_key を
   * 新キーへ写す移行がここで走るので、先に AiProviderFields を mount すると
   * 移行前の空を読んでしまう
   */
  useEffect(() => {
    void loadAiConfig().then((c) => setProvider(c.id));
  }, []);

  const pick = (id: ProviderId) => {
    setProvider(id);
    void api.setSetting(PROVIDER_KEY, id);
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-heading">AI アシスタント</div>
        <div className="settings-note">
          DVM の中で AI に話しかけて、ライブラリを検索したり画面を絞り込んだりできます。
          使う AI を選んで、その API キーを入れてください
        </div>
        <div className="mcp-tabs">
          {ORDER.map((id) => (
            <button
              key={id}
              className={provider === id ? 'mcp-tab active' : 'mcp-tab'}
              onClick={() => pick(id)}
            >
              {PROVIDERS[id].label}
            </button>
          ))}
        </div>
        {/* key で mount し直す(理由は AiProviderFields の doc コメント) */}
        {provider && <AiProviderFields key={provider} provider={provider} />}
        <div className="settings-note">
          キーは app.db に平文で保存されます(アプリ全体の設定なので、ライブラリを切り替えても
          入れ直す必要はありません)。プロバイダごとに別々に覚えるので、切り替えても消えません。
          利用量に応じて各社の API 料金が発生します(ローカル LLM なら無料です)
        </div>
        {provider === 'anthropic' && (
          <div className="settings-note">
            Claude Pro / Max のサブスクリプションでは使えません(API は従量課金の別契約です)。
            サブスクのまま使いたい場合は、下の MCP 連携をお使いください
          </div>
        )}
      </div>

      <McpSettings
        exePath={info ? info.mcpPath : undefined}
        allowWrite={mcpAllowWrite}
        onAllowWriteChange={setMcpAllowWrite}
        libraryName={info?.libraryName}
      />
    </>
  );
}
