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
  // --- v1.16 でリストの列にするために足した(Rust の core/query.rs と手動同期) ---
  /**
   * ファイルの作成時刻。**登録時に一度だけ**入り、以後更新されない。
   * Windows ではコピーやダウンロードでリセットされるので「動画が作られた日」ではない
   */
  fileCreatedAt: string | null;
  /** ファイルの最終更新時刻(再スキャンで追従する) */
  fileModifiedAt: string | null;
  fps: number | null;
  bitrate: number | null;
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

/**
 * 並び順。Rust の `order_clause()` のホワイトリストと 1 対 1(片方だけ足さないこと)。
 *
 * ツールバーの select に出すのは lib/listColumns.ts の CURATED_SORTS だけで、
 * 残りは詳細リストの列ヘッダから選ぶ
 */
export type SortKey =
  | 'added_desc' | 'added_asc'
  | 'name_asc' | 'name_desc'
  | 'size_asc' | 'size_desc'
  | 'duration_asc' | 'duration_desc'
  | 'rating_asc' | 'rating_desc'
  /** 最終視聴日。viewed_desc = 「最近見た順」 */
  | 'viewed_asc' | 'viewed_desc'
  /** 視聴回数。views_desc = 「よく見た順」 */
  | 'views_asc' | 'views_desc'
  /** 解像度(画素数で比較) */
  | 'res_asc' | 'res_desc'
  | 'ext_asc' | 'ext_desc'
  | 'codec_asc' | 'codec_desc'
  | 'acodec_asc' | 'acodec_desc'
  /** フルパス順。フォルダごとにまとまり、中はファイル名順になる */
  | 'folder_asc' | 'folder_desc'
  | 'fmodified_asc' | 'fmodified_desc'
  | 'fcreated_asc' | 'fcreated_desc'
  | 'fps_asc' | 'fps_desc'
  | 'bitrate_asc' | 'bitrate_desc'
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
  /**
   * 絞り込むタグ。同じグループのタグ同士は OR、グループをまたぐと AND になる。
   * 未分類タグはそれぞれ独立した軸として AND(組み立ては Rust の core/query.rs)
   */
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

/**
 * 視聴履歴の 1 行(v1.18)。1 視聴 = 1 行なので、同じ動画が何度も出る。
 * 操作履歴(OpEntry)と違って取り消しの概念は無い
 */
export interface ViewEntry {
  id: number;
  videoId: number;
  /** 'YYYY-MM-DD HH:MM:SS'(localtime) */
  viewedAt: string;
  /** 閉じた時点の再生位置。null = 不明(外部プレイヤー / 異常終了)。0 とは意味が違う */
  watchedMs: number | null;
  filename: string;
  title: string | null;
  durationMs: number | null;
  thumbPath: string | null;
  isMissing: boolean;
}

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
  /** 所属グループ(null = 未分類) */
  groupId: number | null;
  /** グループ名。見出し表示と AI へのヒントに使う */
  groupName: string | null;
  videoCount: number;
}

/**
 * タグをまとめる軸(v1.19)。「ジャンル」「メディア種別」のような分類の入れ物で、
 * グループ自体は動画に付かない。検索では同じグループのタグ同士が OR になる
 */
export interface TagGroup {
  id: number;
  name: string;
  sortOrder: number;
  tagCount: number;
}

/** 選択中の動画のうち、そのタグが付いている件数(タグパレットの 3 状態表示用) */
export interface TagCount {
  tagId: number;
  count: number;
}

/**
 * 一覧(グリッド・詳細リスト)のチップに出すタグ・シリーズ(v1.23)。
 * **Rust の core/labels.rs と手動同期**。
 *
 * VideoRow には入れず、表示中のページの id ぶんだけ別便で取る(理由は core/labels.rs 冒頭)。
 * 「まだ取れていない」は undefined、「1 つも付いていない」は空配列で表す —
 * 呼び出し側がセルを `—` にするか空欄にするかを決められるようにするため
 */
export interface VideoLabels {
  videoId: number;
  tags: { id: number; name: string; color: string | null }[];
  series: { id: number; name: string }[];
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
  /** コマの画像の**既定**の保存先(v1.26)。設定が空欄のときの行き先 */
  framesDir: string;
  /** MCP サーバーの実行ファイル。同梱されていなければ null */
  mcpPath: string | null;
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

// --- メディア情報(詳細ペインの折りたたみセクション。v1.15) ---
//
// Rust の core/metadata.rs と手動で同期している(型生成ツールは使っていない)。
// 値は ffprobe のほぼ生。単位変換・日本語ラベルは lib/mediaInfo.ts の担当

/** ffprobe の tags 1 件。エンコーダ名・作成日時・mkv の BPS などが入る */
export interface MediaTag {
  key: string;
  value: string;
}

export interface MediaFormat {
  formatName: string | null;
  formatLongName: string | null;
  durationMs: number | null;
  size: number | null;
  bitrate: number | null;
  streamCount: number | null;
  tags: MediaTag[];
}

/**
 * ffprobe の 1 ストリーム。映像 / 音声 / 字幕 / 添付を同じ型で運ぶ
 * (種別ごとに使うフィールドが違うだけ。取れなかった値は null)
 */
export interface MediaStream {
  index: number;
  /** 'video' | 'audio' | 'subtitle' | 'attachment' | 'data' */
  kind: string;
  codecName: string | null;
  codecLongName: string | null;
  codecTag: string | null;
  profile: string | null;
  /** codec 依存の生値(h264 の 40 が L4.0)。表示は fmtLevel() で変換する */
  level: number | null;
  durationMs: number | null;
  bitrate: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  /** 埋め込みのカバー画像(kind は 'video' だが本編ではない) */
  isAttachedPic: boolean;
  tags: MediaTag[];
  width: number | null;
  height: number | null;
  displayAspectRatio: string | null;
  sampleAspectRatio: string | null;
  pixFmt: string | null;
  bitDepth: number | null;
  colorSpace: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorRange: string | null;
  fieldOrder: string | null;
  avgFrameRate: number | null;
  rFrameRate: number | null;
  frameCount: number | null;
  rotation: number | null;
  /** 'HDR10 (PQ)' / 'HLG' / 'Dolby Vision'(フレームを読まずに分かる範囲) */
  hdr: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  sampleFmt: string | null;
}

export interface MediaChapter {
  startMs: number;
  endMs: number;
  title: string | null;
}

export interface MediaInfo {
  format: MediaFormat;
  streams: MediaStream[];
  chapters: MediaChapter[];
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
