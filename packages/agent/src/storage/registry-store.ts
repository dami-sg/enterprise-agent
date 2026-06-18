/**
 * Entity registry (agent §5.2): Workspaces / Works / Chats persisted as JSON
 * under `~/.enterprise-agent/`. Read side is a quick snapshot; the session log is the
 * source of truth for messages.
 */
import type {
  Chat,
  ScopedConfig,
  UsageTotals,
  Work,
  Workspace,
} from '@enterprise-agent/agent-contract';
import type { Paths } from '../config/paths.js';
import { ensureDir, listDirs, readJson, writeJson } from '../util/fs.js';
import { newId } from './session-store.js';

export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cost: 0,
};

export class RegistryStore {
  constructor(private readonly paths: Paths) {}

  // -- workspaces --

  listWorkspaces(): Workspace[] {
    return listDirs(this.paths.workspaces)
      .map((id) => readJson<Workspace>(this.paths.workspaceJson(id)))
      .filter((w): w is Workspace => Boolean(w));
  }

  getWorkspace(id: string): Workspace | undefined {
    return readJson<Workspace>(this.paths.workspaceJson(id));
  }

  createWorkspace(input: { name: string; rootPath: string; config?: ScopedConfig }): Workspace {
    const ws: Workspace = {
      id: newId('ws'),
      name: input.name,
      rootPath: input.rootPath,
      isActive: this.listWorkspaces().length === 0,
      config: input.config ?? {},
    };
    ensureDir(this.paths.workspaceDir(ws.id));
    writeJson(this.paths.workspaceJson(ws.id), ws);
    return ws;
  }

  saveWorkspace(ws: Workspace): void {
    writeJson(this.paths.workspaceJson(ws.id), ws);
  }

  /** Make exactly one workspace active (agent §1.1). */
  setActiveWorkspace(id: string): void {
    for (const ws of this.listWorkspaces()) {
      const isActive = ws.id === id;
      if (ws.isActive !== isActive) this.saveWorkspace({ ...ws, isActive });
    }
  }

  /** Ensure a Default workspace exists for zero-config use (agent §1.1). */
  ensureDefaultWorkspace(rootPath: string): Workspace {
    const existing = this.listWorkspaces();
    if (existing.length > 0) return existing.find((w) => w.isActive) ?? existing[0]!;
    return this.createWorkspace({ name: 'Default', rootPath });
  }

  // -- works --

  listWorks(workspaceId: string): Work[] {
    return listDirs(`${this.paths.workspaceDir(workspaceId)}/works`)
      .map((id) => readJson<Work>(this.paths.workJson(workspaceId, id)))
      .filter((w): w is Work => Boolean(w));
  }

  getWork(workspaceId: string, workId: string): Work | undefined {
    return readJson<Work>(this.paths.workJson(workspaceId, workId));
  }

  createWork(input: { workspaceId: string; title: string; goal: string }): Work {
    const work: Work = {
      id: newId('wk'),
      workspaceId: input.workspaceId,
      title: input.title,
      goal: input.goal,
      status: 'active',
      todos: [],
      usage: { ...ZERO_USAGE },
    };
    ensureDir(this.paths.workDir(input.workspaceId, work.id));
    writeJson(this.paths.workJson(input.workspaceId, work.id), work);
    return work;
  }

  saveWork(work: Work): void {
    writeJson(this.paths.workJson(work.workspaceId, work.id), work);
  }

  // -- chats --

  listChats(): Chat[] {
    return listDirs(this.paths.chats)
      .map((id) => readJson<Chat>(this.paths.chatJson(id)))
      .filter((c): c is Chat => Boolean(c));
  }

  getChat(id: string): Chat | undefined {
    return readJson<Chat>(this.paths.chatJson(id));
  }

  createChat(input: { name: string; config?: ScopedConfig }): Chat {
    const chat: Chat = {
      id: newId('ch'),
      name: input.name,
      config: input.config ?? {},
      status: 'active',
      todos: [],
      usage: { ...ZERO_USAGE },
    };
    ensureDir(this.paths.chatScratch(chat.id));
    writeJson(this.paths.chatJson(chat.id), chat);
    return chat;
  }

  saveChat(chat: Chat): void {
    writeJson(this.paths.chatJson(chat.id), chat);
  }
}
