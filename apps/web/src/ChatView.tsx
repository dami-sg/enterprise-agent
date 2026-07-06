import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ArrowDown, PanelLeft, Sparkles, SquarePen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchHistory, fetchSessionMode, setSessionMode, type ExecutionMode, type HistoryMessage } from './api';
import { Composer } from './components/chat/Composer';
import { Greeting } from './components/chat/Greeting';
import { Message } from './components/chat/Message';
import { ModeSelector } from './components/chat/ModeSelector';
import { collectPendingPrompts, PromptDock } from './components/chat/PromptDock';
import { Button } from './components/ui/button';
import { RpcChatView } from './RpcChatView';

const DEMO_MESSAGES: UIMessage[] = [
  {
    id: 'd1',
    role: 'user',
    parts: [{ type: 'text', text: '帮我写一个 TypeScript 防抖函数，并说明用途。' }],
  } as UIMessage,
  {
    id: 'd2',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '用户要一个防抖函数 + 用途说明。给出泛型版本，保留参数类型，并对比节流。' },
      {
        type: 'text',
        text: '**防抖（debounce）** 把高频触发合并为「停止触发 N 毫秒后只执行一次」，常用于搜索输入、窗口 resize。\n\n```ts\nfunction debounce<T extends (...a: any[]) => void>(fn: T, ms = 300) {\n  let t: ReturnType<typeof setTimeout>;\n  return (...args: Parameters<T>) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\n要点：\n- 每次调用都重置计时器\n- 适合「最后一次为准」的场景（对比节流 throttle 的「固定频率」）',
      },
      { type: 'data-memory', data: { count: 2 } },
    ],
  } as UIMessage,
  {
    id: 'd3',
    role: 'user',
    parts: [{ type: 'text', text: '帮我清理构建产物并重新部署到预发布环境。' }],
  } as UIMessage,
  {
    id: 'd4',
    role: 'assistant',
    parts: [
      {
        type: 'data-todos',
        data: {
          todos: [
            { id: 't1', content: '清理旧的构建产物', status: 'completed' },
            { id: 't2', content: '运行单元测试', status: 'in_progress' },
            { id: 't3', content: '构建并部署到预发布', status: 'pending' },
          ],
        },
      },
      { type: 'text', text: '好的，这一步涉及高风险操作，需要你确认。' },
      {
        type: 'data-approval',
        data: { toolCallId: 'demo-tc', toolName: 'bash', grantScope: 'shell:run', detail: 'rm -rf ./build && pnpm build' },
      },
      {
        type: 'data-question',
        data: {
          questionId: 'demo-q',
          questions: [
            {
              question: '部署到哪个环境？',
              header: '环境',
              multiSelect: false,
              options: [
                { label: '预发布', description: 'staging，自动回滚' },
                { label: '生产', description: '面向真实用户，需谨慎' },
              ],
            },
          ],
        },
      },
      {
        type: 'data-plan',
        data: {
          planId: 'demo-p',
          plan: '### 部署计划\n1. 清理 `./build`\n2. 运行单元测试\n3. 构建产物\n4. 部署到 **staging**',
          allowedActions: ['执行 shell 命令', '写入文件'],
        },
      },
    ],
  } as UIMessage,
  {
    id: 'd5',
    role: 'user',
    parts: [{ type: 'text', text: '调研一下竞品的定价策略，并整理我们仓库里的相关文档。' }],
  } as UIMessage,
  {
    id: 'd6',
    role: 'assistant',
    parts: [
      { type: 'text', text: '我把这个任务拆给两个子代理并行处理：' },
      {
        type: 'data-subagent',
        data: { agentId: 'researcher-1', role: 'researcher', status: 'done', activity: ['webSearch', 'readUrl', 'readUrl'], summary: '整理了 3 家竞品的定价档位与差异化要点。' },
      },
      {
        type: 'data-subagent',
        data: { agentId: 'coder-1', role: 'coder', status: 'running', activity: ['glob', 'readFile'] },
      },
    ],
  } as UIMessage,
];

function toUiMessage(h: HistoryMessage): UIMessage {
  // Prefer the server's structured, ordered parts (text · reasoning · tool chips)
  // so a reopened session renders like the live stream; fall back to a single
  // text part for an older server that only sends `text`.
  const parts = h.parts?.length ? h.parts : [{ type: 'text' as const, text: h.text }];
  return { id: h.id, role: h.role, parts: parts as UIMessage['parts'] };
}

