/**
 * Agents view (cli-ui §9.4.1). Declarative sub-agents (agent §2.3): built-in seeds +
 * discovered `AGENT.md`, in a session's effective scope (global + session
 * override). Mirrors `ea skill` — `ls` / `show` / `add`. Installation drops a
 * directory into the global agent root; discovery + the role hard gate stay in
 * the core (AgentRegistry), so the CLI never reimplements policy.
 */
import type { Command } from 'commander';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GlobalOpts } from './util.js';
import { formatTable, print, printErr, withCtx } from './util.js';
import type { CliContext } from '../host/bootstrap.js';
import { color } from '../core/color.js';

interface ScopeOpts {
  session?: string;
}

async function scopeSessionId(ctx: CliContext, opts: ScopeOpts): Promise<string | undefined> {
  if (opts.session) return opts.session;
  const all = await ctx.host.listSessions();
  return all.find((s) => s.isActive)?.id;
}

/** Compact one-line render of a policy's capabilities (read/write/exec/http/mcp). */
function capsOf(def: { policy: { file: { read: boolean; write: boolean }; exec: boolean; http: boolean; mcp: boolean | string[] } }): string {
  const caps: string[] = [];
  if (def.policy.file.read) caps.push('read');
  if (def.policy.file.write) caps.push('write');
  if (def.policy.exec) caps.push('exec');
  if (def.policy.http) caps.push('http');
  const mcp = def.policy.mcp;
  if (mcp === true) caps.push('mcp:*');
  else if (Array.isArray(mcp) && mcp.length) caps.push(`mcp:${mcp.join('+')}`);
  return caps.join('·') || color.muted('—');
}

export function registerAgent(program: Command, getGlobal: () => GlobalOpts): void {
  const agent = program.command('agent').description('子 Agent 定义（生效作用域，cli §9.5 / agent §2.3）');

  agent
    .command('ls')
    .description('列出当前作用域可用的 agent（内置种子 + AGENT.md，含 global + session 覆盖）')
    .option('--session <id>', '指定 Session 作用域（默认活动 Session）')
    .action(async (opts: ScopeOpts) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sid = await scopeSessionId(ctx, opts);
        const agents = ctx.agentsForScope(sid);
        printErr(color.muted(`作用域: ${sid ? `${sid}（global + session）` : 'global'}`));
        const rows = agents.map((d) => [
          d.name,
          truncate(d.description, 36),
          capsOf(d),
          d.model ?? color.muted('—'),
          d.builtin ? color.muted('内置') : '自定义',
        ]);
        print(formatTable(['name', 'description', 'tools', 'model', 'source'], rows));
      });
    });

  agent
    .command('show <name>')
    .description('打印某 agent 的能力策略与系统 prompt（AGENT.md 正文）')
    .option('--session <id>', '指定 Session 作用域')
    .action(async (name: string, opts: ScopeOpts) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sid = await scopeSessionId(ctx, opts);
        const def = ctx.agentsForScope(sid).find((d) => d.name === name);
        if (!def) throw new Error(`agent ${name} not found in scope`);
        print(color.bold(def.name) + (def.builtin ? color.muted('  (内置种子)') : ''));
        print(`  ${def.description}`);
        print(`  tools   ${capsOf(def)}`);
        print(`  delegate ${def.policy.delegate ? '✓' : '✗'}`);
        if (def.model) print(`  model   ${def.model}`);
        if (def.timeoutMs !== undefined) print(`  timeout ${def.timeoutMs}ms`);
        print('');
        print(def.prompt);
      });
    });

  agent
    .command('add <dir>')
    .description('导入一个 AGENT.md 定义到 global agents（目录名即 agent 名）')
    .action(async (dir: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        if (!existsSync(join(dir, 'AGENT.md'))) throw new Error(`${dir} 不含 AGENT.md`);
        const dest = join(ctx.paths.agents, basename(dir));
        cpSync(dir, dest, { recursive: true });
        print(color.success(`✓ 已导入 agent 到 ${dest}`));
        printErr(color.muted('若设置了 `agents` 准入白名单，需将该名加入后才会启用（agent §2.3）'));
      });
    });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
