import { ask } from '@tauri-apps/plugin-dialog';
import { ChevronDown, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api';
import { useContextMenu } from '../hooks/useContextMenu';
import { buildTagGroupMenu, buildTagMenu } from '../lib/contextMenu';
import { TAG_PALETTE } from '../lib/tagColors';
import { useLibrary } from '../store';
import type { Tag, TagGroup } from '../types';
import { ContextMenu } from './ContextMenu';

/** 折りたたんだグループの id。未分類は id を持たないので 0 で表す(グループ id は 1 以上) */
const UNGROUPED = 0;
const COLLAPSED_KEY = 'dvm.collapsedTagGroups';

/**
 * ドラッグとみなすまでの移動量(px)。これ未満はクリック(絞り込みのトグル)として扱う。
 *
 * **HTML5 の D&D は使えない**。Tauri のドラッグ&ドロップハンドラを無効にしないと
 * Windows では draggable / onDrop が動かず、無効にすると App.tsx の onDragDropEvent
 * (フォルダを落として監視フォルダ登録)が壊れる。なのでポインタイベントで自前実装する
 */
const DRAG_THRESHOLD = 4;

function loadCollapsed(): Set<number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v): v is number => typeof v === 'number') : []);
  } catch {
    return new Set();
  }
}

/**
 * タグの削除。**確認からここに閉じ込める**(v1.20)。
 * `⋯` の編集パネルと右クリックメニューの両方から呼ぶので、
 * 文言をコピペすると片方だけ直して挙動がずれる。消えたら true
 */
async function confirmDeleteTag(tag: Tag): Promise<boolean> {
  const yes = await ask(
    `タグ「${tag.name}」を削除しますか?\n(${tag.videoCount} 件の動画から外れます。動画自体は消えません)`,
    { title: 'タグの削除' },
  );
  if (!yes) return false;
  const { tagIds, toggleTagFilter, bumpVersion } = useLibrary.getState();
  await api.deleteTag(tag.id);
  // 消したタグで絞り込んだままだと 0 件になって戻れなくなる
  if (tagIds.includes(tag.id)) toggleTagFilter(tag.id);
  bumpVersion();
  return true;
}

/** グループの削除。中のタグは消えず未分類に落ちる。呼び出し口は上と同じ理由で 1 つ */
async function confirmDeleteGroup(group: TagGroup): Promise<boolean> {
  const yes = await ask(
    `グループ「${group.name}」を削除しますか?\n(${group.tagCount} 個のタグは未分類に移ります。動画に付いたタグはそのままです)`,
    { title: 'グループの削除' },
  );
  if (!yes) return false;
  await api.deleteTagGroup(group.id);
  useLibrary.getState().bumpVersion();
  return true;
}

