import type { DedupeResult } from '../types';

/**
 * 重複解消のあとに出すトースト文言(v1.33)。
 *
 * 入口が 2 つ(絞り込み帯とフォルダーツリー)あるので、文言はここに 1 つだけ置く。
 * **ファイルがどうなったかを必ず書く** —— 「登録を外した」のか「ごみ箱へ送った」のかが
 * 分からないと、ユーザーはファイルが無事か確かめに行くことになる
 */
export function dedupeMessage(result: DedupeResult, trashed: boolean): string {
  if (result.removed === 0 && result.failed === 0) {
    return '解消できる重複はありませんでした';
  }
  if (!trashed) {
    return `${result.removed.toLocaleString()} 件をライブラリから外しました(ファイルは残っています)`;
  }
  const head = `${result.trashed.toLocaleString()} 件をごみ箱へ送りました`;
  // 送れなかったぶんは登録も残してある(ファイルがあるのに一覧から消えると行方が分からなくなる)
  return result.failed > 0
    ? `${head}。${result.failed.toLocaleString()} 件は送れなかったので登録も残しています`
    : head;
}