// `?demo` seeds a sample transcript once per page load so the very first thread
// previews populated; opening a new chat then shows the real empty/greeting state.
let demoSeeded = false;

interface ChatViewProps {
  threadId: string;
  sessionId?: string;
  onTurnDone: () => void;
  onNewChat: () => void;
  onToggleSidebar: () => void;
}

export function ChatView(props: ChatViewProps): React.ReactElement {
  if (new URLSearchParams(location.search).has('rpc')) return <RpcChatView {...props} />;
  return <LegacyChatView {...props} />;
}

function LegacyChatView({
  threadId,
  sessionId,
  onTurnDone,
  onNewChat,
  onToggleSidebar,
}: ChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Ids of interactive prompts the user has already acted on (kept out of the dock).
  const [resolvedPrompts, setResolvedPrompts] = useState<ReadonlySet<string>>(() => new Set());
  // The active session's execution mode (agent §3.8). Loaded once a session exists.
  const [mode, setModeState] = useState<ExecutionMode>('ask');

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        credentials: 'include',
      }),
    [],
  );
  const { messages, sendMessage, setMessages, status, error, stop, regenerate } = useChat({ id: threadId, transport });

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef(status);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    if (sessionId) {
      fetchHistory(sessionId)
        .then((h) => setMessages(h.map(toUiMessage)))
        .catch(() => {});
      fetchSessionMode(sessionId).then(setModeState).catch(() => {});
    } else if (location.search.includes('demo') && !demoSeeded) {
      demoSeeded = true;
      setMessages(DEMO_MESSAGES);
    } else {
      setModeState('ask'); // a fresh thread starts at the default until it exists
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Switch the session's execution mode (optimistic; revert if the POST fails).
  function changeMode(next: ExecutionMode): void {
    if (!sessionId || next === mode) return;
    const prev = mode;
    setModeState(next);
    setSessionMode(sessionId, next).catch(() => setModeState(prev));
  }

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  useEffect(() => {
    if (prevStatus.current !== 'ready' && status === 'ready') onTurnDone();
    prevStatus.current = status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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

  function send(): void {
    const text = input.trim();
    if ((!text && !files?.length) || status !== 'ready') return;
    void sendMessage({ text, files });
    setInput('');
    setFiles(undefined);
  }

  function sendText(text: string): void {
    if (!text.trim() || status !== 'ready') return;
    void sendMessage({ text: text.trim() });
  }

  const empty = messages.length === 0;
  const pendingPrompts = useMemo(() => collectPendingPrompts(messages, resolvedPrompts), [messages, resolvedPrompts]);
  function markResolved(id: string): void {
    setResolvedPrompts((prev) => new Set(prev).add(id));
  }

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2.5">
        <Button variant="ghost" size="icon" onClick={onToggleSidebar} title="切换侧栏" className="text-muted-foreground">
          <PanelLeft className="size-[18px]" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onNewChat} title="新建会话" className="text-muted-foreground">
          <SquarePen className="size-[18px]" />
        </Button>
        <div className="ml-auto">
          <ModeSelector mode={mode} disabled={!sessionId} onChange={changeMode} />
        </div>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex flex-1 flex-col overflow-y-auto">
        {empty ? (
          <Greeting onPick={sendText} />
        ) : (
          <div className="flex flex-col gap-6 py-6">
            {messages.map((m, idx) => (
              <Message
                key={m.id}
                message={m}
                isLast={idx === messages.length - 1}
                canRegenerate={status === 'ready'}
                onRegenerate={() => void regenerate()}
              />
            ))}

            {status === 'submitted' && (
              <div className="mx-auto flex w-full max-w-3xl gap-4 px-4">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background ring-1 ring-border">
                  <Sparkles className="size-4 text-muted-foreground" />
                </div>
                <div className="flex items-center pt-1.5">
                  <span className="dots">
                    <span /><span /><span />
                  </span>
                </div>
              </div>
            )}
            {error && (
              <div className="mx-auto w-full max-w-3xl px-4 text-sm text-destructive">出错了：{error.message}</div>
            )}
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
        <PromptDock prompts={pendingPrompts} onResolved={markResolved} />
        <Composer
          input={input}
          setInput={setInput}
          files={files}
          setFiles={setFiles}
          onSend={send}
          onStop={() => void stop()}
          busy={busy}
          canSend={!!input.trim() || !!files?.length}
        />
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          Enter 发送 · Shift+Enter 换行 · AI 也会犯错，请核对重要信息。
        </p>
      </div>
    </main>
  );
}
