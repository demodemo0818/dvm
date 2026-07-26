import { ask, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { PlanItem, Series, Tag } from '../types';
import { FileOpDialog } from './FileOpDialog';
import type { FileOpKind } from './FileOpDialog';

/** 選択中の動画の詳細とタグ・シリーズ・レーティング編集を行う右パネル */
export function Inspector() {
  const {
    selection, version, bumpVersion, clearSelection, patchSelection,
    inspectorPinned, inspectorWidth,
  } = useLibrary();
  const [commonTags, setCommonTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [commonSeries, setCommonSeries] = useState<Series[]>([]);
  const [allSeries, setAllSeries] = useState<Series[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [seriesInput, setSeriesInput] = useState('');
  const [rating, setRatingLocal] = useState(0);
  /** dry-run の結果。null の間はダイアログを出さない(プレビューなしに実行させない) */
  const [fileOp, setFileOp] = useState<{ kind: FileOpKind; plan: PlanItem[] } | null>(null);

  const ids = selection.map((v) => v.id);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (ids.length === 0) return;
    api.tagsForVideos(ids).then(setCommonTags);
    api.listTags().then(setAllTags);
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
            ≡ {s.name}
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

      {!single && (
        <div className="inspector-note">変更は選択中の全動画に適用されます</div>
      )}

      <div className="side-section">ファイル操作</div>
      <div className="inspector-fileops">
        {single && (
          <button
            onClick={async () => {
              const name = window.prompt('新しいファイル名', single.filename);
              if (name === null || name.trim() === '' || name === single.filename) return;
              const item = await api.planRename(single.id, name.trim());
              setFileOp({ kind: 'rename', plan: [item] });
            }}
          >
            名前を変更...
          </button>
        )}
        <button
          onClick={async () => {
            const dest = await open({ directory: true, multiple: false, title: '移動先フォルダ' });
            if (typeof dest !== 'string') return;
            const plan = await api.planMove(ids, dest);
            setFileOp({ kind: 'move', plan });
          }}
        >
          移動...
        </button>
      </div>

      <div className="inspector-footer">
        <button
          className="danger"
          onClick={async () => {
            const yes = await ask(
              `${selection.length} 件をライブラリから削除しますか?\n(登録とタグ情報が消えます。ファイル自体は削除されません)`,
              { title: 'ライブラリから削除' },
            );
            if (!yes) return;
            await api.removeVideos(ids);
            clearSelection();
            bumpVersion();
          }}
        >
          ライブラリから削除
        </button>
      </div>

      {fileOp && (
        <FileOpDialog kind={fileOp.kind} plan={fileOp.plan} onClose={() => setFileOp(null)} />
      )}
    </aside>
  );
}
