/*
 * Server-Sent Events の組み立て(v1.43)。3 社とも text/event-stream なのでここは 1 本で足りる。
 *
 * 行に切るところは Rust 側(core/ai_http.rs)がやっている —— チャンクの境界が
 * UTF-8 の文字の途中に落ちても化けないよう、バイト列で貯めてから改行で切るのが
 * 安全だから。ここが受け取るのは**改行を除いた 1 行**の列。
 */

export interface SseMessage {
  /** `event:` 行。省略されることが多い(Anthropic は必ず付ける) */
  event?: string;
  /** `data:` 行の中身。複数行あれば改行で連結される(SSE の仕様どおり) */
  data: string;
}

/**
 * 行を渡すと、イベントが 1 つ確定したときだけ返す状態機械。
 *
 * SSE は**空行でイベントが確定する**。`:` で始まる行はコメント(keep-alive)なので捨てる。
 * 純粋な状態機械にしてあるのでテストしやすい
 */
export class SseAssembler {
  private event: string | undefined;
  private dataLines: string[] = [];

  /** 1 行食わせる。イベントが確定したらそれを返す */
  push(line: string): SseMessage | null {
    // 空行 = イベントの区切り
    if (line === '') {
      if (this.dataLines.length === 0 && this.event === undefined) return null;
      const msg: SseMessage = { data: this.dataLines.join('\n') };
      if (this.event !== undefined) msg.event = this.event;
      this.event = undefined;
      this.dataLines = [];
      return msg;
    }
    // コメント行(`: keep-alive` など)
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // 仕様上、コロンの直後の空白 1 つだけを落とす
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.event = value;
    // id / retry は使わないので捨てる
    return null;
  }

  /**
   * 最後の空行が来ないまま切れたときの取りこぼしを回収する。
   * Gemini は `[DONE]` を送らずにストリームを閉じるので、これが無いと最終イベントが落ちる
   */
  flush(): SseMessage | null {
    if (this.dataLines.length === 0) return null;
    return this.push('');
  }
}

/** 行の列を SSE のイベントに組み直す */
export async function* assembleSse(lines: AsyncIterable<string>): AsyncGenerator<SseMessage> {
  const asm = new SseAssembler();
  for await (const line of lines) {
    const msg = asm.push(line);
    if (msg) yield msg;
  }
  const last = asm.flush();
  if (last) yield last;
}
