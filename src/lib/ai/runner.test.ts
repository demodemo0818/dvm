import { describe, expect, it, vi } from 'vitest';
import { runToolLoop, type RunnerEvent } from './runner';
import { AiError, type AiMessage, type AiTool, type Provider, type StreamEvent, type ToolCall } from './types';

/**
 * 台本どおりに StreamEvent を吐く偽プロバイダ。
 * 1 ターン目・2 ターン目…をこの順に返し、**そのとき渡された messages を記録する**
 * (tool_result が正しく積まれているかを見るため)
 */
function fakeProvider(turns: StreamEvent[][]): Provider & { seen: AiMessage[][] } {
  let i = 0;
  const seen: AiMessage[][] = [];
  return {
    id: 'anthropic',
    seen,
    async *stream(req) {
      seen.push(JSON.parse(JSON.stringify(req.messages)) as AiMessage[]);
      for (const ev of turns[i] ?? []) yield ev;
      i++;
    },
  };
}

const endWith = (
  content: string,
  toolCalls?: ToolCall[],
): StreamEvent => ({
  type: 'end',
  stopReason: toolCalls?.length ? 'tool_use' : 'end',
  assistant: { role: 'assistant', content, toolCalls },
});

const call = (name: string, input: Record<string, unknown> = {}, id = `c_${name}`): ToolCall => ({
  id,
  name,
  input,
});

function tool(name: string, run: AiTool['run']): AiTool {
  return { def: { name, description: '', parameters: { type: 'object', properties: {} } }, run };
}

