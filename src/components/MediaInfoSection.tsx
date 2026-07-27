import { ChevronDown, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { buildMediaSections, mediaSectionsToText } from '../lib/mediaInfo';
import { useLibrary } from '../store';
import type { MediaInfo, VideoRow } from '../types';

/**
 * ffprobe を叩くまでの待ち時間。セクションを開いたまま矢印キーで一覧を流し見すると
 * 選択が高速に変わるので、その間はプロセスを起動しない。
 * React StrictMode の二重マウントもここで 1 回に畳まれる
 */
const PROBE_DELAY_MS = 250;

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; info: MediaInfo }
  | { kind: 'error'; message: string }
  /** ドライブ未接続 / ファイル欠落。ffprobe を起動するまでもない */
  | { kind: 'unavailable'; message: string };

/**
 * 詳細ペインの「メディア情報」(v1.15)。MediaInfo 相当の内容を ffprobe から出す。
 *
 * **展開したときに初めて ffprobe を叩く**。閉じている間は元動画に一切触らない
 * (CLAUDE.md パフォーマンス原則 2)。
 * 結果はキャッシュしない — ヘッダを読むだけで速く、鮮度管理のほうが高くつくため
 * (判断の理由は DESIGN.md「メディア情報の表示」)
 */
export function MediaInfoSection({ video }: { video: VideoRow }) {
  const open = useLibrary((s) => s.mediaInfoOpen);
  const setOpen = useLibrary((s) => s.setMediaInfoOpen);
  const pushToast = useLibrary((s) => s.pushToast);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!open) return;
    // DB のフラグは古いことがあるので Rust 側でも同じガードをしている
    if (video.isOffline) {
      setState({ kind: 'unavailable', message: 'ドライブが接続されていません' });
      return;
    }
    if (video.isMissing) {
      setState({ kind: 'unavailable', message: 'ファイルが見つかりません' });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    const timer = window.setTimeout(() => {
      api.getMediaInfo(video.id)
        .then((info) => {
          if (alive) setState({ kind: 'ok', info });
        })
        .catch((e) => {
          if (alive) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        });
    }, PROBE_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, video.id, video.isOffline, video.isMissing]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    void api.setSetting('media_info_open', next ? '1' : '0');
  };

  const sections = state.kind === 'ok' ? buildMediaSections(state.info) : [];

  const copy = async () => {
    const header = `${video.title ?? video.filename}\n${video.path}`;
    try {
      await navigator.clipboard.writeText(mediaSectionsToText(header, sections));
      pushToast('メディア情報をコピーしました', 'info');
    } catch {
      pushToast('クリップボードにコピーできませんでした');
    }
  };

  return (
    <>
      <div className="section-head">
        <button
          className={`section-toggle ${open ? 'open' : ''}`}
          onClick={toggle}
          title={open ? 'メディア情報を隠す' : 'ffprobe で調べて表示する'}
        >
          {/* 開閉でアイコンを変えず CSS で回す(形が変わると大きさが違って見える) */}
          <ChevronDown className="section-chevron" />
          メディア情報
        </button>
        {open && sections.length > 0 && (
          <button className="section-copy" onClick={copy} title="表示中の内容をテキストでコピー">
            <Copy />
          </button>
        )}
      </div>

      {open && (
        <div className="media-info">
          {state.kind === 'loading' && <div className="media-note">読み込み中...</div>}
          {state.kind === 'unavailable' && <div className="media-note">{state.message}</div>}
          {state.kind === 'error' && (
            <div className="media-note warn">メディア情報を取得できませんでした: {state.message}</div>
          )}
          {state.kind === 'ok' && sections.length === 0 && (
            <div className="media-note">読み取れる情報がありませんでした</div>
          )}
          {sections.map((s) => (
            <div key={s.title} className="media-block">
              <div className="media-block-title">{s.title}</div>
              {s.rows.map((r) => (
                <div key={r.label} className="media-row">
                  <span className="media-key">{r.label}</span>
                  <span className="media-val">{r.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
