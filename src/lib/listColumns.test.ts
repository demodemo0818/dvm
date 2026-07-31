import { describe, expect, it } from 'vitest';
import type { SortKey, VideoLabels, VideoRow } from '../types';
import {
  COLUMN_ORDER, COLUMNS, CURATED_SORTS, DEFAULT_COLUMNS, extensionOf, folderOf, gridTemplate,
  layout, NAME_MIN_W, needsLabels, nextSort, parseColumns, sortDirOf, sortLabel,
} from './listColumns';
import type { ColumnKey } from './listColumns';

function row(patch: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 1, path: 'C:\\動画\\アニメ\\第01話.mp4', filename: '第01話.mp4', title: null,
    size: 0, durationMs: null, width: null, height: null, rating: 0, viewCount: 0,
    lastViewedAt: null, resumeMs: 0, videoCodec: null, audioCodec: null,
    isMissing: false, isOffline: false, thumbState: 0, thumbPath: null,
    addedAt: '2026-07-20 19:55:05',
    fileCreatedAt: null, fileModifiedAt: null, fps: null, bitrate: null,
    ...patch,
  };
}

const ALL_KEYS = Object.keys(COLUMNS) as ColumnKey[];

describe('parseColumns', () => {
  it('未設定は既定に落とす', () => {
    expect(parseColumns(null)).toEqual(DEFAULT_COLUMNS);
  });

  // settings 初の JSON なので、何が入っていても起動できることが最優先
  it('壊れた値はすべて既定に落とす', () => {
    expect(parseColumns('{')).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns('"list"')).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns('{"a":1}')).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns('[]')).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns('[1,2,3]')).toEqual(DEFAULT_COLUMNS);
    // 既知のキーが 1 つも残らないなら壊れているとみなす
    expect(parseColumns('["nope","gone"]')).toEqual(DEFAULT_COLUMNS);
  });

  it('未知のキーと重複は黙って捨てる', () => {
    expect(parseColumns('["duration","nope","size","duration"]')).toEqual(['duration', 'size']);
  });

  it('サムネイルは必ず先頭に寄せる', () => {
    expect(parseColumns('["size","thumb","duration"]')).toEqual(['thumb', 'size', 'duration']);
  });

  it('既定は v1.15 までのリスト表示と同じ', () => {
    expect(DEFAULT_COLUMNS).toEqual(['thumb', 'duration', 'size', 'resolution', 'rating', 'added']);
  });

  // COLUMN_ORDER が ColumnPicker の描画元なので、漏れた列はユーザーが選べなくなる
  it('すべての列が列選択ポップオーバーに並ぶ', () => {
    expect([...COLUMN_ORDER].sort()).toEqual([...ALL_KEYS].sort());
  });
});

describe('gridTemplate', () => {
  it('名前列だけが伸縮し、末尾にヘッダのボタン用の余白を空ける', () => {
    expect(gridTemplate(['thumb', 'duration', 'size']))
      .toBe('64px minmax(160px, 1fr) 60px 70px 22px');
  });

  it('サムネイルを外すと先頭の固定幅が消える', () => {
    expect(gridTemplate(['duration', 'size'])).toBe('minmax(160px, 1fr) 60px 70px 22px');
  });

  // 0 まで縮ませると名前が消えて行を識別できなくなる。下回るぶんは横スクロールに逃がす
  it('名前列は下限より縮まない', () => {
    expect(gridTemplate(ALL_KEYS)).toContain(`minmax(${NAME_MIN_W}px, 1fr)`);
  });

  // 行はサムネ + 名前 + 残りしか描かないので、トラックが 1 つ多い状態が正しい
  it('トラック数はセル数 + 余白 1 つ', () => {
    for (const cols of [DEFAULT_COLUMNS, ALL_KEYS, ['duration'] as ColumnKey[]]) {
      const { thumb, rest } = layout(cols);
      expect(gridTemplate(cols).split(' ').filter((t) => t.endsWith('px') || t.endsWith('1fr)')))
        .toHaveLength((thumb ? 1 : 0) + 1 + rest.length + 1);
    }
  });
});

