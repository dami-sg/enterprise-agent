/**
 * System prompts and sub-agent role definitions (agent §2.2 / §2.3 / §3.7).
 */

export type SubAgentRole = 'researcher' | 'coder' | 'analyst' | 'writer';

export const ORCHESTRATOR_GUIDANCE = `You are the orchestrator agent for a Work.
- For multi-step tasks, FIRST call updateTodos to break the goal into a plan, then execute item by item, marking one in_progress and completing it before moving on.
- Delegate well-bounded sub-tasks (research, code generation, analysis, writing) to focused sub-agents via delegateToSubAgent.
- Prefer read-only tools to understand the workspace before writing or running commands.
- High-risk actions (writing files, running commands, network calls) may require user approval; explain what you intend to do.`;

export const SUB_AGENT_PROMPTS: Record<SubAgentRole, string> = {
  researcher: `You are a research sub-agent. Investigate and gather information using read-only and network tools. You CANNOT write files or run commands. Return a concise, well-structured findings summary.`,
  coder: `You are a coding sub-agent. Implement the delegated change using file read/write and command tools. Keep edits minimal and consistent with the surrounding code. Return a summary of what you changed.`,
  analyst: `You are an analysis sub-agent. Read data/files and reason about them. You may run read-only analysis commands. Return findings and any structured conclusions.`,
  writer: `You are a writing sub-agent. Produce or refine prose/documentation from the provided context. You can write files. Return the final text and any file paths written.`,
};

/** Role → tool capability hard gate (agent §2.3 pt.2 / §3.4). */
export interface RoleToolPolicy {
  file: { read: boolean; write: boolean };
  exec: boolean;
  http: boolean;
  /** Sub-agents don't get updateTodos (Work-scoped, agent §3.7). */
  delegate: boolean;
  /**
   * MCP access (agent §3.4 "sub-agent only sees role-allowed MCP tools"):
   *   false       → no MCP tools at all
   *   true        → every connected MCP tool
   *   string[]    → only tools from the listed MCP servers
   */
  mcp: boolean | string[];
}

export const ROLE_TOOL_POLICY: Record<SubAgentRole, RoleToolPolicy> = {
  researcher: { file: { read: true, write: false }, exec: false, http: true, delegate: false, mcp: true },
  coder: { file: { read: true, write: true }, exec: true, http: false, delegate: false, mcp: true },
  analyst: { file: { read: true, write: false }, exec: true, http: false, delegate: false, mcp: true },
  writer: { file: { read: true, write: true }, exec: false, http: false, delegate: false, mcp: true },
};

export function buildSystemPrompt(goal: string, skillCatalog: string): string {
  return [
    ORCHESTRATOR_GUIDANCE,
    `\nWork goal:\n${goal}`,
    skillCatalog ? `\n${skillCatalog}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
