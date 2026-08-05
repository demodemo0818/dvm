import { describe, expect, it } from 'vitest';
import { dedupeMessage } from './dedupeMessage';

describe('dedupeMessage', () => {
  it('登録を外しただけならファイルが残ることを書く', () => {
    expect(dedupeMessage({ removed: 2666, trashed: 0, failed: 0 }, false))
      .toBe('2,666 件をライブラリから外しました(ファイルは残っています)');
  });

  it('ごみ箱へ送ったときは送った件数を書く', () => {
    expect(dedupeMessage({ removed: 10, trashed: 10, failed: 0 }, true))
      .toBe('10 件をごみ箱へ送りました');
  });

  it('送れなかったぶんは登録も残したことを書く', () => {
    expect(dedupeMessage({ removed: 8, trashed: 8, failed: 2 }, true))
      .toBe('8 件をごみ箱へ送りました。2 件は送れなかったので登録も残しています');
  });

  it('対象が無ければそう言う', () => {
    expect(dedupeMessage({ removed: 0, trashed: 0, failed: 0 }, false))
      .toBe('解消できる重複はありませんでした');
    expect(dedupeMessage({ removed: 0, trashed: 0, failed: 0 }, true))
      .toBe('解消できる重複はありませんでした');
  });

  it('1 件も送れなかったときも結果を報告する(無反応にしない)', () => {
    expect(dedupeMessage({ removed: 0, trashed: 0, failed: 3 }, true))
      .toBe('0 件をごみ箱へ送りました。3 件は送れなかったので登録も残しています');
  });
});
