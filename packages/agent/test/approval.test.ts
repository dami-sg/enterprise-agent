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
  it('SESSION grant auto-allows later matching calls within the session', async () => {
    const grants = new GrantTable();
    const ctrl = new ApprovalController(grants, noopEmitter);
    const p = ctrl.gate(req());
    ctrl.resolve('t1', APPROVAL.SESSION);
    const first = await p;
    expect(first.mode).toBe('session');

    // a second matching call is auto-allowed without prompting
    const second = await ctrl.gate(req({ toolCallId: 't2' }));
    expect(second.mode).toBe('session-auto');
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

describe('Active grant delegation (agent §3.4 B, opt-in)', () => {
  it("delegates only the parent's OWN scoped grants to the child, scoped + provenance", () => {
    const grants = new GrantTable();
    grants.add({ tool: 'runCommand', grantKey: 'git', agentId: 'orch', agentScoped: true });
    grants.add({ tool: 'writeFile', grantKey: '/repo', agentId: 'orch', agentScoped: false }); // shared, inherits anyway
    grants.add({ tool: 'runCommand', grantKey: 'rm', agentId: 'other', agentScoped: true }); // someone else's

    const delegated = grants.delegateScoped('orch', 'sub-coder-1');

    // Only orch's scoped grant is delegated (shared already inherits; other's stays).
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({
      tool: 'runCommand',
      grantKey: 'git',
      agentId: 'sub-coder-1',
      agentScoped: true,
      delegatedFrom: 'orch',
    });
    // Child can now use the delegated scoped grant…
    expect(grants.match('runCommand', 'git', 'sub-coder-1')).toBeDefined();
    // …but a sibling still cannot (the delegated copy is child-scoped).
    expect(grants.match('runCommand', 'git', 'sub-coder-2')).toBeUndefined();
    // …and the other agent's scoped grant never reached the child.
    expect(grants.match('runCommand', 'rm', 'sub-coder-1')).toBeUndefined();
  });

  it('never escalates: a child cannot receive a grant the parent does not hold', () => {
    const grants = new GrantTable();
    const delegated = grants.delegateScoped('orch', 'sub-1');
    expect(delegated).toEqual([]);
    expect(grants.match('runCommand', 'git', 'sub-1')).toBeUndefined();
  });

  it('is idempotent — re-delegating does not duplicate', () => {
    const grants = new GrantTable();
    grants.add({ tool: 'httpFetch', grantKey: 'api.example.com', agentId: 'orch', agentScoped: true });
    expect(grants.delegateScoped('orch', 'sub-1')).toHaveLength(1);
    expect(grants.delegateScoped('orch', 'sub-1')).toHaveLength(0);
  });
});
