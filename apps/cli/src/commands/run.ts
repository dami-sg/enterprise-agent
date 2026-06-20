/**
 * `ea run` (cli §5) and `ea report` (agent §2.4) — the headless entry points.
 * They share the host + event stream with the TUI, swapping in a printer
 * (§5.3). Exit codes follow cli §5.4.
 */
import type { Command } from 'commander';
import type { GlobalOpts } from './util.js';
import { print, printErr, withCtx } from './util.js';
import { EXIT, runHeadless } from '../headless/run.js';
import { resolveWorkingDir } from '../host/resolve.js';
import { color } from '../core/color.js';

export function registerRun(program: Command, getGlobal: () => GlobalOpts): void {
  program
    .command('run')
    .description('Headless 跑一次（脚本/CI，cli §5）')
    .requiredOption('-p, --prompt <text>', '提示词')
    .option('--json', '事件以 JSON Lines 打到 stdout（§11.2）')
    .option('-q, --quiet', '只输出最终结果（§11.1）')
    .option('--approve <policy>', '非交互审批：reject | auto:once | auto:session | policy:<file>')
    .option('--session <id>', '续已有 Session（默认按 cwd 新建）')
    .option('--title <title>', '自动新建 Session 的名字')
    .action(async (opts: { prompt: string; json?: boolean; quiet?: boolean; approve?: string; session?: string; title?: string }) => {
      const code = await withCtx(getGlobal(), (ctx) =>
        runHeadless(ctx, {
          prompt: opts.prompt,
          json: opts.json,
          quiet: opts.quiet,
          approve: opts.approve,
          title: opts.title,
          session: opts.session,
        }),
      );
      process.exitCode = code;
    });

  program
    .command('report')
    .description('结构化输出（agent §2.4）：跑会话产出校验过的 JSON 到 stdout')
    .requiredOption('-p, --prompt <text>', '产出说明/schema 提示')
    .option('--session <id>', '目标 Session（默认按 cwd 新建）')
    .action(async (opts: { prompt: string; session?: string }) => {
      await withCtx(getGlobal(), async (ctx) => {
        const sessionId =
          opts.session ??
          (await ctx.host.startSession({ name: 'Report', workingDir: resolveWorkingDir(), goal: opts.prompt })).sessionId;
        const out = await ctx.host.report(sessionId, opts.prompt);
        print(JSON.stringify(out, null, 2));
      });
    });

  // Daemon-oriented verbs (cli §8): meaningful only against a running server.
  program
    .command('approve <toolCallId> <decision>')
    .description('非交互审批（cli §8 daemon 模式）：once | session | reject')
    .action(() => {
      printErr(color.muted('approve 需 daemon 模式（cli §8）：先 `ea serve`，再 `ea approve --server <url> …`'));
      process.exitCode = EXIT.bootstrap;
    });

  program
    .command('abort <runId>')
    .description('中断运行（cli §8 daemon 模式）')
    .action(() => {
      printErr(color.muted('abort 需 daemon 模式（cli §8）：先 `ea serve`，再 `ea abort --server <url> <runId>`'));
      process.exitCode = EXIT.bootstrap;
    });

  program
    .command('serve')
    .description('可选：启动 daemon（cli §8，尚未实现）')
    .action(() => {
      printErr(color.muted('daemon 模式（cli §8）尚未实现——默认进程内嵌已覆盖单人本地用法。'));
      process.exitCode = EXIT.bootstrap;
    });
}
