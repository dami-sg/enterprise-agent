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
import { registerAgent } from './agent.js';
import { registerConfig } from './config.js';
import { registerDoctor } from './doctor.js';
import { registerServe } from './serve.js';

export interface ProgramOptions {
  /**
   * Inject the TUI launcher. By default the `tui` command lazily imports it via a
   * NON-LITERAL specifier, so the Node `tsc` program never resolves the Solid/.tsx
   * world (type-checked separately) and headless commands never pay for the
   * OpenTUI runtime. The standalone-binary entry (`tui-otui/compile-entry.tsx`)
   * injects a STATICALLY-imported launcher instead, because `bun build --compile`
   * can't bundle a non-literal dynamic import.
   */
  launchTui?: (g: GlobalOpts) => Promise<void>;
}

export function buildProgram(opts: ProgramOptions = {}): Command {
  const program = new Command();
  program
    .name('ea')
    .description('Enterprise Agent CLI — 进程内嵌 host 的终端壳（cli-architecture.md）')
    .version('0.0.3')
    .option('--root <dir>', 'App 数据根目录（默认 ~/.enterprise-agent）');

  const getGlobal = (): GlobalOpts => ({ root: program.opts<{ root?: string }>().root });

  registerRun(program, getGlobal);
  registerSessions(program, getGlobal);
  registerProvider(program, getGlobal);
  registerModels(program, getGlobal);
  registerMcp(program, getGlobal);
  registerSkill(program, getGlobal);
  registerAgent(program, getGlobal);
  registerConfig(program, getGlobal);
  registerDoctor(program, getGlobal);
  registerServe(program, getGlobal);

  program
    .command('tui', { isDefault: true })
    .description('启动 OpenTUI 全屏 TUI（默认入口，cli §4）')
    .action(async () => {
      // Compiled binary: use the statically-injected launcher (the dynamic import
      // below can't be bundled by `bun build --compile`).
      if (opts.launchTui) return opts.launchTui(getGlobal());
      // Normal path: OpenTUI/Solid via a non-literal specifier, which keeps the
      // Node `tsc` program from resolving the Solid/.tsx world (type-checked
      // separately via tsconfig.tui.json); the transform is registered in bin.ts.
      const otuiLaunch = '../tui-otui/launch.js';
      const { launchTui } = (await import(otuiLaunch)) as { launchTui: (g: GlobalOpts) => Promise<void> };
      return launchTui(getGlobal());
    });

  return program;
}
