import { useId } from 'react';
import { useSystemFonts } from '../hooks/useSystemFonts';
import { isDefaultSubStyle, SUB_COLOR_PRESETS, SUB_STYLE_FIELDS } from '../lib/subtitleStyle';
import type { SubStyle, SubStyleField, SubStyleGroup } from '../lib/subtitleStyle';

/**
 * 字幕の見た目を編集する UI(v1.24)。
 *
 * **状態を持たない**。プレイヤーのパネル(SubtitleStylePanel)と設定モーダルの
 * 両方から同じ挙動で使えるよう、値も保存も呼び出し側(= store)に任せる。
 * 描くのは SUB_STYLE_FIELDS の中身だけなので、項目を増やすときに触るのは
 * lib/subtitleStyle.ts だけで済む
 */

/**
 * group の見出し。**「大きさのスライダーが 2 本あってどっちを動かすのか」を
 * ここで解く** —— sub-scale と sub-font-size は効く対象が違うので見出しで切る
 */
const GROUPS: { key: SubStyleGroup; title: string; note?: string }[] = [
  { key: 'all', title: 'すべての字幕', note: 'ASS/SSA(アニメなど)にも効きます' },
  {
    key: 'plain',
    title: '文字の見た目',
    note: 'SRT など、自前の装飾を持たない字幕にだけ効きます',
  },
  { key: 'ass', title: 'ASS/SSA 字幕', note: undefined },
];

function Slider({
  field, value, onChange,
}: {
  field: Extract<SubStyleField, { kind: 'slider' }>;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="sub-style-control">
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sub-style-value">{field.format(value)}</span>
    </div>
  );
}

function ColorRow({
  hex, alpha, onChange,
}: {
  hex: string;
  alpha: number;
  onChange: (hex: string, alpha: number) => void;
}) {
  return (
    <div className="sub-style-control sub-style-color">
      {/*
        定番色を先に並べる。<input type="color"> は WebView2 のネイティブダイアログを
        開くので、全画面再生中に開くと画面の外に出る。日常の操作はここで完結させる
      */}
      <div className="sub-style-swatches">
        {SUB_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            className={`sub-style-swatch${c === hex ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(c, alpha)}
          />
        ))}
        <input
          type="color"
          className="sub-style-picker"
          value={hex}
          title="その他の色"
          onChange={(e) => onChange(e.target.value.toUpperCase(), alpha)}
        />
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={alpha}
        title="不透明度"
        onChange={(e) => onChange(hex, Number(e.target.value))}
      />
      <span className="sub-style-value">{Math.round(alpha * 100)}%</span>
    </div>
  );
}

export function SubtitleStyleEditor({
  value, onChange, onReset, assWarning = false, compact = false,
}: {
  value: SubStyle;
  onChange: (patch: Partial<SubStyle>) => void;
  onReset: () => void;
  /** 今選んでいる字幕が ASS/SSA のとき true。「色を変えても効かない」を先回りで伝える */
  assWarning?: boolean;
  /** プレイヤーのパネル用。ラベルを詰めて縦を短くする */
  compact?: boolean;
}) {
  const fonts = useSystemFonts();
  // datalist は id 参照なので、同じ画面に 2 つ出ても衝突しない id を作る
  const fontListId = useId();

  const renderField = (f: SubStyleField) => {
    switch (f.kind) {
      case 'slider':
        return (
          <Slider field={f} value={value[f.key]} onChange={(v) => onChange({ [f.key]: v })} />
        );
      case 'font':
        return (
          <div className="sub-style-control">
            {/*
              <select> ではなく <input list> にしてある —— フォント列挙に失敗しても
              名前を直接打てば効くので、機能そのものが列挙の成否に依存しない
            */}
            <input
              className="sub-style-font"
              list={fontListId}
              value={value.font}
              placeholder="既定(sans-serif)"
              onChange={(e) => onChange({ font: e.target.value })}
            />
            <datalist id={fontListId}>
              {fonts.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        );
      case 'color': {
        const hex = value[f.key];
        const a = value[f.alphaKey];
        return (
          <ColorRow
            hex={hex}
            alpha={a}
            onChange={(nextHex, nextAlpha) =>
              onChange({ [f.key]: nextHex, [f.alphaKey]: nextAlpha })
            }
          />
        );
      }
    }
  };

  return (
    <div className={`sub-style${compact ? ' compact' : ''}`}>
      {assWarning && (
        <div className="sub-style-warn">
          この字幕は制作者が付けたスタイルを持っています。
          「拡大率」「縦位置」以外は反映されません
        </div>
      )}
      {GROUPS.map((g) => {
        const fields = SUB_STYLE_FIELDS.filter((f) => f.group === g.key);
        if (fields.length === 0) return null;
        return (
          <div key={g.key} className="sub-style-group">
            <div className="sub-style-group-title">{g.title}</div>
            {g.note && <div className="sub-style-group-note">{g.note}</div>}
            {fields.map((f) =>
              // チェックは「ラベル 104px + コントロール」の枠に収まらない
              // (「ASS/SSA 字幕にもこの見た目を適用する」が切れる)。
              // 行を分けて、設定モーダルのチェックと同じ「□ + 文」の形にする
              f.kind === 'check' ? (
                <div key={f.key} className="sub-style-check-row">
                  <label className="sub-style-check">
                    <input
                      type="checkbox"
                      checked={value[f.key]}
                      onChange={(e) => onChange({ [f.key]: e.target.checked })}
                    />
                    {f.label}
                  </label>
                  {f.hint && <div className="sub-style-hint">{f.hint}</div>}
                </div>
              ) : (
                <div key={f.key} className="sub-style-row">
                  <span className="sub-style-label" title={f.hint}>
                    {f.label}
                  </span>
                  {renderField(f)}
                  {!compact && f.hint && <div className="sub-style-hint">{f.hint}</div>}
                </div>
              ),
            )}
          </div>
        );
      })}
      <div className="sub-style-actions">
        <button
          type="button"
          disabled={isDefaultSubStyle(value)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onReset}
        >
          既定に戻す
        </button>
      </div>
    </div>
  );
}
