import type {
  ApprovalDecision,
  CreateSessionInput,
  ExecutionMode,
  PlanDecision,
  ScopedConfig,
  UserPart,
  UserQuestionAnswer,
} from '@dami-sg/agent-contract';

export const APP_SERVER_PROTOCOL_VERSION = 1;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  error: AppServerError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type ServerMessage = JsonRpcResponse | JsonRpcNotification;

export const APP_SERVER_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  BAD_LIFECYCLE: -32000,
  OVERLOADED: -32001,
  UNAUTHORIZED: -32002,
  FORBIDDEN: -32003,
  NOT_FOUND: -32004,
  CONFLICT: -32005,
} as const;

export type AppServerErrorCode = (typeof APP_SERVER_ERROR)[keyof typeof APP_SERVER_ERROR];

export interface AppServerError {
  code: AppServerErrorCode;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: AppServerErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: {
    experimental?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentProtocolVersion: number;
  accountId?: string;
  serverInfo: {
    name: string;
    version: string;
  };
}

export type SubscriptionScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'account' };

export interface TurnInputTextPart {
  type: 'text';
  text: string;
}

export type TurnInputPart = TurnInputTextPart | UserPart;

export interface TurnStartParams {
  sessionId: string;
  input: TurnInputPart[];
  model?: string;
}

export interface TurnStartResult {
  runId: string;
}

/** `session/uploadFile` — persist a user upload into the session's `uploads/`
 *  dir (multimodal Route C). `base64` is the file bytes. */
export interface SessionUploadFileParams {
  sessionId: string;
  filename: string;
  base64: string;
}

export interface SessionUploadFileResult {
  /** Session-relative path (`uploads/<final-name>`). */
  path: string;
  size: number;
}

/** `session/uploadContent` — read a previously uploaded file's bytes back for
 *  preview/download, addressed by the `uploads/<name>` relative path that
 *  `session/uploadFile` returned. `offset`/`length` page through files beyond
 *  the per-call 8MB cap (same semantics as `session/artifactContent`). */
export interface SessionUploadContentParams {
  sessionId: string;
  path: string;
  offset?: number;
  length?: number;
}

export interface SessionUploadContentResult {
  base64: string;
  /** True when the returned bytes are not the whole file. */
  truncated: boolean;
  /** Full on-disk size in bytes. */
  size: number;
}

export interface SessionCreateParams extends CreateSessionInput {}

export interface SessionCreateResult {
  session: unknown;
}

export interface SessionHistoryParams {
  sessionId: string;
}

export interface SessionIdParams {
  sessionId: string;
}

export interface SessionRenameParams {
  sessionId: string;
  name: string;
}

export interface ApprovalRespondParams {
  toolCallId: string;
  decision: ApprovalDecision;
}

export interface QuestionRespondParams {
  questionId: string;
  answers: UserQuestionAnswer[] | null;
}

export interface PlanRespondParams {
  planId: string;
  decision: PlanDecision;
  editedPlan?: string;
  targetMode?: ExecutionMode;
}

export interface ModeSetParams {
  sessionId: string;
  mode: ExecutionMode;
}

export interface ModelOverrideConfig {
  config?: ScopedConfig;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { id, result };
}

export function failure(id: JsonRpcId, err: unknown): JsonRpcFailure {
  if (err instanceof RpcError) {
    return { id, error: { code: err.code, message: err.message, data: err.data } };
  }
  const message = err instanceof Error ? err.message : 'internal error';
  return { id, error: { code: APP_SERVER_ERROR.INTERNAL_ERROR, message } };
}

export function notification(method: string, params: unknown): JsonRpcNotification {
  return { method, params };
}

export function parseRequest(raw: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RpcError(APP_SERVER_ERROR.PARSE_ERROR, 'parse error');
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string' || !('id' in parsed)) {
    throw new RpcError(APP_SERVER_ERROR.INVALID_REQUEST, 'invalid request');
  }
  const id = parsed.id;
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) {
    throw new RpcError(APP_SERVER_ERROR.INVALID_REQUEST, 'invalid id');
  }
  return { id, method: parsed.method, params: parsed.params };
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, `invalid ${label}`);
  return value;
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, `invalid ${label}`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
