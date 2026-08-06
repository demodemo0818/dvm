import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useLibrary } from '../../store';
import type { AppInfo, ExcludedPath, LibraryEntry } from '../../types';

/**
 * ライブラリの管理(v1.27)と、監視フォルダの中で取り込まない場所(v1.33)。
 *
 * どちらも「ライブラリに何が入るか」の管理で、どちらも**ファイルは消さない**ことを
 * 文言で言い切る必要がある操作なので、同じカテゴリに置いている。
 *
 * ここが持つのは**名前の変更と一覧からの削除**だけ。切り替えの入口はサイドバーの
 * 上部に固定する(同じ操作の入口を 2 か所に置かない)。
 */
export function LibrarySection({ info }: { info: AppInfo | null }) {
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);
  const [excluded, setExcluded] = useState<ExcludedPath[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listLibraries().then(setLibraries).catch(() => {});
    api.listExcludedPaths().then(setExcluded).catch(() => {});
  }, []);

  /** 名前を変える。フォルダ名は変えない(開いている最中に動かせないため) */
  const renameLibrary = async (lib: LibraryEntry) => {
    const name = window.prompt('新しいライブラリ名', lib.name);
    if (name === null || name.trim() === '' || name.trim() === lib.name) return;
    await api.renameLibrary(lib.id, name.trim());
    setLibraries(await api.listLibraries());
    // サイドバーのボタンの表示を追従させる
    useLibrary.getState().bumpVersion();
  };

  /** 一覧から外す。**ファイルは消さない**ことを文言で必ず言い切る */
  const forgetLibrary = async (lib: LibraryEntry) => {
    const yes = await ask(
      `「${lib.name}」を一覧から外しますか?\n\n`
        + 'フォルダとファイルは削除されません。\n'
        + `${lib.root} はそのまま残るので、あとで「既存のライブラリを開く」から戻せます。`,
      { title: '一覧から外す' },
    );
    if (!yes) return;
    await api.forgetLibrary(lib.id);
    setLibraries(await api.listLibraries());
    useLibrary.getState().bumpVersion();
  };

  /**
   * 監視除外フォルダを足す。監視フォルダの中のフォルダを選ぶのが本来の使い方なので、
   * ここでは監視フォルダかどうかの検査はしない(外を選んでも害は無い)
   */
  const addExclude = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '監視除外フォルダを選ぶ',
    });
    if (typeof selected !== 'string') return;
    const alsoRemove = await ask(
      `${selected} の配下を、次のスキャンから取り込まないようにします。\n\n` +
        '今ライブラリに入っている配下の動画も外しますか?\n' +
        '「いいえ」を選ぶと一覧には残ったまま、今後増えなくなります。\n\n' +
        'どちらを選んでも動画ファイルは削除しません。',
      { title: '監視除外フォルダに登録' },
    );
    setBusy(true);
    try {
      const removed = await api.addExcludedPaths([selected], alsoRemove);
      setExcluded(await api.listExcludedPaths());
      useLibrary.getState().bumpVersion();
      if (removed > 0) {
        await message(`${removed.toLocaleString()} 件をライブラリから外しました(ファイルは残っています)`, {
          title: '監視除外フォルダに登録',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  /** 監視除外を解除する。該当ファイルは次のスキャンで取り込まれる */
  const removeExclude = async (id: number, path: string) => {
    const yes = await ask(
      `${path} を監視除外から外しますか?\n\n次のスキャンで該当する動画がライブラリに再登録されます。`,
      { title: '監視除外を解除' },
    );
    if (!yes) return;
    await api.removeExcludedPath(id);
    setExcluded(await api.listExcludedPaths());
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-heading">ライブラリ</div>
        <div className="settings-note">
          ライブラリごとに動画・タグ・シリーズ・監視フォルダが分かれます。
          見た目や API キーなどの設定は切り替えても変わりません。
          切り替えはサイドバー上部のライブラリ名から行います
        </div>
        <ul className="library-list">
          {libraries.map((lib) => {
            const isCurrent = lib.id === info?.libraryId;
            return (
              <li key={lib.id} className={isCurrent ? 'current' : ''}>
                <div className="library-list-main">
                  <span className="library-list-name">
                    {lib.name}
                    {isCurrent && <span className="library-badge">開いています</span>}
                    {!lib.online && <span className="library-badge warn">未接続</span>}
                  </span>
                  <span className="library-list-root" title={lib.root}>{lib.root}</span>
                </div>
                <div className="library-list-actions">
                  <button onClick={() => renameLibrary(lib)}>名前を変更...</button>
                  <button onClick={() => api.openLibraryDir(lib.id)} disabled={!lib.online}>
                    フォルダを開く
                  </button>
                  <button
                    onClick={() => forgetLibrary(lib)}
                    disabled={isCurrent}
                    title={
                      isCurrent
                        ? '開いているライブラリは外せません(別のライブラリに切り替えてから)'
                        : 'フォルダとファイルは削除されません'
                    }
                  >
                    一覧から外す
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="settings-section">
        <div className="settings-heading">監視除外フォルダ</div>
        <div className="settings-note">
          監視フォルダの中でも、ここに入れたフォルダの配下はスキャンで取り込みません。
          世代ごとのバックアップや作業用の書き出し先など、ライブラリに出したくない場所に使います。
          動画を削除するときに登録したファイル 1 個だけの行も、ここに並びます。
          <strong>動画ファイルは削除しません。</strong>
        </div>
        {excluded.length > 0 && (
          <ul className="excluded-list">
            {excluded.map((e) => (
              <li key={e.id}>
                <span className="excluded-path" title={e.path}>{e.path}</span>
                {/* 消し残しがあるときだけ件数を出す(0 を並べても意味が無い) */}
                {e.videoCount > 0 && (
                  <span
                    className="excluded-count"
                    title="除外したあとも一覧に残っている登録数。除外したときに外さなかったぶんです"
                  >
                    {e.videoCount.toLocaleString()} 件が一覧に残っています
                  </span>
                )}
                <button onClick={() => removeExclude(e.id, e.path)}>解除</button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-row">
          <button onClick={addExclude} disabled={busy}>フォルダを選んで追加...</button>
        </div>
        <div className="settings-note">
          サイドバーのフォルダーツリーを右クリックしても追加できます
        </div>
      </div>
    </>
  );
}
