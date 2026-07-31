import type { VideoLabels, VideoRow } from '../types';

/** クリック時に見る修飾キー(実イベントでもテスト用の擬似オブジェクトでも受けられるように) */
export interface PickModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** グリッドのカードと詳細リストの行で共通の props(VideoGrid が親として渡す) */
export interface VideoRowProps {
  /** ページ未取得の間は undefined(プレースホルダ表示) */
  video?: VideoRow;
  /**
   * タグ・シリーズ(v1.23)。行より一拍遅れて届くので、未取得の間は undefined。
   * 「取れていない」と「1 つも付いていない(= 空の配列を持つ)」は区別する
   */
  labels?: VideoLabels;
  /** 一覧内の通し番号。範囲選択・キーボード移動の基準になる */
  index: number;
  selected: boolean;
  focused: boolean;
  onPick: (video: VideoRow, index: number, e: PickModifiers) => void;
  onPlay: (video: VideoRow, index: number) => void;
  /** 右クリック。選択の入れ替えとメニュー表示は VideoGrid 側で行う */
  onContextMenu: (video: VideoRow, index: number, e: React.MouseEvent) => void;
}
