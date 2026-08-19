/**
 * 外部 AI クライアントに貼り付ける MCP 設定を組み立てる(設定画面の「MCP 連携」で使う)。
 *
 * DB の場所は dvm-mcp.exe 自身が %APPDATA%\jp.demo2.dvm\library.db を既定で開くので、
 * 通常は実行ファイルのパスだけ渡せばよい(別の場所を見せたいときは環境変数 DVM_DB)。
 */

/** クライアント側の設定に載るサーバー名。ユーザーが AI に「dvm で」と言えるよう短くしておく */
export const SERVER_NAME = 'dvm';

/** Claude Desktop の設定ファイル(Windows) */
export const CLAUDE_DESKTOP_CONFIG = '%APPDATA%\\Claude\\claude_desktop_config.json';

/** Codex CLI の設定ファイル(Windows) */
export const CODEX_CONFIG = '%USERPROFILE%\\.codex\\config.toml';

/** Gemini CLI の設定ファイル(Windows) */
export const GEMINI_CLI_CONFIG = '%USERPROFILE%\\.gemini\\settings.json';

/** VS Code の MCP 設定ファイル(Windows) */
export const VSCODE_MCP_CONFIG = '%APPDATA%\\Code\\User\\mcp.json';

export interface McpConfigInput {
  /** dvm-mcp.exe の絶対パス */
  exePath: string;
  /** true なら書き込みツール(タグ・レーティング・シリーズ等)を有効にする */
  allowWrite: boolean;
}

/**
 * mcpServers 形式の JSON。Claude Desktop のほか Cursor / Cline / VS Code など
 * 大半の MCP クライアントがこの形を使う
 */
export function mcpServersJson({ exePath, allowWrite }: McpConfigInput): string {
  const server: { command: string; args: string[]; env?: Record<string, string> } = {
    command: exePath,
    args: [],
  };
  if (allowWrite) server.env = { DVM_ALLOW_WRITE: '1' };
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2);
}

/**
 * Claude Code の登録コマンド。
 * -s user を付けてどのフォルダから起動しても使えるようにする(既定の local はプロジェクト単位)
 */
export function claudeCodeCommand({ exePath, allowWrite }: McpConfigInput): string {
  const env = allowWrite ? ' -e DVM_ALLOW_WRITE=1' : '';
  return `claude mcp add ${SERVER_NAME} -s user${env} -- "${exePath}"`;
}

/**
 * VS Code の mcp.json。**キーが servers**(他のクライアントの mcpServers ではない)で、
 * **type: "stdio" が必須**。この 2 点だけが mcpServersJson と違う
 */
export function vscodeMcpJson({ exePath, allowWrite }: McpConfigInput): string {
  const server: { type: string; command: string; args: string[]; env?: Record<string, string> } = {
    type: 'stdio',
    command: exePath,
    args: [],
  };
  if (allowWrite) server.env = { DVM_ALLOW_WRITE: '1' };
  return JSON.stringify({ servers: { [SERVER_NAME]: server } }, null, 2);
}

/**
 * TOML の文字列リテラル。
 *
 * **シングルクォートのリテラル文字列を優先する** —— Windows のパスは `\` を含むが、
 * リテラル文字列ならエスケープが要らず `C:\Program Files\...` をそのまま貼れる
 * (基本文字列だと `C:\\Program Files\\...` になり、手で直したときに壊れやすい)。
 * リテラル文字列には `'` を含められないので、その場合だけ基本文字列に落とす
 */
function tomlString(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Codex CLI の config.toml。
 * セクション名は **mcp_servers**(アンダースコア。他のクライアントの mcpServers とは綴りが違う)
 */
export function codexConfigToml({ exePath, allowWrite }: McpConfigInput): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(exePath)}`,
    'args = []',
  ];
  if (allowWrite) lines.push('env = { DVM_ALLOW_WRITE = "1" }');
  return lines.join('\n');
}
