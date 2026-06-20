/**
 * Commander program assembly (cli §3). Subcommands are ergonomic wrappers over
 * the `AgentHost` methods; the default command (no args) launches the OpenTUI
 * TUI (cli §4), lazily imported so headless commands never pay for the
 * Solid/OpenTUI runtime.
 */
import { Command } from 'commander';
import type { GlobalOpts } from './util.js';
import { registerRun } from './run.js';
import { registerSessions } from './sessions.js';
import { registerProvider } from './provider.js';
import { registerModels } from './models.js';
import { registerMcp } from './mcp.js';
import { registerSkill } from './skill.js';
import { registerConfig } from './config.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ea')
    .description('Enterprise Agent CLI — 进程内嵌 host 的终端壳（cli-architecture.md）')
    .version('0.4.0')
    .option('--root <dir>', 'App 数据根目录（默认 ~/.enterprise-agent）');

  const getGlobal = (): GlobalOpts => ({ root: program.opts<{ root?: string }>().root });

  registerRun(program, getGlobal);
  registerSessions(program, getGlobal);
  registerProvider(program, getGlobal);
  registerModels(program, getGlobal);
  registerMcp(program, getGlobal);
  registerSkill(program, getGlobal);
  registerConfig(program, getGlobal);

  program
    .command('tui', { isDefault: true })
    .description('启动 OpenTUI 全屏 TUI（默认入口，cli §4）')
    .action(async () => {
      // OpenTUI/Solid. A non-literal specifier keeps the Node `tsc` program from
      // resolving the Solid/.tsx world (type-checked separately via
      // tsconfig.tui.json); the `@opentui/solid` transform is registered in bin.ts.
      const otuiLaunch = '../tui-otui/launch.js';
      const { launchTui } = (await import(otuiLaunch)) as { launchTui: (g: GlobalOpts) => Promise<void> };
      return launchTui(getGlobal());
    });

  return program;
}
