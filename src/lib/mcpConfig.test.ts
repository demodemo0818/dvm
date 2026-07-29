import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, mcpServersJson } from './mcpConfig';

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
