/**
 * 絞り込み帯(v1.28)の中身を組み立てる純関数。
 *
 * 画面の狙いは「**同じ箱の中は『または』(OR)、箱と箱の間は『かつ』(AND)**」の 1 文で
 * 検索の意味が読み取れること。タグの OR/AND は Rust 側(core/query.rs)が決めているので、
 * ここでは**同じ規則で箱に分けるだけ**。意味は一切変えない。
 *
 * React も api も import しない(vitest でそのまま動かせるようにするため)。
 */

import type { AdvancedFilter, Series, Tag, WatchedFolder } from '../types';
import { baseName } from './paths';
import { DURATION_LABELS, RESOLUTION_OPTIONS, type FilterState } from './query';

/**
 * ラベルを引くのに要るマスタ。まだ取れていなければ空配列でよい
 * (該当のチップが `unresolved` になるだけで、帯そのものは成立する)
 */
export interface FilterMasters {
  tags: Tag[];
  folders: WatchedFolder[];
  series: Series[];
}

export const NO_MASTERS: FilterMasters = { tags: [], folders: [], series: [] };

/** × を押したとき何を外すか。store の関数への振り分けは FilterBar 側の仕事 */
export type ClearAction =
  | { type: 'text' }
  | { type: 'searchPath' }
  | { type: 'tag'; tagId: number }
  | { type: 'tagAxis'; tagIds: number[] }
  | { type: 'folder' }
  | { type: 'dirPath' }
  | { type: 'series' }
  | { type: 'minRating' }
  | { type: 'duration' }
  | { type: 'missing' }
  | { type: 'duplicates' }
  | { type: 'codec'; codec: string }
  | { type: 'advanced'; key: keyof AdvancedFilter };

export interface FilterChip {
  key: string;
  label: string;
  /** タグの色。枠と文字色に使う(Inspector と同じ作法)。無ければ null */
  color: string | null;
  /** マスタ未着、または消えたタグ・フォルダ・シリーズ。呼ぶ側は薄く出す */
  unresolved: boolean;
  clear: ClearAction;
}

/** 「箱」1 つ。中のチップは「または」で繋がり、箱どうしは「かつ」で繋がる */
export interface FilterTerm {
  key: string;
  /** 箱の見出し(タググループ名 /「コーデック」)。無ければ null */
  caption: string | null;
  chips: FilterChip[];
  /**
   * 箱ごとまとめて外す。チップが 2 つ以上のときだけ入る。
   * **これが入るときは caption も必ず入る**(束ねられるのはグループ付きタグとコーデックだけで、
   * どちらも見出しを持つ)。帯はこの × を見出しの隣に描く
   */
  clearAll: ClearAction | null;
}

/**
 * タグを束ねる「軸」のキー。
 *
 * **`src-tauri/src/core/query.rs` の `COALESCE('g' || group_id, 't' || id)` と 1 対 1。
 * 片方だけ変えないこと** —— ここがずれると、画面の説明と実際の検索結果が食い違う。
 * グループ付きのタグはグループ単位に潰れて OR、未分類タグはタグ単位のままなので AND になる
 */
function axisKey(tag: Tag): string {
  return tag.groupId != null ? `g${tag.groupId}` : `t${tag.id}`;
}

/** 単独のチップ 1 つだけを持つ箱 */
function single(key: string, label: string, clear: ClearAction): FilterTerm {
  return {
    key,
    caption: null,
    chips: [{ key, label, color: null, unresolved: false, clear }],
    clearAll: null,
  };
}

/** マスタから名前を引く。消えている / まだ取れていなければ `…`(unresolved) */
function named(
  key: string,
  name: string | undefined,
  prefix: string,
  clear: ClearAction,
): FilterTerm {
  return {
    key,
    caption: null,
    chips: [{
      key,
      label: name !== undefined ? `${prefix}${name}` : '…',
      color: null,
      unresolved: name === undefined,
      clear,
    }],
    clearAll: null,
  };
}

/**
 * タグの選択を「軸」ごとの箱に分ける。
 * 箱の順番は **tagIds の初出順**(選んだ順に右へ伸びる)。
 * マスタに無い id は軸が分からないので、勝手に OR へまとめず単独の箱にする
 */
