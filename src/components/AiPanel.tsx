import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { buildSystemPrompt, buildTools } from '../lib/aiTools';
import { useLibrary } from '../store';

const DEFAULT_MODEL = 'claude-opus-5';

interface ChatItem {
  role: 'user' | 'assistant';
  text: string;
  /** ツール実行カード(「3 件にタグを付けました」など) */
  cards: string[];
}

export function AiPanel() {
  const { showAiPanel, aiPanelWidth } = useLibrary();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // API 履歴(テキストのみ。thinking / tool ブロックは持ち回さない)
  const history = useRef<BetaMessageParam[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showAiPanel) {
      api.getSetting('anthropic_api_key').then((v) => setApiKey(v ?? ''));
      api.getSetting('anthropic_model').then((v) => setModel(v?.trim() || DEFAULT_MODEL));
    }
  }, [showAiPanel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  if (!showAiPanel) return null;

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !apiKey) return;
    setInput('');
    setBusy(true);
    setChat((c) => [...c, { role: 'user', text, cards: [] }, { role: 'assistant', text: '', cards: [] }]);

    const appendText = (delta: string) =>
      setChat((c) => {
        const next = [...c];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      });
    const addCard = (card: string) =>
      setChat((c) => {
        const next = [...c];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, cards: [...last.cards, card] };
        return next;
      });

    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const system = await buildSystemPrompt();
      history.current.push({ role: 'user', content: text });

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system,
        tools: buildTools(addCard),
        messages: [...history.current],
        stream: true,
      });

      let finalText = '';
      for await (const stream of runner) {
        let thinkingShown = false;
        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking' && !thinkingShown) {
            thinkingShown = true;
          }
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            appendText(ev.delta.text);
          }
        }
        const msg = await stream.finalMessage();
        for (const block of msg.content) {
          if (block.type === 'text') finalText += (finalText ? '\n' : '') + block.text;
        }
        // ツール実行を挟むターンの区切り
        if (msg.stop_reason === 'tool_use') appendText('\n');
      }

      // 履歴にはテキストのみ積む(thinking / tool ブロックの持ち回し問題を避ける)
      history.current.push({ role: 'assistant', content: finalText || '(ツールを実行しました)' });
    } catch (e) {
      const msg = e instanceof Anthropic.AuthenticationError
        ? 'API キーが無効です。設定を確認してください'
        : e instanceof Anthropic.APIError
          ? `API エラー (${e.status}): ${e.message}`
          : String(e);
      addCard(msg);
      // 失敗したターンは履歴から取り除く(次回リクエストを壊さない)
      if (history.current[history.current.length - 1]?.role === 'user') history.current.pop();
    } finally {
      setBusy(false);
    }
  };

  return (
    // 幅はドラッグで変えられる。min-width も同じ値にして flex に縮められないようにする
    <aside className="ai-panel" style={{ width: aiPanelWidth, minWidth: aiPanelWidth }}>
      <div className="ai-header">
        <span>AI アシスタント</span>
        <button
          title="会話をクリア"
          onClick={() => {
            setChat([]);
            history.current = [];
          }}
        >
          <Trash2 />
        </button>
      </div>
      <div className="ai-messages" ref={scrollRef}>
        {chat.length === 0 && (
          <div className="ai-hint">
            例:
            <br />「★4 以上で 10 分以内の動画を見せて」
            <br />「この動画にタグを提案して」(動画を選択して)
            <br />「最近追加した動画を教えて」
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`ai-msg ai-${m.role}`}>
            {m.text && <div className="ai-text">{m.text}</div>}
            {m.cards.map((card, j) => (
              <div key={j} className="ai-card">
                {card}
              </div>
            ))}
            {m.role === 'assistant' && !m.text && m.cards.length === 0 && busy && i === chat.length - 1 && (
              <div className="ai-text ai-thinking">考え中…</div>
            )}
          </div>
        ))}
      </div>
      {apiKey === '' ? (
        <div className="ai-setup">
          API キーが未設定です。ツールバーの設定ボタンから「AI アシスタント」で Anthropic API
          キーを保存してください
        </div>
      ) : (
        <div className="ai-input-row">
          <textarea
            value={input}
            placeholder="ライブラリについて質問…"
            rows={2}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button onClick={send} disabled={busy || !input.trim()}>
            {busy ? '…' : '送信'}
          </button>
        </div>
      )}
    </aside>
  );
}
