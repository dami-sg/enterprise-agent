import { describe, it, expect, afterEach } from 'vitest';
import { childBaseEnv } from '../src/mcp/client.js';

// childBaseEnv builds the base environment handed to a spawned stdio MCP server.
// A stdio server is third-party code, so the standing invariant is: it sees ONLY
// an allowlist of launch/runtime vars — never the host's credentials. These
// tests lock that isolation in place.

const INJECTED = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'GH_TOKEN',
  'ENTERPRISE_AGENT_KEY_OPENAI',
  'MY_APP_SECRET',
];

afterEach(() => {
  for (const k of INJECTED) delete process.env[k];
  delete process.env.LC_TESTALL;
});

describe('childBaseEnv — MCP subprocess env isolation (agent §4)', () => {
  it('strips every host credential from the child env', () => {
    for (const k of INJECTED) process.env[k] = 'super-secret-value';
    const env = childBaseEnv();
    for (const k of INJECTED) expect(env[k]).toBeUndefined();
    // and none of the secret values leak under any key
    expect(Object.values(env)).not.toContain('super-secret-value');
  });

  it('passes through allowlisted launch/runtime vars', () => {
    const env = childBaseEnv();
    // PATH/HOME are effectively always present in a POSIX CI runner; assert PATH
    // survives when the host has it.
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
  });

  it('passes through locale LC_* vars (allowlisted by prefix)', () => {
    process.env.LC_TESTALL = 'en_US.UTF-8';
    const env = childBaseEnv();
    expect(env.LC_TESTALL).toBe('en_US.UTF-8');
  });
});
