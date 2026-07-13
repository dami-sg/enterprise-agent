import { describe, it, expect } from 'bun:test';
import type { AgentStreamEvent } from '@dami-sg/agent-contract';
import { belongsToActive } from './event-routing.js';

const approval = (runId: string): AgentStreamEvent => ({
  kind: 'tool-approval-required',
  runId,
  agentId: 'orch',
  toolCallId: 'tc',
  toolName: 'writeFile',
  input: {},
});

describe('belongsToActive', () => {
  it('admits events for the active turn run', () => {
    expect(belongsToActive(approval('r1'), 'r1', new Set(), 's1')).toBe(true);
  });

  it('admits sub-agent run events tracked under the turn', () => {
    expect(belongsToActive(approval('sub1'), 'r1', new Set(['sub1']), 's1')).toBe(true);
  });

  it('drops events whose runId is not the active turn or a tracked sub-run', () => {
    // This is exactly what would strand a still-running turn if `send` let a new
    // turn reassign `runId` mid-flight — its approval would be filtered out here.
    expect(belongsToActive(approval('old-run'), 'r2', new Set(), 's1')).toBe(false);
  });

  it('routes todo-update by sessionId, not runId', () => {
    const todo: AgentStreamEvent = { kind: 'todo-update', sessionId: 's1', todos: [] };
    expect(belongsToActive(todo, 'r1', new Set(), 's1')).toBe(true);
    expect(belongsToActive(todo, 'r1', new Set(), 's2')).toBe(false);
  });

  it('always admits mcp/sandbox infrastructure errors', () => {
    const err: AgentStreamEvent = { kind: 'error', runId: 'mcp', message: 'boom' };
    expect(belongsToActive(err, undefined, new Set(), undefined)).toBe(true);
  });
});
