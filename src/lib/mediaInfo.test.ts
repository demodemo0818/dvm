import { describe, expect, it } from 'vitest';
import type { MediaInfo, MediaStream } from '../types';
import {
  buildMediaSections, fmtBitrate, fmtLanguage, fmtLevel, fmtSampleRate,
  mediaSectionsToText, visibleTags,
} from './mediaInfo';

/** 全 null のストリーム。テストごとに必要な項目だけ上書きする */
function stream(over: Partial<MediaStream>): MediaStream {
  return {
    index: 0, kind: 'video', codecName: null, codecLongName: null, codecTag: null,
    profile: null, level: null, durationMs: null, bitrate: null, language: null, title: null,
    isDefault: false, isForced: false, isAttachedPic: false, tags: [],
    width: null, height: null, displayAspectRatio: null, sampleAspectRatio: null,
    pixFmt: null, bitDepth: null, colorSpace: null, colorPrimaries: null, colorTransfer: null,
    colorRange: null, fieldOrder: null, avgFrameRate: null, rFrameRate: null, frameCount: null,
    rotation: null, hdr: null,
    sampleRate: null, channels: null, channelLayout: null, sampleFmt: null,
    ...over,
  };
}

function info(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    format: {
      formatName: null, formatLongName: null, durationMs: null, size: null,
      bitrate: null, streamCount: null, tags: [],
    },
    streams: [],
    chapters: [],
    ...over,
  };
}

/** ffprobe に実際に食わせて確認した mkv 相当(映像 1 + 音声 2 + 字幕 1 + 添付 1) */
function sampleMkv(): MediaInfo {
  return info({
    format: {
      formatName: 'matroska,webm', formatLongName: 'Matroska / WebM',
      durationMs: 1_420_500, size: 1_524_000_000, bitrate: 8_580_000, streamCount: 5,
      tags: [{ key: 'ENCODER', value: 'libebml v1.3.1' }],
    },
    streams: [
      stream({
        index: 0, kind: 'video', codecName: 'h264', profile: 'High', level: 40,
        width: 1920, height: 1080, avgFrameRate: 23.976, rFrameRate: 23.976,
        pixFmt: 'yuv420p', bitDepth: 8, colorSpace: 'bt709', colorRange: 'tv',
        fieldOrder: 'progressive', bitrate: 8_551_234, frameCount: 34_000,
        language: 'jpn', isDefault: true, durationMs: 1_420_500,
        tags: [
          { key: 'BPS', value: '8551234' },
          { key: 'ENCODER', value: 'x264' },
          { key: '_STATISTICS_WRITING_APP', value: 'mkvmerge' },
        ],
      }),
      stream({
        index: 1, kind: 'audio', codecName: 'aac', profile: 'LC', sampleRate: 48_000,
        channels: 2, channelLayout: 'stereo', sampleFmt: 'fltp', bitrate: 192_000,
        language: 'jpn', title: '本編', isDefault: true, durationMs: 1_420_500,
      }),
      stream({
        index: 2, kind: 'audio', codecName: 'ac3', channels: 6,
        channelLayout: '5.1(side)', sampleRate: 48_000, language: 'eng',
      }),
      stream({ index: 3, kind: 'subtitle', codecName: 'subrip', language: 'eng', isForced: true }),
      stream({ index: 4, kind: 'attachment', codecName: 'ttf' }),
    ],
  });
}

describe('fmtBitrate', () => {
  it('1 Mbps 以上は Mbps、未満は kbps', () => {
    expect(fmtBitrate(8_551_234)).toBe('8.55 Mbps');
    expect(fmtBitrate(1_000_000)).toBe('1.00 Mbps');
    expect(fmtBitrate(192_000)).toBe('192 kbps');
    expect(fmtBitrate(0)).toBe('0 kbps');
  });
});

describe('fmtSampleRate', () => {
  it('kHz に直す', () => {
    expect(fmtSampleRate(48_000)).toBe('48.0 kHz');
    expect(fmtSampleRate(44_100)).toBe('44.1 kHz');
  });
});

