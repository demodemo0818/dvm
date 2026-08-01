import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUB_STYLE, fieldKeys, isAssCodec, isDefaultSubStyle, mpvSubProps, parseSubStyle,
  serializeSubStyle, splitMpvColor, SUB_STYLE_FIELDS, toMpvColor,
} from './subtitleStyle';
import type { SubStyle } from './subtitleStyle';

const def = (patch: Partial<SubStyle> = {}): SubStyle => ({ ...DEFAULT_SUB_STYLE, ...patch });

describe('toMpvColor / splitMpvColor', () => {
  // FF = 不透明。この向きが逆だと全部の色が透けるので、規則をここで固定する
  it('#AARRGGBB に合成する', () => {
    expect(toMpvColor('#ffffff', 1)).toBe('#FFFFFFFF');
    expect(toMpvColor('#000000', 0)).toBe('#00000000');
    expect(toMpvColor('#000000', 0.5)).toBe('#80000000');
    expect(toMpvColor('#FF8080', 0.25)).toBe('#40FF8080');
  });

  it('読めない色は黒に落とし、不透明度は 0〜1 に丸める', () => {
    expect(toMpvColor('まっしろ', 1)).toBe('#FF000000');
    expect(toMpvColor('#fff', 1)).toBe('#FF000000');
    expect(toMpvColor('#ffffff', 5)).toBe('#FFFFFFFF');
    expect(toMpvColor('#ffffff', -1)).toBe('#00FFFFFF');
  });

  it('往復する', () => {
    for (const hex of ['#FFFFFF', '#000000', '#12AB34']) {
      for (const a of [0, 0.25, 0.5, 1]) {
        const r = splitMpvColor(toMpvColor(hex, a));
        expect(r.hex).toBe(hex);
        expect(Math.abs(r.alpha - a)).toBeLessThanOrEqual(1 / 255);
      }
    }
  });

  it('アルファ無し(#RRGGBB)は不透明として読む', () => {
    expect(splitMpvColor('#ffffff')).toEqual({ hex: '#FFFFFF', alpha: 1 });
    expect(splitMpvColor('ffffff')).toEqual({ hex: '#FFFFFF', alpha: 1 });
  });

  it('壊れた値は黒・不透明に落とす', () => {
    expect(splitMpvColor('')).toEqual({ hex: '#000000', alpha: 1 });
    expect(splitMpvColor('#zzz')).toEqual({ hex: '#000000', alpha: 1 });
  });
});

describe('parseSubStyle', () => {
  it('未設定は既定に落とす', () => {
    expect(parseSubStyle(null)).toEqual(DEFAULT_SUB_STYLE);
    expect(parseSubStyle('')).toEqual(DEFAULT_SUB_STYLE);
    expect(parseSubStyle('{}')).toEqual(DEFAULT_SUB_STYLE);
  });

  // 何が入っていても起動できることが最優先(parseColumns と同じ)
  it('壊れた値はすべて既定に落とす', () => {
    expect(parseSubStyle('not json')).toEqual(DEFAULT_SUB_STYLE);
    expect(parseSubStyle('[]')).toEqual(DEFAULT_SUB_STYLE);
    expect(parseSubStyle('null')).toEqual(DEFAULT_SUB_STYLE);
    expect(parseSubStyle('42')).toEqual(DEFAULT_SUB_STYLE);
  });

  it('型が違うフィールドだけを既定に戻す', () => {
    const s = parseSubStyle('{"fontSize":"big","bold":true,"font":"Meiryo"}');
    expect(s.fontSize).toBe(DEFAULT_SUB_STYLE.fontSize);
    expect(s.bold).toBe(true);
    expect(s.font).toBe('Meiryo');
  });

  it('範囲外の数値はスライダーの値域へ丸める', () => {
    const s = parseSubStyle('{"scale":0,"pos":9999,"outlineSize":-5,"colorAlpha":3}');
    expect(s.scale).toBe(0.5);
    expect(s.pos).toBe(150);
    expect(s.outlineSize).toBe(0);
    expect(s.colorAlpha).toBe(1);
  });

  it('未知のキーは黙って捨てる', () => {
    expect(parseSubStyle('{"nope":1,"scale":2}')).toEqual(def({ scale: 2 }));
  });

  it('serialize と往復する', () => {
    const s = def({ font: 'メイリオ', fontSize: 70, color: '#FFFF00', backAlpha: 0.6, bold: true });
    expect(parseSubStyle(serializeSubStyle(s))).toEqual(s);
  });
});

