/**
 * サムネイルの URL にバージョンを足す。
 *
 * サムネイルのファイル名は `{video_id}.jpg` で固定なので、中身を作り直しても URL が変わらず、
 * WebView2 は古い画像をキャッシュから出し続ける(「サムネイルを作り直す」も
 * T キーでのコマ指定も、画面上は何も起きていないように見えていた)。
 * Rust の `thumbs:changed` で増えるカウンタを付けて、そのときだけ読み直させる。
 *
 * version が 0(まだ再生成が起きていない起動直後)では何も足さない。
 * 通常のスクロールでキャッシュを効かせたいため
 */
export function thumbSrc(url: string, version: number): string {
  if (version <= 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
}
