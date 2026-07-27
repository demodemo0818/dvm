/**
 * バイト数を人が読める形にする(カード・設定画面・詳細ペインで共用)。
 *
 * 詳細リスト(VideoListRow)と統計(StatsModal)は表示幅と桁の都合で
 * わざと別の丸め方をしているので、そちらはここに寄せていない
 */
export function fmtSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** 秒を "m:ss" / "h:mm:ss" に整形する(プレイヤー・カード・ホバープレビューで共用) */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}
