import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, codexConfigToml, mcpServersJson, vscodeMcpJson } from './mcpConfig';

const EXE = 'C:\\Program Files\\DVM\\binaries\\dvm-mcp.exe';

describe('mcpServersJson', () => {
  it('読み取り専用のときは env を出さない', () => {
    const parsed = JSON.parse(mcpServersJson({ exePath: EXE, allowWrite: false }));
    expect(parsed.mcpServers.dvm.command).toBe(EXE);
    expect(parsed.mcpServers.dvm.args).toEqual([]);
    expect(parsed.mcpServers.dvm.env).toBeUndefined();
  });

  it('書き込み許可のときだけ DVM_ALLOW_WRITE を入れる', () => {
    const parsed = JSON.parse(mcpServersJson({ exePath: EXE, allowWrite: true }));
    expect(parsed.mcpServers.dvm.env).toEqual({ DVM_ALLOW_WRITE: '1' });
  });

  it('Windows のパスがそのまま貼り付けられる形にエスケープされる', () => {
    const json = mcpServersJson({ exePath: EXE, allowWrite: false });
    // JSON 上は \ が \\ になっていて、読み戻すと元のパスに戻る
    expect(json).toContain('C:\\\\Program Files\\\\DVM\\\\binaries\\\\dvm-mcp.exe');
    expect(JSON.parse(json).mcpServers.dvm.command).toBe(EXE);
  });
});

describe('claudeCodeCommand', () => {
  it('空白を含むパスを引用符で囲む', () => {
    expect(claudeCodeCommand({ exePath: EXE, allowWrite: false })).toBe(
      `claude mcp add dvm -s user -- "${EXE}"`,
    );
  });

  it('書き込み許可のときは -e を足す', () => {
    expect(claudeCodeCommand({ exePath: EXE, allowWrite: true })).toBe(
      `claude mcp add dvm -s user -e DVM_ALLOW_WRITE=1 -- "${EXE}"`,
    );
  });
});

describe('vscodeMcpJson', () => {
  it('キーは servers で、type: stdio が入る(VS Code だけ形が違う)', () => {
    const parsed = JSON.parse(vscodeMcpJson({ exePath: EXE, allowWrite: false }));
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.servers.dvm.type).toBe('stdio');
    expect(parsed.servers.dvm.command).toBe(EXE);
    expect(parsed.servers.dvm.args).toEqual([]);
    expect(parsed.servers.dvm.env).toBeUndefined();
  });

  it('書き込み許可のときだけ env を入れる', () => {
    const parsed = JSON.parse(vscodeMcpJson({ exePath: EXE, allowWrite: true }));
    expect(parsed.servers.dvm.env).toEqual({ DVM_ALLOW_WRITE: '1' });
  });
});

describe('codexConfigToml', () => {
  it('パスをリテラル文字列で出すので \\ のエスケープが要らない', () => {
    const toml = codexConfigToml({ exePath: EXE, allowWrite: false });
    expect(toml).toContain(`command = '${EXE}'`);
    // 貼り付けたパスがそのまま読める(\\ に化けていない)
    expect(toml).not.toContain('\\\\');
  });

  it('セクション名はアンダースコアの mcp_servers', () => {
    expect(codexConfigToml({ exePath: EXE, allowWrite: false })).toContain('[mcp_servers.dvm]');
  });

  it('読み取り専用のときは env の行を出さない', () => {
    expect(codexConfigToml({ exePath: EXE, allowWrite: false })).not.toContain('env');
  });

  it('書き込み許可のときだけ env をインラインテーブルで足す', () => {
    expect(codexConfigToml({ exePath: EXE, allowWrite: true })).toContain(
      'env = { DVM_ALLOW_WRITE = "1" }',
    );
  });

  it("パスに ' を含むときは基本文字列に落として \\ をエスケープする", () => {
    const odd = "C:\\Users\\O'Brien\\dvm-mcp.exe";
    const toml = codexConfigToml({ exePath: odd, allowWrite: false });
    // リテラル文字列には ' を入れられないので、ダブルクォート + \\ になる
    expect(toml).toContain('command = "C:\\\\Users\\\\O\'Brien\\\\dvm-mcp.exe"');
  });
});
