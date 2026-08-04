import { describe, expect, it } from 'vitest';
import {
  chapterIndexAt, chapterJumpTarget, chapterLabelAt, hasChapters, toChapters,
} from './chapters';
import type { Chapter } from './chapters';

/** 0:00 / 1:30 / 3:00 / 5:00 の 4 チャプター */
const four: Chapter[] = [
  { time: 0, label: 'オープニング' },
  { time: 90, label: 'チャプター 2' },
  { time: 180, label: '本編' },
  { time: 300, label: 'エンディング' },
];

describe('toChapters', () => {
  it('mpv の chapter-list を整形する', () => {
    expect(
      toChapters([
        { time: 0, title: 'オープニング' },
        { time: 90, title: '本編' },
      ]),
    ).toEqual([
      { time: 0, label: 'オープニング' },
      { time: 90, label: '本編' },
    ]);
  });

  // 名前無しの mkv は珍しくない。詳細ペインのメディア情報と同じ規則で埋める
  it('タイトルが無い / 空白だけなら「チャプター N」で埋める', () => {
    expect(toChapters([{ time: 0 }, { time: 10, title: '   ' }, { time: 20, title: '終' }])).toEqual([
      { time: 0, label: 'チャプター 1' },
      { time: 10, label: 'チャプター 2' },
      { time: 20, label: '終' },
    ]);
  });

  // mpv は名前の無いチャプターに "(unnamed)" を入れて返す(空文字では来ない)。
  // 実機で一覧に「(unnamed)」が並んだので足したテスト
  it('mpv の "(unnamed)" は名前無しとして扱う', () => {
    expect(toChapters([{ time: 0, title: '(unnamed)' }, { time: 20, title: '(unnamed)' }])).toEqual([
      { time: 0, label: 'チャプター 1' },
      { time: 20, label: 'チャプター 2' },
    ]);
  });

  it('時刻が数値でない要素は捨てる(NaN の目盛りを出さない)', () => {
    expect(toChapters([{ time: 0 }, { title: '時刻なし' }, { time: null }, null, 'ごみ'])).toEqual([
      { time: 0, label: 'チャプター 1' },
    ]);
  });

  // 番号は並べ替えたあとの順番。崩れると一覧と目盛りの対応が狂う
  it('時刻順に並べ替えてから番号を振る', () => {
    expect(toChapters([{ time: 90 }, { time: 0 }])).toEqual([
      { time: 0, label: 'チャプター 1' },
      { time: 90, label: 'チャプター 2' },
    ]);
  });

  it('配列でなければ空', () => {
    expect(toChapters(null)).toEqual([]);
    expect(toChapters(undefined)).toEqual([]);
    expect(toChapters({ time: 0 })).toEqual([]);
  });
});

describe('hasChapters', () => {
  // 1 つだけのチャプターは飛び先が無いので UI を出さない
  it('2 つ以上のときだけ真', () => {
    expect(hasChapters([])).toBe(false);
    expect(hasChapters([{ time: 0, label: 'A' }])).toBe(false);
    expect(hasChapters(four)).toBe(true);
  });
});

describe('chapterIndexAt / chapterLabelAt', () => {
  it('その秒数が入っているチャプターを返す', () => {
    expect(chapterIndexAt(four, 0)).toBe(0);
    expect(chapterIndexAt(four, 89.9)).toBe(0);
    expect(chapterIndexAt(four, 90)).toBe(1);
    expect(chapterIndexAt(four, 299)).toBe(2);
    expect(chapterIndexAt(four, 10_000)).toBe(3);
    expect(chapterLabelAt(four, 180)).toBe('本編');
  });

  // 0:00 から始まらないファイルもある。その手前では名前を出さない
  it('最初のチャプターより前なら -1 / null', () => {
    const late: Chapter[] = [{ time: 30, label: 'A' }, { time: 60, label: 'B' }];
    expect(chapterIndexAt(late, 10)).toBe(-1);
    expect(chapterLabelAt(late, 10)).toBeNull();
  });
});

describe('chapterJumpTarget', () => {
  it('次は先の区切りへ、前は 1 つ前の頭へ(mpv 標準)', () => {
    expect(chapterJumpTarget(four, 100, 1)).toBe(180);
    // チャプター 3 の途中 → チャプター 2 の頭。今のチャプターの頭には戻さない
    expect(chapterJumpTarget(four, 200, -1)).toBe(90);
  });

  // 端で mpv 任せにすると終端に到達して連続再生が発動してしまう
  it('端では null(何もしない)', () => {
    expect(chapterJumpTarget(four, 310, 1)).toBeNull();
    expect(chapterJumpTarget(four, 10, -1)).toBeNull();
    expect(chapterJumpTarget(four, 0, -1)).toBeNull();
  });

  it('チャプターが 2 つ未満なら常に null', () => {
    expect(chapterJumpTarget([], 0, 1)).toBeNull();
    expect(chapterJumpTarget([{ time: 0, label: 'A' }], 0, 1)).toBeNull();
  });

  // time-pos は区切りのわずか手前を指すことがある。素直に比べると進まなくなる
  it('区切りのわずか手前で「次」を押しても、その区切りへ飛び直さない', () => {
    expect(chapterJumpTarget(four, 89.99, 1)).toBe(180);
    expect(chapterJumpTarget(four, 89.5, 1)).toBe(90);
  });

  it('ちょうど区切りの上では、次は先へ・前は 1 つ前へ', () => {
    expect(chapterJumpTarget(four, 90, 1)).toBe(180);
    expect(chapterJumpTarget(four, 90, -1)).toBe(0);
  });
});
