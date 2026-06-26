/**
 * Config overview (cli §9.5): a read-only view of the effective config chain
 * — global `settings.json` merged with the active Session override (agent §2.5)
 * — with the sandbox switch, `compactRatio`, `maxDepth` and permission policy
 * laid out, flagging "⚠ 沙箱已关闭" prominently (agent §4.1).
 *
 * The `config <sub>` subcommands are the mutable knobs, each writing the global
 * `settings.json`: `sandbox` toggles the landstrip OS sandbox (off by default,
 * agent §4.1), `delegate` toggles which sub-agent roles may spawn nested
 * sub-agents (agent §2.3 pt.2), `timeout` sets sub-agent wall-clock caps.
 */
import type { Command } from 'commander';
import { SUB_AGENT_ROLES, DEFAULT_SETTINGS } from '@enterprise-agent/agent';
import type { GlobalOpts } from './util.js';
import { print, printErr, withCtx } from './util.js';
import { color } from '../core/color.js';

export function registerConfig(program: Command, getGlobal: () => GlobalOpts): void {
  const config = program
    .command('config')
    .description('查看生效配置链（global → session 合并，cli §9.5）')
    .option('--session <id>', '指定 Session（默认活动 Session）')
    .action(async (opts: { session?: string }) => {
      await withCtx(getGlobal(), async (ctx) => {
        const all = await ctx.host.listSessions();
        const target = opts.session ? all.find((s) => s.id === opts.session) : all.find((s) => s.isActive);
        const eff = ctx.config.effective(target?.config, target ? ctx.config.loadSessionAliases(target.id) : []);

        print(color.bold(`生效配置${target ? `（${target.name}）` : '（global）'}`));
        print(`  orchestrator   ${eff.orchestratorAlias}`);
        print(`  sandbox        ${eff.sandboxEnabled ? color.success('✓ 启用') : color.danger('✗ 已关闭')}`);
        print(`  执行模式默认   ${formatExecutionMode(eff.executionMode)}`);
        print(`  memory         ${eff.memoryEnabled ? color.success(`✓ 启用（${eff.memoryScopeMode}）`) : color.muted('✗ 关闭')}`);
        print(`  compactRatio   ${eff.compactRatio}`);
        print(`  maxDepth       ${eff.maxDepth}`);
        print(`  maxConcurrency ${eff.maxConcurrency}`);
        print(`  maxSteps       ${eff.maxSteps}`);
        print(`  子agent超时    ${formatTimeout(eff.subAgentTimeoutMs)}${formatRoleTimeouts(eff.roleTimeoutMs)}`);
        print(`  delegateAgents ${formatNameList(eff.delegateAgents)}`);
        print(`  agents 白名单  ${eff.agents === undefined ? color.muted('（全部启用）') : formatNameList(eff.agents)}`);
        const perm = eff.permission;
        print(`  permission     ${summarizePermission(perm)}`);
        if (!eff.sandboxEnabled) {
          printErr(color.warning('⚠ 沙箱已关闭——工具写/执行不受 landstrip 边界保护（agent §4.1）'));
        }
      });
    });

  config
    .command('sandbox [state]')
    .description('开关 landstrip 沙箱（默认关闭；写 global settings.json，agent §4.1）')
    .action(async (state?: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        const fallback = DEFAULT_SETTINGS.sandbox.enabled;
        const current = settings.sandbox?.enabled ?? fallback;

        // No arg → show the current global value + usage.
        if (!state) {
          print(`当前（global）沙箱：${current ? color.success('✓ 启用') : color.danger('✗ 已关闭')}${
            settings.sandbox?.enabled === undefined ? color.muted(`（默认：${fallback ? '启用' : '关闭'}）`) : ''
          }`);
          printErr(color.muted('用法：ea config sandbox on | off | default（恢复默认）'));
          return;
        }

        const s = state.toLowerCase();
        const ON = new Set(['on', 'true', 'enable', 'enabled', '1']);
        const OFF = new Set(['off', 'false', 'disable', 'disabled', '0']);

        if (s === 'default') {
          if (settings.sandbox) delete settings.sandbox.enabled; // unset → fall back to built-in default
          ctx.config.saveSettings(settings);
          print(color.success(`✓ 已恢复默认（${fallback ? '启用' : '关闭'}）`));
          return;
        }

        if (!ON.has(s) && !OFF.has(s)) {
          printErr(color.danger(`✗ 无法识别：${state}`));
          printErr(color.muted('用法：ea config sandbox on | off | default'));
          process.exitCode = 1;
          return;
        }

        const enabled = ON.has(s);
        settings.sandbox = { ...settings.sandbox, enabled };
        ctx.config.saveSettings(settings);
        print(color.success(`✓ landstrip 沙箱 → ${enabled ? '启用' : '已关闭'}`));
        if (!enabled) {
          printErr(color.warning('⚠ 关闭后工具写/执行不受 landstrip 边界保护，仅靠审批 + 路径校验（agent §4.1）'));
        }
      });
    });

  config
    .command('memory [state]')
    .description('开关跨会话记忆（默认关闭；写 global settings.json，memory §1/§5）')
    .action(async (state?: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        const fallback = false; // memory is OFF by default (memory §1)
        const current = settings.memory?.enabled ?? fallback;

        // No arg → show the current global value + usage.
        if (!state) {
          print(`当前（global）记忆：${current ? color.success('✓ 启用') : color.danger('✗ 已关闭')}${
            settings.memory?.enabled === undefined ? color.muted('（默认：关闭）') : ''
          }`);
          printErr(color.muted('用法：ea config memory on | off | default（恢复默认）'));
          printErr(color.muted('提示：还需用 EA_MEMORY_BACKEND（如 mock）选择后端，hook 才会真正运行。'));
          return;
        }

        const s = state.toLowerCase();
        const ON = new Set(['on', 'true', 'enable', 'enabled', '1']);
        const OFF = new Set(['off', 'false', 'disable', 'disabled', '0']);

        if (s === 'default') {
          if (settings.memory) delete settings.memory.enabled; // unset → fall back to built-in default
          ctx.config.saveSettings(settings);
          print(color.success('✓ 已恢复默认（关闭）'));
          return;
        }

        if (!ON.has(s) && !OFF.has(s)) {
          printErr(color.danger(`✗ 无法识别：${state}`));
          printErr(color.muted('用法：ea config memory on | off | default'));
          process.exitCode = 1;
          return;
        }

        const enabled = ON.has(s);
        settings.memory = { ...settings.memory, enabled };
        ctx.config.saveSettings(settings);
        print(color.success(`✓ 跨会话记忆 → ${enabled ? '启用' : '已关闭'}`));
        if (enabled) {
          printErr(color.muted('记得设置 EA_MEMORY_BACKEND（如 mock）选择后端；否则即便启用也无可用引擎。'));
        }
      });
    });

  // The former `ea config bypass` is gone — the classifier-skipping relaxation is
  // now the `full` execution mode (EXECUTION_MODE.FULL), selected live with
  // Shift+Tab in the TUI or via setExecutionMode, not a settings.json flag.

  config
    .command('delegate [agents...]')
    .description('开关子 Agent 嵌套委派（哪些 agent 可再 spawn 子 Agent，agent §2.3）')
    .action(async (names: string[]) => {
      await withCtx(getGlobal(), async (ctx) => {
        const known = ctx.agentsForScope().map((d) => d.name);
        // No args → show the current global setting + usage.
        if (names.length === 0) {
          const settings = ctx.config.loadSettings();
          const cur = settings.delegateAgents;
          print(
            `当前（global）delegateAgents：${
              cur === undefined ? color.muted('（默认：无 agent 可嵌套）') : formatNameList(cur)
            }`,
          );
          printErr(
            color.muted(
              `用法：ea config delegate <agent...> 开启 | ea config delegate none 全部关闭 | ea config delegate default 恢复默认\n可选 agent：${known.join(', ')}`,
            ),
          );
          return;
        }

        const settings = ctx.config.loadSettings();
        const first = (names[0] ?? '').toLowerCase();

        if (names.length === 1 && first === 'default') {
          delete settings.delegateAgents; // unset → fall back to built-in defaults
          ctx.config.saveSettings(settings);
          print(color.success('✓ 已恢复默认（无 agent 可嵌套委派）'));
          return;
        }

        // `none` (or `off`) explicitly disables nesting for every agent.
        if (names.length === 1 && (first === 'none' || first === 'off')) {
          settings.delegateAgents = [];
          ctx.config.saveSettings(settings);
          print(color.success('✓ 已关闭全部 agent 的嵌套委派（delegateAgents = []）'));
          return;
        }

        // Validate + dedupe against the live agent names (built-in + custom).
        const valid = new Set<string>(known);
        const unknown = names.filter((r) => !valid.has(r));
        if (unknown.length) {
          printErr(color.danger(`✗ 未知 agent：${unknown.join(', ')}（可选：${known.join(', ')}）`));
          process.exitCode = 1;
          return;
        }
        const next = [...new Set(names)];
        settings.delegateAgents = next;
        ctx.config.saveSettings(settings);
        print(color.success(`✓ 已开启嵌套委派：${formatNameList(next)}`));
        printErr(color.muted('仍受 maxDepth + 该 agent 自身 delegate 开关约束；高风险工具同样走三态审批（agent §2.3 pt.6）'));
      });
    });

  config
    .command('agents [names...]')
    .description('设置启用哪些磁盘 agent 定义的准入白名单（agent §2.3，写 global settings.json）')
    .action(async (names: string[]) => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        // No args → show current + usage.
        if (names.length === 0) {
          const cur = settings.agents;
          print(
            `当前（global）agents 白名单：${
              cur === undefined ? color.muted('（未设：全部 agent 启用）') : cur.length ? formatNameList(cur) : color.muted('[]（仅内置种子）')
            }`,
          );
          printErr(
            color.muted(
              '用法：ea config agents <name...> 只启用列出的磁盘 agent | ea config agents none 仅内置 | ea config agents all 全部启用',
            ),
          );
          return;
        }

        const first = (names[0] ?? '').toLowerCase();
        if (names.length === 1 && first === 'all') {
          delete settings.agents; // unset → all enabled
          ctx.config.saveSettings(settings);
          print(color.success('✓ 已启用全部 agent（移除白名单）'));
          return;
        }
        if (names.length === 1 && (first === 'none' || first === 'off')) {
          settings.agents = [];
          ctx.config.saveSettings(settings);
          print(color.success('✓ 已限定为仅内置种子（agents = []）'));
          return;
        }
        settings.agents = [...new Set(names)];
        ctx.config.saveSettings(settings);
        print(color.success(`✓ agents 白名单 → ${formatNameList(settings.agents)}`));
        printErr(color.muted('内置种子始终可用；白名单只控制磁盘 AGENT.md 的启用（agent §2.3）'));
      });
    });

  config
    .command('timeout [args...]')
    .description('设置子 Agent 墙钟超时（全局默认或按 role 覆盖，agent §2.3，写 settings.json）')
    .action(async (rawArgs: string[]) => {
      await withCtx(getGlobal(), async (ctx) => {
        const usage = `用法：
  ea config timeout <ms|off>             设置全局默认（off=0 关闭）
  ea config timeout <role> <ms|off>      为某 role 覆盖（off=0 关闭）
  ea config timeout <role> default       移除该 role 覆盖，回退默认
可选 role：${SUB_AGENT_ROLES.join(', ')}`;
        const settings = ctx.config.loadSettings();
        const args = rawArgs ?? [];

        // No args → show global default + per-role overrides.
        if (args.length === 0) {
          const eff = ctx.config.effective(undefined, []);
          print(`全局默认：${formatTimeout(eff.subAgentTimeoutMs)}`);
          const roles = Object.entries(eff.roleTimeoutMs);
          if (roles.length) print(`按 role 覆盖：${roles.map(([r, v]) => `${r}=${formatTimeout(v)}`).join('  ')}`);
          else print(color.muted('按 role 覆盖：（无）'));
          printErr(color.muted(usage));
          return;
        }

        const isRole = (s: string): boolean => (SUB_AGENT_ROLES as readonly string[]).includes(s);
        // Parse "off"/"0"/<ms> → a non-negative integer, or null if invalid.
        const parseMs = (s: string): number | null => {
          if (s.toLowerCase() === 'off') return 0;
          const n = Number(s);
          return Number.isInteger(n) && n >= 0 ? n : null;
        };

        // Form 1: global default — `timeout <ms|off>`.
        if (args.length === 1 && !isRole(args[0]!)) {
          const ms = parseMs(args[0]!);
          if (ms === null) {
            printErr(color.danger(`✗ 非法毫秒值：${args[0]}`));
            printErr(color.muted(usage));
            process.exitCode = 1;
            return;
          }
          settings.subAgentTimeoutMs = ms;
          ctx.config.saveSettings(settings);
          print(color.success(`✓ 全局默认子 Agent 超时 → ${formatTimeout(ms)}`));
          return;
        }

        // Form 2: per-role — `timeout <role> <ms|off|default>`.
        if (args.length === 2 && isRole(args[0]!)) {
          const role = args[0]!;
          const val = args[1]!;
          const map = { ...(settings.roleTimeoutMs ?? {}) };
          if (val.toLowerCase() === 'default') {
            delete map[role];
            settings.roleTimeoutMs = map;
            ctx.config.saveSettings(settings);
            print(color.success(`✓ 已移除 ${role} 的超时覆盖（回退全局默认）`));
            return;
          }
          const ms = parseMs(val);
          if (ms === null) {
            printErr(color.danger(`✗ 非法毫秒值：${val}`));
            printErr(color.muted(usage));
            process.exitCode = 1;
            return;
          }
          map[role] = ms;
          settings.roleTimeoutMs = map;
          ctx.config.saveSettings(settings);
          print(color.success(`✓ ${role} 子 Agent 超时 → ${formatTimeout(ms)}`));
          return;
        }

        printErr(color.danger('✗ 参数无法识别'));
        printErr(color.muted(usage));
        process.exitCode = 1;
      });
    });
}

