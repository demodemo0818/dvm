/*
 * ツール宣言を各社の tools 形式へ変換する(v1.43)。純関数だけ。
 *
 * DVM のスキーマは JSON Schema のごく狭い部分集合しか使っていない
 * (`$ref` / `oneOf` / `nullable` / `additionalProperties` / ネストしたオブジェクトが 0 件)ので、
 * 基本は**キー名の付け替えだけ**で済む。例外は下の 2 つで、どちらもテストで固定してある。
 */

import type { ToolDef, ToolSchema } from './types';

/** Anthropic: `input_schema`。スキーマはそのまま通る */
export function toAnthropicTools(defs: ToolDef[]): unknown[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.parameters,
  }));
}

/**
 * OpenAI(と互換サーバー): `{type:'function', function:{...}}`。
 *
 * **strict は使わない。** strict は「properties の全キーが required」かつ
 * 「未指定を表すには型を nullable にする」ことを要求するが、DVM の `search_videos` は
 * プロパティ 31 個で required が 0 個(全条件が任意)なので相性が悪い。
 * 引数の検証は実装側(toQuery / Rust の clamp)で既にやっている
 */
export function toOpenAITools(defs: ToolDef[]): unknown[] {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

/**
 * Gemini: `[{functionDeclarations: [...]}]`(**配列 1 個の中にまとめる**)。
 *
 * **引数を取らないツールは `parameters` ごと落とす** —— `list_tags` / `list_series` の
 * ように `properties: {}` を渡すと Gemini が弾くことがある。
 * 3 社のうちここだけがこの特例を必要とする
 */
export function toGeminiTools(defs: ToolDef[]): unknown[] {
  const functionDeclarations = defs.map((d) => {
    const decl: { name: string; description: string; parameters?: ToolSchema } = {
      name: d.name,
      description: d.description,
    };
    if (Object.keys(d.parameters.properties).length > 0) decl.parameters = d.parameters;
    return decl;
  });
  return [{ functionDeclarations }];
}
