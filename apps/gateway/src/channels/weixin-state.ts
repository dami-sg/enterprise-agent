/**
 * iLink adapter state persistence (gateway §8.5). Two files per account:
 *   - `<id>.json`: the `get_updates_buf` cursor (+ account ids). On restart the
 *     cursor MUST be resumed or history is replayed (§8.5).
 *   - `<id>.context-tokens.json`: the latest `context_token` per conversation,
 *     refilled on reply so messages land in the right window across restarts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GatewayPaths } from '../config/paths.js';

export interface AccountState {
  accountId: string;
  getUpdatesBuf: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export class WeixinStateStore {
  private readonly stateFile: string;
  private readonly tokensFile: string;
  private state: AccountState;
  private tokens: Record<string, string>;

  constructor(paths: GatewayPaths, accountId: string) {
    this.stateFile = paths.accountState('weixin', accountId);
    this.tokensFile = paths.contextTokens('weixin', accountId);
    this.state = readJson<AccountState>(this.stateFile, { accountId, getUpdatesBuf: '' });
    this.tokens = readJson<Record<string, string>>(this.tokensFile, {});
  }

  getCursor(): string {
    return this.state.getUpdatesBuf;
  }

  setCursor(buf: string): void {
    if (buf === this.state.getUpdatesBuf) return;
    this.state.getUpdatesBuf = buf;
    writeJson(this.stateFile, this.state);
  }

  setAccountIds(ilinkBotId?: string, ilinkUserId?: string): void {
    this.state.ilinkBotId = ilinkBotId ?? this.state.ilinkBotId;
    this.state.ilinkUserId = ilinkUserId ?? this.state.ilinkUserId;
    writeJson(this.stateFile, this.state);
  }

  getContextToken(conversationId: string): string | undefined {
    return this.tokens[conversationId];
  }

  setContextToken(conversationId: string, token: string): void {
    if (this.tokens[conversationId] === token) return;
    this.tokens[conversationId] = token;
    writeJson(this.tokensFile, this.tokens);
  }
}
