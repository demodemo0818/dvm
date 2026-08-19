//! AI プロバイダへの HTTP(Server-Sent Events)。UI 非依存。
//!
//! **なぜ Rust 側で HTTP を持つのか(v1.43)**
//!
//! v1.3〜v1.42 のアプリ内 AI アシスタントは、フロントの `@anthropic-ai/sdk` が
//! WebView から直接 Anthropic を叩いていた。これは Anthropic が
//! `anthropic-dangerous-direct-browser-access: true` というブラウザ直叩き専用の
//! ヘッダを用意しているから通っていたもので、**他社では通らない**。
//!
//! 実測(WebView2 / origin = http://localhost:1420):
//!
//! | 経路 | 結果 |
//! |---|---|
//! | Anthropic POST(上記ヘッダ付き) | 通る |
//! | Anthropic POST(ヘッダ無し) | `MissingAllowOriginHeader` |
//! | Gemini POST `:streamGenerateContent` | 通る |
//! | **OpenAI POST + `Authorization`** | **`MissingAllowOriginHeader`** |
//! | OpenAI POST(認証ヘッダ無し) | 通る(401 が読める) |
//!
//! OpenAI はプリフライト(OPTIONS)の応答に `Access-Control-Allow-Origin` を
//! 返さないので、`Authorization` を付けた POST がブラウザから一切届かない。
//! OpenAI SDK の `dangerouslyAllowBrowser` は SDK 側のガードを外すだけで
//! CORS には何の関係もない。
//!
//! **3 社まとめてここを通す。** プロバイダごとに fetch と Rust を使い分けると
//! 2 経路を保守することになるうえ、dev(`http://localhost:1420`)と配布版
//! (`http://tauri.localhost`)で origin が違うため「dev では通ったのに配布版で落ちる」
//! を踏む。ローカル LLM の `OLLAMA_ORIGINS` 制限も、ここを通せば最初から関係なくなる。
//!
//! **SSE のパースはしない。** 行に切って渡すだけで、`data:` の解釈は
//! フロントの `src/lib/ai/sse.ts` とアダプタが行う(プロバイダごとの方言は
//! 全部あちら側にあるので、Rust に持ち込むと二重管理になる)。

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct SseRequest {
    pub url: String,
    pub headers: HashMap<String, String>,
    /// そのまま送る JSON 文字列(組み立てはフロントのアダプタの仕事)
    pub body: String,
}

pub enum SseEvent {
    /// SSE の 1 行(改行は含まない)。空行もそのまま渡す
    Line(String),
    /// 非 2xx。**本文をそのまま渡す** —— OpenAI 互換サーバーの方言エラーは
    /// これを握り潰すと原因が永遠に分からなくなる
    HttpError { status: u16, body: String },
}

/// POST して SSE を行単位で流す。`cancel` が立ったら次のチャンクで抜ける
pub async fn stream_sse<F>(req: SseRequest, cancel: Arc<AtomicBool>, mut on_event: F) -> Result<()>
where
    F: FnMut(SseEvent),
{
    let client = reqwest::Client::new();

    let mut headers = reqwest::header::HeaderMap::new();
    for (k, v) in &req.headers {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .with_context(|| format!("ヘッダ名が不正です: {k}"))?;
        let value = reqwest::header::HeaderValue::from_str(v)
            .with_context(|| format!("ヘッダの値が不正です: {k}"))?;
        headers.insert(name, value);
    }

    let res = client
        .post(&req.url)
        .headers(headers)
        .body(req.body)
        .send()
        .await
        .with_context(|| format!("接続できませんでした: {}", req.url))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        on_event(SseEvent::HttpError { status: status.as_u16(), body });
        return Ok(());
    }

    /*
     * **バイト列で貯めてから行に切る。**
     * チャンクの境界は UTF-8 の文字の途中に落ちることがあるので、
     * チャンクごとに文字列化すると日本語が化ける。改行(0x0A)は
     * UTF-8 のマルチバイト列の中には現れないので、バイトで切ってから
     * 1 行ずつ文字列にするのが安全。
     */
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        buf.extend_from_slice(&chunk.context("受信中に接続が切れました")?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = buf.drain(..=pos).collect();
            line.pop(); // \n
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            on_event(SseEvent::Line(String::from_utf8_lossy(&line).into_owned()));
        }
    }
    // 改行で終わらずに切れた最後の 1 行
    if !buf.is_empty() {
        on_event(SseEvent::Line(String::from_utf8_lossy(&buf).into_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 行分割の中身だけを取り出したもの(HTTP を張らずに試せるようにしている)
    fn split_lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        let mut buf: Vec<u8> = Vec::new();
        for c in chunks {
            buf.extend_from_slice(c);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = buf.drain(..=pos).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                out.push(String::from_utf8_lossy(&line).into_owned());
            }
        }
        if !buf.is_empty() {
            out.push(String::from_utf8_lossy(&buf).into_owned());
        }
        out
    }

    #[test]
    fn 行の途中で切れたチャンクをつなぐ() {
        let lines = split_lines(&[b"data: {\"a\":", b"1}\n\n", b"data: [DONE]\n"]);
        assert_eq!(lines, vec!["data: {\"a\":1}", "", "data: [DONE]"]);
    }

    #[test]
    fn 日本語がチャンク境界で割れても化けない() {
        // 「あ」= E3 81 82。チャンクの境目を文字の真ん中に置く
        let lines = split_lines(&[b"data: \xe3\x81", b"\x82\n"]);
        assert_eq!(lines, vec!["data: あ"]);
    }

    #[test]
    fn crlf_を落とす() {
        let lines = split_lines(&[b"data: x\r\n\r\n"]);
        assert_eq!(lines, vec!["data: x", ""]);
    }

    #[test]
    fn 改行で終わらない最後の行も渡す() {
        let lines = split_lines(&[b"data: x\ndata: y"]);
        assert_eq!(lines, vec!["data: x", "data: y"]);
    }
}