describe('serializeSubStyle', () => {
  // 「既定に戻す」= '{}' を書く。settings に削除コマンドが無いのでこの形にしている
  it('既定は空オブジェクトになる', () => {
    expect(serializeSubStyle(DEFAULT_SUB_STYLE)).toBe('{}');
  });

  it('既定と違うフィールドだけ書く', () => {
    expect(JSON.parse(serializeSubStyle(def({ scale: 1.5 })))).toEqual({ scale: 1.5 });
  });

  it('isDefaultSubStyle が既定だけ true', () => {
    expect(isDefaultSubStyle(DEFAULT_SUB_STYLE)).toBe(true);
    expect(isDefaultSubStyle(def({ bold: true }))).toBe(false);
    expect(isDefaultSubStyle(def({ font: 'Meiryo' }))).toBe(false);
  });
});

describe('mpvSubProps', () => {
  /*
   * useMpvPlayer の run() は setProperty の失敗を握り潰すので、プロパティ名を
   * 間違えても実行時には気付けない。**名前を守れるのはこのテストだけ**。
   * sub-outline-* を使うこと(sub-border-* は mpv の非推奨エイリアス)
   */
  it('mpv のプロパティ名を固定する', () => {
    expect(Object.keys(mpvSubProps(DEFAULT_SUB_STYLE)).sort()).toEqual([
      'sub-ass-override',
      'sub-back-color',
      'sub-bold',
      'sub-color',
      'sub-font',
      'sub-font-size',
      'sub-outline-color',
      'sub-outline-size',
      'sub-pos',
      'sub-scale',
      'sub-shadow-color',
      'sub-shadow-offset',
    ]);
  });

  it('既定は mpv 素の見た目になる', () => {
    expect(mpvSubProps(DEFAULT_SUB_STYLE)).toEqual({
      'sub-scale': 1,
      'sub-pos': 100,
      'sub-font': 'sans-serif',
      'sub-font-size': 55,
      'sub-bold': 'no',
      'sub-color': '#FFFFFFFF',
      'sub-outline-color': '#FF000000',
      'sub-outline-size': 3,
      'sub-shadow-color': '#FF000000',
      'sub-shadow-offset': 0,
      'sub-back-color': '#00000000',
      'sub-ass-override': 'scale',
    });
  });

  it('空のフォントは mpv の既定に戻す', () => {
    expect(mpvSubProps(def({ font: '   ' }))['sub-font']).toBe('sans-serif');
    expect(mpvSubProps(def({ font: ' Meiryo ' }))['sub-font']).toBe('Meiryo');
  });

  it('真偽値は mpv が受ける表現に直す', () => {
    expect(mpvSubProps(def({ bold: true }))['sub-bold']).toBe('yes');
    expect(mpvSubProps(def({ assOverride: true }))['sub-ass-override']).toBe('force');
  });
});

describe('SUB_STYLE_FIELDS', () => {
  // 型に足したのに UI へ出し忘れる(あるいは二重に出す)事故を落とす
  it('SubStyle の全キーをちょうど 1 回ずつ扱う', () => {
    const covered = SUB_STYLE_FIELDS.flatMap(fieldKeys);
    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_SUB_STYLE).sort());
  });

  it('スライダーの既定値が値域に入っている', () => {
    for (const f of SUB_STYLE_FIELDS) {
      if (f.kind !== 'slider') continue;
      const v = DEFAULT_SUB_STYLE[f.key];
      expect(f.min).toBeLessThan(f.max);
      expect(v).toBeGreaterThanOrEqual(f.min);
      expect(v).toBeLessThanOrEqual(f.max);
    }
  });
});

describe('isAssCodec', () => {
  it('自前のスタイルを持つ字幕だけ true', () => {
    expect(isAssCodec('ass')).toBe(true);
    expect(isAssCodec('SSA')).toBe(true);
    expect(isAssCodec('subrip')).toBe(false);
    expect(isAssCodec(undefined)).toBe(false);
  });
});
