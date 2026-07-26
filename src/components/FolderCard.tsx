import { Folder, FolderUp } from 'lucide-react';
import type { FolderNode } from '../types';

/**
 * メインビューの先頭に並べるフォルダ 1 件。
 * 「上のフォルダ」(up)と実在のサブフォルダを同じ形で扱う
 */
export interface FolderEntry {
  /** 開いたときに設定する dirPath */
  path: string;
  name: string;
  up: boolean;
  /** 上のフォルダには件数を出さない */
  node: FolderNode | null;
}

export function toEntry(node: FolderNode): FolderEntry {
  return { path: node.path, name: node.name, up: false, node };
}

export function upEntry(parent: string): FolderEntry {
  return { path: parent, name: '上のフォルダ', up: true, node: null };
}

function tooltip(entry: FolderEntry): string {
  if (entry.up) return `${entry.path}\nダブルクリックで上のフォルダへ`;
  const n = entry.node!;
  return `${n.path}\nダブルクリックで開く(直下 ${n.directCount} 件${
    n.totalCount !== n.directCount ? ` / 配下すべて ${n.totalCount} 件` : ''
  })`;
}

/** 件数の表示。直下が 0 でも配下にあるなら「配下 N 件」を出す */
function subLabel(entry: FolderEntry): string {
  if (entry.up) return '';
  const n = entry.node!;
  if (n.directCount === 0) return `配下 ${n.totalCount} 件`;
  return n.totalCount !== n.directCount
    ? `${n.directCount} 件(配下 ${n.totalCount} 件)`
    : `${n.directCount} 件`;
}

/** グリッド表示のフォルダカード。動画カードと同じ高さに収まる */
export function FolderCard({
  entry, onOpen,
}: { entry: FolderEntry; onOpen: (path: string) => void }) {
  return (
    <div
      className={`card folder-card ${entry.up ? 'up' : ''}`}
      title={tooltip(entry)}
      onDoubleClick={() => onOpen(entry.path)}
    >
      <div className="folder-thumb">
        {/* カードのサムネイル枠に合わせて大きく出すので、ここだけ size を明示する */}
        <span className="folder-glyph">
          {entry.up ? <FolderUp size={34} /> : <Folder size={34} />}
        </span>
      </div>
      <div className="card-name">{entry.name}</div>
      <div className="card-sub">{subLabel(entry)}</div>
    </div>
  );
}

/** 詳細リスト表示のフォルダ行 */
export function FolderListRow({
  entry, onOpen, height,
}: { entry: FolderEntry; onOpen: (path: string) => void; height: number }) {
  return (
    <div
      className={`list-row folder-row ${entry.up ? 'up' : ''}`}
      style={{ height }}
      title={tooltip(entry)}
      onDoubleClick={() => onOpen(entry.path)}
    >
      <div className="list-thumb folder-thumb">
        <span className="folder-glyph">
          {entry.up ? <FolderUp size={18} /> : <Folder size={18} />}
        </span>
      </div>
      <div className="list-name">{entry.name}</div>
      <div className="list-col folder-count">{subLabel(entry)}</div>
    </div>
  );
}
