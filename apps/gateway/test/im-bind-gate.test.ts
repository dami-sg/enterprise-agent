/**
 * IM in-band `/bind` access gate (gateway-consolidation §P3b). In `managed` mode
 * an unbound private-chat user must present an access key via `/bind <key>` before
 * any message reaches the agent; `open` mode keeps the current no-gate behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { Router } from '../src/runtime/router.js';
import type { AuthMode } from '../src/accounts/auth-mode.js';
import { FakeAdapter, FakeHost, inbound } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-bind-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function setupGate(opts: {
  mode: AuthMode;
  bound?: Record<string, string>; // `${provider}:${userId}` → accountId
  keys?: Record<string, string>; // rawKey → accountId
  bindThrows?: string;
}) {
  const host = new FakeHost();
  const router = new Router(join(dir, 'routes.json'));
  const tg = new FakeAdapter();
  const bindings = new Map(Object.entries(opts.bound ?? {}));
  const dispatcher = new Dispatcher({
    host: host.asHost(),
    router,
    now: () => 1_000_000,
    authMode: opts.mode,
    resolveAccount: (p, u) => bindings.get(`${p}:${u}`),
    resolveKey: (k) => (opts.keys ?? {})[k],
    bindIdentity: (p, u, acct) => {
      if (opts.bindThrows) throw new Error(opts.bindThrows);
      bindings.set(`${p}:${u}`, acct);
    },
  });
  dispatcher.registerChannel(tg, { name: tg.name });
  return { host, dispatcher, tg, bindings };
}

describe('IM /bind gate — managed mode', () => {
  it('prompts an unbound user to bind and does not reach the agent', async () => {
    const { host, dispatcher, tg } = setupGate({ mode: 'managed' });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '你好' }));
    expect(host.calls.startSession).toHaveLength(0);
    expect(tg.lastText()).toContain('/bind');
  });

  it('binds on a valid /bind <key> and persists the identity→account mapping', async () => {
    const { host, dispatcher, tg, bindings } = setupGate({
      mode: 'managed',
      keys: { GOODKEY: 'acct_1' },
    });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/bind GOODKEY' }));
    expect(bindings.get('telegram:u1')).toBe('acct_1');
    expect(tg.lastText()).toContain('绑定成功');
    expect(host.calls.startSession).toHaveLength(0); // the /bind message never reaches the agent
  });

  it('rejects an invalid /bind key without binding', async () => {
    const { dispatcher, tg, bindings } = setupGate({ mode: 'managed', keys: { GOODKEY: 'acct_1' } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/bind WRONG' }));
    expect(bindings.has('telegram:u1')).toBe(false);
    expect(tg.lastText()).toContain('无效');
  });

  it('lets a bound user talk to the agent normally', async () => {
    const { host, dispatcher } = setupGate({ mode: 'managed', bound: { 'telegram:u1': 'acct_1' } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'run this' }));
    expect(host.calls.startSession).toHaveLength(1);
  });

  it('tells an already-bound user that /bind is unnecessary and does not re-reach the agent', async () => {
    const { host, dispatcher, tg } = setupGate({ mode: 'managed', bound: { 'telegram:u1': 'acct_1' } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/bind ANY' }));
    expect(tg.lastText()).toContain('已完成绑定');
    expect(host.calls.startSession).toHaveLength(0);
  });

  it('surfaces a bind failure (identity already bound elsewhere)', async () => {
    const { dispatcher, tg } = setupGate({
      mode: 'managed',
      keys: { GOODKEY: 'acct_2' },
      bindThrows: 'identity telegram:u1 already bound to acct_1',
    });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/bind GOODKEY' }));
    expect(tg.lastText()).toContain('绑定失败');
  });

  it('does not gate group chats (DM-only scope)', async () => {
    const { host, dispatcher } = setupGate({ mode: 'managed' });
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'g1', text: 'hi', isPrivate: false }),
    );
    expect(host.calls.startSession).toHaveLength(1); // gate skipped → normal flow
  });
});

describe('IM /bind gate — open mode', () => {
  it('does not gate: an unbound user reaches the agent', async () => {
    const { host, dispatcher } = setupGate({ mode: 'open' });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hello' }));
    expect(host.calls.startSession).toHaveLength(1);
  });
});