function TagEditor({ tag, groups, onDone }: { tag: Tag; groups: TagGroup[]; onDone: () => void }) {
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
        {TAG_PALETTE.map((c) => (
          <button
            key={c.value}
            className={`tag-swatch ${tag.color === c.value ? 'on' : ''}`}
            style={{ background: c.value }}
            title={c.label}
            onClick={() => apply(() => api.setTagColor(tag.id, c.value))}
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
        <span className="tag-editor-label">グループ</span>
        <select
          value={tag.groupId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            apply(() => api.setTagGroup(tag.id, v === '' ? null : Number(v)));
          }}
        >
          <option value="">(未分類)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      <div className="tag-editor-row">
        <button
          className="danger"
          onClick={async () => {
            if (await confirmDeleteTag(tag)) onDone();
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

function GroupEditor({
  group, index, total, onMove, onDone,
}: {
  group: TagGroup;
  index: number;
  total: number;
  onMove: (dir: -1 | 1) => void;
  onDone: () => void;
}) {
  const bumpVersion = useLibrary((s) => s.bumpVersion);
  const [name, setName] = useState(group.name);

  const apply = async (fn: () => Promise<void>) => {
    try {
      await fn();
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  return (
    <div className="tag-editor" onClick={(e) => e.stopPropagation()}>
      <div className="tag-editor-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && name !== group.name) {
              apply(() => api.renameTagGroup(group.id, name.trim()));
            }
          }}
          placeholder="グループ名"
        />
        <button
          disabled={!name.trim() || name === group.name}
          onClick={() => apply(() => api.renameTagGroup(group.id, name.trim()))}
        >
          名前を変更
        </button>
      </div>

      <div className="tag-editor-row">
        <span className="tag-editor-label">並び順</span>
        <button disabled={index === 0} onClick={() => onMove(-1)}>↑ 上へ</button>
        <button disabled={index === total - 1} onClick={() => onMove(1)}>↓ 下へ</button>
      </div>

      <div className="tag-editor-row">
        <button
          className="danger"
          onClick={async () => {
            if (await confirmDeleteGroup(group)) onDone();
          }}
        >
          グループを削除
        </button>
        <button onClick={onDone}>閉じる</button>
      </div>
    </div>
  );
}

/**
 * サイドバーのタグ一覧。tag_groups > tags の 2 階層で出す(v1.19)。
 *
 * グループ見出しをクリックすると配下タグをまとめて絞り込みに入れる。
 * 同じグループのタグ同士は Rust 側(core/query.rs)で OR になるので、
 * 「このグループのタグが何か付いている動画」が出る
 */
export function TagTree({
  tags, groups, filtering,
}: {
  tags: Tag[];
  groups: TagGroup[];
  /** サイドバーの絞り込みが効いているか。効いている間は畳まず、空のグループも出さない */
  filtering: boolean;
}) {
  const { tagIds, toggleTagFilter, setTagFilter, bumpVersion } = useLibrary();
  const [collapsed, setCollapsed] = useState<Set<number>>(loadCollapsed);
  const [editingTag, setEditingTag] = useState<number | null>(null);
  const [editingGroup, setEditingGroup] = useState<number | null>(null);
  // 作成フォームの表示先。tag は「どのグループに作るか」を持つ(null = 未分類)
  const [creating, setCreating] =
    useState<{ kind: 'group' } | { kind: 'tag'; groupId: number | null } | null>(null);
  const [newName, setNewName] = useState('');

  /**
   * D&D の状態。**掴むものによってドロップ先の意味が違う**ので判別可能ユニオンにしてある:
   * タグはグループの上に落として所属を変え、グループは他のグループの前後に落として並べ替える
   */
  const dragStart = useRef<{ kind: 'tag' | 'group'; id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<
    | { kind: 'tag'; id: number; x: number; y: number; overGroup: number | null }
    | { kind: 'group'; id: number; x: number; y: number; insertAt: number | null }
    | null
  >(null);
  // ドラッグで終わった pointerup の直後に click が来るので、絞り込みのトグルを 1 回だけ抑える
  const suppressClick = useRef(false);

  /** 右クリックメニュー(v1.20)。対象はタグ 1 個かグループ見出し(未分類は group=null) */
  const { menu, open: openMenu, close: closeMenu } = useContextMenu<
    { kind: 'tag'; tag: Tag } | { kind: 'group'; group: TagGroup | null; index: number }
  >();

  /**
   * ドラッグ中の右クリックはドラッグを中止してメニューを出さない(エクスプローラーと同じ)。
   * `onDragPointerDown` が `e.button !== 0` で弾くのでドラッグ自体は始まらないが、
   * **左ボタンで掴んだままの右クリック**では pointerup が来ず、掴んだ状態が宙に浮く
   */
  const cancelDragForMenu = () => {
    if (!dragStart.current && !dragging) return false;
    dragStart.current = null;
    setDragging(null);
    return true;
  };

  const onDragPointerDown = (e: React.PointerEvent, kind: 'tag' | 'group', id: number) => {
    if (e.button !== 0) return;
    dragStart.current = { kind, id, x: e.clientX, y: e.clientY };
    // capture しておくと、行の外にカーソルが出ても move/up を取りこぼさない
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragPointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return;
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
    // capture 中は pointerenter が飛ばないので、座標からドロップ先を引く
    const at = document.elementFromPoint(e.clientX, e.clientY);
    if (start.kind === 'tag') {
      const el = at?.closest('[data-drop-group]');
      const over = el instanceof HTMLElement ? Number(el.dataset.dropGroup) : null;
      setDragging({ kind: 'tag', id: start.id, x: e.clientX, y: e.clientY, overGroup: over });
    } else {
      // グループは「どのグループの前に入るか」。見出しの上半分なら手前、下半分なら次の位置
      const el = at?.closest('[data-group-index]');
      let insertAt: number | null = null;
      if (el instanceof HTMLElement) {
        const idx = Number(el.dataset.groupIndex);
        const r = el.getBoundingClientRect();
        insertAt = e.clientY < r.top + r.height / 2 ? idx : idx + 1;
      }
      setDragging({ kind: 'group', id: start.id, x: e.clientX, y: e.clientY, insertAt });
    }
  };

  const onDragPointerUp = async () => {
    const start = dragStart.current;
    const drop = dragging;
    dragStart.current = null;
    setDragging(null);
    if (!start || !drop) return; // 動かしていない = ただのクリック
    suppressClick.current = true;
    // click が来なかったとき(ドロップ先がボタンの上だった等)にフラグが残って
    // 次のクリックを食べてしまわないよう、同じイベントループの最後で必ず戻す
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    try {
      if (drop.kind === 'tag') {
        const tag = tags.find((t) => t.id === drop.id);
        // ドロップ先が無い(サイドバーの外)か、元と同じグループなら何もしない
        if (drop.overGroup === null || !tag) return;
        if ((tag.groupId ?? UNGROUPED) === drop.overGroup) return;
        await api.setTagGroup(tag.id, drop.overGroup === UNGROUPED ? null : drop.overGroup);
      } else {
        const from = groups.findIndex((g) => g.id === drop.id);
        if (drop.insertAt === null || from < 0) return;
        // 自分を配列から抜くぶん、後ろへ動かすときは挿入位置が 1 つ手前にずれる
        const to = drop.insertAt > from ? drop.insertAt - 1 : drop.insertAt;
        if (to === from) return;
        const next = [...groups];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        await api.reorderTagGroups(next.map((g) => g.id));
      }
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  const toggleCollapse = (id: number) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });

  // グループごとに仕分ける。消えたグループを指すタグは未分類に落とす(参照切れ対策)
  const known = new Set(groups.map((g) => g.id));
  const byGroup = new Map<number, Tag[]>();
  for (const t of tags) {
    const key = t.groupId != null && known.has(t.groupId) ? t.groupId : UNGROUPED;
    const list = byGroup.get(key) ?? [];
    list.push(t);
    byGroup.set(key, list);
  }
  const ungrouped = byGroup.get(UNGROUPED) ?? [];

  const startCreate = (target: { kind: 'group' } | { kind: 'tag'; groupId: number | null }) => {
    setNewName('');
    setCreating(target);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name || !creating) return;
    try {
      if (creating.kind === 'group') await api.createTagGroup(name);
      else await api.createTag(name, creating.groupId);
      setNewName('');
      setCreating(null);
      bumpVersion();
    } catch {
      // 名前が重複したときなど。トーストが出るので入力は残したままにする
    }
  };

  const moveGroup = async (index: number, dir: -1 | 1) => {
    const next = [...groups];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    try {
      await api.reorderTagGroups(next.map((g) => g.id));
      bumpVersion();
    } catch {
      // トーストは call() の担当
    }
  };

  /** グループ見出しのクリックと同じ絞り込み。配下タグをまとめて入れ替える */
  const toggleGroupFilter = (ids: number[]) => {
    if (ids.length === 0) return;
    const allOn = ids.every((id) => tagIds.includes(id));
    setTagFilter(
      allOn ? tagIds.filter((id) => !ids.includes(id)) : [...new Set([...tagIds, ...ids])],
    );
  };

  /** 右クリックメニューの実行(v1.20)。削除は `⋯` の編集パネルと同じ関数を通す */
  const runMenuAction = async (
    id: string,
    target: { kind: 'tag'; tag: Tag } | { kind: 'group'; group: TagGroup | null; index: number },
  ) => {
    try {
      if (target.kind === 'tag') {
        const tag = target.tag;
        if (id.startsWith('tag:color:')) {
          const v = id.slice('tag:color:'.length);
          await api.setTagColor(tag.id, v === 'none' ? null : v);
          bumpVersion();
          return;
        }
        if (id.startsWith('tag:group:')) {
          const v = id.slice('tag:group:'.length);
          await api.setTagGroup(tag.id, v === 'none' ? null : Number(v));
          bumpVersion();
          return;
        }
        switch (id) {
          case 'tag:filter': toggleTagFilter(tag.id); break;
          case 'tag:filterOnly': setTagFilter([tag.id]); break;
          case 'tag:rename': {
            const name = window.prompt('新しいタグ名', tag.name);
            if (name === null || name.trim() === '' || name.trim() === tag.name) return;
            await api.renameTag(tag.id, name.trim());
            bumpVersion();
            break;
          }
          case 'tag:delete': await confirmDeleteTag(tag); break;
          default:
        }
        return;
      }

      const { group, index } = target;
      const key = group?.id ?? UNGROUPED;
      switch (id) {
        case 'group:filter':
          toggleGroupFilter((byGroup.get(key) ?? []).map((t) => t.id));
          break;
        case 'group:toggle': toggleCollapse(key); break;
        case 'group:newTag': startCreate({ kind: 'tag', groupId: group?.id ?? null }); break;
        case 'group:newGroup': startCreate({ kind: 'group' }); break;
        case 'group:rename': {
          if (!group) return;
          const name = window.prompt('新しいグループ名', group.name);
          if (name === null || name.trim() === '' || name.trim() === group.name) return;
          await api.renameTagGroup(group.id, name.trim());
          bumpVersion();
          break;
        }
        case 'group:moveUp': await moveGroup(index, -1); break;
        case 'group:moveDown': await moveGroup(index, 1); break;
        case 'group:delete': if (group) await confirmDeleteGroup(group); break;
        default:
      }
    } catch {
      // トーストは call() の担当
    }
  };

  const createForm = (placeholder: string) => (
    <div className="tag-create" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={newName}
        placeholder={placeholder}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitCreate();
          if (e.key === 'Escape') setCreating(null);
        }}
      />
      <button disabled={!newName.trim()} onClick={submitCreate}>作成</button>
      <button onClick={() => setCreating(null)}>取消</button>
    </div>
  );

  const renderTag = (t: Tag) => (
    <div key={t.id}>
      <div
        className={`side-item folder tag-row ${tagIds.includes(t.id) ? 'active' : ''} ${
          dragging?.kind === 'tag' && dragging.id === t.id ? 'dragging' : ''
        }`}
        data-drop-group={t.groupId ?? UNGROUPED}
        onPointerDown={(e) => onDragPointerDown(e, 'tag', t.id)}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        // ウィンドウがフォーカスを失うなどしたらゴーストを消す
        onPointerCancel={() => {
          dragStart.current = null;
          setDragging(null);
        }}
        onClick={() => {
          // ドラッグで終わったときは絞り込みを切り替えない
          if (suppressClick.current) return;
          toggleTagFilter(t.id);
        }}
        onContextMenu={(e) => {
          if (cancelDragForMenu()) return;
          openMenu(e, buildTagMenu(t, groups, tagIds), { kind: 'tag', tag: t });
        }}
        title={`${t.name}(クリックで絞り込み。グループの見出しへドラッグすると移動できます)`}
      >
        {/* タグ色の丸。監視フォルダの接続状態(.dot)と同じ CSS の円にしている */}
        <span className="tag-dot" style={t.color ? { background: t.color } : undefined} />
        <span className="folder-name">{t.name}</span>
        <span className="count">{t.videoCount}</span>
        <button
          className="remove"
          title="タグを編集(名前・色・グループ・削除)"
          // ここを掴んでもドラッグを始めない(ボタンとして押せなくなるため)
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setEditingTag(editingTag === t.id ? null : t.id);
          }}
        >
          ⋯
        </button>
      </div>
      {editingTag === t.id && (
        <TagEditor tag={t} groups={groups} onDone={() => setEditingTag(null)} />
      )}
    </div>
  );

  /** グループ / 未分類の見出し行。未分類は id を持たないので group = null で呼ぶ */
  const renderHeader = (group: TagGroup | null, index: number) => {
    const key = group?.id ?? UNGROUPED;
    const groupTags = byGroup.get(key) ?? [];
    const ids = groupTags.map((t) => t.id);
    // 配下タグが全部選ばれていれば「グループごと選択中」とみなす
    // 絞り込みで空になったグループは見出しごと消す。
    // ただしドラッグ中は「移動先」として要るので残す
    if (filtering && groupTags.length === 0 && !dragging) return null;
    const allOn = ids.length > 0 && ids.every((id) => tagIds.includes(id));
    // 絞った結果が畳まれていては意味がないので、絞り込み中は必ず開く
    const isCollapsed = !filtering && collapsed.has(key);
    // ドラッグ中のタグを受け入れられるか(元と同じグループには落とせない)
    const tagDrag = dragging?.kind === 'tag' ? dragging : null;
    const draggingTag = tagDrag ? tags.find((t) => t.id === tagDrag.id) : undefined;
    const isDropTarget =
      tagDrag != null &&
      tagDrag.overGroup === key &&
      draggingTag != null &&
      (draggingTag.groupId ?? UNGROUPED) !== key;

    // グループの並べ替え中の挿入位置。動かない位置(自分のすぐ前後)には線を出さない
    const groupDrag = dragging?.kind === 'group' ? dragging : null;
    const from = groupDrag ? groups.findIndex((g) => g.id === groupDrag.id) : -1;
    const insertAt =
      groupDrag && groupDrag.insertAt !== from && groupDrag.insertAt !== from + 1
        ? groupDrag.insertAt
        : null;
    const cls = [
      'tag-group-block',
      isDropTarget ? 'drop-target' : '',
      group != null && insertAt === index ? 'insert-before' : '',
      group != null && index === groups.length - 1 && insertAt === groups.length ? 'insert-after' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={`g${key}`}
        className={cls}
        // 未分類は並べ替えの対象外(常に最後)なので index を持たせない。
        // 見出しではなく**ブロック全体**に付けるのは、展開したまま並べ替えるときに
        // 配下タグの上を通っても挿入位置の線が消えないようにするため
        {...(group ? { 'data-group-index': index } : {})}
      >
        <div
          className={`side-item folder tag-group ${allOn ? 'active' : ''} ${
            groupDrag?.id === group?.id && group != null ? 'dragging' : ''
          }`}
          data-drop-group={key}
          onPointerDown={group ? (e) => onDragPointerDown(e, 'group', group.id) : undefined}
          onPointerMove={group ? onDragPointerMove : undefined}
          onPointerUp={group ? onDragPointerUp : undefined}
          onPointerCancel={() => {
            dragStart.current = null;
            setDragging(null);
          }}
          onClick={() => {
            // 並べ替えのドラッグで終わったときは絞り込みを切り替えない
            if (suppressClick.current) return;
            toggleGroupFilter(ids);
          }}
          onContextMenu={(e) => {
            if (cancelDragForMenu()) return;
            openMenu(
              e,
              buildTagGroupMenu(group, index, groups.length, ids.length, allOn, isCollapsed),
              { kind: 'group', group, index },
            );
          }}
          title={[
            group?.name ?? '未分類',
            ids.length === 0
              ? '(タグがまだありません'
              : '(クリックでこの中のタグが付いた動画をまとめて表示',
            group ? '。上下にドラッグで並べ替え)' : ')',
          ].join('')}
        >
          <button
            className={`tree-toggle ${isCollapsed ? '' : 'open'}`}
            title={isCollapsed ? 'タグを表示' : 'タグを隠す'}
            // ここを掴んでも並べ替えを始めない(ボタンとして押せなくなるため)
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(key);
            }}
          >
            {/* 開閉でアイコンを変えず CSS で回す(形が変わると大きさが違って見える) */}
            <ChevronDown />
          </button>
          <span className="folder-name">{group?.name ?? '未分類'}</span>
          <span className="count">{groupTags.length}</span>
          <button
            className="remove"
            title={group ? `「${group.name}」にタグを追加` : 'グループに属さないタグを追加'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              startCreate({ kind: 'tag', groupId: group?.id ?? null });
            }}
          >
            <Plus size={13} />
          </button>
          {group && (
            <button
              className="remove"
              title="グループを編集(名前・並び順・削除)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setEditingGroup(editingGroup === group.id ? null : group.id);
              }}
            >
              ⋯
            </button>
          )}
        </div>
        {group && editingGroup === group.id && (
          <GroupEditor
            group={group}
            index={index}
            total={groups.length}
            onMove={(dir) => moveGroup(index, dir)}
            onDone={() => setEditingGroup(null)}
          />
        )}
        {creating?.kind === 'tag' && creating.groupId === (group?.id ?? null) &&
          createForm('タグ名を入力して Enter')}
        {!isCollapsed && groupTags.map(renderTag)}
      </div>
    );
  };

  return (
    <>
      {/* 絞り込み中は作成ボタンを出さない — 探している最中に出ていても邪魔なだけ */}
      {!filtering && (
        <>
          <div className="tag-tree-head">
            <button onClick={() => startCreate({ kind: 'group' })} title="タグをまとめる軸を作る">
              <Plus size={12} /> グループ
            </button>
            <button
              onClick={() => startCreate({ kind: 'tag', groupId: null })}
              title="グループに属さないタグを作る"
            >
              <Plus size={12} /> タグ
            </button>
          </div>
          {creating?.kind === 'group' && createForm('グループ名を入力して Enter')}
        </>
      )}

      {groups.map((g, i) => renderHeader(g, i))}
      {/* 未分類は中身があるときだけ出す。作成フォームを開いている間と、
          ドラッグ中(グループから外す先が要る)も出しておく */}
      {(ungrouped.length > 0 ||
        dragging != null ||
        (creating?.kind === 'tag' && creating.groupId === null)) &&
        renderHeader(null, -1)}

      {/* ドラッグ中のゴースト。カーソルに追従させて「何を掴んでいるか」を見せる */}
      {dragging && (
        <div className="tag-drag-ghost" style={{ left: dragging.x + 12, top: dragging.y + 8 }}>
          {dragging.kind === 'tag'
            ? tags.find((t) => t.id === dragging.id)?.name
            : groups.find((g) => g.id === dragging.id)?.name}
        </div>
      )}

      {!filtering && tags.length === 0 && groups.length === 0 && (
        <div className="tag-tree-empty">
          まずグループ(「ジャンル」など)とタグを作ると、動画を選んで詳細ペインから付けられます
        </div>
      )}

      {menu && (
        <ContextMenu
          key={`${menu.x},${menu.y}`}
          x={menu.x}
          y={menu.y}
          entries={menu.entries}
          onClose={closeMenu}
          onSelect={(id) => void runMenuAction(id, menu.target)}
        />
      )}
    </>
  );
}