async function collect(gen: AsyncGenerator<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const base = {
  system: 'sys',
  history: [] as AiMessage[],
  userText: 'こんにちは',
  signal: new AbortController().signal,
};

describe('runToolLoop', () => {
  it('ツールを呼ばなければ 1 往復で終わる', async () => {
    const provider = fakeProvider([[{ type: 'text', text: 'やあ' }, endWith('やあ')]]);
    const events = await collect(runToolLoop({ ...base, provider, tools: [] }));
    expect(events).toEqual([
      { type: 'text', text: 'やあ' },
      { type: 'done', finalText: 'やあ' },
    ]);
  });

  it('ツールを並列に実行して結果を次のターンへ積む', async () => {
    const order: string[] = [];
    const tools = [
      tool('a', async () => {
        order.push('a');
        return 'A の結果';
      }),
      tool('b', async () => {
        order.push('b');
        return 'B の結果';
      }),
    ];
    const provider = fakeProvider([
      [endWith('', [call('a'), call('b')])],
      [{ type: 'text', text: '終わり' }, endWith('終わり')],
    ]);
    const events = await collect(runToolLoop({ ...base, provider, tools }));

    expect(order.sort()).toEqual(['a', 'b']);
    expect(events.some((e) => e.type === 'turn_break')).toBe(true);
    // 2 ターン目に渡された履歴に tool の結果が 2 件入っている
    const second = provider.seen[1];
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({
      role: 'tool',
      results: [
        { id: 'c_a', name: 'a', content: 'A の結果' },
        { id: 'c_b', name: 'b', content: 'B の結果' },
      ],
    });
  });

  it('ツールが throw してもループを止めず、失敗をモデルに見せる', async () => {
    const tools = [
      tool('a', async () => {
        throw new Error('タグ「ほげ」が見つかりません');
      }),
    ];
    const provider = fakeProvider([
      [endWith('', [call('a')])],
      [{ type: 'text', text: '言い直します' }, endWith('言い直します')],
    ]);
    const events = await collect(runToolLoop({ ...base, provider, tools }));

    // エラーはカードとして出る(会話は続く)
    expect(events).toContainEqual({ type: 'card', text: 'エラー: タグ「ほげ」が見つかりません' });
    expect(events.slice(-1)[0]).toEqual({ type: 'done', finalText: '言い直します' });
    const toolMsg = provider.seen[1].find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ results: [{ isError: true }] });
  });

  it('引数の JSON が壊れているツールは実行しない', async () => {
    const run = vi.fn();
    const tools = [tool('a', run)];
    const broken: ToolCall = { id: 'c1', name: 'a', input: {}, parseError: '引数の JSON が壊れています' };
    const provider = fakeProvider([[endWith('', [broken])], [endWith('やり直し')]]);

    const events = await collect(runToolLoop({ ...base, provider, tools }));
    expect(run).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'card', text: '引数の JSON が壊れています' });
  });

  it('存在しないツールを呼ばれても落ちない', async () => {
    const provider = fakeProvider([[endWith('', [call('nope')])], [endWith('ごめん')]]);
    const events = await collect(runToolLoop({ ...base, provider, tools: [] }));
    expect(events).toContainEqual({ type: 'card', text: 'そのツールはありません: nope' });
  });

  it('反復上限で打ち切り、そのことをカードで知らせる', async () => {
    const tools = [tool('a', async () => 'ok')];
    // 毎ターン必ずツールを呼び続けるモデル
    const turns = Array.from({ length: 5 }, () => [endWith('', [call('a')])]);
    const provider = fakeProvider(turns);
    const events = await collect(runToolLoop({ ...base, provider, tools, maxIterations: 3 }));

    expect(provider.seen).toHaveLength(3);
    expect(events).toContainEqual({ type: 'card', text: 'ツールの実行が上限(3 回)に達しました' });
  });

  it('中断されたら aborted で投げる', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = fakeProvider([[endWith('来ないはず')]]);
    await expect(collect(runToolLoop({ ...base, provider, tools: [], signal: ac.signal }))).rejects.toMatchObject(
      { kind: 'aborted' },
    );
  });

  it('ツール実行の直前に中断されたら、そこで止める', async () => {
    const ac = new AbortController();
    const run = vi.fn(async () => 'ok');
    const provider: Provider = {
      id: 'anthropic',
      async *stream() {
        yield endWith('', [call('a')]);
        ac.abort(); // 応答を受け取り終えた直後に停止ボタンが押された状況
      },
    };
    await expect(
      collect(runToolLoop({ ...base, provider, tools: [tool('a', run)], signal: ac.signal })),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(run).not.toHaveBeenCalled();
  });

  it('トークン数を合算して最後に 1 回出す', async () => {
    const tools = [tool('a', async () => 'ok')];
    const provider = fakeProvider([
      [{ type: 'usage', inputTokens: 100, outputTokens: 20 }, endWith('', [call('a')])],
      [{ type: 'usage', inputTokens: 150, outputTokens: 30 }, endWith('完了')],
    ]);
    const events = await collect(runToolLoop({ ...base, provider, tools }));
    expect(events).toContainEqual({ type: 'usage', inputTokens: 250, outputTokens: 50 });
  });

  it('拒否されたターンは無反応にせずカードを出す', async () => {
    const provider = fakeProvider([
      [{ type: 'end', stopReason: 'refusal', assistant: { role: 'assistant', content: '' } }],
    ]);
    const events = await collect(runToolLoop({ ...base, provider, tools: [] }));
    expect(events).toContainEqual({ type: 'card', text: 'モデルが応答を拒否しました' });
  });

  it('渡した履歴を書き換えない(呼び出し側の配列を壊さない)', async () => {
    const history: AiMessage[] = [{ role: 'user', content: '前のターン' }];
    const provider = fakeProvider([[endWith('はい')]]);
    await collect(runToolLoop({ ...base, provider, tools: [], history }));
    expect(history).toEqual([{ role: 'user', content: '前のターン' }]);
  });

  it('応答が空のまま終わったら parse エラーにする', async () => {
    const provider = fakeProvider([[]]);
    await expect(collect(runToolLoop({ ...base, provider, tools: [] }))).rejects.toBeInstanceOf(AiError);
  });
});
