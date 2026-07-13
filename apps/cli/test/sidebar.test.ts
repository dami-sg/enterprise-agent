import { describe, it, expect } from 'vitest';
import type { AgentStreamEvent } from '@dami-sg/agent-contract';
import { reduceTrace, initialTrace } from '../src/core/trace.js';
import { collectSidebar } from '../src/core/sidebar.js';

const run = (...events: AgentStreamEvent[]) => events.reduce(reduceTrace, initialTrace());
const call = (toolCallId: string, toolName: string, input: unknown): AgentStreamEvent => ({
  kind: 'tool-call',
  runId: 'r1',
  agentId: 'orch',
  toolCallId,
  toolName,
  input,
});

describe('collectSidebar (cli-ui §7)', () => {
  it('groups tool calls into artifacts / files / links', () => {
    const s = run(
      call('t1', 'writeFile', { path: 'weather.py' }),
      call('t2', 'applyPatch', { path: 'README.md' }),
      call('t3', 'readFile', { path: 'src/auth.ts' }),
      call('t4', 'listDir', { path: 'src' }),
      call('t5', 'httpFetch', { url: 'https://wttr.in/beijing?format=j1' }),
      call('t6', 'webSearch', { query: 'oauth best practices' }),
    );
    const side = collectSidebar(s);
    expect(side.artifacts).toEqual(['weather.py', 'README.md']);
    expect(side.files).toEqual(['src/auth.ts', 'src']);
    expect(side.links).toEqual(['wttr.in', 'oauth best practices']); // url → host, search → query
  });

  it('dedupes repeated paths and ignores tools with no salient arg', () => {
    const s = run(
      call('t1', 'writeFile', { path: 'a.py' }),
      call('t2', 'writeFile', { path: 'a.py' }), // duplicate
      call('t3', 'updateTodos', { todos: [] }), // not an artifact/ref
    );
    const side = collectSidebar(s);
    expect(side.artifacts).toEqual(['a.py']);
    expect(side.files).toEqual([]);
    expect(side.links).toEqual([]);
  });
});
