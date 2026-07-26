import { ChevronDown, Folder } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from '../store';
import type { FolderNode } from '../types';

/** Windows のパスは大文字小文字を区別しない。ASCII だけ畳む(Rust / SQL 側の lower に合わせる) */
const sameDir = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/** parent からツリーを組む。親が見つからないノードはトップレベル扱いにする */
function buildTree(nodes: FolderNode[]): Map<string | null, FolderNode[]> {
  const known = new Set(nodes.map((n) => n.path));
  const children = new Map<string | null, FolderNode[]>();
  for (const n of nodes) {
    const parent = n.parent !== null && known.has(n.parent) ? n.parent : null;
    const list = children.get(parent) ?? [];
    list.push(n);
    children.set(parent, list);
  }
  return children;
}

/**
 * サイドバー「フォルダー」タブのフォルダーツリー。
 * クリックすると**そのフォルダ直下だけ**に絞り込む(エクスプローラーと同じ)。
 * 監視フォルダ配下をまとめて見たいときは「ライブラリ」タブの監視フォルダ一覧を使う
 */
export function FolderTree({ nodes }: { nodes: FolderNode[] }) {
  const { dirPath, toggleDirPath } = useLibrary();
  // 既定はすべて畳んだ状態(ルートだけ見える)。深いライブラリでサイドバーが伸びきらないように
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(nodes), [nodes]);

  /**
   * 一覧側のフォルダをダブルクリックして潜ったときに、ツリーの表示が置いていかれないよう
   * 選択中フォルダの祖先を開いておく(エクスプローラーと同じ挙動)
   */
  useEffect(() => {
    if (dirPath === null) return;
    const byKey = new Map(nodes.map((n) => [n.path.toLowerCase(), n]));
    const ancestors: string[] = [];
    let cur = byKey.get(dirPath.toLowerCase());
    while (cur?.parent) {
      ancestors.push(cur.parent);
      cur = byKey.get(cur.parent.toLowerCase());
    }
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });
  }, [dirPath, nodes]);

  const toggleExpand = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNodes = (list: FolderNode[], depth: number) =>
    list.map((n) => {
      const children = tree.get(n.path) ?? [];
      const isOpen = expanded.has(n.path);
      return (
        <div key={n.path}>
          <div
            className={`side-item folder ${sameDir(dirPath, n.path) ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggleDirPath(n.path)}
            title={`${n.path}\nクリックでこのフォルダ直下の ${n.directCount} 件に絞り込み(もう一度で解除)${
              n.totalCount !== n.directCount ? `\n配下すべてでは ${n.totalCount} 件` : ''
            }`}
          >
            {children.length > 0 ? (
              <button
                className={`tree-toggle ${isOpen ? 'open' : ''}`}
                title={isOpen ? 'サブフォルダを隠す' : 'サブフォルダを表示'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(n.path);
                }}
              >
                {/* 開閉でアイコンを変えず CSS で回す(形が変わると大きさが違って見える) */}
                <ChevronDown />
              </button>
            ) : (
              <span className="tree-toggle spacer" />
            )}
            {n.watchedFolderId !== null ? (
              <span className={`dot ${n.online ? 'online' : 'offline'}`} />
            ) : (
              <Folder className="tag-mark" />
            )}
            <span className="folder-name">{n.name}</span>
            {/* 直下に動画が無い中継ぎのフォルダは「0」を出さない(数字だらけになるため) */}
            {n.directCount > 0 && <span className="count">{n.directCount}</span>}
          </div>
          {isOpen && renderNodes(children, depth + 1)}
        </div>
      );
    });

  const roots = tree.get(null) ?? [];
  const watched = roots.filter((n) => n.watchedFolderId !== null);
  const others = roots.filter((n) => n.watchedFolderId === null);

  if (nodes.length === 0) {
    return (
      <div className="side-empty">
        監視フォルダを登録するか動画を追加すると、ここにフォルダの階層が出ます
      </div>
    );
  }

  return (
    <>
      {renderNodes(watched, 0)}
      {others.length > 0 && (
        <div className="side-section" title="監視フォルダの外にある動画(個別登録など)">
          その他の場所
        </div>
      )}
      {renderNodes(others, 0)}
    </>
  );
}
