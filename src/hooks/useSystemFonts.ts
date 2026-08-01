import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * システムにインストールされたフォント名(v1.24)。
 *
 * Rust 側でもプロセス 1 回しか列挙していないが、IPC も 1 回で済ませたいので
 * Promise をモジュールスコープに置く(セッション中は使い回す)。
 * 取れなくても空配列を返すだけ —— 呼び出し側は datalist の候補にしか使わないので、
 * 空でもフォント名の手入力で機能が成立する
 */
let fontsPromise: Promise<string[]> | null = null;

export function useSystemFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    if (!fontsPromise) fontsPromise = api.listSystemFonts().catch(() => []);
    let alive = true;
    void fontsPromise.then((f) => {
      if (alive) setFonts(f);
    });
    return () => {
      alive = false;
    };
  }, []);

  return fonts;
}
