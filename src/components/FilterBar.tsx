import { Fragment, useEffect, useRef, useState } from 'react';
import { useFilterMasters } from '../hooks/useFilterMasters';
import { dedupeMessage } from '../lib/dedupeMessage';
import { describeFilter, type ClearAction } from '../lib/filterChips';
import type { FilterState } from '../lib/query';
import { useLibrary } from '../store';
import { EMPTY_ADVANCED, type AdvancedFilter } from '../types';
import { DedupeDialog } from './DedupeDialog';

/**
 * 絞り込み帯(v1.28)。ツールバーと一覧の間に常駐する 1 行。
 *
 * 狙いは 2 つ。
 * 1. **タグの OR / AND を目で分かるようにする**。同じ箱の中は「または」、箱と箱は「かつ」。
 *    箱の分け方は Rust 側の軸(core/query.rs)と同じ規則(lib/filterChips.ts)
 * 2. **いまの条件に何件マッチしているかを出す**。件数は VideoGrid が使っているものを
 *    そのまま受け取る —— ここで数え直すと count_videos が 2 回走り、
 *    しかも帯とグリッドで数字が食い違う瞬間ができる
 *
 * 条件が無くても消さない。出し入れするとツールバーと一覧の間が 32px 伸縮して
 * グリッドが上下に跳ねるため(件数を常に見せたいという理由もある)
 */
