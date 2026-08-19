import { describe, expect, it } from 'vitest';
import { SseAssembler } from './sse';

/** 行を順に食わせて、確定したイベントだけ集める */
function feed(lines: string[]) {
  const asm = new SseAssembler();
  const out = [];
  for (const l of lines) {
    const m = asm.push(l);
    if (m) out.push(m);
  }
  const last = asm.flush();
  if (last) out.push(last);
  return out;
}

describe('SseAssembler', () => {
  it('空行でイベントが確定する', () => {
    expect(feed(['data: {"a":1}', ''])).toEqual([{ data: '{"a":1}' }]);
  });

  it('event 行を拾う(Anthropic は必ず付ける)', () => {
    expect(feed(['event: content_block_delta', 'data: {"x":1}', ''])).toEqual([
      { event: 'content_block_delta', data: '{"x":1}' },
    ]);
  });

  it('コロンの直後の空白 1 つだけを落とす', () => {
    expect(feed(['data:  二つ目の空白は残す', ''])).toEqual([{ data: ' 二つ目の空白は残す' }]);
  });

  it('コメント行(keep-alive)を捨てる', () => {
    expect(feed([': ping', 'data: x', ''])).toEqual([{ data: 'x' }]);
  });

  it('data が複数行なら改行で連結する', () => {
    expect(feed(['data: 1行目', 'data: 2行目', ''])).toEqual([{ data: '1行目\n2行目' }]);
  });

  it('[DONE] も普通のデータとして渡す(判断はアダプタに任せる)', () => {
    expect(feed(['data: [DONE]', ''])).toEqual([{ data: '[DONE]' }]);
  });

  it('最後の空行が来ないまま切れても取りこぼさない(Gemini がこの形)', () => {
    expect(feed(['data: {"last":true}'])).toEqual([{ data: '{"last":true}' }]);
  });

  it('連続した空行で空のイベントを作らない', () => {
    expect(feed(['data: x', '', '', ''])).toEqual([{ data: 'x' }]);
  });

  it('複数イベントを順に返す', () => {
    expect(feed(['data: 1', '', 'data: 2', ''])).toEqual([{ data: '1' }, { data: '2' }]);
  });
});
