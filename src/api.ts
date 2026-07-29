import { invoke } from '@tauri-apps/api/core';
import { useLibrary } from './store';
import type {
  AppInfo, BackupInfo, FolderNode, LibraryStats, MediaInfo, OpEntry, OpResult, PlanItem, Series,
  SmartFolder, SubfolderView, Tag, VideoQuery, VideoRow, ViewEntry, WatchedFolder,
} from './types';

/**
 * Tauri コマンド呼び出しの共通ラッパ。
 * 失敗を握り潰さず必ずトーストで見せてから再スローする
 * (ffmpeg 欠落・権限エラー・プレイヤー起動失敗などが「無反応」になるのを防ぐ)
 */
async function call<T>(cmd: string, args?: Record<string, unknown>, silent = false): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (!silent) {
      const detail = e instanceof Error ? e.message : String(e);
      useLibrary.getState().pushToast(`${detail}(${cmd})`);
    }
    throw e;
  }
}

export const api = {
  listWatchedFolders: () => call<WatchedFolder[]>('list_watched_folders'),
  /** サイドバー「フォルダー」タブのツリー。DB のパスから組み立てるだけでディスクは触らない */
  listFolderTree: () => call<FolderNode[]>('list_folder_tree'),
  /** メインビューに出すサブフォルダ(そのフォルダの中しか見ないのでツリーより軽い) */
  listSubfolders: (dirPath: string) => call<SubfolderView>('list_subfolders', { dirPath }),
  addWatchedFolder: (path: string) => call<number>('add_watched_folder', { path }),
  removeWatchedFolder: (id: number, removeVideos: boolean) =>
    call<void>('remove_watched_folder', { id, removeVideos }),
  rescanAll: () => call<void>('rescan_all'),
  countVideos: (query: VideoQuery) => call<number>('count_videos', { query }),
  queryVideos: (query: VideoQuery, limit: number, offset: number) =>
    call<VideoRow[]>('query_videos', { query, limit, offset }),
  registerFiles: (paths: string[]) => call<number>('register_files', { paths }),
  /** id 1 件を一覧と同じ形で引く(視聴履歴からの再生用) */
  getVideo: (id: number) => call<VideoRow | null>('get_video', { id }),
  openVideo: (id: number) => call<void>('open_video', { id }),
  /** 外部プレイヤー設定を無視して Windows の関連付けアプリで開く(右クリックメニュー用) */
  openWithDefault: (id: number) => call<void>('open_with_default', { id }),
  /** Windows の「プログラムから開く」ダイアログを出す */
  openWithDialog: (id: number) => call<void>('open_with_dialog', { id }),
  markViewed: (id: number) => call<void>('mark_viewed', { id }),
  /**
   * 再生が実際に始まった時点で 1 回だけ呼ぶ(v1.18)。返るのは view_history の行 id。
   * 失敗しても再生には関係ないので silent(トーストを出さない)
   */
  markOpened: (id: number) => call<number>('mark_opened', { id }, true),
  /** 閉じる / 終わるときに到達位置を書き戻す(v1.18)。こちらも silent */
  finishView: (historyId: number, watchedMs: number) =>
    call<void>('finish_view', { historyId, watchedMs }, true),
  setResume: (id: number, resumeMs: number) => call<void>('set_resume', { id, resumeMs }),
  /**
   * 再生用変換(remux/transcode)。完了までブロックし、キャッシュ mp4 の絶対パスを返す。
   * 失敗は呼び出し側が transcode / 外部プレイヤーへフォールバックする正常経路であり、
   * 準備中に閉じたときのキャンセルでも失敗するため、トーストは出さない(silent)
   */
  prepareVideo: (id: number, mode: 'remux' | 'transcode') =>
    call<string>('prepare_video', { id, mode }, true),
  cancelPrepare: () => call<void>('cancel_prepare', undefined, true),
  listTags: () => call<Tag[]>('list_tags'),
  tagVideos: (videoIds: number[], name: string, actor?: 'user' | 'ai') =>
    call<number>('tag_videos', { videoIds, name, actor }),
  untagVideos: (videoIds: number[], tagId: number, actor?: 'user' | 'ai') =>
    call<void>('untag_videos', { videoIds, tagId, actor }),
  renameTag: (tagId: number, name: string) => call<void>('rename_tag', { tagId, name }),
  deleteTag: (tagId: number) => call<void>('delete_tag', { tagId }),
  /** color に null を渡すと色なしに戻す */
  setTagColor: (tagId: number, color: string | null) =>
    call<void>('set_tag_color', { tagId, color }),
  /** parentId に null を渡すとトップレベルに戻す */
  setTagParent: (tagId: number, parentId: number | null) =>
    call<void>('set_tag_parent', { tagId, parentId }),
  tagsForVideos: (videoIds: number[]) => call<Tag[]>('tags_for_videos', { videoIds }),
  setRating: (videoIds: number[], rating: number, actor?: 'user' | 'ai') =>
    call<void>('set_rating', { videoIds, rating, actor }),
  removeVideos: (videoIds: number[], actor?: 'user' | 'ai') =>
    call<void>('remove_videos', { videoIds, actor }),
  listSeries: () => call<Series[]>('list_series'),
  addToSeries: (videoIds: number[], name: string, actor?: 'user' | 'ai') =>
    call<number>('add_to_series', { videoIds, name, actor }),
  removeFromSeries: (videoIds: number[], seriesId: number, actor?: 'user' | 'ai') =>
    call<void>('remove_from_series', { videoIds, seriesId, actor }),
  deleteSeries: (seriesId: number) => call<void>('delete_series', { seriesId }),
  seriesForVideos: (videoIds: number[]) => call<Series[]>('series_for_videos', { videoIds }),
  getSetting: (key: string) => call<string | null>('get_setting', { key }),
  setSetting: (key: string, value: string) => call<void>('set_setting', { key, value }),
  listSmartFolders: () => call<SmartFolder[]>('list_smart_folders'),
  createSmartFolder: (name: string, query: VideoQuery, actor?: 'user' | 'ai') =>
    call<number>('create_smart_folder', { name, queryJson: JSON.stringify(query), actor }),
  updateSmartFolder: (id: number, name?: string, query?: VideoQuery, actor?: 'user' | 'ai') =>
    call<void>('update_smart_folder', {
      id,
      name,
      queryJson: query ? JSON.stringify(query) : undefined,
      actor,
    }),
  deleteSmartFolder: (id: number) => call<void>('delete_smart_folder', { id }),
  reorderSmartFolders: (ids: number[]) => call<void>('reorder_smart_folders', { ids }),
  libraryStats: () => call<LibraryStats>('library_stats'),
  getAppInfo: () => call<AppInfo>('get_app_info'),
  backupDb: () => call<BackupInfo>('backup_db'),
  listDbBackups: () => call<BackupInfo[]>('list_db_backups'),
  openBackupsDir: () => call<void>('open_backups_dir'),
  openDataDir: () => call<void>('open_data_dir'),
  regenerateThumbnails: (onlyFailed: boolean) =>
    call<number>('regenerate_thumbnails', { onlyFailed }),
  /** atMs を省略するとサムネイルのコマ選びを自動に戻す */
  setThumbTime: (id: number, atMs?: number) => call<void>('set_thumb_time', { id, atMs }),
  /**
   * ffprobe をその場で起動してメディア情報を取る。
   * **詳細ペインの「メディア情報」を展開したときだけ**呼ぶこと(元動画を読むため)。
   * 失敗はセクション内に文言で出すのでトーストは出さない(silent)
   */
  getMediaInfo: (id: number) => call<MediaInfo>('get_media_info', { id }, true),
  purgeOrphanThumbnails: () =>
    call<{ removed: number; freedBytes: number }>('purge_orphan_thumbnails'),
  /** 復元の予約。実際の差し替えは次回起動時。戻り値は退避した現行 DB のファイル名 */
  restoreBackup: (path: string) => call<string>('restore_backup', { path }),

  // --- ファイル操作(plan_* は読むだけ。apply_* はユーザーが承認してから呼ぶ) ---
  planRelink: (fromPrefix: string, toPrefix: string) =>
    call<PlanItem[]>('plan_relink', { fromPrefix, toPrefix }),
  applyRelink: (items: PlanItem[], actor?: 'user' | 'ai') =>
    call<OpResult[]>('apply_relink', { items, actor }),
  planMove: (videoIds: number[], destDir: string) =>
    call<PlanItem[]>('plan_move', { videoIds, destDir }),
  planRename: (videoId: number, newName: string) =>
    call<PlanItem>('plan_rename', { videoId, newName }),
  applyMove: (items: PlanItem[], action: 'move_file' | 'rename_file', actor?: 'user' | 'ai') =>
    call<OpResult[]>('apply_move', { items, action, actor }),
  classifyPaths: (paths: string[]) =>
    call<{ dirs: string[]; files: string[] }>('classify_paths', { paths }),
  planTrash: (videoIds: number[]) => call<PlanItem[]>('plan_trash', { videoIds }),
  /** ごみ箱へ送り、成功したものはライブラリ登録も消す(v1.14) */
  applyTrash: (items: PlanItem[], actor?: 'user' | 'ai') =>
    call<OpResult[]>('apply_trash', { items, actor }),

  // --- 操作履歴 ---
  listOperations: (limit: number, offset: number) =>
    call<OpEntry[]>('list_operations', { limit, offset }),
  undoOperation: (opId: number) => call<string>('undo_operation', { opId }),

  // --- 視聴履歴(v1.18)---
  listViewHistory: (limit: number, offset: number) =>
    call<ViewEntry[]>('list_view_history', { limit, offset }),
};