function formatTimeout(ms: number): string {
  return ms > 0 ? `${ms}ms` : color.muted('关闭');
}

function formatExecutionMode(mode: string): string {
  // full is the riskiest (classifier skipped) → warn-colored; ask is the default.
  if (mode === 'full') return color.warning('⚡ full（边界关闭·仅提权/高危删除）');
  if (mode === 'auto') return color.accent('auto（分类器）');
  if (mode === 'plan') return color.accent('plan');
  return color.muted('ask（默认）');
}

function formatRoleTimeouts(roleTimeoutMs: Record<string, number>): string {
  const entries = Object.entries(roleTimeoutMs);
  if (!entries.length) return '';
  return color.muted(`  [${entries.map(([r, v]) => `${r}=${v > 0 ? `${v}ms` : 'off'}`).join(' ')}]`);
}

function formatNameList(names: string[]): string {
  return names.length ? names.join(', ') : color.muted('（无）');
}

function summarizePermission(p: { allowCommands?: string[]; allowHosts?: string[]; allowPaths?: string[] }): string {
  const parts: string[] = [];
  if (p.allowCommands?.length) parts.push(`allowCmd=${p.allowCommands.length}`);
  if (p.allowHosts?.length) parts.push(`allowHosts=${p.allowHosts.length}`);
  if (p.allowPaths?.length) parts.push(`allowPaths=${p.allowPaths.length}`);
  return parts.join(' ') || color.muted('（默认）');
}
