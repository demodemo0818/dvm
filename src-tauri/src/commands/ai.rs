//! アプリ内 AI アシスタントの HTTP 中継(v1.43)。
//!
//! フロントから直接 fetch できない理由は `core::ai_http` の先頭に書いてある。
//! ここは薄いラッパで、**リクエストの組み立ても SSE の解釈も一切しない**
//! (プロバイダごとの方言はすべてフロントの `src/lib/ai/` にある)。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;

use crate::core::ai_http::{stream_sse, SseEvent, SseRequest};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    /// SSE の 1 行(改行なし)
    Line { data: String },
    /// 非 2xx。エラーの分類はフロント側で行う
    HttpError { status: u16, body: String },
    /// 正常終了。**必ず最後に 1 回だけ届く**(これが来ないまま止まったら異常)
    Done,
}

/// 実行中のリクエストの中断フラグ。`ai_cancel` から立てる
fn cancels() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// AI プロバイダへ POST して、SSE を行単位で `channel` に流す。
///
/// `request_id` はフロントが採番する。同じ id で `ai_cancel` を呼ぶと止まる
#[tauri::command]
pub async fn ai_stream(
    request_id: u64,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    channel: Channel<AiEvent>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    // 先に登録する。送信が始まる前に中断されても取りこぼさないため
    cancels().lock().unwrap().insert(request_id, cancel.clone());

    let result = stream_sse(SseRequest { url, headers, body }, cancel, |ev| {
        let _ = channel.send(match ev {
            SseEvent::Line(data) => AiEvent::Line { data },
            SseEvent::HttpError { status, body } => AiEvent::HttpError { status, body },
        });
    })
    .await;

    cancels().lock().unwrap().remove(&request_id);

    match result {
        Ok(()) => {
            let _ = channel.send(AiEvent::Done);
            Ok(())
        }
        // 中断・切断・DNS 失敗などはここに来る。文言はフロントで分類する
        Err(e) => Err(format!("{e:#}")),
    }
}

/// 実行中のリクエストを止める。存在しない id は黙って無視する
/// (応答が終わった直後に停止ボタンを押しても事故らないため)
#[tauri::command]
pub fn ai_cancel(request_id: u64) {
    if let Some(c) = cancels().lock().unwrap().get(&request_id) {
        c.store(true, Ordering::Relaxed);
    }
}
