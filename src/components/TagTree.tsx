import { ask } from '@tauri-apps/plugin-dialog';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { Tag } from '../types';

/** タグに付けられる色。自由入力より選ばせた方が一覧が散らからない */
const PALETTE = ['#e05252', '#e08c3a', '#d9c04a', '#5aab5a', '#4a9ed9', '#8f6fd0', '#c76fa8'];

/** parent_id からツリーを組む。親が消えている(参照切れ)タグはトップレベル扱いにする */
function buildTree(tags: Tag[]): Map<number | null, Tag[]> {
  const known = new Set(tags.map((t) => t.id));
  const children = new Map<number | null, Tag[]>();
  for (const t of tags) {
    const parent = t.parentId != null && known.has(t.parentId) ? t.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }
  return children;
}

function TagEditor({ tag, allTags, onDone }: { tag: Tag; allTags: Tag[]; onDone: () => void }) {
  const bumpVersion = useLibrary((s) => s.bumpVersion);
  const [name, setName] = useState(tag.name);

  const apply = async (fn: () => Promise<void>) => {
    try {
      await fn();
      bumpVersion();
    } catch {
      // call() が既にトーストを出しているので、ここでは開いたままにするだけ
    }
  };

  // 自分自身と自分の子孫は親に選べない(循環するため。Rust 側でも弾いている)
  const descendants = new Set<number>([tag.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of allTags) {
      if (t.parentId != null && descendants.has(t.parentId) && !descendants.has(t.id)) {
        descendants.add(t.id);
        grew = true;
      }
    }
  }

  return (
    <div className="tag-editor" onClick={(e) => e.stopPropagation()}>
      <div className="tag-editor-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && name !== tag.name) {
              apply(() => api.renameTag(tag.id, name.trim()));
            }
          }}
          placeholder="タグ名"
        />
        <button
          disabled={!name.trim() || name === tag.name}
          onClick={() => apply(() => api.renameTag(tag.id, name.trim()))}
        >
          名前を変更
        </button>
      </div>

      <div className="tag-editor-row">
        <span className="tag-editor-label">色</span>
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`tag-swatch ${tag.color === c ? 'on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => apply(() => api.setTagColor(tag.id, c))}
          />
        ))}
        <button
          className="tag-swatch none"
          title="色なし"
          onClick={() => apply(() => api.setTagColor(tag.id, null))}
        >
          ×
        </button>
      </div>

      <div className="tag-editor-row">
        <span className="tag-editor-label">親タグ</span>
        <select
          value={tag.parentId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            apply(() => api.setTagParent(tag.id, v === '' ? null : Number(v)));
          }}
        >
          <option value="">(なし)</option>
          {allTags
            .filter((t) => !descendants.has(t.id))
            .map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
        </select>
      </div>

      <div className="tag-editor-row">
        <button
          className="danger"
          onClick={async () => {
            const yes = await ask(
              `タグ「${tag.name}」を削除しますか?\n(${tag.videoCount} 件の動画から外れます。動画自体は消えません。子タグは親なしになります)`,
              { title: 'タグの削除' },
            );
            if (!yes) return;
            const { tagIds, toggleTagFilter } = useLibrary.getState();
            await api.deleteTag(tag.id);
            if (tagIds.includes(tag.id)) toggleTagFilter(tag.id);
            bumpVersion();
            onDone();
          }}
        >
          タグを削除
        </button>
        <button onClick={onDone}>閉じる</button>
      </div>
      {tag.videoCount === 0 && (
        <div className="tag-editor-note">このタグが付いた動画はまだありません</div>
      )}
    </div>
  );
}

/**
 * サイドバーのタグ一覧。tags.parent_id を使ってツリー表示する。
 * 親タグをクリックすると子タグが付いた動画も出る(絞り込みは Rust 側の再帰 CTE)
 */
export function TagTree({ tags }: { tags: Tag[] }) {
  const { tagIds, toggleTagFilter } = useLibrary();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const tree = buildTree(tags);

  const toggleCollapse = (id: number) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderLevel = (parent: number | null, depth: number) =>
    (tree.get(parent) ?? []).map((t) => {
      const children = tree.get(t.id) ?? [];
      const isCollapsed = collapsed.has(t.id);
      return (
        <div key={t.id}>
          <div
            className={`side-item folder ${tagIds.includes(t.id) ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggleTagFilter(t.id)}
            title={`${t.name}(クリックで絞り込み。複数選択で AND 検索${
              children.length > 0 ? '。子タグの動画も含みます' : ''
            })`}
          >
            {children.length > 0 ? (
              <button
                className={`tree-toggle ${isCollapsed ? '' : 'open'}`}
                title={isCollapsed ? '子タグを表示' : '子タグを隠す'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapse(t.id);
                }}
              >
                {/* 開閉でアイコンを変えず CSS で回す(形が変わると大きさが違って見える) */}
                <ChevronDown />
              </button>
            ) : (
              <span className="tree-toggle spacer" />
            )}
            {/* タグ色の丸。監視フォルダの接続状態(.dot)と同じ CSS の円にしている */}
            <span
              className="tag-dot"
              style={t.color ? { background: t.color } : undefined}
            />
            <span className="folder-name">{t.name}</span>
            <span className="count">{t.videoCount}</span>
            <button
              className="remove"
              title="タグを編集(名前・色・親タグ・削除)"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(editing === t.id ? null : t.id);
              }}
            >
              ⋯
            </button>
          </div>
          {editing === t.id && (
            <TagEditor tag={t} allTags={tags} onDone={() => setEditing(null)} />
          )}
          {!isCollapsed && renderLevel(t.id, depth + 1)}
        </div>
      );
    });

  return <>{renderLevel(null, 0)}</>;
}
