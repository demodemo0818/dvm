/**
 * クリップボードへコピーする。
 * WebView2 では navigator.clipboard が使えるが、権限やフォーカスの都合で失敗することがあるので
 * 旧 API での書き込みにフォールバックする(コピーボタンが無反応に見えるのを防ぐ)。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}