describe('fmtLevel', () => {
  it('codec ごとに基準が違う', () => {
    expect(fmtLevel('h264', 40)).toBe('L4.0');
    expect(fmtLevel('h264', 31)).toBe('L3.1');
    expect(fmtLevel('hevc', 120)).toBe('L4.0');
    expect(fmtLevel('hevc', 153)).toBe('L5.1');
  });

  it('知らない codec は生値のまま出す', () => {
    expect(fmtLevel('av1', 8)).toBe('L8');
    expect(fmtLevel(null, 3)).toBe('L3');
  });
});

describe('fmtLanguage', () => {
  it('日本語名を添えつつ生値も残す', () => {
    expect(fmtLanguage('jpn')).toBe('日本語 (jpn)');
    expect(fmtLanguage('eng')).toBe('英語 (eng)');
  });

  it('知らないコードは生値のまま', () => {
    expect(fmtLanguage('tlh')).toBe('tlh');
  });

  // ほぼ全ての mp4 に入っていて情報量がゼロなので行ごと出さない
  it('und と欠落は null', () => {
    expect(fmtLanguage('und')).toBeNull();
    expect(fmtLanguage(null)).toBeNull();
  });
});

describe('visibleTags', () => {
  it('専用行がある値と中身の無いタグを落とす', () => {
    const kept = visibleTags([
      { key: 'ENCODER', value: 'x264' },
      { key: 'language', value: 'jpn' },
      { key: 'BPS-eng', value: '8551234' },
      { key: '_STATISTICS_WRITING_APP', value: 'mkvmerge' },
      { key: 'handler_name', value: 'VideoHandler' },
      { key: 'DURATION', value: '00:23:40.500000000' },
      { key: 'creation_time', value: '2026-07-20T00:00:00Z' },
    ]);
    expect(kept.map((t) => t.key)).toEqual(['ENCODER', 'creation_time']);
  });
});

