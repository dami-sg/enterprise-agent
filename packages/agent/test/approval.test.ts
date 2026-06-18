import { describe, it, expect } from 'vitest';
import { GrantTable } from '../src/approval/grants.js';
import { ApprovalController, type ApprovalEmitter } from '../src/approval/approval.js';
import { APPROVAL } from '@enterprise-agent/agent-contract';

const noopEmitter: ApprovalEmitter = { emitApprovalRequired: () => {} };

function req(over: Partial<Parameters<ApprovalController['gate']>[0]> = {}) {
  return {
    runId: 'r1',
    toolName: 'runCommand',
    toolCallId: 't1',
    agentId: 'orch',
    input: {},
    grantKey: 'git',
    grantScope: 'run git *',
    ...over,
  };
}

describe('Three-state approval (agent §3.3/§3.4)', () => {
  it('TASK grant auto-allows later matching calls within the task', async () => {
    const grants = new GrantTable();
    const ctrl = new ApprovalController(grants, noopEmitter);
    const p = ctrl.gate(req());
    ctrl.resolve('t1', APPROVAL.TASK);
    const first = await p;
    expect(first.mode).toBe('task');

    // a second matching call is auto-allowed without prompting
    const second = await ctrl.gate(req({ toolCallId: 't2' }));
    expect(second.mode).toBe('task-auto');
  });

  it('ONCE does not persist a grant', async () => {
    const grants = new GrantTable();
    const ctrl = new ApprovalController(grants, noopEmitter);
    const p = ctrl.gate(req());
    ctrl.resolve('t1', APPROVAL.ONCE);
    expect((await p).mode).toBe('once');
    expect(grants.list()).toHaveLength(0);
  });

  it('REJECT returns reject', async () => {
    const ctrl = new ApprovalController(new GrantTable(), noopEmitter);
    const p = ctrl.gate(req());
    ctrl.resolve('t1', APPROVAL.REJECT);
    expect((await p).mode).toBe('reject');
  });

  it('agentScoped grants do not leak to other agents', () => {
    const grants = new GrantTable();
    grants.add({ tool: 'runCommand', grantKey: 'git', agentId: 'orch', agentScoped: true });
    expect(grants.match('runCommand', 'git', 'orch')).toBeDefined();
    expect(grants.match('runCommand', 'git', 'sub-coder-1')).toBeUndefined();
  });

  it('shared grants are inherited by sub-agents by default', () => {
    const grants = new GrantTable();
    grants.add({ tool: 'runCommand', grantKey: 'git', agentId: 'orch', agentScoped: false });
    expect(grants.match('runCommand', 'git', 'sub-coder-1')).toBeDefined();
  });
});
