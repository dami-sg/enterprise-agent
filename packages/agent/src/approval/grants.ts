/**
 * Session-scoped grant table (agent §3.3 / §3.4). Lives in memory for the
 * session's lifetime — across the session's multiple turns/runs, but not
 * persisted, not across restarts, not across sessions. Grants are keyed by a
 * meaningful "grant key" each tool derives from its input.
 */
export interface Grant {
  /** Tool name the grant applies to. */
  tool: string;
  /** Meaningful scope: argv[0], dir prefix, host, or tool name (agent §3.3). */
  grantKey: string;
  /** agentId the grant was issued under (for audit + agentScoped). */
  agentId: string;
  /** If true, only the issuing agent benefits — not sub-agents (agent §3.4). */
  agentScoped: boolean;
  /** Set when this grant was actively delegated from a parent agent (agent §3.4 B). */
  delegatedFrom?: string;
}

export class GrantTable {
  private grants: Grant[] = [];

  /**
   * Find a matching grant for a tool call.
   * Default: session-level shared (sub-agents inherit). agentScoped grants only
   * match the issuing agent (agent §3.4).
   */
  match(tool: string, grantKey: string, agentId: string): Grant | undefined {
    return this.grants.find(
      (g) =>
        g.tool === tool &&
        g.grantKey === grantKey &&
        (!g.agentScoped || g.agentId === agentId),
    );
  }

  add(grant: Grant): void {
    if (!this.match(grant.tool, grant.grantKey, grant.agentId)) {
      this.grants.push(grant);
    }
  }

  /**
   * Active delegation (agent §3.4 B): copy a parent's OWN agent-scoped grants to
   * a freshly-spawned child as child-scoped grants, so the worker reuses the
   * parent's sensitive approvals for the delegated task. Bounded by what the
   * parent already holds — never escalates (child ≤ parent), so the user remains
   * the only source of new authority. Non-scoped grants already inherit passively
   * via `match`, so only `agentScoped` ones (which otherwise stay with the parent)
   * are delegated here. Returns the grants newly delegated (for audit).
   */
  delegateScoped(fromAgentId: string, toAgentId: string): Grant[] {
    // Snapshot first — we push into `this.grants` below.
    const source = this.grants.filter((g) => g.agentScoped && g.agentId === fromAgentId);
    const delegated: Grant[] = [];
    for (const g of source) {
      const copy: Grant = {
        tool: g.tool,
        grantKey: g.grantKey,
        agentId: toAgentId,
        agentScoped: true,
        delegatedFrom: fromAgentId,
      };
      if (!this.match(copy.tool, copy.grantKey, copy.agentId)) {
        this.grants.push(copy);
        delegated.push(copy);
      }
    }
    return delegated;
  }

  /** Revoke all grants (session close / user "revoke", agent §3.3). */
  clear(): void {
    this.grants = [];
  }

  list(): readonly Grant[] {
    return this.grants;
  }
}
