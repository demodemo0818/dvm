import { saveStoreFlag } from '../../hooks/useSetting';
import { useLibrary } from '../../store';

/**
 * 一覧の見た目(v1.38 で「再生」から分けた)。
 *
 * カードのタグ行 / シリーズ行は**カードの高さを変える**設定で、再生とは関係が無い。
 * 詳細リストの列と 1 行おきの濃淡は**ここに置かない** —— 入口は列ヘッダの列ピッカーで、
 * あちらはリスト表示のときしか開けないぶん「設定が効く場所と操作する場所」が一致する
 * (DESIGN.md「詳細リスト」節)。
 *
 * カード幅・グリッド/リストの切り替え・詳細ペインの固定も置かない(入口はツールバー)。
 */
export function DisplaySection() {
  const previewOnHover = useLibrary((s) => s.previewOnHover);
  const setPreviewOnHover = useLibrary((s) => s.setPreviewOnHover);
  const cardTags = useLibrary((s) => s.cardTags);
  const setCardTags = useLibrary((s) => s.setCardTags);
  const cardSeries = useLibrary((s) => s.cardSeries);
  const setCardSeries = useLibrary((s) => s.setCardSeries);

  return (
    <div className="settings-section">
      <div className="settings-heading">表示</div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={cardTags}
          onChange={(e) => saveStoreFlag('card_tags', setCardTags, e.target.checked)}
        />
        グリッドのカードにタグを表示する
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={cardSeries}
          onChange={(e) => saveStoreFlag('card_series', setCardSeries, e.target.checked)}
        />
        グリッドのカードにシリーズを表示する
      </label>
      <div className="settings-note">
        詳細リストに出す列と 1 行おきの濃淡は、リスト表示のときに列ヘッダの歯車から選びます
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={previewOnHover}
          onChange={(e) => saveStoreFlag('preview_on_hover', setPreviewOnHover, e.target.checked)}
        />
        カードにカーソルを合わせるとプレビュー再生する(マウスを左右に動かすとシーンを送れます)
      </label>
      <div className="settings-note">
        プレビューは元の動画ファイルを直接読みます。外付け HDD / NAS のアクセスを抑えたいときは
        オフにしてください
      </div>
    </div>
  );
}
