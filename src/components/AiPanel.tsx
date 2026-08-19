import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createProvider } from '../lib/ai';
import { loadAiConfig, missingSettingMessage } from '../lib/ai/config';
import { runToolLoop } from '../lib/ai/runner';
import { AiError, type AiMessage } from '../lib/ai/types';
import { buildSystemPrompt, buildTools } from '../lib/aiTools';
import { useShallow } from 'zustand/react/shallow';
import { pickState, useLibrary } from '../store';

interface ChatItem {
  role: 'user' | 'assistant';
  text: string;
  /** ツール実行カード(「3 件にタグを付けました」など) */
  cards: string[];
}

export function AiPanel() {
  const { showAiPanel, aiPanelWidth } = useLibrary(
    useShallow(pickState('showAiPanel', 'aiPanelWidth')),
  );
  /** 設定が足りないときの案内。undefined は読み込み中、null は送信できる状態 */
  const [missing, setMissing] = useState<string | null | undefined>(undefined);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** 直近のターンのトークン数(課金の目安として小さく出す) */
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  // API 履歴(テキストのみ。thinking / tool ブロックは持ち回さない)
  const history = useRef<AiMessage[]>([]);
  /** 実行中のターンを止めるためのもの。停止ボタンと会話クリアから使う */
  const abort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showAiPanel) void loadAiConfig().then((c) => setMissing(missingSettingMessage(c)));
  }, [showAiPanel]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  // パネルを閉じたりアプリを離れたりしたら、走らせっぱなしにしない
  useEffect(() => () => abort.current?.abort(), []);

  if (!showAiPanel) return null;

  const send = async () => {
    const text = input.trim();
    if (!text || busy || missing) return;
    setInput('');
    setBusy(true);
    setUsage(null);
    setChat((c) => [...c, { role: 'user', text, cards: [] }, { role: 'assistant', text: '', cards: [] }]);

    // 空配列ガード: クリア直後にストリーミングの残りが届いても落とさない
    const appendText = (delta: string) =>
      setChat((c) => {
        const last = c[c.length - 1];
        if (!last) return c;
        const next = [...c];
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      });
    const addCard = (card: string) =>
      setChat((c) => {
        const last = c[c.length - 1];
        if (!last) return c;
        const next = [...c];
        next[next.length - 1] = { ...last, cards: [...last.cards, card] };
        return next;
      });

    const ac = new AbortController();
    abort.current = ac;

    try {
      // 送信のたびに読み直す。パネルを開いたまま設定を変えても次の送信から効く
      const config = await loadAiConfig();
      const blocked = missingSettingMessage(config);
      if (blocked) {
        setMissing(blocked);
        throw new AiError('auth', blocked);
      }
      const system = await buildSystemPrompt();
      let finalText = '';

      for await (const ev of runToolLoop({
        provider: createProvider(config),
        system,
        history: history.current,
        userText: text,
        tools: buildTools(addCard),
        signal: ac.signal,
      })) {
        switch (ev.type) {
          case 'text':
            appendText(ev.text);
            break;
          // ツール実行を挟むターンの区切り
          case 'turn_break':
            appendText('\n');
            break;
          case 'card':
            addCard(ev.text);
            break;
          case 'usage':
            setUsage({ input: ev.inputTokens, output: ev.outputTokens });
            break;
          case 'done':
            finalText = ev.finalText;
            break;
        }
      }

      // 履歴にはテキストのみ積む(thinking / tool ブロックの持ち回し問題を避ける)
      history.current.push({ role: 'user', content: text });
      history.current.push({
        role: 'assistant',
        content: finalText || '(ツールを実行しました)',
      });
    } catch (e) {
      // 中断は失敗ではない。出かかっていた文字はそのまま残し、履歴にも積まない
      if (!(e instanceof AiError && e.kind === 'aborted')) {
        addCard(e instanceof AiError ? e.message : String(e));
      }
    } finally {
      if (abort.current === ac) abort.current = null;
      setBusy(false);
    }
  };

  return (
    // 幅はドラッグで変えられる。min-width も同じ値にして flex に縮められないようにする
    <aside className="ai-panel" style={{ width: aiPanelWidth, minWidth: aiPanelWidth }}>
      <div className="ai-header">
        <span>AI アシスタント</span>
        <button
          title={busy ? '応答中はクリアできません' : '会話をクリア'}
          disabled={busy}
          onClick={() => {
            setChat([]);
            setUsage(null);
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
      {missing ? (
        <div className="ai-setup">{missing}</div>
      ) : (
        <>
          {usage && (
            <div className="ai-usage">
              入力 {usage.input.toLocaleString()} / 出力 {usage.output.toLocaleString()} トークン
            </div>
          )}
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
            {busy ? (
              // 応答中は「停止」に差し替える(受信の途中でも止まる)
              <button onClick={() => abort.current?.abort()} title="応答を止める">
                停止
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()}>
                送信
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
