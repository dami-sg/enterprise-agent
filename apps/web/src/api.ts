/** Typed wrappers over the gateway's account-scoped Web API (web-app §4.2). */

export interface SessionSummary {
  sessionId: string;
  threadId?: string;
  name: string;
}

/** A reloaded history part — same vocabulary as the live SSE stream so a
 *  reopened session renders identically (ordered text · reasoning · tool chips). */
export type HistoryPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'data-tool'; data: { id?: string; name?: string } };

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Structured, ordered parts; falls back to `text` when absent (older server). */
  parts?: HistoryPart[];
  ts: number;
}

/** Thrown on 401 so the UI can show the dev-login / (future) OAuth screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export interface Me {
  accountId: string;
  displayName?: string;
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`GET /api/auth/me → ${res.status}`);
  return (await res.json()) as Me;
}

export interface AuthConfig {
  /** Bot Client ID for the modern Telegram OIDC login (from BotFather). */
  telegramClientId: string | null;
  /** Bot username for the legacy Login Widget. */
  telegramBot: string | null;
  googleMock: boolean;
}

export async function telegramLogin(idToken: string): Promise<void> {
  const res = await fetch('/api/auth/telegram', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: idToken }),
  });
  if (!res.ok) throw new Error(`telegram login → ${res.status}`);
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config', { credentials: 'include' });
  if (!res.ok) throw new Error(`GET /api/auth/config → ${res.status}`);
  return (await res.json()) as AuthConfig;
}

export async function googleMockLogin(email: string): Promise<void> {
  const res = await fetch('/api/auth/google/mock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`google mock login → ${res.status}`);
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
}

export interface ModelOption {
  alias: string;
  ref: string;
}

export async function fetchModels(): Promise<ModelOption[]> {
  const res = await fetch('/api/models', { credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`GET /api/models → ${res.status}`);
  return ((await res.json()) as { models: ModelOption[] }).models;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/sessions', { credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`GET /api/sessions → ${res.status}`);
  return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function fetchHistory(sessionId: string): Promise<HistoryMessage[]> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/history`, { credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`GET history → ${res.status}`);
  return ((await res.json()) as { messages: HistoryMessage[] }).messages;
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/rename`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`rename → ${res.status}`);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`delete → ${res.status}`);
}

// ---- Execution mode (agent §3.8): who adjudicates a high-risk tool call ----

export type ExecutionMode = 'ask' | 'plan' | 'auto' | 'full';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['ask', 'plan', 'auto', 'full'];

export async function fetchSessionMode(sessionId: string): Promise<ExecutionMode> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/mode`, { credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`GET mode → ${res.status}`);
  return ((await res.json()) as { mode: ExecutionMode }).mode;
}

export async function setSessionMode(sessionId: string, mode: ExecutionMode): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/mode`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`set mode → ${res.status}`);
}

// ---- Interactive suspensions (web-app §4.2): approval / askUserQuestion / plan ----

/** Three-state tool approval (agent §3.3). */
export type ApprovalDecision = 'once' | 'session' | 'reject';

export interface UserQuestionOption {
  label: string;
  description?: string;
}
export interface UserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: UserQuestionOption[];
}
/** Aligned to the emitted `questions`; `selected` holds the chosen option labels. */
export interface UserQuestionAnswer {
  selected: string[];
}

/** Streamed `data-approval` payload. */
export interface ApprovalData {
  toolCallId: string;
  toolName: string;
  grantScope?: string;
  detail?: string;
}
/** Streamed `data-question` payload. */
export interface QuestionData {
  questionId: string;
  questions: UserQuestion[];
}
/** Streamed `data-plan` payload. */
export interface PlanData {
  planId: string;
  plan: string;
  allowedActions?: Array<{ description?: string } | string>;
}

/** Streamed `data-subagent` payload — one delegated sub-agent's live progress. */
export interface SubAgentData {
  agentId: string;
  role: string;
  status: 'running' | 'done';
  /** Tool names the sub-agent has called (its execution process). */
  activity: string[];
  /** Final summary text, once finished. */
  summary?: string;
}

/** A single agent task (agent §2.3). */
export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
/** Streamed `data-todos` payload — the live task list, reconciled in place. */
export interface TodosData {
  todos: Todo[];
}

/** Deliver a decision for a pending suspension. `?demo` short-circuits (no backend). */
async function respond(body: Record<string, unknown>): Promise<void> {
  if (location.search.includes('demo')) return; // preview mode: resolve optimistically
  const res = await fetch('/api/respond', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`respond → ${res.status}`);
}

export function respondApproval(id: string, decision: ApprovalDecision): Promise<void> {
  return respond({ kind: 'approval', id, decision });
}
export function respondQuestion(id: string, answers: UserQuestionAnswer[] | null): Promise<void> {
  return respond({ kind: 'question', id, answers });
}
export function respondPlan(id: string, approve: boolean): Promise<void> {
  return respond({ kind: 'plan', id, approve });
}