describe('buildMediaSections', () => {
  it('種別ごとにセクションを作る', () => {
    const titles = buildMediaSections(sampleMkv()).map((s) => s.title);
    // 音声は 2 本なので番号が付き、映像・字幕は 1 本なので付かない
    expect(titles).toEqual(['全般', '映像', '音声 #1', '音声 #2', '字幕']);
  });

  // YouTube 由来の mp4 はサムネイルが PNG の映像ストリームとして入っている。
  // 本編と一緒に数えると「映像 2」に見えてしまう
  it('埋め込みカバー画像を本編の映像と分ける', () => {
    const sections = buildMediaSections(info({
      streams: [
        stream({ kind: 'video', codecName: 'h264' }),
        stream({ kind: 'video', codecName: 'png', isAttachedPic: true, width: 1280, height: 720 }),
        stream({ kind: 'audio', codecName: 'aac' }),
      ],
    }));
    expect(sections.map((s) => s.title)).toEqual(['全般', '映像', '音声', 'カバー画像']);
    expect(sections[0].rows).toContainEqual({ label: 'ストリーム', value: '映像 1 / 音声 1' });
    expect(sections[0].rows).toContainEqual({ label: 'カバー画像', value: '1 個' });
  });

  it('添付ファイルは個別セクションにせず全般の 1 行にまとめる', () => {
    const general = buildMediaSections(sampleMkv())[0];
    expect(general.rows).toContainEqual({ label: '添付ファイル', value: '1 個' });
    expect(general.rows).toContainEqual({ label: 'ストリーム', value: '映像 1 / 音声 2 / 字幕 1' });
  });

  it('全般に単位を付けて出す', () => {
    const rows = buildMediaSections(sampleMkv())[0].rows;
    expect(rows).toContainEqual({ label: 'コンテナ', value: 'Matroska / WebM (matroska,webm)' });
    expect(rows).toContainEqual({ label: '再生時間', value: '23:40' });
    expect(rows).toContainEqual({ label: 'ファイルサイズ', value: '1.42 GB' });
    expect(rows).toContainEqual({ label: '総ビットレート', value: '8.58 Mbps' });
  });

  it('映像のコーデック行に profile と level をまとめる', () => {
    const video = buildMediaSections(sampleMkv())[1];
    expect(video.rows).toContainEqual({ label: 'コーデック', value: 'h264 (High) @ L4.0' });
    expect(video.rows).toContainEqual({ label: '解像度', value: '1920×1080' });
    expect(video.rows).toContainEqual({ label: 'フレームレート', value: '23.976 fps' });
    expect(video.rows).toContainEqual({ label: 'ビット深度', value: '8 bit' });
    expect(video.rows).toContainEqual({ label: '色範囲', value: '制限 (tv)' });
    expect(video.rows).toContainEqual({ label: '走査方式', value: 'プログレッシブ' });
    expect(video.rows).toContainEqual({ label: 'フラグ', value: '既定' });
  });

  it('音声のチャンネル数とレイアウトを 1 行にまとめる', () => {
    const [, , first, second] = buildMediaSections(sampleMkv());
    expect(first.rows).toContainEqual({ label: 'チャンネル', value: '2 ch (stereo)' });
    expect(first.rows).toContainEqual({ label: 'サンプルレート', value: '48.0 kHz' });
    expect(first.rows).toContainEqual({ label: 'タイトル', value: '本編' });
    expect(second.rows).toContainEqual({ label: 'チャンネル', value: '6 ch (5.1(side))' });
  });

  it('強制字幕のフラグを出す', () => {
    const subtitle = buildMediaSections(sampleMkv())[4];
    expect(subtitle.rows).toContainEqual({ label: 'フラグ', value: '強制' });
    expect(subtitle.rows).toContainEqual({ label: '言語', value: '英語 (eng)' });
  });

  // コンテナと同じ尺を全ストリームに並べても読む意味が無い
  it('ストリームの尺はコンテナとズレているときだけ出す', () => {
    const same = buildMediaSections(sampleMkv())[1];
    expect(same.rows.some((r) => r.label === '長さ')).toBe(false);

    const short = buildMediaSections(info({
      format: { ...info().format, durationMs: 1_420_500 },
      streams: [stream({ kind: 'audio', codecName: 'aac', durationMs: 900_000 })],
    }));
    expect(short[1].rows).toContainEqual({ label: '長さ', value: '15:00' });
  });

  it('可変フレームレートを書き添える', () => {
    const vfr = buildMediaSections(info({
      streams: [stream({ kind: 'video', codecName: 'h264', avgFrameRate: 23.976, rFrameRate: 30 })],
    }));
    expect(vfr[1].rows).toContainEqual({ label: 'フレームレート', value: '23.976 fps(可変)' });
  });

  it('値が無いフィールドは行を作らない', () => {
    // 何も読めなかったストリームは空セクションになるので丸ごと消える。
    // 全般に残るのは本数の行だけ(枠だけのブロックを並べない)
    const bare = buildMediaSections(info({ streams: [stream({ kind: 'video' })] }));
    expect(bare).toEqual([{ title: '全般', rows: [{ label: 'ストリーム', value: '映像 1' }] }]);
  });

  it('空のメディア情報でもセクションを作らない', () => {
    expect(buildMediaSections(info())).toEqual([]);
  });

  it('チャプターは開始時刻をラベルにする', () => {
    const sections = buildMediaSections(info({
      chapters: [
        { startMs: 0, endMs: 90_000, title: 'オープニング' },
        { startMs: 90_000, endMs: 1_420_500, title: null },
      ],
    }));
    expect(sections[0]).toEqual({
      title: 'チャプター',
      rows: [
        { label: '0:00', value: 'オープニング' },
        { label: '1:30', value: 'チャプター 2' },
      ],
    });
  });
});

describe('mediaSectionsToText', () => {
  it('見出しと ラベル: 値 の形にする', () => {
    const text = mediaSectionsToText('sample.mkv\nD:\\動画\\sample.mkv', [
      { title: '全般', rows: [{ label: 'コンテナ', value: 'Matroska' }] },
      { title: '映像', rows: [{ label: 'コーデック', value: 'h264' }] },
    ]);
    expect(text).toBe(
      'sample.mkv\nD:\\動画\\sample.mkv\n\n[全般]\nコンテナ: Matroska\n\n[映像]\nコーデック: h264\n',
    );
  });

  // 表示とコピーが同じ InfoSection[] から作られていることの担保
  it('画面に出ている行がすべてテキストにも入る', () => {
    const sections = buildMediaSections(sampleMkv());
    const text = mediaSectionsToText('header', sections);
    const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
    expect(text.split('\n').filter((l) => l.includes(': ')).length).toBe(rowCount);
    for (const s of sections) expect(text).toContain(`[${s.title}]`);
  });
});
