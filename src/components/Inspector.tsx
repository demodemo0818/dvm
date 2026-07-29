import { useEffect, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { Series, Tag, TagCount, TagGroup } from '../types';
import { MediaInfoSection } from './MediaInfoSection';

/** 未分類タグをまとめる擬似グループ id(実グループの id は 1 以上) */
const UNGROUPED = 0;

/**
 * 選択中の動画の詳細とタグ・シリーズ・レーティング編集を行う右パネル。
 *
 * ファイル操作(名前の変更・移動・削除)は置かない(v1.14) —
 * 一覧の右クリックメニューと Delete キーに一本化した。
 * 同じ操作の入口が 2 か所にあると、片方だけ直して挙動がずれる
 */
export function Inspector() {
  const {
    selection, version, bumpVersion, clearSelection, patchSelection,
    inspectorPinned, inspectorWidth,
  } = useLibrary();
  const [tagCounts, setTagCounts] = useState<TagCount[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [commonSeries, setCommonSeries] = useState<Series[]>([]);
  const [allSeries, setAllSeries] = useState<Series[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [seriesInput, setSeriesInput] = useState('');
  const [rating, setRatingLocal] = useState(0);

  const ids = selection.map((v) => v.id);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (ids.length === 0) return;
    // パレットの 3 状態(全部 / 一部 / なし)は件数から導くので、共通タグも tagCounts から出す
    api.tagCountsForVideos(ids).then(setTagCounts);
    api.listTags().then(setAllTags);
    api.listTagGroups().then(setTagGroups);
    api.seriesForVideos(ids).then(setCommonSeries);
    api.listSeries().then(setAllSeries);
    // 全選択で同じレーティングならそれを、バラバラなら 0 を表示
    const ratings = new Set(selection.map((v) => v.rating));
    setRatingLocal(ratings.size === 1 ? selection[0].rating : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, version]);

  // 幅はドラッグで変えられる。min-width も同じ値にして、flex に縮められないようにする
  const style = { width: inspectorWidth, minWidth: inspectorWidth };

  if (selection.length === 0) {
    // 固定表示していないときは従来どおり畳む
    if (!inspectorPinned) return null;
    // 固定中は枠だけ残す。レーティングやタグは選択が無いと操作できないので出さない
    return (
      <aside className="inspector" style={style}>
        <div className="inspector-head">
          <span>詳細</span>
        </div>
        <div className="inspector-empty">動画を選ぶとここに詳細が出ます</div>
      </aside>
    );
  }

  const single = selection.length === 1 ? selection[0] : undefined;

  const addTag = async () => {
    const name = tagInput.trim();
    if (!name) return;
    await api.tagVideos(ids, name);
    setTagInput('');
    bumpVersion();
  };

  // 選択中の動画のうち何件にそのタグが付いているか。0 = なし / ids.length = 全部 / 途中 = 一部
  const counts = new Map(tagCounts.map((c) => [c.tagId, c.count]));
  const commonTags = allTags.filter((t) => counts.get(t.id) === ids.length);

  /** パレットのクリック。全部に付いていれば全部外し、そうでなければ全部に付ける */
  const togglePaletteTag = async (tag: Tag, count: number) => {
    try {
      if (count === ids.length) await api.untagVideos(ids, tag.id);
      else await api.tagVideos(ids, tag.name);
      bumpVersion();
    } catch {
      // call() がトーストを出す
    }
  };

  // 絞り込み後のタグをグループごとに仕分ける。消えたグループを指すタグは未分類に落とす
  const needle = paletteFilter.trim().toLowerCase();
  const visibleTags = needle
    ? allTags.filter((t) => t.name.toLowerCase().includes(needle))
    : allTags;
  const knownGroups = new Set(tagGroups.map((g) => g.id));
  const byGroup = new Map<number, Tag[]>();
  for (const t of visibleTags) {
    const key = t.groupId != null && knownGroups.has(t.groupId) ? t.groupId : UNGROUPED;
    const list = byGroup.get(key) ?? [];
    list.push(t);
    byGroup.set(key, list);
  }

  const renderPaletteGroup = (key: number, label: string) => {
    const list = byGroup.get(key) ?? [];
    if (list.length === 0) return null;
    return (
      <div key={key} className="tag-palette-group">
        <div className="tag-palette-label">{label}</div>
        <div className="chip-list">
          {list.map((t) => {
            const count = counts.get(t.id) ?? 0;
            const state = count === 0 ? '' : count === ids.length ? 'on' : 'partial';
            return (
              <button
                key={t.id}
                className={`chip pick ${state}`}
                // 色付きタグは枠と文字色で示す(塗り潰すと文字が読みにくい色が出るため)。
                // 付いている状態は青で塗るので、そのときは色を上書きしない
                style={t.color && state === '' ? { borderColor: t.color, color: t.color } : undefined}
                title={
                  count === 0
                    ? `「${t.name}」を ${ids.length} 件に付ける`
                    : count === ids.length
                      ? `「${t.name}」を外す`
                      : `${count}/${ids.length} 件に付いています(クリックで全部に付ける)`
                }
                onClick={() => togglePaletteTag(t, count)}
              >
                {t.name}
                {state === 'partial' && <span className="chip-partial">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const addSeries = async () => {
    const name = seriesInput.trim();
    if (!name) return;
    await api.addToSeries(ids, name);
    setSeriesInput('');
    bumpVersion();
  };

  const applyRating = async (value: number) => {
    const next = value === rating ? 0 : value;
    setRatingLocal(next);
    await api.setRating(ids, next);
    // 選択中の行データにも即時反映(再取得までの間に古い値へ戻るのを防ぐ)
    patchSelection({ rating: next });
    bumpVersion();
  };

  return (
    <aside className="inspector" style={style}>
      <div className="inspector-head">
        <span>{single ? '詳細' : `${selection.length} 件選択中`}</span>
        <button className="close" title="選択解除 (Esc)" onClick={clearSelection}>×</button>
      </div>

      {single && (
        <div className="inspector-info">
          <div className="info-name" title={single.path}>{single.title ?? single.filename}</div>
          <div className="info-path" title={single.path}>{single.path}</div>
          {single.width && single.height ? (
            <div className="info-sub">{single.width}×{single.height}</div>
          ) : null}
          <div className="info-sub">
            視聴 {single.viewCount} 回
            {single.lastViewedAt ? `(最終: ${single.lastViewedAt})` : ''}
          </div>
          <div className="info-sub">追加日: {single.addedAt}</div>
        </div>
      )}

      <div className="side-section">レーティング</div>
      <div className="stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={`star ${n <= rating ? 'on' : ''}`}
            title={`★${n}(同じ星をもう一度クリックで解除)`}
            onClick={() => applyRating(n)}
          >
            {n <= rating ? '★' : '☆'}
          </button>
        ))}
      </div>

      <div className="side-section">タグ</div>
      <div className="chip-list">
        {commonTags.map((t) => (
          <span
            key={t.id}
            className="chip"
            // 色付きタグは枠と文字色で示す(塗り潰すと文字が読みにくい色が出るため)
            style={t.color ? { borderColor: t.color, color: t.color } : undefined}
          >
            {t.name}
            <button onClick={() => api.untagVideos(ids, t.id).then(bumpVersion)} title="このタグを外す">×</button>
          </span>
        ))}
        {commonTags.length === 0 && <span className="chip-empty">タグなし</span>}
      </div>

      {/*
        タグパレット(v1.19)。既存タグをグループ別に並べ、クリックで選択中の動画にまとめて付ける。
        タグ名を覚えていなくても押すだけで付けられるのが狙い。
        タグが増えても縦に伸び続けないよう、高さ上限を付けて中だけスクロールさせている
      */}
      {allTags.length > 0 && (
        <div className="tag-palette">
          <input
            className="tag-palette-filter"
            placeholder="タグを絞り込む"
            value={paletteFilter}
            onChange={(e) => setPaletteFilter(e.target.value)}
          />
          <div className="tag-palette-body">
            {tagGroups.map((g) => renderPaletteGroup(g.id, g.name))}
            {renderPaletteGroup(UNGROUPED, '未分類')}
            {visibleTags.length === 0 && (
              <span className="chip-empty">「{paletteFilter}」に一致するタグはありません</span>
            )}
          </div>
        </div>
      )}

      <div className="tag-add">
        <input
          list="all-tags"
          placeholder="タグを追加して Enter"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTag();
          }}
        />
        <datalist id="all-tags">
          {allTags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </div>

      <div className="side-section">シリーズ</div>
      <div className="chip-list">
        {commonSeries.map((s) => (
          <span key={s.id} className="chip">
            <ListOrdered size={13} />
            {s.name}
            <button
              onClick={() => api.removeFromSeries(ids, s.id).then(bumpVersion)}
              title="このシリーズから外す"
            >
              ×
            </button>
          </span>
        ))}
        {commonSeries.length === 0 && <span className="chip-empty">シリーズなし</span>}
      </div>
      <div className="tag-add">
        <input
          list="all-series"
          placeholder="シリーズに追加して Enter"
          value={seriesInput}
          onChange={(e) => setSeriesInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSeries();
          }}
        />
        <datalist id="all-series">
          {allSeries.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </div>

      {/*
        展開すると縦に長くなるので一番下に置く(レーティング・タグの位置がずれない)。
        複数選択では出さない — ffprobe を選択数だけ起動することになるため
      */}
      {single && <MediaInfoSection video={single} />}

      {!single && (
        <div className="inspector-note">変更は選択中の全動画に適用されます</div>
      )}
    </aside>
  );
}
