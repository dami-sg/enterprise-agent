import { describe, it, expect } from 'vitest';
import {
  isLocalBase,
  providerKeyRef,
  PROTOCOL_VERSION,
  EXECUTION_MODE,
  SUB_AGENT_CAPABILITIES,
  APPROVAL,
  ORCHESTRATOR_AGENT_ID,
} from '../src/index.js';

describe('providerKeyRef', () => {
  it('derives the `${id}.key` keychain ref', () => {
    expect(providerKeyRef('openai')).toBe('openai.key');
    expect(providerKeyRef('my-gateway')).toBe('my-gateway.key');
  });
});

describe('isLocalBase', () => {
  it('treats loopback hosts as local (no key needed)', () => {
    expect(isLocalBase('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBase('http://127.0.0.1:1234')).toBe(true);
    expect(isLocalBase('http://[::1]:8080')).toBe(true);
    // 0.0.0.0 is included as a *connect* target — the drift the catalog copy
    // had and the host copies lacked; unified here.
    expect(isLocalBase('http://0.0.0.0:5000')).toBe(true);
  });

  it('is case-insensitive on the host and ignores path/port', () => {
    expect(isLocalBase('HTTP://LOCALHOST/v1')).toBe(true);
    expect(isLocalBase('https://127.0.0.1')).toBe(true);
  });

  it('treats remote hosts as non-local (key required)', () => {
    expect(isLocalBase('https://api.openai.com/v1')).toBe(false);
    expect(isLocalBase('https://generativelanguage.googleapis.com')).toBe(false);
  });

  it('is not fooled by look-alike subdomains', () => {
    expect(isLocalBase('http://localhost.evil.com/v1')).toBe(false);
    expect(isLocalBase('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('returns false for malformed input and undefined', () => {
    expect(isLocalBase('not a url')).toBe(false);
    expect(isLocalBase('')).toBe(false);
    expect(isLocalBase(undefined)).toBe(false);
  });
});

// Golden anchors: these values are wire/protocol contracts consumed across
// packages. A change here should be deliberate — the test exists to make an
// accidental edit fail loudly rather than silently break every consumer.
describe('protocol/domain constant anchors', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('pins the execution modes', () => {
    expect(EXECUTION_MODE).toEqual({ ASK: 'ask', PLAN: 'plan', AUTO: 'auto', FULL: 'full' });
  });

  it('pins the sub-agent capability set', () => {
    expect([...SUB_AGENT_CAPABILITIES].sort()).toEqual(['exec', 'http', 'read', 'write']);
  });

  it('exposes the orchestrator agent id', () => {
    expect(ORCHESTRATOR_AGENT_ID).toBe('orch');
  });

  it('exposes the approval constant surface', () => {
    expect(APPROVAL).toBeTypeOf('object');
    expect(APPROVAL).not.toBeNull();
  });
});
