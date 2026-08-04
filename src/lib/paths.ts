/**
 * Windows パスの小道具(v1.14)。
 *
 * **Rust 側 `core/folders.rs` の `normalize_dir` / `parent_dir` と同じ結果になること**。
 * 右クリックの「このフォルダーを開く」は、ここで出したパスを `VideoQuery.dirPath` に渡し、
 * Rust 側が組み立てたフォルダーツリーのキーと突き合わせる。表記が 1 文字でもずれると
 * 「絞り込んだのに 0 件」になる
 */

/** 区切りを `\` に揃え、末尾の区切りを落とす。ドライブ直下(`C:\`)だけは区切りを残す */
export function normalizeDir(path: string): string {
  const p = path.replace(/\//g, '\\');
  const trimmed = p.replace(/\\+$/, '');
  if (trimmed === '') return p;
  // "C:" のままだとカレントドライブの相対パスという別の意味になる
  if (trimmed.length === 2 && trimmed[1] === ':') return `${trimmed}\\`;
  return trimmed;
}

/** 末尾の名前だけを返す。`C:\動画\アニメ` → `アニメ`。取れなければパスをそのまま */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 親フォルダを返す。`C:\v\a.mp4` → `C:\v`、`C:\a.mp4` → `C:\`。取れなければ null */
export function parentDir(path: string): string | null {
  const p = path.replace(/\//g, '\\').replace(/\\+$/, '');
  const i = p.lastIndexOf('\\');
  if (i < 0) return null;
  const head = p.slice(0, i);
  if (head === '') return null;
  return normalizeDir(head);
}
