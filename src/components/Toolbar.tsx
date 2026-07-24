import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLibrary } from '../store';
import type { SortKey } from '../types';

export function Toolbar() {
  const { text, setText, sort, setSort, scanning, seriesId } = useLibrary();
  const [input, setInput] = useState(text);
  const [showSettings, setShowSettings] = useState(false);
  const [playerPath, setPlayerPath] = useState('');

  // 入力から 300ms 落ち着いたら検索を反映
  useEffect(() => {
    const t = setTimeout(() => setText(input), 300);
    return () => clearTimeout(t);
  }, [input, setText]);

  useEffect(() => {
    if (showSettings) {
      api.getSetting('player_path').then((v) => setPlayerPath(v ?? ''));
    }
  }, [showSettings]);

  const browsePlayer = async () => {
    const selected = await open({
      multiple: false,
      title: '外部プレイヤーの実行ファイルを選択',
      filters: [{ name: '実行ファイル', extensions: ['exe'] }],
    });
    if (typeof selected === 'string') setPlayerPath(selected);
  };

  const saveSettings = async () => {
    await api.setSetting('player_path', playerPath.trim());
    setShowSettings(false);
  };

  return (
    <div className="toolbar">
      <input
        className="search"
        type="search"
        placeholder="ファイル名・タイトルで検索"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        <option value="added_desc">追加日時(新しい順)</option>
        <option value="added_asc">追加日時(古い順)</option>
        <option value="name_asc">名前(昇順)</option>
        <option value="name_desc">名前(降順)</option>
        <option value="size_desc">サイズ(大きい順)</option>
        <option value="duration_desc">長さ(長い順)</option>
        <option value="rating_desc">レーティング順</option>
        <option value="viewed_desc">最近見た順</option>
        {seriesId !== null && <option value="series_asc">シリーズ順</option>}
      </select>
      <button onClick={() => api.rescanAll()} disabled={scanning}>
        再スキャン
      </button>
      <button title="設定" onClick={() => setShowSettings(true)}>⚙</button>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">設定</div>
            <label className="modal-label">
              外部プレイヤー(空欄なら Windows の既定のプレイヤーで開く)
            </label>
            <div className="modal-row">
              <input
                value={playerPath}
                placeholder="例: C:\\Program Files\\mpv\\mpv.exe"
                onChange={(e) => setPlayerPath(e.target.value)}
              />
              <button onClick={browsePlayer}>参照...</button>
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowSettings(false)}>キャンセル</button>
              <button className="primary" onClick={saveSettings}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
