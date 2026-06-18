/**
 * Command contract (agent §6.1): host → module, request style.
 * Transport-agnostic — desktop carries it over Electron IPC, a CLI over stdio.
 */
import type {
  Chat,
  ScopedConfig,
  SessionRef,
  Workspace,
  Work,
  Todo,
} from './domain.js';
import type { AgentStreamEvent } from './events.js';
import type { Entry } from './storage.js';

/** Three-state approval decision (agent §3.3). */
export const APPROVAL = {
  ONCE: 'once',
  TASK: 'task',
  REJECT: 'reject',
} as const;

export type ApprovalDecision = (typeof APPROVAL)[keyof typeof APPROVAL];

export interface SessionTreeNode {
  entry: Entry;
  children: SessionTreeNode[];
}

export interface SessionTree {
  rootId?: string;
  headId?: string;
  nodes: Record<string, Entry>;
  labels: Record<string, string>;
  root?: SessionTreeNode;
}

export interface CreateWorkspaceInput {
  name: string;
  rootPath: string;
  config?: ScopedConfig;
}

export interface CreateChatInput {
  name: string;
  config?: ScopedConfig;
}

export interface StartWorkInput {
  workspaceId: string;
  title: string;
  goal: string;
  config?: ScopedConfig;
}

/**
 * The agent core's outward command surface. A host obtains an instance via
 * the package entry point and drives sessions through it.
 */
export interface AgentHost {
  // -- container management (agent §6.1) --
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  switchWorkspace(workspaceId: string): Promise<void>;
  updateWorkspaceConfig(
    workspaceId: string,
    config: ScopedConfig,
  ): Promise<Workspace>;

  listChats(): Promise<Chat[]>;
  createChat(input: CreateChatInput): Promise<Chat>;
  updateChatConfig(chatId: string, config: ScopedConfig): Promise<Chat>;

  // -- works --
  listWorks(workspaceId: string): Promise<Work[]>;
  createWork(input: { workspaceId: string; title: string; goal: string }): Promise<Work>;

  // -- session driving --
  startWork(input: StartWorkInput): Promise<{ workId: string; runId: string }>;
  sendMessage(session: SessionRef, text: string): Promise<{ runId: string }>;
  approveTool(toolCallId: string, decision: ApprovalDecision): void;
  abortRun(runId: string): void;

  // -- session tree ops (agent §6.1) --
  forkFrom(session: SessionRef, entryId: string): Promise<void>;
  labelEntry(session: SessionRef, entryId: string, label: string): Promise<void>;
  compact(session: SessionRef, reason?: 'manual'): Promise<void>;
  getSessionTree(session: SessionRef): Promise<SessionTree>;
  cloneToWork(session: SessionRef, leafId: string): Promise<{ workId: string }>;
  getTodos(session: SessionRef): Promise<Todo[]>;

  /** Structured output (agent §2.4): run the session to produce typed data. */
  report(session: SessionRef, prompt: string): Promise<unknown>;

  // -- event subscription (agent §6.2) --
  onEvent(listener: (event: AgentStreamEvent) => void): () => void;

  dispose(): Promise<void>;
}
