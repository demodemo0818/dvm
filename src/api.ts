import { invoke } from '@tauri-apps/api/core';
import type { AppInfo, BackupInfo, Series, Tag, VideoQuery, VideoRow, WatchedFolder } from './types';

export const api = {
  listWatchedFolders: () => invoke<WatchedFolder[]>('list_watched_folders'),
  addWatchedFolder: (path: string) => invoke<number>('add_watched_folder', { path }),
  removeWatchedFolder: (id: number, removeVideos: boolean) =>
    invoke<void>('remove_watched_folder', { id, removeVideos }),
  rescanAll: () => invoke<void>('rescan_all'),
  countVideos: (query: VideoQuery) => invoke<number>('count_videos', { query }),
  queryVideos: (query: VideoQuery, limit: number, offset: number) =>
    invoke<VideoRow[]>('query_videos', { query, limit, offset }),
  registerFiles: (paths: string[]) => invoke<number>('register_files', { paths }),
  openVideo: (id: number) => invoke<void>('open_video', { id }),
  listTags: () => invoke<Tag[]>('list_tags'),
  tagVideos: (videoIds: number[], name: string) =>
    invoke<number>('tag_videos', { videoIds, name }),
  untagVideos: (videoIds: number[], tagId: number) =>
    invoke<void>('untag_videos', { videoIds, tagId }),
  renameTag: (tagId: number, name: string) => invoke<void>('rename_tag', { tagId, name }),
  deleteTag: (tagId: number) => invoke<void>('delete_tag', { tagId }),
  tagsForVideos: (videoIds: number[]) => invoke<Tag[]>('tags_for_videos', { videoIds }),
  setRating: (videoIds: number[], rating: number) =>
    invoke<void>('set_rating', { videoIds, rating }),
  removeVideos: (videoIds: number[]) => invoke<void>('remove_videos', { videoIds }),
  listSeries: () => invoke<Series[]>('list_series'),
  addToSeries: (videoIds: number[], name: string) =>
    invoke<number>('add_to_series', { videoIds, name }),
  removeFromSeries: (videoIds: number[], seriesId: number) =>
    invoke<void>('remove_from_series', { videoIds, seriesId }),
  deleteSeries: (seriesId: number) => invoke<void>('delete_series', { seriesId }),
  seriesForVideos: (videoIds: number[]) => invoke<Series[]>('series_for_videos', { videoIds }),
  getSetting: (key: string) => invoke<string | null>('get_setting', { key }),
  setSetting: (key: string, value: string) => invoke<void>('set_setting', { key, value }),
  getAppInfo: () => invoke<AppInfo>('get_app_info'),
  backupDb: () => invoke<BackupInfo>('backup_db'),
  listDbBackups: () => invoke<BackupInfo[]>('list_db_backups'),
  openBackupsDir: () => invoke<void>('open_backups_dir'),
  openDataDir: () => invoke<void>('open_data_dir'),
  regenerateThumbnails: (onlyFailed: boolean) =>
    invoke<number>('regenerate_thumbnails', { onlyFailed }),
};
