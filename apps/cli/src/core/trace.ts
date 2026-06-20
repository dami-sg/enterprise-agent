/**
 * `reduceTrace` (cli §5.3) — the render-agnostic core shared by the Ink TUI
 * (cli §4) and headless renderers (cli §11). It folds the one-directional
 * `AgentStreamEvent` stream (agent §6.2) into a navigable trace-tree state that
 * components (§3 trace, §4 approval, §5 todo, §2.1 usage) project verbatim.
 *
 * The reducer also accepts a handful of **local actions** (`@…`) the UI raises
 * for things the event stream does not carry: an approval decision the user
 * just made, a dismissed toast, the resolved orchestrator model for the TopBar.
 */
import type {
  AgentStreamEvent,
  ApprovalDecision,
  CompactionReason,
  Entry,
  SessionTree,
  Todo,
  TokenUsage,
  UsageTotals,
  UserQuestion,
} from '@enterprise-agent/agent-contract';

// ---------------------------------------------------------------------------
// Trace tree (§3.1) — an ordered tree of items hung under agent nodes.
// ---------------------------------------------------------------------------

export type ToolStatus = 'running' | 'ok' | 'error' | 'approval' | 'question';

export interface TextItem {
  kind: 'text';
  text: string;
  /**
   * Who said it — user turns render quoted, assistant plainly, `reasoning` as
   * dim "thinking" text (§3). Reasoning is the model's normalized thinking
   * stream (agent §2.2), shown muted so it doesn't compete with the answer.
   */
  speaker: 'user' | 'assistant' | 'reasoning';
}

export interface ToolItem {
  kind: 'tool';
  toolCallId: string;
  agentId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  status: ToolStatus;
  /** Human-readable scope an approval would grant (agent §3.3). */
  grantScope?: string;
  /** Set once the user picks `task`: subsequent same-scope calls auto-pass. */
  granted?: ApprovalDecision;
}

export interface CompactionItem {
  kind: 'compaction';
  reason: CompactionReason;
  tokensBefore?: number;
  tokensAfter?: number;
  done: boolean;
}

export interface AgentItem {
  kind: 'agent';
  agentId: string;
  parentAgentId?: string;
  /** 'orchestrator' for the root, the sub-agent role otherwise (§3.1). */
  role: string;
  children: TraceItem[];
  status: 'running' | 'done';
  /** sub-agent-finish summary (§3.1). */
  summary?: string;
  usage?: TokenUsage;
}

export type TraceItem = TextItem | ToolItem | CompactionItem | AgentItem;

// ---------------------------------------------------------------------------
// Approval queue (§4) & toasts (§2.3)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  toolCallId: string;
  agentId: string;
  parentAgentId?: string;
  toolName: string;
  input: unknown;
  grantScope?: string;
}

/** A pending `askUserQuestion` round-trip; the UI shows one at a time (§4). */
export interface PendingQuestion {
  questionId: string;
  agentId: string;
  parentAgentId?: string;
  questions: UserQuestion[];
}

export type ToastLevel = 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  level: ToastLevel;
  text: string;
  /** Persistent toasts (errors) stay until dismissed (§13.4). */
  persistent: boolean;
}

export type RunStatus = 'idle' | 'running' | 'finished' | 'error' | 'aborted';

export interface TraceState {
  runId?: string;
  rootAgentId?: string;
  /** agentId → node, for O(1) appends; nodes are shared with the tree. */
  agents: Map<string, AgentItem>;
  /** toolCallId → node, for matching `tool-result` to its `tool-call`. */
  tools: Map<string, ToolItem>;
  /** FIFO of un-decided approvals; the UI shows one at a time (§4). */
  pending: PendingApproval[];
  /** FIFO of un-answered `askUserQuestion` prompts; shown one at a time (§4). */
  questions: PendingQuestion[];
  todos: Todo[];
  usage: UsageTotals;
  compaction?: { active: boolean; reason?: CompactionReason };
  /** Orchestrator model context window (agent §2.6) — for window-usage display. */
  contextWindow?: number;
  /** Orchestrator model output reservation; usable input = context − this. */
  maxOutputTokens?: number;
  /** Latest step's input tokens = how full the context window currently is. */
  lastInputTokens?: number;
  status: RunStatus;
  finishReason?: string;
  lastError?: string;
  /** MCP connection failures (error{runId:'mcp'}) — persistent status (§9.3). */
  mcpErrors: string[];
  toasts: Toast[];
  /** Resolved orchestrator alias for the TopBar (§2.1); set via @set-model. */
  model?: string;
  toastSeq: number;
}

