/**
 * Schedule grant pre-authorization (§7 B.2 / B.3). A schedule's `grants:` list
 * pre-authorizes specific high-risk scopes for the unattended run, so those exact
 * operations are honored by the gate instead of denied (ask→deny). Everything NOT
 * listed still fails closed. This is the explicit escape hatch a human opts into
 * when creating the schedule — bounded to named scopes, never blanket.
 *
 * Format (fine-grained `<cap>:<scope>`, comma-separated in frontmatter):
 *   exec:<command>   → runCommand grant keyed by argv[0]      (e.g. `exec:git`)
 *   write:<dir>      → writeFile + applyPatch grant keyed by a dir prefix
 *   http:<host>      → httpFetch grant keyed by host           (e.g. `http:api.github.com`)
 * A bare capability with no `:scope` is ignored (it can't form a meaningful grant
 * key) — grants are always scope-bounded.
 */
import type { Grant } from '../approval/grants.js';

/** Map a capability token to the tool name(s) whose grant key it pre-authorizes. */
const CAP_TOOLS: Record<string, string[]> = {
  exec: ['runCommand'],
  write: ['writeFile', 'applyPatch'],
  http: ['httpFetch'],
};

/**
 * Parse a schedule's `grants` specs into session grant-table entries. Each grant
 * is session-shared (`agentScoped: false`) so the run's sub-agents inherit it too,
 * matching how the orchestrator's own approvals flow down. Unknown caps and
 * scope-less tokens are dropped (fail-closed: an unparseable grant authorizes
 * nothing rather than something broad).
 */
export function parseScheduleGrants(specs: string[], agentId: string): Grant[] {
  const out: Grant[] = [];
  for (const spec of specs) {
    const i = spec.indexOf(':');
    if (i < 0) continue; // bare cap → no scope → ignore
    const cap = spec.slice(0, i).trim().toLowerCase();
    const scope = spec.slice(i + 1).trim();
    if (!scope) continue;
    const tools = CAP_TOOLS[cap];
    if (!tools) continue;
    for (const tool of tools) {
      out.push({ tool, grantKey: scope, agentId, agentScoped: false });
    }
  }
  return out;
}
