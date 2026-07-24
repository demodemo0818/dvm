import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { Tag } from '../types';

/** 選択中の動画の詳細とタグ編集を行う右パネル */
export function Inspector() {
  const { selection, version, bumpVersion, clearSelection } = useLibrary();
  const [commonTags, setCommonTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [input, setInput] = useState('');

  const ids = selection.map((v) => v.id);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (ids.length === 0) return;
    api.tagsForVideos(ids).then(setCommonTags);
    api.listTags().then(setAllTags);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, version]);

  if (selection.length === 0) return null;

  const single = selection.length === 1 ? selection[0] : undefined;

  const addTag = async () => {
    const name = input.trim();
    if (!name) return;
    await api.tagVideos(ids, name);
    setInput('');
    bumpVersion();
  };

  const removeTag = async (tagId: number) => {
    await api.untagVideos(ids, tagId);
    bumpVersion();
  };

  return (
    <aside className="inspector">
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
        </div>
      )}

      <div className="side-section">タグ</div>
      <div className="chip-list">
        {commonTags.map((t) => (
          <span key={t.id} className="chip">
            {t.name}
            <button onClick={() => removeTag(t.id)} title="このタグを外す">×</button>
          </span>
        ))}
        {commonTags.length === 0 && <span className="chip-empty">タグなし</span>}
      </div>
      <div className="tag-add">
        <input
          list="all-tags"
          placeholder="タグを追加して Enter"
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
      {!single && (
        <div className="inspector-note">タグの追加・削除は選択中の全動画に適用されます</div>
      )}
    </aside>
  );
}
