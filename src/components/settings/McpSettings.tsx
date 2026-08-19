import { useState } from 'react';
import { copyText } from '../../lib/clipboard';
import {
  CLAUDE_DESKTOP_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  VSCODE_MCP_CONFIG,
  claudeCodeCommand,
  codexConfigToml,
  mcpServersJson,
  vscodeMcpJson,
} from '../../lib/mcpConfig';

type Client = 'desktop' | 'code' | 'codex' | 'gemini' | 'vscode' | 'other';

const CLIENTS: { key: Client; label: string }[] = [
  { key: 'desktop', label: 'Claude Desktop' },
  { key: 'code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex CLI' },
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'vscode', label: 'VS Code' },
  { key: 'other', label: 'その他のアプリ' },
];

const HOWTO: Record<Client, string> = {
  desktop:
    `Claude Desktop の 設定 → 開発者 → 「構成を編集」で ${CLAUDE_DESKTOP_CONFIG} を開き、` +
    '上の内容を貼り付けて Claude Desktop を再起動してください。' +
    'すでに mcpServers がある場合は "dvm": { ... } の部分だけをその中に足します',
  code:
    'PowerShell かコマンドプロンプトに貼り付けて実行してください。' +
    'そのあと claude mcp list で「dvm ... Connected」と出れば成功です',
  codex:
    `${CODEX_CONFIG} を開いて末尾に貼り付けてください(ファイルが無ければ新しく作ります)。` +
    'そのあと codex を起動し直すと使えるようになります',
  gemini:
    `${GEMINI_CLI_CONFIG} を開いて貼り付けてください(ファイルが無ければ新しく作ります)。` +
    'そのあと gemini を起動し直し、/mcp で「dvm」が出れば成功です',
  vscode:
    `${VSCODE_MCP_CONFIG} を開いて貼り付けてください` +
    '(コマンドパレットの「MCP: Open User Configuration」でも開けます)。' +
    'VS Code だけ mcpServers ではなく servers 形式で、type の指定が要ります',
  other:
    'Cursor・Cline・Windsurf など、mcpServers 形式に対応した MCP クライアントで同じ設定が使えます。' +
    'それぞれの設定ファイルに貼り付けてアプリを再起動してください',
};

/**
 * JSON を貼り付けるクライアント共通の注意。
 * 中身が空でない設定ファイルに継ぎ足すとき、直前の行のカンマを忘れるのが定番の事故で、
 * JSON が壊れると設定を読めずにアプリ自体が起動しなくなる(実際に踏んだので明記する)
 */
const JSON_CAVEAT =
  '設定ファイルに既に中身がある場合、貼り付ける直前の行の末尾に , が要ります。' +
  'これが抜けると JSON として壊れ、AI アプリが起動時にエラーになります';

/** TOML はカンマの問題が無い代わりに、セクションの入れ子で事故る */
const TOML_CAVEAT =
  '設定ファイルに既に [mcp_servers.○○] がある場合は、上のセクションをそのまま末尾に足してください。' +
  '既存のセクションの中に入れると別のサーバーの設定として読まれます';

export function McpSettings({
  exePath,
  allowWrite,
  onAllowWriteChange,
  libraryName,
}: {
  /** undefined は取得中。null は同梱されていない(この 2 つで出す文言が変わる) */
  exePath: string | null | undefined;
  allowWrite: boolean;
  onAllowWriteChange: (v: boolean) => void;
  /** いま開いているライブラリ(v1.27)。設定を貼り直す必要が無いことを説明するために出す */
  libraryName?: string;
}) {
  const [client, setClient] = useState<Client>('desktop');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };

  const snippet = !exePath
    ? ''
    : client === 'code'
      ? claudeCodeCommand({ exePath, allowWrite })
      : client === 'codex'
        ? codexConfigToml({ exePath, allowWrite })
        : client === 'vscode'
          ? vscodeMcpJson({ exePath, allowWrite })
          : // Claude Desktop / Gemini CLI / その他 は同じ mcpServers 形式
            mcpServersJson({ exePath, allowWrite });

  return (
    <div className="settings-section">
      <div className="settings-heading">MCP 連携(外部の AI から操作する)</div>
      <div className="settings-note">
        Claude Desktop などの AI アプリからライブラリを直接検索・整理できるようにします。
        「タグの付いていない動画を 20 件見せて」「このシリーズに評価を付けて」のように話しかけるだけです。
        DVM を起動していなくても動きます
      </div>
      <div className="settings-note">
        AI が見るのは<b>いま DVM で開いているライブラリ</b>
        {libraryName ? `(現在:「${libraryName}」)` : ''}です。
        別のライブラリに切り替えると AI 側もそのまま追従するので、設定を貼り直す必要はありません
      </div>

      {exePath === undefined ? null : !exePath ? (
        <div className="settings-note">
          MCP サーバー(dvm-mcp.exe)が見つかりません。開発環境で動かしている場合は
          <code> npm run build:mcp </code>
          を実行すると配置されます
        </div>
      ) : (
        <>
          <label className="modal-label">サーバーの場所</label>
          <div className="modal-row">
            <input readOnly value={exePath} title={exePath} />
            <button onClick={() => copy('path', exePath)}>
              {copied === 'path' ? 'コピーしました' : 'コピー'}
            </button>
          </div>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={allowWrite}
              onChange={(e) => onAllowWriteChange(e.target.checked)}
            />
            AI からの変更を許可する(タグ・レーティング・シリーズの編集)
          </label>
          <div className="settings-note">
            オフのままなら DB を読み取り専用で開くので、AI はライブラリを一切変更できません。
            オンにした場合も、ファイルをごみ箱へ送る操作だけは必ず対象一覧の確認を挟みます
          </div>

          <label className="modal-label">貼り付ける設定</label>
          <div className="mcp-tabs">
            {CLIENTS.map((c) => (
              <button
                key={c.key}
                className={client === c.key ? 'mcp-tab active' : 'mcp-tab'}
                onClick={() => setClient(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <pre className="mcp-snippet">{snippet}</pre>
          <div className="modal-row">
            <button onClick={() => copy('snippet', snippet)}>
              {copied === 'snippet' ? 'コピーしました' : 'コピー'}
            </button>
          </div>
          <div className="settings-note">{HOWTO[client]}</div>
          {client === 'codex' ? (
            <div className="settings-note warn">{TOML_CAVEAT}</div>
          ) : (
            client !== 'code' && <div className="settings-note warn">{JSON_CAVEAT}</div>
          )}
        </>
      )}
    </div>
  );
}
