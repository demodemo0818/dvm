import { ask, open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, FolderPlus, FolderX, HardDriveDownload, Library, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LibraryEntry, LibraryState, LibraryStatus } from '../types';

/**
 * ライブラリを開けなかったときの画面(v1.27)。
 *
 * このとき DVM は**空の placeholder DB** で起動している。動画は 1 件も無く、
 * ここで監視フォルダを足したりタグを付けたりできてしまうと、
 * ユーザーは「ライブラリが消えた」と誤解して作り直しにかかる。
 * だから通常の UI ごと覆い隠して、復旧の道だけを出す。
 *
 * **「開けないから代わりに別のライブラリを開く」は絶対にしない。**
 * 普通に起動したように見えてしまい、違うライブラリにタグを付ける事故になる
 */
const HEADING: Record<LibraryStatus, { title: string; icon: typeof Library }> = {
  ok: { title: '', icon: Library },
  offline: { title: 'ドライブに接続できません', icon: Unplug },
  missing: { title: 'ライブラリが見つかりません', icon: FolderX },
  broken: { title: 'ライブラリを読めません', icon: FolderX },
  none: { title: 'ライブラリを選んでください', icon: Library },
};

export function LibraryUnavailable({ state }: { state: LibraryState }) {
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const head = HEADING[state.status];
  const current = state.current;

  const reload = () => api.listLibraries().then(setLibraries);
  useEffect(() => {
    void reload();
  }, []);

  /** 切り替え(= 再起動)。**成功するとこの Promise は解決しない** */
  const switchTo = async (lib: LibraryEntry) => {
    setBusy(true);
    try {
      await api.switchLibrary(lib.id);
    } catch {
      setBusy(false); // 戻ってくるのは開けなかったときだけ(トーストは call() が出す)
    }
  };

  const createLibrary = async () => {
    const name = window.prompt('新しいライブラリの名前');
    if (name === null || name.trim() === '') return;
    const parent = await open({
      directory: true,
      defaultPath: await api.defaultLibraryDir(),
      title: 'ライブラリを置くフォルダを選ぶ',
    });
    if (typeof parent !== 'string') return;
    await switchTo(await api.createLibrary(name.trim(), parent));
  };

  const addExisting = async () => {
    const root = await open({ directory: true, title: 'ライブラリのフォルダを選ぶ' });
    if (typeof root !== 'string') return;
    await switchTo(await api.addExistingLibrary(root));
  };

  /** 一覧から外す。ここでだけ「開こうとしていたもの」も外せる(外せないと詰む) */
  const forget = async (lib: LibraryEntry) => {
    const yes = await ask(
      `「${lib.name}」を一覧から外しますか?\n\n`
        + 'フォルダとファイルは削除されません。\n'
        + `${lib.root} はそのまま残るので、あとで「既存のライブラリを開く」から戻せます。`,
      { title: '一覧から外す' },
    );
    if (!yes) return;
    await api.forgetLibrary(lib.id);
    await reload();
  };

  return (
    <div className="library-unavailable">
      <div className="lu-card">
        <head.icon className="lu-icon" />
        <h1>{head.title}</h1>
        {state.message && <p className="lu-message">{state.message}</p>}
        {current && (
          <p className="lu-path" title={current.root}>
            {current.name} — {current.root}
          </p>
        )}

        {current && (
          <div className="lu-actions">
            <button disabled={busy} onClick={() => void switchTo(current)}>
              <RefreshCw />
              もう一度開く
            </button>
            <button disabled={busy} onClick={() => void forget(current)}>
              <FolderX />
              一覧から外す
            </button>
          </div>
        )}

        {libraries.filter((l) => l.id !== current?.id).length > 0 && (
          <>
            <div className="lu-sep">他のライブラリを開く</div>
            <ul className="lu-list">
              {libraries
                .filter((l) => l.id !== current?.id)
                .map((lib) => (
                  <li key={lib.id}>
                    <button
                      className="lu-lib"
                      disabled={busy || !lib.online}
                      title={lib.online ? lib.root : `${lib.root} に接続できません`}
                      onClick={() => void switchTo(lib)}
                    >
                      {lib.online ? <Library /> : <Unplug />}
                      <span className="lu-lib-name">{lib.name}</span>
                      <span className="lu-lib-root">{lib.root}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}

        <div className="lu-actions">
          <button disabled={busy} onClick={() => void createLibrary()}>
            <FolderPlus />
            ライブラリを新規作成...
          </button>
          <button disabled={busy} onClick={() => void addExisting()}>
            <FolderOpen />
            既存のライブラリを開く...
          </button>
        </div>

        {state.status === 'broken' && current && (
          <p className="lu-note">
            <HardDriveDownload />
            バックアップから戻すときは、{current.root}\backups の中から選んで
            library.db を置き換えてください。
          </p>
        )}
      </div>
    </div>
  );
}
