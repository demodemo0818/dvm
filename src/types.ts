export interface VideoRow {
  id: number;
  path: string;
  filename: string;
  title: string | null;
  size: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  rating: number;
  viewCount: number;
  lastViewedAt: string | null;
  /** アプリ内再生のレジューム位置(0 = 位置なし) */
  resumeMs: number;
  /** 再生方式判定用(ffprobe 由来。未取得時 null) */
  videoCodec: string | null;
  audioCodec: string | null;
  isMissing: boolean;
  isOffline: boolean;
  thumbState: number;
  thumbPath: string | null;
  addedAt: string;
}

export interface WatchedFolder {
  id: number;
  path: string;
  recursive: boolean;
  enabled: boolean;
  online: boolean;
  videoCount: number;
}

export type SortKey =
  | 'added_desc'
  | 'added_asc'
  | 'name_asc'
  | 'name_desc'
  | 'size_desc'
  | 'duration_desc'
  | 'rating_desc'
  | 'viewed_desc'
  | 'series_asc';

export interface VideoQuery {
  text?: string;
  sort?: SortKey;
  folderId?: number | null;
  tagIds?: number[];
  seriesId?: number | null;
  missing?: boolean;
  /** このレーティング以上に絞る(1〜5) */
  minRating?: number;
  /** 尺の範囲(ミリ秒)。指定時、尺が未取得の動画は含まれない */
  minDurationMs?: number;
  maxDurationMs?: number;
}

/** 尺フィルタのプリセット */
export type DurationBucket = 'lt5' | '5to20' | '20to60' | 'gt60';

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  videoCount: number;
}

export interface Series {
  id: number;
  name: string;
  videoCount: number;
}

/** transcode:progress イベントのペイロード */
export interface TranscodeProgress {
  videoId: number;
  /** 0〜100。尺が不明なときは null(スピナー表示) */
  percent: number | null;
  message: string;
}

/** 画面右下に出す通知(主に API 失敗の報告) */
export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

export interface AppInfo {
  dataDir: string;
  dbPath: string;
  dbSize: number;
  thumbsDir: string;
  thumbCount: number;
  thumbCacheSize: number;
  backupsDir: string;
}

export interface BackupInfo {
  fileName: string;
  path: string;
  size: number;
  createdAt: string;
}