export function FilterBar({
  filters, total, counted,
}: {
  /** VideoGrid が buildQuery に渡したものと同じ絞り込み一式 */
  filters: FilterState;
  total: number;
  /** 一度でも数え終わったか。false の間は 0 を「0 件」と読ませない */
  counted: boolean;
}) {
  const {
    setText, setAdvanced, toggleTagFilter, setTagFilter, setFolderId, toggleDirPath,
    toggleSeriesFilter, setMinRating, setDurationBucket, toggleMissingOnly,
    toggleDuplicatesOnly, applyFilter, version, bumpVersion, pushToast,
  } = useLibrary();
  const [showDedupe, setShowDedupe] = useState(false);

  // 名前を引かないと出せない条件が効いているときだけマスタを取りに行く
  const needsMasters =
    filters.tagIds.length > 0 || filters.folderId !== null || filters.seriesId !== null;
  const masters = useFilterMasters(needsMasters, version);
  const terms = describeFilter(filters, masters);

  /*
   * 縦ホイールで横へ流す。何もしないと、縦に動けないこの帯を wheel が素通りして
   * 後ろのグリッドがスクロールしてしまう(実機で確認済み)。
   * React の onWheel は passive で登録されるため preventDefault が効かない。
   * だから直接 addEventListener する
   */
  const termsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = termsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * 右端のフェードは**本当に溢れているときだけ**出す。出しっぱなしにすると、
   * 端に来ただけのチップが薄くなって「まだ続きがある」と誤解させる。
   * 幅(窓のリサイズ)とチップの中身の両方で測り直す
   */
  const [overflowing, setOverflowing] = useState(false);
  const shape = terms.map((t) => t.chips.map((c) => c.label).join()).join('|');
  useEffect(() => {
    const el = termsRef.current;
    if (!el) return;
    const update = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape]);

  /** チップの × を押したときの振り分け。ClearAction の種類はここで出し切る */
  const clear = (action: ClearAction) => {
    switch (action.type) {
      case 'text': setText(''); break;
      case 'searchPath': setAdvanced({ searchPath: false }); break;
      case 'tag': toggleTagFilter(action.tagId); break;
      case 'tagAxis':
        setTagFilter(filters.tagIds.filter((id) => !action.tagIds.includes(id)));
        break;
      case 'folder': setFolderId(null); break;
      case 'dirPath': toggleDirPath(null); break;
      case 'series':
        if (filters.seriesId !== null) toggleSeriesFilter(filters.seriesId);
        break;
      case 'minRating': setMinRating(0); break;
      case 'duration': setDurationBucket(null); break;
      case 'missing': toggleMissingOnly(); break;
      case 'duplicates': toggleDuplicatesOnly(); break;
      case 'codec':
        setAdvanced({
          videoCodecs: filters.advanced.videoCodecs.filter((c) => c !== action.codec),
        });
        break;
      // 既定値は EMPTY_ADVANCED から引く。詳細検索に項目が増えてもここは増えない
      case 'advanced':
        setAdvanced({ [action.key]: EMPTY_ADVANCED[action.key] } as Partial<AdvancedFilter>);
        break;
    }
  };

  return (
    <div className="filterbar">
      <div className={`fb-terms${overflowing ? ' overflowing' : ''}`} ref={termsRef}>
        {terms.length === 0 && <span className="fb-empty">絞り込みなし</span>}
        {terms.map((term, i) => (
          <Fragment key={term.key}>
            {i > 0 && <span className="fb-join">かつ</span>}
            {/* 箱の枠は 2 つ以上のとき(= 実際に「または」が起きているとき)だけ付ける */}
            <span className={`fb-term${term.chips.length > 1 ? ' or' : ''}`}>
              {term.caption !== null && (
                <span className="fb-caption">
                  {term.caption}
                  {/*
                    箱ごと外す × は**見出しの隣**に置く。チップの右端に置くと
                    直前のチップの × と並んでどちらを消すのか分からなくなる
                  */}
                  {term.clearAll !== null && (
                    <button
                      className="fb-term-clear"
                      title={`「${term.caption}」の条件をまとめて外す`}
                      onClick={() => clear(term.clearAll!)}
                    >
                      ×
                    </button>
                  )}
                </span>
              )}
              {term.chips.map((chip, j) => (
                <Fragment key={chip.key}>
                  {j > 0 && <span className="fb-or">または</span>}
                  <span
                    className={`chip${chip.unresolved ? ' unresolved' : ''}`}
                    // 色付きタグは枠と文字色で示す(Inspector と同じ作法)
                    style={chip.color ? { borderColor: chip.color, color: chip.color } : undefined}
                    title={chip.unresolved ? '名前を読み込み中、または削除された項目です' : chip.label}
                  >
                    {chip.label}
                    <button title="この条件を外す" onClick={() => clear(chip.clear)}>×</button>
                  </span>
                </Fragment>
              ))}
            </span>
          </Fragment>
        ))}
      </div>

      <span className="fb-count">
        {counted
          ? <>{terms.length > 0 ? '' : '全 '}<b>{total.toLocaleString()}</b> 件</>
          : '集計中…'}
      </span>
      {/*
        重複を見ているときだけ出す作業ボタン(v1.33)。ツールバーではなくここに置くのは、
        「いま画面に出ている重複」が対象だと分かる場所だから。
        フォルダで絞り込んでいれば、そのフォルダ配下だけが対象になる
      */}
      {filters.duplicatesOnly && (
        <button
          className="fb-dedupe"
          title={
            filters.dirPath !== null
              ? `${filters.dirPath} の配下で、同じ内容の動画を 1 本だけ残す(ファイルは消しません)`
              : 'ライブラリ全体で、同じ内容の動画を 1 本だけ残す(ファイルは消しません)'
          }
          onClick={() => setShowDedupe(true)}
        >
          重複を解消
        </button>
      )}
      {terms.length > 0 && (
        <button
          className="fb-clear"
          title="絞り込みをすべて解除する(並び順はそのまま)"
          onClick={() => applyFilter({})}
        >
          すべて解除
        </button>
      )}

      {showDedupe && (
        <DedupeDialog
          scope={filters.dirPath ?? undefined}
          onClose={() => setShowDedupe(false)}
          onDone={(result, trashed) => {
            setShowDedupe(false);
            bumpVersion();
            pushToast(dedupeMessage(result, trashed), result.failed > 0 ? 'error' : 'info');
          }}
        />
      )}
    </div>
  );
}
