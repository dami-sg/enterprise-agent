import type {
  ApprovalDecision,
  CreateSessionInput,
  ExecutionMode,
  PlanDecision,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';
import {
  APP_SERVER_ERROR,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type SessionHistoryParams,
  type SubscriptionScope,
  type TurnInputPart,
  type TurnStartResult,
} from '@enterprise-agent/agent-server';

export interface AgentClientTransport {
  send(raw: string): void | Promise<void>;
  close?(): void | Promise<void>;
  onMessage(listener: (raw: string) => void): () => void;
}

export interface AgentClientOptions {
  transport: AgentClientTransport;
}

export interface AgentClientNotification {
  method: string;
  params?: unknown;
}

export class AgentClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

type NotificationListener = (notification: AgentClientNotification) => void;

export class AgentClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly unsubscribeTransport: () => void;

  constructor(private readonly opts: AgentClientOptions) {
    this.unsubscribeTransport = opts.transport.onMessage((raw) => this.handle(raw));
  }

  close(): void | Promise<void> {
    this.unsubscribeTransport();
    for (const [id, pending] of this.pending) {
      pending.reject(new AgentClientError(APP_SERVER_ERROR.CONFLICT, `connection closed before response ${String(id)}`));
      this.pending.delete(id);
    }
    return this.opts.transport.close?.();
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request<InitializeResult>('initialize', params);
  }

  listSessions(): Promise<{ sessions: unknown[] }> {
    return this.request('session/list', {});
  }

  createSession(input: CreateSessionInput): Promise<{ session: unknown }> {
    return this.request('session/create', input);
  }

  history(sessionId: string): Promise<{ tree: unknown }> {
    const params: SessionHistoryParams = { sessionId };
    return this.request('session/history', params);
  }

  renameSession(sessionId: string, name: string): Promise<{ session: unknown }> {
    return this.request('session/rename', { sessionId, name });
  }

  deleteSession(sessionId: string): Promise<Record<string, never>> {
    return this.request('session/delete', { sessionId });
  }

  compactSession(sessionId: string): Promise<Record<string, never>> {
    return this.request('session/compact', { sessionId });
  }

  todos(sessionId: string): Promise<{ todos: unknown[] }> {
    return this.request('session/todos', { sessionId });
  }

  startTurn(sessionId: string, input: TurnInputPart[], opts: { model?: string } = {}): Promise<TurnStartResult> {
    return this.request('turn/start', { sessionId, input, model: opts.model });
  }

  interruptTurn(runId: string): Promise<Record<string, never>> {
    return this.request('turn/interrupt', { runId });
  }

  respondToApproval(toolCallId: string, decision: ApprovalDecision): Promise<Record<string, never>> {
    return this.request('approval/respond', { toolCallId, decision });
  }

  respondToQuestion(questionId: string, answers: UserQuestionAnswer[] | null): Promise<Record<string, never>> {
    return this.request('question/respond', { questionId, answers });
  }

  respondToPlan(
    planId: string,
    decision: PlanDecision,
    opts: { editedPlan?: string; targetMode?: ExecutionMode } = {},
  ): Promise<Record<string, never>> {
    return this.request('plan/respond', { planId, decision, editedPlan: opts.editedPlan, targetMode: opts.targetMode });
  }

  getMode(sessionId: string): Promise<{ mode: ExecutionMode }> {
    return this.request('mode/get', { sessionId });
  }

  setMode(sessionId: string, mode: ExecutionMode): Promise<Record<string, never>> {
    return this.request('mode/set', { sessionId, mode });
  }

  listModels(): Promise<{ models: Array<{ alias: string; ref: string }> }> {
    return this.request('models/list', {});
  }

  subscribe(scope: SubscriptionScope): Promise<Record<string, never>> {
    return this.request('event/subscribe', scope);
  }

  unsubscribe(scope: SubscriptionScope): Promise<Record<string, never>> {
    return this.request('event/unsubscribe', scope);
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    void Promise.resolve(this.opts.transport.send(payload)).catch((err) => {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(err);
      }
    });
    return result;
  }

  private handle(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.emit({ method: 'client/error', params: { message: 'invalid server JSON' } });
      return;
    }
    if (!isRecord(msg)) {
      this.emit({ method: 'client/error', params: { message: 'invalid server message' } });
      return;
    }
    if (typeof msg.method === 'string') {
      this.emit(msg as unknown as JsonRpcNotification);
      return;
    }
    if (!('id' in msg)) return;
    const response = msg as unknown as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (isFailure(response)) {
      pending.reject(new AgentClientError(response.error.code, response.error.message, response.error.data));
    } else {
      pending.resolve((response as JsonRpcSuccess).result);
    }
  }

  private emit(notification: AgentClientNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
