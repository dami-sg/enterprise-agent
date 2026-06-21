/**
 * Router (gateway §4). Maps a platform identity (`channel:conversationId`) to a
 * core `sessionId`, persists the mapping in `routes.json`, and decides when a
 * chat session has gone stale and must start fresh (§4.3). It holds no agent
 * logic — session creation/driving is the host's job; the Router only owns the
 * identity↔session table and the reset clock.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResetConfig } from '../config/gateway-config.js';

export interface RouteEntry {
  sessionId: string;
  /** Epoch ms the route was created (start of this chat session). */
  createdAt: number;
  /** Epoch ms of the last inbound message (drives idle reset, §4.3). */
  lastActiveAt: number;
}

type RouteTable = Record<string, RouteEntry>;

/** The `routes.json` key for a conversation (gateway §4.1). */
export function routeKey(channel: string, conversationId: string): string {
  return `${channel}:${conversationId}`;
}

export class Router {
  private table: RouteTable;

  constructor(private readonly file: string) {
    this.table = Router.read(file);
  }

  private static read(file: string): RouteTable {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as RouteTable)
        : {};
    } catch {
      // A corrupt routes file must not crash the whole gateway: treat as empty
      // (new sessions are created on demand; old session trees remain on disk).
      return {};
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.table, null, 2) + '\n');
  }

  /** Current mapping for a conversation, if any (gateway §4.1). */
  lookup(channel: string, conversationId: string): RouteEntry | undefined {
    return this.table[routeKey(channel, conversationId)];
  }

  /** Bind a conversation to a freshly created session and persist (§4.1). */
  bind(channel: string, conversationId: string, sessionId: string, now: number): RouteEntry {
    const entry: RouteEntry = { sessionId, createdAt: now, lastActiveAt: now };
    this.table[routeKey(channel, conversationId)] = entry;
    this.flush();
    return entry;
  }

  /** Drop a conversation's mapping; the next message creates a new session (§4.3). */
  unbind(channel: string, conversationId: string): void {
    delete this.table[routeKey(channel, conversationId)];
    this.flush();
  }

  /** Stamp last-activity (idle reset clock, §4.3). */
  touch(channel: string, conversationId: string, now: number): void {
    const e = this.table[routeKey(channel, conversationId)];
    if (e) {
      e.lastActiveAt = now;
      this.flush();
    }
  }

  /** All routes, for `status` / `route ls` (gateway §7). */
  entries(): Array<{ key: string; entry: RouteEntry }> {
    return Object.entries(this.table).map(([key, entry]) => ({ key, entry }));
  }
}

/**
 * Whether an existing route should be reset before the next message (gateway
 * §4.3). Pure over `now` so it's deterministic and testable.
 *   - idle    → silent for ≥ `idleMinutes`.
 *   - daily   → a configured wall-clock boundary (default 04:00) fell between
 *               last activity and now.
 *   - command → never auto-resets (only `/new` `/reset`, §6.3).
 */
export function shouldReset(entry: RouteEntry, reset: ResetConfig | undefined, now: number): boolean {
  if (!reset) return false;
  switch (reset.mode) {
    case 'command':
      return false;
    case 'idle': {
      const minutes = reset.idleMinutes ?? 1440;
      return now - entry.lastActiveAt >= minutes * 60_000;
    }
    case 'daily': {
      const boundary = nextDailyBoundary(entry.lastActiveAt, reset.at ?? '04:00');
      return now >= boundary;
    }
  }
}

/**
 * The first daily-reset instant strictly after `from` for a local `HH:MM`. If
 * `from` is already past today's boundary, the boundary rolls to tomorrow — so a
 * message arriving after the cutoff (with the previous message before it)
 * triggers exactly one reset.
 */
function nextDailyBoundary(from: number, hhmm: string): number {
  const [h, m] = parseHHMM(hhmm);
  const d = new Date(from);
  const boundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  if (boundary.getTime() <= from) boundary.setDate(boundary.getDate() + 1);
  return boundary.getTime();
}

function parseHHMM(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return [4, 0];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return [h, min];
}
