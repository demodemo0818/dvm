import { open } from '@tauri-apps/plugin-dialog';
import { saveStoreFlag, useTextSetting } from '../../hooks/useSetting';
import { useLibrary } from '../../store';

/**
 * 再生まわり(v1.38 でカードの表示設定を「表示」へ移した)。
 *
 * シークバーのコマ出しはカードのホバープレビューとは**別設定**にしてある ——
 * こちらは再生中に同じ動画をもう 1 本デコードするので、外付け HDD の大きいファイルで
 * 本編がカクつくなら単独で切りたい(DESIGN.md 参照)。
 */
export function PlaybackSection() {
  const storePlayerPath = useLibrary((s) => s.playerPath);
  const setStorePlayerPath = useLibrary((s) => s.setPlayerPath);
  const seekPreview = useLibrary((s) => s.seekPreview);
  const setSeekPreview = useLibrary((s) => s.setSeekPreview);
  const autoplayNext = useLibrary((s) => s.autoplayNext);
  const setAutoplayNext = useLibrary((s) => s.setAutoplayNext);
  const hdrPassthrough = useLibrary((s) => s.hdrPassthrough);
  const setHdrPassthrough = useLibrary((s) => s.setHdrPassthrough);

  /**
   * 外部プレイヤーのパス。テキストなので打っている途中では書かず、フォーカスが
   * 外れたとき(と閉じたとき)に DB と store の両方へ入れる。
   * store は起動時に App.tsx が読んでいるので、初期値はそこからもらって読み直さない
   */
  const playerPath = useTextSetting('player_path', {
    initial: storePlayerPath,
    onCommit: setStorePlayerPath,
  });

  const browsePlayer = async () => {
    const selected = await open({
      multiple: false,
      title: '外部プレイヤーの実行ファイルを選択',
      filters: [{ name: '実行ファイル', extensions: ['exe'] }],
    });
    // ダイアログで選んだ値は確定済みなので、blur を待たずに書く
    if (typeof selected === 'string') playerPath.save(selected);
  };

  return (
    <div className="settings-section">
      <div className="settings-heading">再生</div>
      <label className="modal-label">
        外部プレイヤー(空欄なら Windows の既定のプレイヤーで開く)
      </label>
      <div className="modal-row">
        <input
          value={playerPath.value}
          placeholder="例: C:\\Program Files\\mpv\\mpv.exe"
          onChange={(e) => playerPath.edit(e.target.value)}
          onBlur={playerPath.commit}
        />
        <button onClick={browsePlayer}>参照...</button>
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={seekPreview}
          onChange={(e) => saveStoreFlag('seek_preview', setSeekPreview, e.target.checked)}
        />
        再生中、シークバーにカーソルを合わせるとその位置のコマを表示する(重い動画で本編がカクつく場合はオフ)
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={autoplayNext}
          onChange={(e) => saveStoreFlag('autoplay_next', setAutoplayNext, e.target.checked)}
        />
        最後まで再生したら次の動画へ進む(一覧の並び順。⏭ / N キーでも進めます)
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={hdrPassthrough}
          /* store に入れた瞬間 useMpvPlayer が setProperty で押し込む(再生中でも切り替わる) */
          onChange={(e) => saveStoreFlag('hdr_passthrough', setHdrPassthrough, e.target.checked)}
        />
        HDR パススルーを有効にする
      </label>
      <div className="settings-note">
        HDR パススルーは、HDR 対応モニタで Windows の HDR をオンにしているときだけ効きます。
        オフのときは従来どおり SDR に変換して表示します(アプリ内再生のみ)。
        切り替えても変わらない場合はアプリを再起動してください
      </div>
    </div>
  );
}
