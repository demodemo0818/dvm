import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  advancedCount, CODEC_OPTIONS, DURATION_LABELS, DURATION_RANGES, GB, MB,
  ORIENTATION_OPTIONS, RESOLUTION_MAX_OPTIONS, RESOLUTION_OPTIONS, sizeUnitFor,
  WITHIN_DAYS_OPTIONS,
} from '../lib/query';
import { useLibrary } from '../store';
import type { AdvancedFilter, DurationBucket, ExtensionCount, Orientation } from '../types';

/** .adv-popover の幅(App.css と対)と、画面端に残す余白 */
const POPOVER_W = 640;
/** 1 カラムに落とす幅。これを下回ると 2 列が窮屈になる */
const ONE_COL_W = 340;
const EDGE = 8;
/** 上下に残す余白。ポップオーバーはこれを引いた高さで内部スクロールする */
const V_MARGIN = 16;

/** 1 分 (ms)。尺の入力は分で受ける */
const MIN = 60_000;

/**
 * ツールバーの「詳細検索」ポップオーバー(v1.35 で 2 カラムに拡張)。
 *
 * **絞り込みの入口はここ 1 つ**。v1.34 までツールバー本体にあった★と長さもここに移した
 * (理由は DESIGN.md「ツールバー」節)。頻繁に使う条件の組み合わせは
 * スマートフォルダに名前を付けてサイドバーに置くほうが速い。
 *
 * **位置はボタンの座標を受け取って画面基準(fixed)で決める**。ツールバーは
 * overflow: hidden なので、中に absolute で置くとそこで切られてしまう。
 * 列選択ポップオーバー・右クリックメニューと同じ扱い
 */