describe('nextSort / sortDirOf', () => {
  it('列ごとに自然な向きから始まる', () => {
    // 追加日を古い順から見たい場面はまず無い
    expect(nextSort(COLUMNS.added, 'name_asc')).toBe('added_desc');
    expect(nextSort(COLUMNS.size, 'name_asc')).toBe('size_desc');
    expect(nextSort(COLUMNS.rating, 'name_asc')).toBe('rating_desc');
    expect(nextSort(COLUMNS.views, 'name_asc')).toBe('views_desc');
    // 名前・拡張子・コーデックは昇順から
    expect(nextSort(COLUMNS.ext, 'added_desc')).toBe('ext_asc');
    expect(nextSort(COLUMNS.folder, 'added_desc')).toBe('folder_asc');
  });

  it('同じ列をもう一度押すと反転する', () => {
    expect(nextSort(COLUMNS.size, 'size_desc')).toBe('size_asc');
    expect(nextSort(COLUMNS.size, 'size_asc')).toBe('size_desc');
  });

  it('矢印はその列で並んでいるときだけ出す', () => {
    expect(sortDirOf(COLUMNS.size, 'size_desc')).toBe('desc');
    expect(sortDirOf(COLUMNS.size, 'size_asc')).toBe('asc');
    expect(sortDirOf(COLUMNS.size, 'added_desc')).toBeNull();
    // 列に対応しない並び順ではどの列にも矢印を出さない
    for (const key of ['random', 'dup', 'series_asc'] as SortKey[]) {
      for (const k of ALL_KEYS) expect(sortDirOf(COLUMNS[k], key)).toBeNull();
    }
  });

  // 最終視聴日の降順 = 既存の「最近見た順」。新しいキーを作らず既存に紐付ける
  it('最終視聴日の 1 回目は既存の viewed_desc になる', () => {
    expect(nextSort(COLUMNS.lastViewed, 'added_desc')).toBe('viewed_desc');
    expect(CURATED_SORTS).toContain('viewed_desc');
  });
});

describe('セルの表示', () => {
  // path / filename / size / rating / view_count / added_at は NOT NULL なので必ず値が出る。
  // 残りは ffprobe や視聴履歴が要るので未取得がありうる
  const ALWAYS_PRESENT: ColumnKey[] = ['thumb', 'size', 'rating', 'views', 'added', 'ext', 'folder'];

  it('未取得の値は null を返す(セルが "—" になる)', () => {
    const bare = row();
    for (const k of ALL_KEYS) {
      if (ALWAYS_PRESENT.includes(k)) continue;
      expect(COLUMNS[k].text(bare), `${k} は未取得なら null`).toBeNull();
    }
  });

  it('長さ・サイズ・解像度', () => {
    expect(COLUMNS.duration.text(row({ durationMs: 4_930_000 }))).toBe('1:22:10');
    expect(COLUMNS.size.text(row({ size: 2.31 * 1024 ** 3 }))).toBe('2.31 GB');
    // 列が狭いので KB は出さず MB の小数も落とす(グリッドの fmtSize とは別実装)
    expect(COLUMNS.size.text(row({ size: 1024 ** 2 * 496.4 }))).toBe('496 MB');
    expect(COLUMNS.resolution.text(row({ width: 1920, height: 1080 }))).toBe('1920×1080');
  });

  it('評価は 0 のとき空欄', () => {
    expect(COLUMNS.rating.text(row({ rating: 3 }))).toBe('★★★');
    expect(COLUMNS.rating.text(row({ rating: 0 }))).toBe('');
  });

  it('日付は列に収めるため日付だけにする', () => {
    expect(COLUMNS.added.text(row())).toBe('2026-07-20');
    expect(COLUMNS.lastViewed.text(row({ lastViewedAt: '2026-07-26 21:42:18' }))).toBe('2026-07-26');
  });

  it('fps は整数なら小数を出さない', () => {
    expect(COLUMNS.fps.text(row({ fps: 30 }))).toBe('30');
    expect(COLUMNS.fps.text(row({ fps: 29.97 }))).toBe('29.97');
  });

  it('ビットレートは単位を切り替える', () => {
    expect(COLUMNS.bitrate.text(row({ bitrate: 8_551_234 }))).toBe('8.55 Mbps');
    expect(COLUMNS.bitrate.text(row({ bitrate: 192_000 }))).toBe('192 kbps');
  });
});

