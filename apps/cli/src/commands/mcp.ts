/**
 * MCP servers view (cli §9.3). Single-scope: the list is the **effective
 * session scope** — global + the session's own override (same-name override).
 * Headless cannot show live connection state (no running session), so it
 * reports the configured `enabled` flag + scope; the TUI overlays the runtime
 * `● 已连 / ✗ 连接失败` from the event stream (agent §3.5).
 */
import type { Command } from 'commander';
import type { McpServerConfig } from '@enterprise-agent/agent-contract';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalOpts } from './util.js';
import { formatTable, print, printErr, withCtx } from './util.js';
import type { CliContext } from '../host/bootstrap.js';
import { color } from '../core/color.js';

interface ScopeOpts {
  session?: string;
}

/** Resolve the session scope to list under (default: active session). */
async function scopeSessionId(ctx: CliContext, opts: ScopeOpts): Promise<string | undefined> {
  if (opts.session) return opts.session;
  const all = await ctx.host.listSessions();
  return all.find((s) => s.isActive)?.id; // active session, or undefined (global only)
}

export function registerMcp(program: Command, getGlobal: () => GlobalOpts): void {
  const mcp = program.command('mcp').description('MCP servers（生效作用域，cli §9.3）');

  mcp
    .command('ls')
    .description('列出当前作用域的 MCP server（global + session 覆盖）')
    .option('--session <id>', '指定 Session 作用域（默认活动 Session）')
    .action(async (opts: ScopeOpts) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sid = await scopeSessionId(ctx, opts);
        const servers = ctx.config.listMcpServers(sid);
        if (!servers.length) {
          printErr(color.muted('（无 MCP server；`ea mcp` 配置外部工具，§12.2）'));
          return;
        }
        printErr(color.muted(`作用域: ${sid ? `${sid}（global + session）` : 'global'}`));
        const rows = servers.map((s) => [
          s.name,
          s.transport,
          s.riskTier ?? color.muted('—'),
          scopeOf(ctx, sid, s.name),
          s.enabled ? color.success('● 启用') : color.muted('⊘ 已停用'),
        ]);
        print(formatTable(['name', 'transport', 'risk', 'scope', '状态'], rows));
      });
    });

  mcp
    .command('enable <name>')
    .description('启用 MCP server（下次会话生效）')
    .option('--session <id>', '指定 Session 作用域')
    .action((name: string, opts: { session?: string }) => toggleMcp(getGlobal(), name, opts.session, true));

  mcp
    .command('disable <name>')
    .description('停用 MCP server')
    .option('--session <id>', '指定 Session 作用域')
    .action((name: string, opts: { session?: string }) => toggleMcp(getGlobal(), name, opts.session, false));
}

function scopeOf(ctx: CliContext, sid: string | undefined, name: string): string {
  if (sid && existsSync(join(ctx.paths.sessionMcp(sid), `${name}.json`))) return 'session';
  return 'global';
}

async function toggleMcp(
  global: GlobalOpts,
  name: string,
  sessionId: string | undefined,
  enabled: boolean,
): Promise<void> {
  await withCtx(global, async (ctx) => {
    const servers = ctx.config.listMcpServers(sessionId);
    const target = servers.find((s) => s.name === name);
    if (!target) throw new Error(`mcp server ${name} not found`);
    const updated: McpServerConfig = { ...target, enabled };
    // Persist to the scope it lives in (session override file if present).
    const inSession = sessionId && existsSync(join(ctx.paths.sessionMcp(sessionId), `${name}.json`));
    ctx.config.saveMcpServer(updated, inSession ? sessionId : undefined);
    print(color.success(`✓ ${name} → ${enabled ? '启用' : '停用'}（下次会话生效）`));
  });
}