function tagTerms(tagIds: number[], tags: Tag[]): FilterTerm[] {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const order: string[] = [];
  const buckets = new Map<string, { caption: string | null; ids: number[]; chips: FilterChip[] }>();

  for (const id of tagIds) {
    const tag = byId.get(id);
    const key = tag ? axisKey(tag) : `t${id}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { caption: tag?.groupName ?? null, ids: [], chips: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.ids.push(id);
    bucket.chips.push({
      key: `tag:${id}`,
      label: tag?.name ?? '…',
      color: tag?.color ?? null,
      unresolved: tag === undefined,
      clear: { type: 'tag', tagId: id },
    });
  }

  return order.map((key) => {
    const b = buckets.get(key)!;
    return {
      key: `tags:${key}`,
      caption: b.caption,
      chips: b.chips,
      clearAll: b.chips.length > 1 ? { type: 'tagAxis', tagIds: b.ids } : null,
    };
  });
}

/**
 * いま効いている条件を、画面に出す順で「箱」の列に変換する。
 *
 * 並びは**種類ごとの固定順**(タグの中だけ選択順)。条件を足すたびに順番が入れ替わると
 * 目で追えなくなるため。並び順(sort)は絞り込みではないので数えない
 */
export function describeFilter(f: FilterState, m: FilterMasters): FilterTerm[] {
  const terms: FilterTerm[] = [];
  const a = f.advanced;

  if (f.text.trim() !== '') {
    terms.push(single('text', `「${f.text.trim()}」を含む`, { type: 'text' }));
  }
  if (a.searchPath) {
    terms.push(single('searchPath', 'パスも検索', { type: 'searchPath' }));
  }
  if (f.folderId !== null) {
    const folder = m.folders.find((x) => x.id === f.folderId);
    terms.push(named(
      'folder',
      folder ? baseName(folder.path) : undefined,
      'フォルダー: ',
      { type: 'folder' },
    ));
  }
  if (f.dirPath !== null) {
    terms.push(single('dirPath', `${baseName(f.dirPath)} の直下`, { type: 'dirPath' }));
  }

  terms.push(...tagTerms(f.tagIds, m.tags));

  if (f.seriesId !== null) {
    const series = m.series.find((x) => x.id === f.seriesId);
    terms.push(named('series', series?.name, 'シリーズ: ', { type: 'series' }));
  }
  if (f.minRating > 0) {
    terms.push(single('minRating', `★${f.minRating} 以上`, { type: 'minRating' }));
  }
  if (f.durationBucket !== null) {
    terms.push(single('duration', DURATION_LABELS[f.durationBucket], { type: 'duration' }));
  }
  if (f.missingOnly) {
    terms.push(single('missing', '見つからないファイル', { type: 'missing' }));
  }
  if (f.duplicatesOnly) {
    terms.push(single('duplicates', '重複のみ', { type: 'duplicates' }));
  }
  if (a.untagged) {
    terms.push(single('untagged', 'タグなし', { type: 'advanced', key: 'untagged' }));
  }
  if (a.unwatched) {
    terms.push(single('unwatched', '未視聴', { type: 'advanced', key: 'unwatched' }));
  }
  if (a.minHeight > 0) {
    const preset = RESOLUTION_OPTIONS.find((o) => o.value === a.minHeight);
    terms.push(single(
      'minHeight',
      preset ? preset.label : `${a.minHeight}p 以上`,
      { type: 'advanced', key: 'minHeight' },
    ));
  }
  if (a.videoCodecs.length > 0) {
    // コーデックの複数指定も OR(VideoQuery.videoCodecs)。タグと同じ「箱」で見せることで、
    // OR がタグだけの特別扱いに見えないようにする
    terms.push({
      key: 'codecs',
      caption: 'コーデック',
      chips: a.videoCodecs.map((c) => ({
        key: `codec:${c}`,
        label: c,
        color: null,
        unresolved: false,
        clear: { type: 'codec', codec: c },
      })),
      clearAll: a.videoCodecs.length > 1 ? { type: 'advanced', key: 'videoCodecs' } : null,
    });
  }
  if (a.addedAfter !== '') {
    terms.push(single(
      'addedAfter',
      `${a.addedAfter} 以降に追加`,
      { type: 'advanced', key: 'addedAfter' },
    ));
  }
  if (a.addedBefore !== '') {
    terms.push(single(
      'addedBefore',
      `${a.addedBefore} 以前に追加`,
      { type: 'advanced', key: 'addedBefore' },
    ));
  }

  return terms;
}

/**
 * 1 つでも絞り込みが効いているか。
 * 帯の見た目と、右クリックの「絞り込みをすべて解除」の活性判定が**必ず同じ**になるよう、
 * describeFilter の結果をそのまま使う(条件を足したときに片方だけ直す事故を防ぐ)
 */
export function hasActiveFilter(f: FilterState): boolean {
  return describeFilter(f, NO_MASTERS).length > 0;
}
