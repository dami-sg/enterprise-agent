/**
 * Filesystem layout under the App data root `~/.enterprise-agent/` (agent §5.1 / §5.2).
 * All paths are derived from a single configurable root so tests can redirect it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  root: string;
  settings: string;
  providers: string;
  aliases: string;
  skills: string;
  mcp: string;
  workspaces: string;
  chats: string;
  workspaceDir(workspaceId: string): string;
  workspaceJson(workspaceId: string): string;
  workspaceAliases(workspaceId: string): string;
  workspaceMcp(workspaceId: string): string;
  workspaceSkills(workspaceId: string): string;
  workDir(workspaceId: string, workId: string): string;
  workJson(workspaceId: string, workId: string): string;
  workSession(workspaceId: string, workId: string): string;
  workRuns(workspaceId: string, workId: string): string;
  workAudit(workspaceId: string, workId: string): string;
  chatDir(chatId: string): string;
  chatJson(chatId: string): string;
  chatSession(chatId: string): string;
  chatRuns(chatId: string): string;
  chatAudit(chatId: string): string;
  chatScratch(chatId: string): string;
}

export function createPaths(root?: string): Paths {
  const base = root ?? process.env.ENTERPRISE_AGENT_HOME ?? join(homedir(), '.enterprise-agent');
  const workspaces = join(base, 'workspaces');
  const chats = join(base, 'chats');
  return {
    root: base,
    settings: join(base, 'settings.json'),
    providers: join(base, 'providers.json'),
    aliases: join(base, 'aliases.json'),
    skills: join(base, 'skills'),
    mcp: join(base, 'mcp'),
    workspaces,
    chats,
    workspaceDir: (w) => join(workspaces, w),
    workspaceJson: (w) => join(workspaces, w, 'workspace.json'),
    workspaceAliases: (w) => join(workspaces, w, 'aliases.json'),
    workspaceMcp: (w) => join(workspaces, w, 'mcp'),
    workspaceSkills: (w) => join(workspaces, w, 'skills'),
    workDir: (w, k) => join(workspaces, w, 'works', k),
    workJson: (w, k) => join(workspaces, w, 'works', k, 'work.json'),
    workSession: (w, k) => join(workspaces, w, 'works', k, 'session.jsonl'),
    workRuns: (w, k) => join(workspaces, w, 'works', k, 'runs.jsonl'),
    workAudit: (w, k) => join(workspaces, w, 'works', k, 'audit.jsonl'),
    chatDir: (c) => join(chats, c),
    chatJson: (c) => join(chats, c, 'chat.json'),
    chatSession: (c) => join(chats, c, 'session.jsonl'),
    chatRuns: (c) => join(chats, c, 'runs.jsonl'),
    chatAudit: (c) => join(chats, c, 'audit.jsonl'),
    chatScratch: (c) => join(chats, c, 'scratch'),
  };
}
