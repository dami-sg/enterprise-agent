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
import { ORCHESTRATOR_AGENT_ID } from '@enterprise-agent/agent-contract';
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
  /** A `delegateToSubAgent` call holds the spawned sub-agent's trace here, so the
   *  UI can render the sub-agent's live log inside this tool call's expansion. */
  children?: TraceItem[];
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
  /** The `delegateToSubAgent` tool call that spawned this sub-agent. Lets the
   *  reducer re-home the node under that tool no matter which event lands first
   *  — `sub-agent-start`, the sub's content, or the delegate `tool-call` (§3.1). */
  spawnedByToolCallId?: string;
}

/** A direct shell-escape command (`!cmd`) and its captured output — runs outside
 *  the model/agent, shown inline in the transcript (cli §6.2). */
export interface ShellItem {
  kind: 'shell';
  command: string;
  output?: string;
  exitCode?: number;
  running: boolean;
}

export type TraceItem = TextItem | ToolItem | CompactionItem | AgentItem | ShellItem;

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
  /**
   * Run ids of sub-agents spawned in this trace (recorded from `sub-agent-start`,
   * which carries the sub's own runId). A `run-finish` for one of these is a
   * sub-agent completing — only the root orchestrator run ends the turn (§3.1).
   */
  subAgentRunIds: Set<string>;
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
  | { kind: '@shell-start'; command: string }
  | { kind: '@shell-result'; output: string; exitCode: number }
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
    subAgentRunIds: new Set(),
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
      const agent = ensureAgent(next, ORCHESTRATOR_AGENT_ID);
      agent.children.push({ kind: 'text', text: action.text, speaker: 'user' });
      return next;
    }

    case '@shell-start': {
      // Shell-escape command — appended to the root agent so it sits inline in
      // the transcript, separate from model turns (cli §6.2).
      const agent = ensureAgent(next, ORCHESTRATOR_AGENT_ID);
      agent.children.push({ kind: 'shell', command: action.command, running: true });
      return next;
    }

    case '@shell-result': {
      const orch = next.agents.get(ORCHESTRATOR_AGENT_ID);
      // Fill the most recent still-running shell item.
      for (let i = (orch?.children.length ?? 0) - 1; i >= 0; i--) {
        const c = orch!.children[i];
        if (c && c.kind === 'shell' && c.running) {
          c.output = action.output;
          c.exitCode = action.exitCode;
          c.running = false;
          break;
        }
      }
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
      // A delegate tool whose sub-agent started before this `tool-call` landed
      // parented its node to the orchestrator (flat). Pull any such sub-agent —
      // and its whole streamed log — back under this tool so it renders in the
      // contained viewport instead of flooding the transcript (§3.1).
      if (action.toolName === 'delegateToSubAgent') rehomeSubAgentsForTool(next, tool);
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
      // Nest the sub-agent under the `delegateToSubAgent` tool call that spawned
      // it (so its live trace shows inside that tool's expansion); fall back to
      // the parent agent when the spawning tool id is unknown — e.g. the delegate
      // `tool-call` hasn't been processed yet (parallel delegation races the
      // orchestrator's stream against the sub's). Recording `spawnedByToolCallId`
      // lets that later `tool-call` re-home this node under the tool (§3.1).
      const tool = action.toolCallId ? next.tools.get(action.toolCallId) : undefined;
      if (tool && !tool.children) tool.children = [];
      const node = ensureAgent(next, action.agentId, action.role, action.parentAgentId, tool);
      if (action.toolCallId) node.spawnedByToolCallId = action.toolCallId;
      // Remember this sub-agent's run so its eventual run-finish (if the runtime
      // surfaces one) doesn't end the whole turn — only the root run does.
      next.subAgentRunIds.add(action.runId);
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
      // Only the root orchestrator run ends the turn. Sub-agents announce their
      // run id via `sub-agent-start`; a run-finish for one of those is a sub
      // completing (it already emitted `sub-agent-finish`) and must NOT flip the
      // whole trace to finished or stop the spinner while the orchestrator runs.
      // The contract has sub-agents emit only `sub-agent-finish`, so this is a
      // guard against a host/runtime that also surfaces a sub run-finish (§3.1).
      if (next.subAgentRunIds.has(action.runId)) return next;
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
  /** When set (a delegate ToolItem), the new agent nests under it instead of the
   *  parent agent — so the sub-agent's trace lives inside the tool call (§3.1). */
  attachTo?: { children?: TraceItem[] },
): AgentItem {
  const existing = state.agents.get(agentId);
  if (existing) {
    if (role) existing.role = role;
    // The node already exists (its content events arrived before this
    // `sub-agent-start`, parenting it to the orchestrator). Re-home it — and its
    // streamed children — under the spawning delegate tool so the log stays
    // contained rather than flat in the main transcript (§3.1).
    if (attachTo && !attachTo.children?.includes(existing)) {
      detachItem(state, existing);
      (attachTo.children ??= []).push(existing);
      if (parentAgentId) existing.parentAgentId = parentAgentId;
    }
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
  if (attachTo) {
    (attachTo.children ??= []).push(node);
  } else if (parentAgentId) {
    const parent = state.agents.get(parentAgentId);
    if (parent) parent.children.push(node);
    else state.rootAgentId ??= agentId; // parent unknown yet → treat as root-ish
  } else {
    state.rootAgentId ??= agentId;
  }
  return node;
}

/** Remove a node from whichever agent- or tool-children array currently holds
 *  it, so it can be re-homed elsewhere (sub-agent re-parenting, §3.1). The node
 *  stays in `state.agents`/`state.tools` — only its tree position changes. */
function detachItem(state: TraceState, node: TraceItem): void {
  for (const agent of state.agents.values()) {
    const i = agent.children.indexOf(node);
    if (i >= 0) {
      agent.children.splice(i, 1);
      return;
    }
  }
  for (const tool of state.tools.values()) {
    const i = tool.children?.indexOf(node) ?? -1;
    if (i >= 0) {
      tool.children!.splice(i, 1);
      return;
    }
  }
}

/** Pull every sub-agent that names `tool` as its spawner under that tool's
 *  children (idempotent). Handles `sub-agent-start` arriving before the delegate
 *  `tool-call`, which would otherwise leave the sub-agent's log flat (§3.1). */
function rehomeSubAgentsForTool(state: TraceState, tool: ToolItem): void {
  for (const agent of state.agents.values()) {
    if (agent.spawnedByToolCallId === tool.toolCallId && !tool.children?.includes(agent)) {
      detachItem(state, agent);
      (tool.children ??= []).push(agent);
    }
  }
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

/** Options for flattening (§3.1). */
export interface FlattenOptions {
  /**
   * Whether a `delegateToSubAgent` tool call's nested sub-agent trace is
   * included. The TUI passes the tool's expand state so the sub-agent log shows
   * only inside the expanded tool call; omitted → always include (headless/full).
   */
  isToolExpanded?: (toolCallId: string) => boolean;
  /**
   * TUI only: keep a delegate tool's sub-agent trace ON the ToolItem instead of
   * flattening it into top-level rows. The screen then renders that log inside a
   * fixed-height, bordered viewport (`flattenSubAgentLog`) so a busy sub-agent
   * scrolls within its own box rather than flooding the main transcript (§3.1).
   * Headless omits this and flattens the log inline.
   */
  containSubAgent?: boolean;
}

/** Depth-first flatten from the root agent, honouring child order (§3.1). */
export function flattenTrace(state: TraceState, opts?: FlattenOptions): TraceRow[] {
  const rows: TraceRow[] = [];
  const root = state.rootAgentId ? state.agents.get(state.rootAgentId) : undefined;
  if (root) walk(root, 0, rows, 'r', opts);
  return rows;
}

function walk(item: TraceItem, depth: number, out: TraceRow[], key: string, opts?: FlattenOptions): void {
  out.push({ item, depth, key });
  if (item.kind === 'agent') {
    item.children.forEach((c, i) => {
      // Under containment, a sub-agent still mis-parented here (its delegate
      // `tool-call` hasn't landed to re-home it yet) belongs in that tool's
      // viewport, never flat in the transcript — skip it; it shows once its tool
      // arrives. `flattenSubAgentLog` enters AT the sub-agent, so its own row is
      // kept; only this descendant path (from the orchestrator) hides it (§3.1).
      if (opts?.containSubAgent && c.kind === 'agent' && c.spawnedByToolCallId) return;
      walk(c, depth + 1, out, `${key}.${i}`, opts);
    });
  } else if (item.kind === 'tool' && item.children?.length) {
    // A delegate tool's sub-agent trace. The TUI contains it in a fixed-height
    // viewport (`containSubAgent`): leave the children on the tool so the screen
    // renders them in their own scrolling box, not as top-level rows. Otherwise
    // (headless/full) it flattens inline, gated by the tool's expand state when
    // a gate is provided.
    if (opts?.containSubAgent) return;
    if (!opts?.isToolExpanded || opts.isToolExpanded(item.toolCallId)) {
      item.children.forEach((c, i) => walk(c, depth + 1, out, `${key}.${i}`, opts));
    }
  }
}

/**
 * Flatten just a delegate tool's nested sub-agent trace (its `children`) into
 * rows, for the TUI's contained, fixed-height sub-agent viewport (§3.1). Walk
 * starts at depth 1 so the sub-agent's own header sits flush in the box; nested
 * sub-agents stay contained (`containSubAgent`), getting their own inner box
 * rather than being flattened here.
 */
export function flattenSubAgentLog(tool: ToolItem): TraceRow[] {
  const out: TraceRow[] = [];
  (tool.children ?? []).forEach((c, i) => walk(c, 1, out, `${tool.toolCallId}:${i}`, { containSubAgent: true }));
  return out;
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

  // Use the live orchestrator agentId (ORCHESTRATOR_AGENT_ID) so events from a
  // subsequent send append to this same root node rather than spawning a second tree.
  const root: AgentItem = { kind: 'agent', agentId: ORCHESTRATOR_AGENT_ID, role: 'orchestrator', children: [], status: 'done' };
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
