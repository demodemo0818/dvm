import { useEffect } from 'react';
import { useLibrary } from '../store';
import type { Toast } from '../types';

const AUTO_DISMISS_MS = 8000;

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useLibrary((s) => s.dismissToast);
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismissToast]);

  return (
    <div className={`toast ${toast.kind}`}>
      <span className="toast-msg">{toast.message}</span>
      <button className="toast-close" title="閉じる" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  );
}

/**
 * 画面右下の通知。api.ts のラッパから呼ばれ、コマンド失敗を必ず可視化する。
 * mpv 再生中は .app ごと非表示になるため、App では .app の外に置くこと
 */
export function Toasts() {
  const toasts = useLibrary((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
