import { parentDir } from './paths';
import type { VideoRow } from '../types';

/** 削除しようとしている動画のうち、監視フォルダ由来のもの(= 消しても再登録されるもの) */
export interface ExcludeTargets {
  /** 監視フォルダ由来の動画のパス。これがファイル単位で除外する対象 */
  files: string[];
  /** その動画たちの親フォルダ(重複なし・昇順) */
  folders: string[];
}

/**
 * 削除の前に監視除外を勧めるかどうかを決める(v1.33)。
 *
 * **監視フォルダ由来のものだけを対象にする**。個別登録(`watchedFolderId === null`)は
 * 消しても再登録されないので、勧めても意味が無く、問いかけが騒がしくなるだけ。
 *
 * 親フォルダは `lib/paths.ts` の `parentDir` で出す —— フォルダーツリーや
 * `VideoQuery.dirPath` と同じ表記でないと、件数を数えるときに突き合わせられない
 */
export function excludeTargets(selection: VideoRow[]): ExcludeTargets {
  const watched = selection.filter((v) => v.watchedFolderId !== null);
  const dirs = watched
    .map((v) => parentDir(v.path))
    .filter((d): d is string => d !== null);
  const folders = [...new Set(dirs)].sort((a, b) => a.localeCompare(b));
  return { files: watched.map((v) => v.path), folders };
}

/**
 * 「親フォルダごと」を選んだときに、選択していない動画を何件巻き込むか。
 *
 * `folderCounts` はそのフォルダ直下にある登録数(小文字のパスをキーにする)。
 * 分からないフォルダは 0 として扱うので、**数え終わる前に 0 を「巻き込み無し」と
 * 見せないこと** —— 呼び出し側は数え終わるまで件数を出さない
 */
export function collateralCount(
  targets: ExcludeTargets,
  folderCounts: Record<string, number>,
): number {
  const selectedPerFolder = new Map<string, number>();
  for (const f of targets.files) {
    const dir = parentDir(f);
    if (dir === null) continue;
    selectedPerFolder.set(dir, (selectedPerFolder.get(dir) ?? 0) + 1);
  }
  let total = 0;
  for (const dir of targets.folders) {
    const inFolder = folderCounts[dir.toLowerCase()] ?? 0;
    total += Math.max(0, inFolder - (selectedPerFolder.get(dir) ?? 0));
  }
  return total;
}