describe('タグ・シリーズ列(v1.23)', () => {
  const labels = (patch: Partial<VideoLabels> = {}): VideoLabels => ({
    videoId: 1,
    tags: [],
    series: [],
    ...patch,
  });

  /*
   * タグは行と別便で届くので、セルには 3 つの状態がある。
   * 「まだ取れていない」を空欄にすると 0 個と見分けが付かず、
   * 逆に 0 個を '—' にすると付け忘れなのか読み込み中なのか分からなくなる
   */
  it('未取得は null(セルが "—")、0 個は空文字(セルが空欄)', () => {
    expect(COLUMNS.tags.text(row())).toBeNull();
    expect(COLUMNS.series.text(row())).toBeNull();
    expect(COLUMNS.tags.text(row(), labels())).toBe('');
    expect(COLUMNS.series.text(row(), labels())).toBe('');
  });

  it('複数はカンマ区切りにする(順序は Rust 側の名前順のまま)', () => {
    const l = labels({
      tags: [
        { id: 1, name: '旅行', color: '#e05252' },
        { id: 2, name: '2024', color: null },
      ],
      series: [{ id: 5, name: '北海道編' }],
    });
    expect(COLUMNS.tags.text(row(), l)).toBe('旅行, 2024');
    expect(COLUMNS.series.text(row(), l)).toBe('北海道編');
  });

  // 動画は「タグの集合」を持つので、並べ替えの向きに自然な定義が無い
  it('並べ替えできない列としてヘッダに矢印を出さない', () => {
    for (const k of ['tags', 'series'] as ColumnKey[]) {
      expect(COLUMNS[k].sort).toBeNull();
      expect(sortDirOf(COLUMNS[k], 'added_desc')).toBeNull();
      // 押しても今の並び順が変わらない
      expect(nextSort(COLUMNS[k], 'added_desc')).toBe('added_desc');
    }
  });
});

describe('needsLabels', () => {
  // 出さない列のために毎ページ問い合わせを投げないため
  it('タグかシリーズの列があるときだけ別便が要る', () => {
    expect(needsLabels(DEFAULT_COLUMNS)).toBe(false);
    expect(needsLabels(['thumb', 'tags'])).toBe(true);
    expect(needsLabels(['thumb', 'series'])).toBe(true);
    expect(needsLabels([])).toBe(false);
  });
});

describe('extensionOf', () => {
  it('最後のドットだけを見る(Rust の ext_expr と同じ規則)', () => {
    expect(extensionOf('z.tar.gz.mp4')).toBe('mp4');
    expect(extensionOf('x.MKV')).toBe('mkv');
  });

  it('ドットが無い / 末尾がドットなら null', () => {
    expect(extensionOf('noext')).toBeNull();
    expect(extensionOf('trailing.')).toBeNull();
  });
});

describe('folderOf', () => {
  it('親フォルダ名だけを返す(フルパスは列に収まらない)', () => {
    expect(folderOf('C:\\動画\\アニメ\\第01話.mp4')).toBe('アニメ');
    expect(folderOf('C:/動画/アニメ/第01話.mp4')).toBe('アニメ');
    expect(folderOf('\\\\server\\share\\a.mp4')).toBe('share');
  });

  it('親がなければ null', () => {
    expect(folderOf('a.mp4')).toBeNull();
  });
});

describe('sortLabel', () => {
  // 網羅漏れがあると select に空の option が出る
  it('全列のソートキーにラベルがある', () => {
    for (const k of ALL_KEYS) {
      const { sort } = COLUMNS[k];
      // タグ・シリーズは並べ替えできない列なのでソートキーを持たない
      if (!sort) continue;
      expect(sortLabel(sort.asc), `${k} の昇順`).toBeTruthy();
      expect(sortLabel(sort.desc), `${k} の降順`).toBeTruthy();
    }
    for (const key of CURATED_SORTS) expect(sortLabel(key)).toBeTruthy();
    for (const key of ['series_asc', 'dup', 'random'] as SortKey[]) {
      expect(sortLabel(key)).toBeTruthy();
    }
  });
});
