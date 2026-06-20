/**
 * Tool assembly (agent §2.2 / §3): builds the orchestrator's local tool set and
 * the role-restricted set for sub-agents (the role "hard gate", agent §3.4).
 */
import type { Tool } from 'ai';
import type { RunContext } from '../runtime/context.js';
import { buildFileTools } from './file.js';
import { buildExecTools } from './exec.js';
import { buildHttpTools } from './http.js';
import { buildTodoTool } from './todos.js';
import { buildAskTool } from './ask.js';
import { buildDateTool } from './date.js';
import { buildSkillTools } from './skill.js';
import { buildPlanTools } from './plan.js';
import { ROLE_TOOL_POLICY, type SubAgentRole } from '../runtime/prompts.js';

export type ToolSet = Record<string, Tool>;

/** Orchestrator local tools: file r/w, exec, http, updateTodos (agent §2.2). */
export function buildLocalTools(ctx: RunContext): ToolSet {
  const file = buildFileTools(ctx);
  const exec = buildExecTools(ctx);
  const http = buildHttpTools(ctx);
  const todos = buildTodoTool(ctx);
  const ask = buildAskTool(ctx);
  const date = buildDateTool(ctx);
  // Skill tools see the full catalog — the orchestrator holds every local tool.
  const skill = buildSkillTools(ctx);
  // exitPlanMode is orchestrator-scoped (like updateTodos): plan mode is a
  // session-level concern, sub-agents don't propose plans (agent §3.8.4).
  const plan = buildPlanTools(ctx);
  return {
    readFile: file.readFile,
    listDir: file.listDir,
    search: file.search,
    writeFile: file.writeFile,
    applyPatch: file.applyPatch,
    runCommand: exec.runCommand,
    httpFetch: http.httpFetch,
    updateTodos: todos.updateTodos,
    askUserQuestion: ask.askUserQuestion,
    getCurrentTime: date.getCurrentTime,
    useSkill: skill.useSkill,
    searchSkills: skill.searchSkills,
    exitPlanMode: plan.exitPlanMode,
  };
}

/**
 * Role-restricted tools for a sub-agent (agent §2.3 / §3.4). The role policy is
 * a hard gate: out-of-scope tools are simply never constructed.
 *
 * `delegateFactory` is the `spawnSubAgentTool` constructor, injected (rather than
 * imported) to avoid a registry ↔ sub-agent import cycle. Nested delegation is
 * opt-in per role via config (`ctx.shared.delegateRoles`, agent §2.3 pt.2) and
 * only wired while depth budget remains; the spawned tool re-checks depth at
 * call time as well.
 */
export function buildToolsForRole(
  role: SubAgentRole,
  ctx: RunContext,
  delegateFactory?: (ctx: RunContext) => Tool,
): ToolSet {
  const policy = ROLE_TOOL_POLICY[role];
  const file = buildFileTools(ctx);
  const out: ToolSet = {};
  // The clock is a read-only baseline capability every role gets (agent §3).
  out.getCurrentTime = buildDateTool(ctx).getCurrentTime;
  if (policy.file.read) {
    out.readFile = file.readFile;
    out.listDir = file.listDir;
    out.search = file.search;
  }
  if (policy.file.write) {
    out.writeFile = file.writeFile;
    out.applyPatch = file.applyPatch;
  }
  if (policy.exec) {
    out.runCommand = buildExecTools(ctx).runCommand;
  }
  if (policy.http) {
    out.httpFetch = buildHttpTools(ctx).httpFetch;
  }
  if (delegateFactory && ctx.shared.delegateRoles.has(role) && ctx.depth < ctx.shared.maxDepth) {
    out.delegateToSubAgent = delegateFactory(ctx);
  }
  // Skill tools last, bound to the role's final tool names so search/load only
  // surface skills this role can actually carry out (§3.6 / §3.4).
  const skill = buildSkillTools(ctx, Object.keys(out));
  out.useSkill = skill.useSkill;
  out.searchSkills = skill.searchSkills;
  return out;
}

/** Whether a role gets any MCP tools at all (agent §3.4/§3.5). */
export function mcpAllowedForRole(role: SubAgentRole): boolean {
  const mcp = ROLE_TOOL_POLICY[role].mcp;
  return mcp === true || (Array.isArray(mcp) && mcp.length > 0);
}

/**
 * Predicate enforcing the role MCP hard gate per fully-qualified tool name
 * (`mcp__<server>__<tool>`). `undefined` means "allow all" (no filtering);
 * a server allowlist filters by the `<server>` segment (agent §3.4).
 */
export function mcpAllowForRole(role: SubAgentRole): ((fqName: string) => boolean) | undefined {
  const mcp = ROLE_TOOL_POLICY[role].mcp;
  if (mcp === true) return undefined;
  if (mcp === false) return () => false;
  const allowed = new Set(mcp);
  return (fqName: string) => {
    const server = fqName.split('__')[1];
    return server !== undefined && allowed.has(server);
  };
}
