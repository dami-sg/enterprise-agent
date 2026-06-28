/**
 * Filesystem layout under the App data root `~/.enterprise-agent/` (agent §5.1 / §5.2).
 * All paths are derived from a single configurable root so tests can redirect it.
 *
 * v0.5: the former `workspaces/`+`works/` and `chats/` trees collapse into a
 * single `sessions/<id>/` (agent §1) — a session optionally binds a working
 * directory; when unset it uses its private `scratch/` as the default working
 * directory.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  root: string;
  settings: string;
  providers: string;
  aliases: string;
  skills: string;
  agents: string;
  /** Schedule definition dirs (`<name>/SCHEDULE.md`), durable §7. */
  schedules: string;
  /** Append-only schedule run state (last/next run), durable §7. */
  schedulesState: string;
  mcp: string;
  sessions: string;
  cache: string;
  /** Global structured error log (`logs/errors.jsonl`, observability §2). */
  errorsLog: string;
  /** Gateway / daemon operational log dir (`logs/`, observability §4). */
  logsDir: string;
  /** Usage analytics ledger dir (`usage/<YYYY-MM>.jsonl`, agent §2.7). */
  usageDir: string;
  modelCache(providerId: string): string;
  /** Shared cache of the models.dev metadata catalog (context/output/pricing). */
  modelsDevCache: string;
  sessionDir(sessionId: string): string;
  sessionJson(sessionId: string): string;
  sessionSession(sessionId: string): string;
  sessionRuns(sessionId: string): string;
  sessionAudit(sessionId: string): string;
  sessionScratch(sessionId: string): string;
  sessionSkills(sessionId: string): string;
  sessionAgents(sessionId: string): string;
  sessionMcp(sessionId: string): string;
  sessionAliases(sessionId: string): string;
}

export function createPaths(root?: string): Paths {
  const base = root ?? process.env.ENTERPRISE_AGENT_HOME ?? join(homedir(), '.enterprise-agent');
  const sessions = join(base, 'sessions');
  const dir = (id: string): string => join(sessions, id);
  return {
    root: base,
    settings: join(base, 'settings.json'),
    providers: join(base, 'providers.json'),
    aliases: join(base, 'aliases.json'),
    skills: join(base, 'skills'),
    agents: join(base, 'agents'),
    schedules: join(base, 'schedules'),
    schedulesState: join(base, 'schedules-state.jsonl'),
    mcp: join(base, 'mcp'),
    sessions,
    cache: join(base, 'cache'),
    errorsLog: join(base, 'logs', 'errors.jsonl'),
    logsDir: join(base, 'logs'),
    usageDir: join(base, 'usage'),
    modelCache: (id) => join(base, 'cache', `models-${id}.json`),
    modelsDevCache: join(base, 'cache', 'models-dev.json'),
    sessionDir: dir,
    sessionJson: (id) => join(dir(id), 'session.json'),
    sessionSession: (id) => join(dir(id), 'session.jsonl'),
    sessionRuns: (id) => join(dir(id), 'runs.jsonl'),
    sessionAudit: (id) => join(dir(id), 'audit.jsonl'),
    sessionScratch: (id) => join(dir(id), 'scratch'),
    sessionSkills: (id) => join(dir(id), 'skills'),
    sessionAgents: (id) => join(dir(id), 'agents'),
    sessionMcp: (id) => join(dir(id), 'mcp'),
    sessionAliases: (id) => join(dir(id), 'aliases.json'),
  };
}