// ---------------------------------------------------------------------------
// Local UI actions (not part of the wire event stream)
// ---------------------------------------------------------------------------

export type LocalAction =
  | { kind: '@approval-decision'; toolCallId: string; decision: ApprovalDecision }
  /** The user answered (or dismissed, `cancelled`) a pending askUserQuestion. */
  | { kind: '@answer-question'; questionId: string; cancelled: boolean }
  | { kind: '@dismiss-toast'; id: string }
  | { kind: '@toast'; level: ToastLevel; text: string }
  | { kind: '@set-model'; model: string }
  /** Restore the persisted usage/context readout when re-opening a session (§2.1). */
  | { kind: '@set-usage'; usage: UsageTotals; lastInputTokens?: number; contextWindow?: number }
  | { kind: '@reset'; runId?: string }
  /** Append the user's own message to the trace so the turn is visible (§3.2). */
  | { kind: '@user-text'; text: string }
  /** Replace the whole trace with one rebuilt from persisted history (§4.6). */
  | { kind: '@load'; tree: SessionTree };

export type TraceAction = AgentStreamEvent | LocalAction;

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cost: 0,
};

export function initialTrace(): TraceState {
  return {
    agents: new Map(),
    tools: new Map(),
    pending: [],
    questions: [],
    todos: [],
    usage: { ...EMPTY_USAGE },
    mcpErrors: [],
    status: 'idle',
    toasts: [],
    toastSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Fold one action into the trace state. Returns a fresh top-level object (so
 * React re-renders) while reusing the node identity inside the tree — at
 * terminal scale that is both correct and cheap.
 */
export function reduceTrace(state: TraceState, action: TraceAction): TraceState {
  const next: TraceState = { ...state };

  switch (action.kind) {
    // -- local actions ------------------------------------------------------
    case '@reset':
      return { ...initialTrace(), model: state.model, runId: action.runId };

    case '@load':
      return { ...reconstructTrace(action.tree), model: state.model };

    case '@set-model':
      next.model = action.model;
      return next;

    case '@set-usage':
      next.usage = { ...action.usage };
      if (action.lastInputTokens != null) next.lastInputTokens = action.lastInputTokens;
      if (action.contextWindow != null) next.contextWindow = action.contextWindow;
      return next;

    case '@dismiss-toast':
      next.toasts = state.toasts.filter((t) => t.id !== action.id);
      return next;

    case '@toast':
      return pushToast(next, action.level, action.text, false);

    case '@user-text': {
      // The user's own message — appended to the root agent so the turn shows,
      // and so the next assistant text-delta starts a fresh (separate) block.
      const agent = ensureAgent(next, 'orch');
      agent.children.push({ kind: 'text', text: action.text, speaker: 'user' });
      return next;
    }

    case '@approval-decision': {
      next.pending = state.pending.filter((p) => p.toolCallId !== action.toolCallId);
      const tool = state.tools.get(action.toolCallId);
      if (tool) {
        if (action.decision === 'reject') {
          tool.status = 'error';
          tool.isError = true;
          tool.output = 'rejected by user';
        } else {
          tool.status = 'running';
          tool.granted = action.decision;
          if (action.decision === 'session' && tool.grantScope) {
            return pushToast(next, 'success', `已放行 ${tool.grantScope} · 本会话`, false);
          }
        }
      }
      return next;
    }

    case '@answer-question': {
      next.questions = state.questions.filter((q) => q.questionId !== action.questionId);
      // The asking tool resumes; its `tool-result` will flip it to ok/error.
      const tool = state.tools.get(action.questionId);
      if (tool && tool.status === 'question') tool.status = 'running';
      return next;
    }

    // -- stream events ------------------------------------------------------
    case 'text-delta': {
      const agent = ensureAgent(next, action.agentId);
      const last = agent.children[agent.children.length - 1];
      // Merge only into an in-progress *assistant* block; a user message (or any
      // other item) before it starts a fresh assistant block — so turns stay
      // separated instead of concatenating onto the previous turn.
      if (last && last.kind === 'text' && last.speaker === 'assistant') last.text += action.text;
      else agent.children.push({ kind: 'text', text: action.text, speaker: 'assistant' });
      next.status = 'running';
      return next;
    }

    case 'reasoning-delta': {
      // Normalized thinking (agent §2.2): coalesce into a trailing reasoning
      // block; any other item before it starts a fresh one so blocks stay
      // separate from the answer text.
      const agent = ensureAgent(next, action.agentId);
      const last = agent.children[agent.children.length - 1];
      if (last && last.kind === 'text' && last.speaker === 'reasoning') last.text += action.text;
      else agent.children.push({ kind: 'text', text: action.text, speaker: 'reasoning' });
      next.status = 'running';
      return next;
    }

    case 'tool-call': {
      const agent = ensureAgent(next, action.agentId);
      const tool: ToolItem = {
        kind: 'tool',
        toolCallId: action.toolCallId,
        agentId: action.agentId,
        toolName: action.toolName,
        input: action.input,
        status: 'running',
      };
      agent.children.push(tool);
      next.tools.set(tool.toolCallId, tool);
      next.status = 'running';
      return next;
    }

    case 'tool-approval-required': {
      const agent = ensureAgent(next, action.agentId, undefined, action.parentAgentId);
      let tool = next.tools.get(action.toolCallId);
      if (!tool) {
        tool = {
          kind: 'tool',
          toolCallId: action.toolCallId,
          agentId: action.agentId,
          toolName: action.toolName,
          input: action.input,
          status: 'approval',
        };
        agent.children.push(tool);
        next.tools.set(tool.toolCallId, tool);
      }
      tool.status = 'approval';
      tool.grantScope = action.grantScope;
      next.pending = [
        ...state.pending,
        {
          toolCallId: action.toolCallId,
          agentId: action.agentId,
          parentAgentId: action.parentAgentId,
          toolName: action.toolName,
          input: action.input,
          grantScope: action.grantScope,
        },
      ];
      return next;
    }

    case 'user-question-required': {
      const agent = ensureAgent(next, action.agentId, undefined, action.parentAgentId);
      // askUserQuestion also fired a `tool-call`, so the node usually exists;
      // create it defensively if events arrived out of order.
      let tool = next.tools.get(action.questionId);
      if (!tool) {
        tool = {
          kind: 'tool',
          toolCallId: action.questionId,
          agentId: action.agentId,
          toolName: 'askUserQuestion',
          input: { questions: action.questions },
          status: 'question',
        };
        agent.children.push(tool);
        next.tools.set(tool.toolCallId, tool);
      }
      tool.status = 'question';
      next.questions = [
        ...state.questions,
        {
          questionId: action.questionId,
          agentId: action.agentId,
          parentAgentId: action.parentAgentId,
          questions: action.questions,
        },
      ];
      return next;
    }

    case 'tool-result': {
      const tool = next.tools.get(action.toolCallId);
      if (tool) {
        tool.output = action.output;
        tool.isError = action.isError;
        tool.status = action.isError ? 'error' : 'ok';
      }
      // A result also clears any lingering approval / question for that call.
      next.pending = state.pending.filter((p) => p.toolCallId !== action.toolCallId);
      next.questions = state.questions.filter((q) => q.questionId !== action.toolCallId);
      return next;
    }

    case 'step-finish': {
      const agent = next.agents.get(action.agentId);
      if (agent) agent.usage = mergeUsage(agent.usage, action.usage);
      return next;
    }

    case 'usage': {
      next.usage = {
        inputTokens: action.totalUsage.inputTokens,
        outputTokens: action.totalUsage.outputTokens,
        totalTokens: action.totalUsage.totalTokens,
        reasoningTokens: action.totalUsage.reasoningTokens ?? 0,
        cachedInputTokens: action.totalUsage.cachedInputTokens ?? 0,
        // `cost` is now session-cumulative from the agent (agent §2.7), so it
        // accumulates across steps instead of showing only the last step.
        cost: action.cost,
      };
      // Track the live input-vs-window so the TopBar can show window usage.
      if (action.contextWindow) next.contextWindow = action.contextWindow;
      if (action.maxOutputTokens != null) next.maxOutputTokens = action.maxOutputTokens;
      next.lastInputTokens = action.usage.inputTokens || next.lastInputTokens;
      const agent = next.agents.get(action.agentId);
      if (agent) agent.usage = mergeUsage(agent.usage, action.usage);
      return next;
    }

    case 'todo-update':
      next.todos = action.todos;
      return next;

    case 'sub-agent-start': {
      ensureAgent(next, action.agentId, action.role, action.parentAgentId);
      return next;
    }

    case 'sub-agent-finish': {
      const agent = next.agents.get(action.agentId);
      if (agent) {
        agent.status = 'done';
        agent.summary = action.summary;
      }
      return next;
    }

    case 'compaction-start': {
      next.compaction = { active: true, reason: action.reason };
      const root = next.rootAgentId ? next.agents.get(next.rootAgentId) : undefined;
      if (root) root.children.push({ kind: 'compaction', reason: action.reason, done: false });
      return next;
    }

    case 'compaction-end': {
      next.compaction = { active: false };
      const root = next.rootAgentId ? next.agents.get(next.rootAgentId) : undefined;
      const node = root && lastCompaction(root);
      if (node) {
        node.done = true;
        node.tokensBefore = action.tokensBefore;
        node.tokensAfter = action.tokensAfter;
      }
      return pushToast(
        next,
        'success',
        `已压缩 ${fmtTok(action.tokensBefore)} → ${fmtTok(action.tokensAfter)} tok`,
        false,
      );
    }

    case 'entry-appended':
      return next; // persistence ack; not rendered in the trace

    case 'run-finish': {
      next.status = next.status === 'error' ? 'error' : 'finished';
      next.finishReason = action.finishReason;
      const root = next.rootAgentId ? next.agents.get(next.rootAgentId) : undefined;
      if (root) root.status = 'done';
      return pushToast(
        next,
        'success',
        `run 完成 · ${fmtTok(next.usage.totalTokens)} tok · $${next.usage.cost.toFixed(3)}`,
        false,
      );
    }

    case 'error': {
      if (action.runId === 'mcp') {
        next.mcpErrors = [...state.mcpErrors, action.message];
        return next;
      }
      // Infrastructure warning (e.g. sandbox fell back) — not a run failure:
      // surface as a persistent warning toast without marking the run errored.
      if (action.runId === 'sandbox') {
        return pushToast(next, 'warning', `⚠ ${action.message}`, true);
      }
      next.status = 'error';
      next.lastError = action.message;
      return pushToast(next, 'danger', `错误：${action.message}`, true);
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureAgent(
  state: TraceState,
  agentId: string,
  role?: string,
  parentAgentId?: string,
): AgentItem {
  const existing = state.agents.get(agentId);
  if (existing) {
    if (role) existing.role = role;
    return existing;
  }
  const node: AgentItem = {
    kind: 'agent',
    agentId,
    parentAgentId,
    role: role ?? (parentAgentId ? 'sub-agent' : 'orchestrator'),
    children: [],
    status: 'running',
  };
  state.agents.set(agentId, node);
  if (parentAgentId) {
    const parent = state.agents.get(parentAgentId);
    if (parent) parent.children.push(node);
    else state.rootAgentId ??= agentId; // parent unknown yet → treat as root-ish
  } else {
    state.rootAgentId ??= agentId;
  }
  return node;
}

function lastCompaction(agent: AgentItem): CompactionItem | undefined {
  for (let i = agent.children.length - 1; i >= 0; i--) {
    const c = agent.children[i];
    if (c && c.kind === 'compaction') return c;
  }
  return undefined;
}

function mergeUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

function pushToast(state: TraceState, level: ToastLevel, text: string, persistent: boolean): TraceState {
  const id = `t${state.toastSeq + 1}`;
  state.toastSeq += 1;
  state.toasts = [...state.toasts, { id, level, text, persistent }];
  return state;
}

/** Compact token count for status lines: 12_400 → "12.4k". */
export function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Render projection — flatten the tree into indented rows (§3 / §11.1).
// ---------------------------------------------------------------------------

export interface TraceRow {
  item: TraceItem;
  depth: number;
  /** Stable key for React lists / row addressing. */
  key: string;
}

/** Depth-first flatten from the root agent, honouring child order (§3.1). */
export function flattenTrace(state: TraceState): TraceRow[] {
  const rows: TraceRow[] = [];
  const root = state.rootAgentId ? state.agents.get(state.rootAgentId) : undefined;
  if (root) walk(root, 0, rows, 'r');
  return rows;
}

function walk(item: TraceItem, depth: number, out: TraceRow[], key: string): void {
  out.push({ item, depth, key });
  if (item.kind === 'agent') {
    item.children.forEach((c, i) => walk(c, depth + 1, out, `${key}.${i}`));
  }
}

// ---------------------------------------------------------------------------
// History reconstruction (§4.6) — rebuild a trace from the persisted session
// tree so an existing session shows its prior conversation, not a blank pane.
// ---------------------------------------------------------------------------

/**
 * Fold the active context path (root → head, stopping at a compaction summary
 * baseline, mirroring `SessionStore.getPath`) into a trace. Entries are the
 * coarse, persisted v6 message parts (agent §5.3): user/assistant text,
 * `tool-call` / `tool-result` parts, and `summary` compaction checkpoints.
 */
export function reconstructTrace(tree: SessionTree): TraceState {
  const state = initialTrace();
  const path = headPath(tree);
  if (path.length === 0) return state;

  // Use the live orchestrator agentId ('orch') so events from a subsequent send
  // append to this same root node rather than spawning a second tree.
  const root: AgentItem = { kind: 'agent', agentId: 'orch', role: 'orchestrator', children: [], status: 'done' };
  state.agents.set(root.agentId, root);
  state.rootAgentId = root.agentId;
  const tools = new Map<string, ToolItem>();

  for (const e of path) {
    if (e.kind === 'user') {
      const text = partsText(e.content);
      if (text) root.children.push({ kind: 'text', text, speaker: 'user' });
    } else if (e.kind === 'assistant') {
      for (const part of e.content ?? []) {
        const p = part as { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown };
        if (p.type === 'reasoning' && p.text) {
          root.children.push({ kind: 'text', text: p.text, speaker: 'reasoning' });
        } else if (p.type === 'text' && p.text) {
          root.children.push({ kind: 'text', text: p.text, speaker: 'assistant' });
        } else if (p.type === 'tool-call' && p.toolCallId) {
          const tool: ToolItem = {
            kind: 'tool',
            toolCallId: p.toolCallId,
            agentId: root.agentId,
            toolName: p.toolName ?? 'tool',
            input: p.input,
            status: 'ok',
          };
          root.children.push(tool);
          tools.set(tool.toolCallId, tool);
        } else if (p.type === 'tool-result' && p.toolCallId) {
          const tool = tools.get(p.toolCallId);
          if (tool) {
            tool.output = p.output;
            tool.status = 'ok';
          }
        }
      }
    } else if (e.kind === 'summary' && e.summary) {
      root.children.push({
        kind: 'compaction',
        reason: e.summary.reason,
        tokensBefore: e.summary.tokensBefore,
        tokensAfter: e.summary.tokensAfter,
        done: true,
      });
    }
  }

  state.status = 'finished';
  return state;
}

/** Active path root→head, stopping at (and including) a compaction summary. */
function headPath(tree: SessionTree): Entry[] {
  const chain: Entry[] = [];
  let cur: string | undefined = tree.headId;
  while (cur) {
    const e: Entry | undefined = tree.nodes[cur];
    if (!e) break;
    chain.push(e);
    if (e.kind === 'summary') break; // compaction baseline (agent §5.4)
    cur = e.parentId;
  }
  return chain.reverse();
}

function partsText(parts: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('')
    .trim();
}
