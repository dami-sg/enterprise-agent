import { connectWebSocketAgentClient, type AgentClient } from '@enterprise-agent/agent-client';
import type { UIMessage } from 'ai';
import { ArrowDown, PanelLeft, Sparkles, SquarePen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalData, PlanData, QuestionData, SubAgentData } from './api';
import { Composer } from './components/chat/Composer';
import { Greeting } from './components/chat/Greeting';
import { Message, type AnyPart } from './components/chat/Message';
import { collectPendingPrompts, PromptDock } from './components/chat/PromptDock';
import { PromptRespondProvider, type PromptResponders } from './components/chat/Prompts';
import { Button } from './components/ui/button';

interface RpcChatViewProps {
  threadId: string;
  sessionId?: string;
  onTurnDone: () => void;
  onNewChat: () => void;
  onToggleSidebar: () => void;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

export function RpcChatView({
  sessionId,
  onTurnDone,
  onNewChat,
  onToggleSidebar,
}: RpcChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [atBottom, setAtBottom] = useState(true);
  const [resolvedPrompts, setResolvedPrompts] = useState<ReadonlySet<string>>(() => new Set());
  const atBottomRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const assistantIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const clientRef = useRef<AgentClient | null>(null);

  const client = useMemo(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return connectWebSocketAgentClient({ url: `${protocol}//${location.host}/rpc` });
  }, []);

  useEffect(() => {
    clientRef.current = client;
    const off = client.onNotification(handleNotification);
    client.initialize({ clientInfo: { name: 'enterprise_web_rpc', title: 'Enterprise Agent Web RPC', version: '0.0.6' } }).catch((err) => {
      setError(err instanceof Error ? err.message : 'RPC 初始化失败');
    });
    return () => {
      off();
      void client.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  function handleNotification(n: RpcNotification): void {
    switch (n.method) {
      case 'item/textDelta':
        appendAssistantText((n.params as { text?: string }).text ?? '');
        break;
      case 'item/reasoningDelta':
        appendAssistantReasoning((n.params as { text?: string }).text ?? '');
        break;
      case 'item/toolCall':
        appendAssistantPart({ type: 'data-tool', data: { id: (n.params as { toolCallId?: string }).toolCallId, name: (n.params as { toolName?: string }).toolName } });
        break;
      case 'item/approvalRequired': {
        const p = n.params as ApprovalData & { input?: unknown };
        appendAssistantPart({
          type: 'data-approval',
          data: {
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            grantScope: p.grantScope,
            detail: p.input ? JSON.stringify(p.input, null, 2) : undefined,
          } satisfies ApprovalData,
        });
        break;
      }
      case 'item/questionRequired': {
        const p = n.params as QuestionData;
        appendAssistantPart({ type: 'data-question', data: { questionId: p.questionId, questions: p.questions } satisfies QuestionData });
        break;
      }
      case 'item/planProposed': {
        const p = n.params as PlanData;
        appendAssistantPart({ type: 'data-plan', data: { planId: p.planId, plan: p.plan, allowedActions: p.allowedActions } satisfies PlanData });
        break;
      }
      case 'item/subAgentStarted': {
        const p = n.params as { agentId: string; role?: string };
        appendAssistantPart({ type: 'data-subagent', data: { agentId: p.agentId, role: p.role ?? 'worker', status: 'running', activity: [] } satisfies SubAgentData });
        break;
      }
      case 'item/subAgentFinished': {
        const p = n.params as { agentId: string; summary?: string };
        appendAssistantPart({ type: 'data-subagent', data: { agentId: p.agentId, role: 'worker', status: 'done', activity: [], summary: p.summary } satisfies SubAgentData });
        break;
      }
      case 'turn/completed':
        setBusy(false);
        assistantIdRef.current = null;
        runIdRef.current = null;
        onTurnDone();
        break;
      case 'item/error':
        setBusy(false);
        setError((n.params as { message?: string }).message ?? 'RPC run 出错');
        break;
    }
  }

  function appendAssistantText(text: string): void {
    if (!text) return;
    mutateAssistant((parts) => {
      const last = parts[parts.length - 1];
      if (last?.type === 'text') last.text = `${last.text ?? ''}${text}`;
      else parts.push({ type: 'text', text });
    });
  }

  function appendAssistantReasoning(text: string): void {
    if (!text) return;
    mutateAssistant((parts) => {
      const last = parts[parts.length - 1];
      if (last?.type === 'reasoning') last.text = `${last.text ?? ''}${text}`;
      else parts.push({ type: 'reasoning', text });
    });
  }

  function appendAssistantPart(part: AnyPart): void {
    mutateAssistant((parts) => parts.push(part));
  }

  function mutateAssistant(mutator: (parts: AnyPart[]) => void): void {
    const id = assistantIdRef.current;
    if (!id) return;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const parts = [...(m.parts as AnyPart[])];
        mutator(parts);
        return { ...m, parts: parts as UIMessage['parts'] };
      }),
    );
  }

