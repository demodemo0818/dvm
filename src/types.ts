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

/**
 * フォルダーツリーの 1 ノード(サイドバーの「フォルダー」タブ)。
 * Rust 側が videos.path から組み立てたものをそのまま受け取る
 */
export interface FolderNode {
  /** 正規化した絶対パス。ツリーの識別子 */
  path: string;
  /** 親ノードの path。ルート(監視フォルダ / 監視フォルダ外の置き場)は null */
  parent: string | null;
  /** 表示名。ルートはフルパス、それ以外は末尾セグメント */
  name: string;
  /** このフォルダ直下の動画数(= クリックしたときに出る件数) */
  directCount: number;
  /** 配下すべての動画数(自分を含む) */
  totalCount: number;
  /** 監視フォルダのルートなら その id */
  watchedFolderId: number | null;
  online: boolean;
}

/** メインビューの先頭に出すサブフォルダ(フォルダカード) */
export interface SubfolderView {
  /** 「上のフォルダ」。監視フォルダの外に出るときは null */
  parent: string | null;
  children: FolderNode[];
}

/** サイドバー下半分の表示切り替え */
export type SidebarTab = 'library' | 'folders';

export type SortKey =
  | 'added_desc'
  | 'added_asc'
  | 'name_asc'
  | 'name_desc'
  | 'size_desc'
  | 'duration_desc'
  | 'rating_desc'
  | 'viewed_desc'
  | 'series_asc'
  /** 重複表示用。同じファイルが隣り合う */
  | 'dup'
  /** randomSeed から決定的にシャッフル(ページングしても崩れない) */
  | 'random';

export interface VideoQuery {
  /** 空白区切りで AND 検索(全角スペースも区切り) */
  text?: string;
  sort?: SortKey;
  /** 監視フォルダ由来の動画すべて(配下のサブフォルダも含む) */
  folderId?: number | null;
  /** このフォルダ**直下**の動画だけ(サブフォルダは含まない)。folderId とは別物 */
  dirPath?: string | null;
  tagIds?: number[];
  seriesId?: number | null;
  missing?: boolean;
  /** このレーティング以上に絞る(1〜5) */
  minRating?: number;
  /** 尺の範囲(ミリ秒)。指定時、尺が未取得の動画は含まれない */
  minDurationMs?: number;
  maxDurationMs?: number;
  /** text の検索対象にフルパスも含める */
  searchPath?: boolean;
  /** タグが 1 つも付いていない動画だけ */
  untagged?: boolean;
  /** 一度も再生していない動画だけ */
  unwatched?: boolean;
  /** 解像度の下限(ピクセル)。未取得の動画は含まれない */
  minWidth?: number;
  minHeight?: number;
  /** 映像コーデックで絞る(複数指定は OR) */
  videoCodecs?: string[];
  /** ライブラリ追加日の範囲(YYYY-MM-DD。両端を含む) */
  addedAfter?: string;
  addedBefore?: string;
  /** 内容が同一(size + partial_hash が一致)の動画だけ */
  duplicatesOnly?: boolean;
  /** tagIds に子孫タグも含めるか(未指定 = 含める) */
  includeChildTags?: boolean;
  /** sort = 'random' のときのシャッフル種 */
  randomSeed?: number;
}

/** 詳細検索のうち、ツールバー本体に出していない条件だけをまとめたもの */
export interface AdvancedFilter {
  searchPath: boolean;
  untagged: boolean;
  unwatched: boolean;
  minHeight: number;
  videoCodecs: string[];
  addedAfter: string;
  addedBefore: string;
}

export const EMPTY_ADVANCED: AdvancedFilter = {
  searchPath: false,
  untagged: false,
  unwatched: false,
  minHeight: 0,
  videoCodecs: [],
  addedAfter: '',
  addedBefore: '',
};

/** 尺フィルタのプリセット */
export type DurationBucket = 'lt5' | '5to20' | '20to60' | 'gt60';

/** グリッド(サムネイル)か詳細リストか */
export type ViewMode = 'grid' | 'list';

/**
 * 連続再生の位置。プレイヤーは「クエリ + 一覧内の位置」だけを持ち、
 * 次の 1 件は Rust から都度引く(グリッドのページキャッシュに依存させない)
 */
export interface PlayQueue {
  query: VideoQuery;
  index: number;
  total: number;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  /** 親タグ(null = トップレベル)。サイドバーのツリー表示に使う */
  parentId: number | null;
  videoCount: number;
}

/** 保存した検索条件。queryJson は VideoQuery をそのまま JSON にしたもの */
export interface SmartFolder {
  id: number;
  name: string;
  queryJson: string;
  position: number;
}

/** 統計の 1 項目(棒グラフ 1 本ぶん) */
export interface StatBucket {
  key: string;
  label: string;
  count: number;
}

export interface LibraryStats {
  videoCount: number;
  totalSizeBytes: number;
  totalDurationMs: number;
  tagCount: number;
  seriesCount: number;
  missingCount: number;
  unwatchedCount: number;
  untaggedCount: number;
  duplicateCount: number;
  /** index = 星の数(0〜5) */
  ratingCounts: number[];
  byCodec: StatBucket[];
  byResolution: StatBucket[];
  byFolder: StatBucket[];
  byMonth: StatBucket[];
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

/** ファイル操作の dry-run で 1 件ごとに付く状態 */
export type PlanStatus = 'ok' | 'conflict' | 'sourceMissing' | 'offline' | 'unchanged';

/** dry-run の 1 行。この表を見せて承認をもらってから apply する */
export interface PlanItem {
  videoId: number;
  from: string;
  to: string;
  status: PlanStatus;
  note: string | null;
}

export interface OpResult {
  videoId: number;
  from: string;
  to: string;
  ok: boolean;
  error: string | null;
}

/** fileop:progress イベントのペイロード */
export interface FileOpProgress {
  done: number;
  total: number;
  current: string;
}

/** 操作履歴の 1 行 */
export interface OpEntry {
  id: number;
  timestamp: string;
  /** "user" / "ai" / "system" */
  actor: string;
  action: string;
  payload: string | null;
  undoable: boolean;
  /** 取り消せない理由 */
  reason: string | null;
  undoneAt: string | null;
}