export function AdvancedSearch({
  at, onClose,
}: {
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const { advanced, setAdvanced, clearAdvanced } = useLibrary();
  const ref = useRef<HTMLDivElement>(null);
  const [exts, setExts] = useState<ExtensionCount[] | null>(null);

  /*
   * 単位は**画面だけの状態**。条件として意味を持つのはバイト数だけなので保存しない。
   * 開いたときに今の値から決める(0.5GB は「512 MB」と出る。lib/query.ts の sizeUnitFor)
   */
  const [sizeUnit, setSizeUnit] = useState(
    () => sizeUnitFor(advanced.minSizeBytes, advanced.maxSizeBytes),
  );

  // 拡張子の候補は**開いたときに 1 回だけ**引く(全件走査なので原則 3 に沿って Rust 側)
  useEffect(() => {
    let alive = true;
    api.listExtensions().then((list) => { if (alive) setExts(list); });
    return () => { alive = false; };
  }, []);

  // 外側クリックと Esc で閉じる
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // クリックで開いた直後の同じイベントで閉じないよう次のフレームから拾う
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /*
   * 幅が足りなければ 1 カラムに落とす。窓を 460px 近くまで縮められる設計なので、
   * 640px 固定だと画面外にはみ出す(ツールバーの「残る限界」と同じ話)
   */
  const width = Math.min(POPOVER_W, window.innerWidth - EDGE * 2);
  const oneCol = width < POPOVER_W && width < ONE_COL_W * 1.6;
  const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE));
  // 縦は画面に収める。溢れたぶんは中でスクロールする(タグパレットと同じ作法)
  const maxHeight = Math.max(200, window.innerHeight - at.y - V_MARGIN);

  const set = (patch: Partial<AdvancedFilter>) => setAdvanced(patch);
  /** 空欄は null(= 指定なし)。0 に意味がある欄があるので 0 と空欄を混ぜない */
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  /** ミリ秒 → 分の表示。端数は出さない(入力欄が分単位なので) */
  const toMin = (ms: number | null) => (ms === null ? '' : String(Math.round(ms / MIN)));
  /** バイト → 表示中の単位。割り切れないときだけ小数を見せる */
  const toUnit = (b: number | null) => {
    if (b === null) return '';
    const v = b / sizeUnit;
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  };

  const toggleIn = (key: 'videoCodecs' | 'extensions', value: string) => {
    const cur = advanced[key];
    set({ [key]: cur.includes(value) ? cur.filter((c) => c !== value) : [...cur, value] });
  };

  /** 単位を変えたら、いま入っている値の**見た目の数字**を保つ(500 MB → 500 GB) */
  const changeUnit = (next: typeof MB | typeof GB) => {
    const keep = (b: number | null) => (b === null ? null : Math.round((b / sizeUnit) * next));
    set({ minSizeBytes: keep(advanced.minSizeBytes), maxSizeBytes: keep(advanced.maxSizeBytes) });
    setSizeUnit(next);
  };

  return (
    <div
      className={`adv-popover${oneCol ? ' one-col' : ''}`}
      ref={ref}
      style={{ left, top: at.y, width, maxHeight }}
    >
      <div className="adv-title">詳細検索</div>

      <div className="adv-cols">
        {/* ---- 左: 探し方 / 評価・視聴 ---------------------------------- */}
        <div className="adv-col-box">
          <div className="adv-group">探し方</div>
          <label className="adv-check">
            <input
              type="checkbox"
              checked={advanced.searchPath}
              onChange={(e) => set({ searchPath: e.target.checked })}
            />
            フォルダのパスも検索対象にする
          </label>
          <label className="adv-check">
            <input
              type="checkbox"
              checked={advanced.searchComment}
              onChange={(e) => set({ searchComment: e.target.checked })}
            />
            メモも検索対象にする
          </label>

          <div className="adv-group">評価・視聴</div>
          <div className="adv-row">
            <span className="adv-label">評価</span>
            <select
              value={advanced.unrated ? 'none' : String(advanced.minRating)}
              onChange={(e) => {
                const v = e.target.value;
                // ★なしと「★N 以上」は同時に成り立たないので、セレクト 1 つで排他にする
                set(v === 'none'
                  ? { unrated: true, minRating: 0 }
                  : { unrated: false, minRating: Number(v) });
              }}
            >
              <option value="0">指定なし</option>
              <option value="none">★なし(未評価)</option>
              <option value="1">★1 以上</option>
              <option value="2">★2 以上</option>
              <option value="3">★3 以上</option>
              <option value="4">★4 以上</option>
              <option value="5">★5</option>
            </select>
          </div>
          <label className="adv-check">
            <input
              type="checkbox"
              checked={advanced.untagged}
              onChange={(e) => set({ untagged: e.target.checked })}
            />
            タグが付いていないものだけ
          </label>
          <label className="adv-check">
            <input
              type="checkbox"
              checked={advanced.unwatched}
              onChange={(e) => set({ unwatched: e.target.checked })}
            />
            まだ観ていないものだけ
          </label>
          <label className="adv-check">
            <input
              type="checkbox"
              checked={advanced.resumedOnly}
              onChange={(e) => set({ resumedOnly: e.target.checked })}
            />
            途中まで観たものだけ
          </label>
          <div className="adv-row">
            <span className="adv-label">再生回数</span>
            <input
              type="number" min={0} className="adv-num"
              value={advanced.minViewCount ?? ''}
              onChange={(e) => set({ minViewCount: num(e.target.value) })}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="number" min={0} className="adv-num"
              value={advanced.maxViewCount ?? ''}
              onChange={(e) => set({ maxViewCount: num(e.target.value) })}
            />
            <span className="adv-unit">回</span>
          </div>

          <div className="adv-group">長さ</div>
          <div className="adv-row">
            <input
              type="number" min={0} className="adv-num"
              value={toMin(advanced.minDurationMs)}
              onChange={(e) => set({ minDurationMs: num(e.target.value) === null ? null : num(e.target.value)! * MIN })}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="number" min={0} className="adv-num"
              value={toMin(advanced.maxDurationMs)}
              onChange={(e) => set({ maxDurationMs: num(e.target.value) === null ? null : num(e.target.value)! * MIN })}
            />
            <span className="adv-unit">分</span>
          </div>
          {/* プリセットは「その値を書き込むショートカット」。文言は帯のチップと共有 */}
          <div className="adv-chips">
            {(Object.keys(DURATION_LABELS) as DurationBucket[]).map((k) => {
              const r = DURATION_RANGES[k];
              const on = (r.min ?? null) === advanced.minDurationMs
                && (r.max ?? null) === advanced.maxDurationMs;
              return (
                <button
                  key={k}
                  type="button"
                  className={`adv-chip ${on ? 'on' : ''}`}
                  onClick={() => set(on
                    ? { minDurationMs: null, maxDurationMs: null }
                    : { minDurationMs: r.min ?? null, maxDurationMs: r.max ?? null })}
                >
                  {DURATION_LABELS[k]}
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- 右: ファイル / 日付 -------------------------------------- */}
        <div className="adv-col-box">
          <div className="adv-group">ファイル</div>
          <div className="adv-row">
            <span className="adv-label">サイズ</span>
            <input
              type="number" min={0} className="adv-num"
              value={toUnit(advanced.minSizeBytes)}
              onChange={(e) => set({ minSizeBytes: num(e.target.value) === null ? null : Math.round(num(e.target.value)! * sizeUnit) })}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="number" min={0} className="adv-num"
              value={toUnit(advanced.maxSizeBytes)}
              onChange={(e) => set({ maxSizeBytes: num(e.target.value) === null ? null : Math.round(num(e.target.value)! * sizeUnit) })}
            />
            <select
              className="adv-unit-select"
              value={sizeUnit === GB ? 'GB' : 'MB'}
              onChange={(e) => changeUnit(e.target.value === 'GB' ? GB : MB)}
            >
              <option value="MB">MB</option>
              <option value="GB">GB</option>
            </select>
          </div>

          <div className="adv-row adv-col">
            <span className="adv-label">拡張子</span>
            <div className="adv-chips">
              {exts === null && <span className="adv-hint">読み込み中…</span>}
              {exts?.length === 0 && <span className="adv-hint">動画がありません</span>}
              {exts?.map((e) => (
                <button
                  key={e.ext}
                  type="button"
                  className={`adv-chip ${advanced.extensions.includes(e.ext) ? 'on' : ''}`}
                  title={`${e.count.toLocaleString()} 件`}
                  onClick={() => toggleIn('extensions', e.ext)}
                >
                  {e.ext} <span className="adv-chip-n">{e.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="adv-row">
            <span className="adv-label">解像度</span>
            <select
              value={advanced.minHeight}
              onChange={(e) => set({ minHeight: Number(e.target.value) })}
            >
              {RESOLUTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={advanced.maxHeight}
              onChange={(e) => set({ maxHeight: Number(e.target.value) })}
            >
              {RESOLUTION_MAX_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="adv-row">
            <span className="adv-label">向き</span>
            <select
              value={advanced.orientation}
              onChange={(e) => set({ orientation: e.target.value as Orientation })}
            >
              {ORIENTATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="adv-row adv-col">
            <span className="adv-label">コーデック</span>
            <div className="adv-chips">
              {CODEC_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`adv-chip ${advanced.videoCodecs.includes(c) ? 'on' : ''}`}
                  onClick={() => toggleIn('videoCodecs', c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="adv-group">日付</div>
          {/*
            相対指定を絶対日付より上に置く。**保存しても腐らない**のはこちらだけなので、
            スマートフォルダに入れるならこちらを選んでほしい
          */}
          <div className="adv-row">
            <span className="adv-label">追加</span>
            <select
              value={advanced.addedWithinDays}
              onChange={(e) => set({ addedWithinDays: Number(e.target.value) })}
            >
              {WITHIN_DAYS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="adv-row">
            <span className="adv-label" />
            <input
              type="date"
              value={advanced.addedAfter}
              onChange={(e) => set({ addedAfter: e.target.value })}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="date"
              value={advanced.addedBefore}
              onChange={(e) => set({ addedBefore: e.target.value })}
            />
          </div>
          <div className="adv-row">
            <span className="adv-label">更新</span>
            <select
              value={advanced.modifiedWithinDays}
              onChange={(e) => set({ modifiedWithinDays: Number(e.target.value) })}
            >
              {WITHIN_DAYS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="adv-row">
            <span className="adv-label" />
            <input
              type="date"
              value={advanced.modifiedAfter}
              onChange={(e) => set({ modifiedAfter: e.target.value })}
            />
            <span className="adv-tilde">〜</span>
            <input
              type="date"
              value={advanced.modifiedBefore}
              onChange={(e) => set({ modifiedBefore: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="adv-actions">
        <button onClick={clearAdvanced} disabled={advancedCount(advanced) === 0}>
          条件をクリア
        </button>
        <button onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
