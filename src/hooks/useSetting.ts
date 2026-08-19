import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { parseFlag, serializeFlag } from '../lib/settings';

/*
 * app.db の設定 1 個を「その場保存」で扱うフック(v1.38)。
 *
 * **store に載っている設定には使わない** —— 値の出所が 2 つになる。store にあるもの
 * (player_path / preview_on_hover / card_tags / card_series / seek_preview /
 * autoplay_next / hdr_passthrough / subtitle_style)は store を唯一の出所にして、
 * setter を呼ぶついでに set_setting を書く(作法は ColumnPicker.tsx を参照)。
 *
 * ここが受け持つのは、Rust か AiPanel が DB から直読みするので store に載せる意味が
 * 無いキーだけ —— use_embedded_cover / frame_save_dir / ai_api_key_* / ai_model_* /
 * ai_base_url_openai_compat / mcp_allow_write / transcode_cache_limit_gb。
 *
 * **キーが変わる使い方をするなら呼び出し側で mount し直すこと**(v1.43)。
 * `useEffect` の依存は `[key]` だが `dirty` / `saved` の ref はリセットしないので、
 * 同じインスタンスのままキーを差し替えると前の入力が別のキーに書かれる。
 * AI 設定はプロバイダごとにキーが変わるので `key={provider}` を付けている
 * (`AiProviderFields`)。
 */

/**
 * **store にある**真偽の設定を、store と DB へ同時に書く(フックではない)。
 *
 * store を先に進めて DB を後回しにすると食い違う窓ができるので、必ず一緒に動かす。
 * 呼び出し側は `onChange={(e) => saveStoreFlag('card_tags', setCardTags, e.target.checked)}`
 */
export function saveStoreFlag(key: string, apply: (v: boolean) => void, v: boolean): void {
  apply(v);
  void api.setSetting(key, serializeFlag(v));
}

/**
 * 真偽の設定。チェックを変えた瞬間に書く。
 *
 * `def` は未設定(null)のときの値。**ロードが返る前にユーザーが触ったら、
 * 遅れて届いたロード結果で上書きしない**(dirty)
 */
export function useFlagSetting(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(def);
  const dirty = useRef(false);

  useEffect(() => {
    let alive = true;
    void api.getSetting(key).then((raw) => {
      if (alive && !dirty.current) setValue(parseFlag(raw, def));
    });
    return () => {
      alive = false;
    };
  }, [key, def]);

  const save = useCallback(
    (v: boolean) => {
      dirty.current = true;
      setValue(v);
      void api.setSetting(key, serializeFlag(v));
    },
    [key],
  );

  return [value, save];
}

/**
 * テキストの設定。**打っている途中では書かず**、フォーカスが外れたとき(commit)に書く。
 *
 * **unmount でも書き切る** —— Escape やオーバーレイのクリックで閉じても blur は
 * 起きないので、これが無いと「API キーを打って即閉じる」で最後の入力が消える。
 * App.tsx の字幕(400ms デバウンス)と違ってタイマーではなく cleanup で同期的に
 * 呼ぶので、モーダルが消えても取りこぼさない。
 */
export function useTextSetting(
  key: string,
  opts: {
    /**
     * DB を読まずにこの値から始める。**store が既に持っている設定**用
     * (App.tsx が起動時に読んでいるので、モーダルから読み直す意味が無い)
     */
    initial?: string;
    /**
     * DB に値が無いときに**欄へ出す**文字列。空欄のままで意味が通る欄
     * (パス・API キー。placeholder が既定を説明する)では指定しない。
     * 表示するだけで DB には書かないので、触らずに閉じても行は増えない
     */
    defaultValue?: string;
    /** 確定時の整形。既定は前後の空白を落とすだけ */
    normalize?: (s: string) => string;
    /** DB へ書いたあとに呼ぶ。store への反映など */
    onCommit?: (v: string) => void;
  } = {},
): {
  value: string;
  /** 画面に反映するだけ。DB には書かない(入力欄の onChange 用) */
  edit: (v: string) => void;
  /** 変化していれば DB に書く(onBlur 用) */
  commit: () => void;
  /** edit + commit。ダイアログで選んだ値や「既定に戻す」など、確定済みの変更用 */
  save: (v: string) => void;
} {
  const [value, setValue] = useState(opts.initial ?? opts.defaultValue ?? '');
  /** ユーザーが触ったか。触っていなければ DB に書かない(未設定のキーに空行を作らない) */
  const dirty = useRef(false);
  /** DB にあるはずの値。同じ内容を書き直さない */
  const saved = useRef<string | null>(opts.initial ?? null);

  /*
   * opts は呼び出し側でインライン定義されるので依存配列に入れられない。
   * 表示中の値も、unmount の cleanup から読むために ref で持つ
   * (cleanup は最初のレンダーの関数を閉じ込めるため)
   */
  const optsRef = useRef(opts);
  const valueRef = useRef(value);
  useEffect(() => {
    optsRef.current = opts;
    valueRef.current = value;
  });

  useEffect(() => {
    // initial をもらった設定は store が出所。DB を読み直さない
    if (optsRef.current.initial !== undefined) return;
    let alive = true;
    void api.getSetting(key).then((raw) => {
      if (!alive || dirty.current) return;
      // saved は DB の実値のまま。触らずに閉じたときに既定値を書き込まないため
      saved.current = raw;
      // defaultValue を指定した欄は「空で意味を持たない」欄なので、空文字も未設定として扱う
      const shown = raw != null && raw !== '' ? raw : (optsRef.current.defaultValue ?? '');
      valueRef.current = shown;
      setValue(shown);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  const edit = useCallback((v: string) => {
    dirty.current = true;
    valueRef.current = v;
    setValue(v);
  }, []);

  /** 実際に書く部分。commit と save で共有する */
  const write = useCallback(
    (raw: string) => {
      const normalize = optsRef.current.normalize ?? ((s: string) => s.trim());
      const next = normalize(raw);
      // 「既定に戻す」のように正規化しても値が変わらない場合があるので、必ず反映する
      valueRef.current = next;
      setValue(next);
      if (next === saved.current) return;
      saved.current = next;
      void api.setSetting(key, next);
      optsRef.current.onCommit?.(next);
    },
    [key],
  );

  const commit = useCallback(() => {
    if (!dirty.current) return;
    write(valueRef.current);
  }, [write]);

  const save = useCallback(
    (v: string) => {
      dirty.current = true;
      write(v);
    },
    [write],
  );

  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);

  return { value, edit, commit, save };
}
