import { useFlagSetting, useTextSetting } from '../../hooks/useSetting';
import type { AppInfo } from '../../types';
import { McpSettings } from './McpSettings';

/**
 * AI 連携(v1.38 で「AI アシスタント」と「MCP 連携」を 1 カテゴリにまとめた)。
 *
 * **2 つを並べたままにする** —— アプリ内のアシスタント(自分の API キーで動く)と
 * MCP(外部の AI アプリからライブラリを触らせる)は別物なので、隣に置いて
 * 違いが分かるようにする、というのが v1.21 からの判断(DESIGN.md 参照)。
 */
export function AiSection({ info }: { info: AppInfo | null }) {
  const aiKey = useTextSetting('anthropic_api_key');
  const aiModel = useTextSetting('anthropic_model');
  /** MCP の設定スニペットに DVM_ALLOW_WRITE を含めるか。表示用だが次回も同じ内容を出せるよう保存する */
  const [mcpAllowWrite, setMcpAllowWrite] = useFlagSetting('mcp_allow_write', false);

  return (
    <>
      <div className="settings-section">
        <div className="settings-heading">AI アシスタント</div>
        <label className="modal-label">Anthropic API キー(AI アシスタントで使用)</label>
        <div className="modal-row">
          <input
            type="password"
            value={aiKey.value}
            placeholder="sk-ant-..."
            onChange={(e) => aiKey.edit(e.target.value)}
            onBlur={aiKey.commit}
          />
        </div>
        <label className="modal-label">モデル(空欄なら claude-opus-5)</label>
        <div className="modal-row">
          <input
            value={aiModel.value}
            placeholder="claude-opus-5"
            onChange={(e) => aiModel.edit(e.target.value)}
            onBlur={aiModel.commit}
          />
        </div>
        <div className="settings-note">
          キーは app.db に平文で保存されます(アプリ全体の設定なので、ライブラリを切り替えても
          入れ直す必要はありません)。利用量に応じて Anthropic の API 料金が発生します
        </div>
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
