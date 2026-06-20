/**
 * Session registry (agent §5.2): Sessions persisted as JSON under
 * `~/.enterprise-agent/sessions/<id>/session.json`. Read side is a quick
 * snapshot; the session log is the source of truth for messages. A session
 * optionally binds a `workingDir`; when unset it uses its private scratch dir
 * as the default working directory (agent §1.1).
 */
import type { ScopedConfig, Session, UsageTotals } from '@enterprise-agent/agent-contract';
import type { Paths } from '../config/paths.js';
import { ensureDir, listDirs, readJson, writeJson } from '../util/fs.js';
import { rmSync } from 'node:fs';
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

  listSessions(): Session[] {
    return listDirs(this.paths.sessions)
      .map((id) => readJson<Session>(this.paths.sessionJson(id)))
      .filter((s): s is Session => Boolean(s));
  }

  getSession(id: string): Session | undefined {
    return readJson<Session>(this.paths.sessionJson(id));
  }

  createSession(input: { name: string; workingDir?: string; config?: ScopedConfig }): Session {
    const session: Session = {
      id: newId('se'),
      name: input.name,
      workingDir: input.workingDir,
      config: input.config ?? {},
      isActive: this.listSessions().length === 0,
      status: 'active',
      todos: [],
      usage: { ...ZERO_USAGE },
    };
    ensureDir(this.paths.sessionDir(session.id));
    // No working directory → seed the default working directory (private scratch).
    if (!session.workingDir) ensureDir(this.paths.sessionScratch(session.id));
    writeJson(this.paths.sessionJson(session.id), session);
    return session;
  }

  saveSession(session: Session): void {
    writeJson(this.paths.sessionJson(session.id), session);
  }

  deleteSession(id: string): void {
    rmSync(this.paths.sessionDir(id), { recursive: true, force: true });
  }

  /** Make exactly one session active (agent §1.1). */
  setActiveSession(id: string): void {
    for (const s of this.listSessions()) {
      const isActive = s.id === id;
      if (s.isActive !== isActive) this.saveSession({ ...s, isActive });
    }
  }
}
