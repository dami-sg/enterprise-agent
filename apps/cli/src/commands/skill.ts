/**
 * Skills view (cli §9.4). Single-scope, mirroring the runtime: global + the
 * session's own override. Progressive disclosure means only descriptions are
 * surfaced here; `ea skill show` loads a full SKILL.md body on demand (agent §3.6).
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

export function registerSkill(program: Command, getGlobal: () => GlobalOpts): void {
  const skill = program.command('skill').description('技能（生效作用域，cli §9.4 / agent §3.6）');

  skill
    .command('ls')
    .description('列出当前作用域的技能（global + session 覆盖）')
    .option('--session <id>', '指定 Session 作用域（默认活动 Session）')
    .action(async (opts: ScopeOpts) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sid = await scopeSessionId(ctx, opts);
        const skills = ctx.skillsForScope(sid);
        if (!skills.length) {
          printErr(color.muted('（无技能；`ea skill add <dir>` 导入 SKILL.md 包，§9.4）'));
          return;
        }
        printErr(color.muted(`作用域: ${sid ? `${sid}（global + session）` : 'global'}`));
        const rows = skills.map((s) => [
          s.name,
          truncate(s.description, 40),
          (s.allowedTools ?? []).join('·') || color.muted('—'),
          s.disableModelInvocation ? color.warning('手动*') : '自动',
          scopeOf(ctx, sid, s.name),
        ]);
        print(formatTable(['name', 'description', 'tools', '调用', 'scope'], rows));
      });
    });

  skill
    .command('show <name>')
    .description('打印技能 SKILL.md 正文（progressive disclosure 的按需载入）')
    .option('--session <id>', '指定 Session 作用域')
    .action(async (name: string, opts: ScopeOpts) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sid = await scopeSessionId(ctx, opts);
        const meta = ctx.skillsForScope(sid).find((s) => s.name === name);
        if (!meta) throw new Error(`skill ${name} not found in scope`);
        print(readFileSync(meta.path, 'utf8'));
      });
    });

  skill
    .command('add <dir>')
    .description('导入一个 SKILL.md 技能包到 global skills（兼容 Anthropic/pi）')
    .action(async (dir: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`${dir} 不含 SKILL.md`);
        const dest = join(ctx.paths.skills, basename(dir));
        cpSync(dir, dest, { recursive: true });
        print(color.success(`✓ 已导入技能到 ${dest}`));
      });
    });
}

function scopeOf(ctx: CliContext, sid: string | undefined, name: string): string {
  if (sid && existsSync(join(ctx.paths.sessionSkills(sid), name))) return 'session';
  return 'global';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
