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

  /** Revoke all grants (session close / user "revoke", agent §3.3). */
  clear(): void {
    this.grants = [];
  }

  list(): readonly Grant[] {
    return this.grants;
  }
}
