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