  async function ensureSession(text: string): Promise<string> {
    if (activeSessionId) return activeSessionId;
    const created = await client.createSession({ name: text.slice(0, 48) || 'New chat', config: {} });
    const session = created.session as { id?: string };
    if (!session.id) throw new Error('RPC session/create 缺少 session.id');
    setActiveSessionId(session.id);
    return session.id;
  }

  async function sendTextValue(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    setFiles(undefined);
    setError(null);
    setBusy(true);
    const assistantId = crypto.randomUUID();
    assistantIdRef.current = assistantId;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] } as UIMessage,
      { id: assistantId, role: 'assistant', parts: [] } as unknown as UIMessage,
    ]);
    try {
      const sid = await ensureSession(text);
      const { runId } = await client.startTurn(sid, [{ type: 'text', text }]);
      runIdRef.current = runId;
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '发送失败');
    }
  }

  async function send(): Promise<void> {
    await sendTextValue(input);
  }

  function stop(): void {
    const runId = runIdRef.current;
    if (runId) void client.interruptTurn(runId).catch(() => {});
    runIdRef.current = null;
    assistantIdRef.current = null;
    setBusy(false);
  }

  function sendText(text: string): void {
    void sendTextValue(text);
  }

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom(near);
  }

  function scrollToBottom(): void {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }

  const empty = messages.length === 0;
  const pendingPrompts = useMemo(() => collectPendingPrompts(messages, resolvedPrompts), [messages, resolvedPrompts]);
  const responders = useMemo<PromptResponders>(
    () => ({
      approval: async (id, decision) => {
        await client.respondToApproval(id, decision);
      },
      question: async (id, answers) => {
        await client.respondToQuestion(id, answers);
      },
      plan: async (id, approve) => {
        await client.respondToPlan(id, approve ? 'approve' : 'reject');
      },
    }),
    [client],
  );

  return (
    <PromptRespondProvider value={responders}>
    <main className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2.5">
        <Button variant="ghost" size="icon" onClick={onToggleSidebar} title="切换侧栏" className="text-muted-foreground">
          <PanelLeft className="size-[18px]" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onNewChat} title="新建会话" className="text-muted-foreground">
          <SquarePen className="size-[18px]" />
        </Button>
        <div className="ml-auto rounded-md border px-2 py-1 text-xs text-muted-foreground">RPC</div>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex flex-1 flex-col overflow-y-auto">
        {empty ? (
          <Greeting onPick={sendText} />
        ) : (
          <div className="flex flex-col gap-6 py-6">
            {messages.map((m, idx) => (
              <Message key={m.id} message={m} isLast={idx === messages.length - 1} canRegenerate={false} onRegenerate={() => {}} />
            ))}
            {busy && (
              <div className="mx-auto flex w-full max-w-3xl gap-4 px-4">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background ring-1 ring-border">
                  <Sparkles className="size-4 text-muted-foreground" />
                </div>
                <span className="dots pt-2">
                  <span /><span /><span />
                </span>
              </div>
            )}
            {error && <div className="mx-auto w-full max-w-3xl px-4 text-sm text-destructive">出错了：{error}</div>}
          </div>
        )}
      </div>

      <div className="relative shrink-0 px-4 pb-4">
        {!atBottom && !empty && (
          <button
            onClick={scrollToBottom}
            title="回到底部"
            className="absolute -top-12 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        <PromptDock prompts={pendingPrompts} onResolved={(id) => setResolvedPrompts((prev) => new Set(prev).add(id))} />
        <Composer
          input={input}
          setInput={setInput}
          files={files}
          setFiles={setFiles}
          onSend={() => void send()}
          onStop={stop}
          busy={busy}
          canSend={!!input.trim()}
        />
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          RPC 实验模式 · Enter 发送 · Shift+Enter 换行。
        </p>
      </div>
    </main>
    </PromptRespondProvider>
  );
}
