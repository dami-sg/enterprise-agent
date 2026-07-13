/**
 * Session commands (cli §3.1): the unified Session entity (agent §1) replaces
 * the former Workspace / Work / Chat. A session optionally binds a working
 * directory (`--dir`); without one it uses a private scratch dir. Thin
 * ergonomic wrappers over the `AgentHost` methods.
 */
import type { Command } from 'commander';
import type { SessionTree } from '@dami-sg/agent-contract';
import { resolve } from 'node:path';
import type { GlobalOpts } from './util.js';
import { formatTable, print, withCtx } from './util.js';
import { color } from '../core/color.js';

export function registerSessions(program: Command, getGlobal: () => GlobalOpts): void {
  const session = program.command('session').description('Session 管理与会话树（agent §1, §5.4）');

  session
    .command('new')
    .description('新建一个 Session（可选绑定工作目录）')
    .requiredOption('--name <name>', 'Session 名')
    .option('--dir <path>', '工作目录（文件边界）；不指定 → 默认工作目录（私有 scratch）')
    .action(async (opts: { name: string; dir?: string }) => {
      await withCtx(getGlobal(), async (ctx) => {
        const s = await ctx.host.createSession({ name: opts.name, workingDir: opts.dir ? resolve(opts.dir) : undefined });
        print(color.success(`✓ Session ${s.name} (${s.id})${s.workingDir ? ` → ${s.workingDir}` : '（默认工作目录）'}`));
      });
    });

  session
    .command('ls')
    .description('列出 Session')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const all = await ctx.host.listSessions();
        const rows = all.map((s) => [
          s.isActive ? color.accent('◆') : ' ',
          statusGlyph(s.status),
          s.name,
          s.id,
          s.workingDir ?? color.muted('（scratch）'),
        ]);
        print(formatTable(['', '', 'name', 'id', 'workingDir'], rows));
      });
    });

  session
    .command('switch <id>')
    .description('设为当前活动 Session')
    .action(async (id: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        await ctx.host.switchSession(id);
        print(color.success(`✓ 活动 Session → ${id}`));
      });
    });

  session
    .command('rm <id>')
    .description('删除一个 Session（连同其会话/审计/scratch）')
    .action(async (id: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        await ctx.host.deleteSession(id);
        print(color.success(`✓ 已删除 Session ${id}`));
      });
    });

  session
    .command('config [id]')
    .description('查看 Session 生效配置（global → session 合并，agent §2.5）')
    .action(async (id?: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const all = await ctx.host.listSessions();
        const target = id ? all.find((s) => s.id === id) : all.find((s) => s.isActive);
        if (!target) throw new Error(id ? `session ${id} not found` : '无活动 Session');
        const eff = ctx.config.effective(target.config, ctx.config.loadSessionAliases(target.id));
        print(JSON.stringify(eff, null, 2));
      });
    });

  session
    .command('tree <id>')
    .description('打印会话树（分支 / checkpoint / 压缩点）')
    .action(async (id: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        print(renderTree(await ctx.host.getSessionTree(id)));
      });
    });

  session
    .command('compact <id>')
    .description('手动压缩当前上下文（agent §5.5）')
    .action(async (id: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        await ctx.host.compact(id);
        print(color.success('✓ 已压缩'));
      });
    });

  session
    .command('label <id> <entryId> <label>')
    .description('给某节点命名 checkpoint')
    .action(async (id: string, entryId: string, label: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        await ctx.host.labelEntry(id, entryId, label);
        print(color.success(`✓ ${entryId} 🏷 ${label}`));
      });
    });

  session
    .command('fork <id> <entryId>')
    .description('从历史节点分叉（agent §5.4）')
    .action(async (id: string, entryId: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        await ctx.host.forkFrom(id, entryId);
        print(color.success(`✓ 已从 ${entryId} 分叉`));
      });
    });

  session
    .command('clone <id> <leafId>')
    .description('把某路径克隆为新 Session')
    .action(async (id: string, leafId: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const { sessionId } = await ctx.host.cloneToSession(id, leafId);
        print(color.success(`✓ 已克隆为新 Session ${sessionId}`));
      });
    });
}

function statusGlyph(status: string): string {
  if (status === 'running') return color.accent('●');
  if (status === 'done') return color.success('✓');
  if (status === 'archived') return color.muted('—');
  return ' ';
}

function renderTree(tree: SessionTree): string {
  const lines: string[] = [];
  const head = tree.headId;
  const walk = (id: string | undefined, depth: number): void => {
    if (!id) return;
    const entry = tree.nodes[id];
    if (!entry) return;
    const label = tree.labels[id];
    const marker = id === head ? color.accent(' ◀ HEAD') : '';
    const tag = label ? color.warning(` 🏷 ${label}`) : '';
    lines.push(`${'  '.repeat(depth)}${color.muted(id.slice(0, 6))} ${entry.kind}${tag}${marker}`);
    for (const child of Object.values(tree.nodes).filter((e) => e.parentId === id)) {
      walk(child.id, depth + 1);
    }
  };
  walk(tree.rootId, 0);
  return lines.join('\n') || color.muted('（空会话树）');
}
