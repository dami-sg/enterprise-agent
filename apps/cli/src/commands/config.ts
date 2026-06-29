/**
 * Config overview (cli §9.5): a read-only view of the effective config chain
 * — global `settings.json` merged with the active Session override (agent §2.5)
 * — with the sandbox switch, `compactRatio`, concurrency and permission policy
 * laid out, flagging "⚠ 沙箱已关闭" prominently (agent §4.1).
 *
 * The `config <sub>` subcommands are the mutable knobs, each writing the global
 * `settings.json`: `sandbox` toggles the landstrip OS sandbox (off by default,
 * agent §4.1), `memory` toggles cross-session memory, `dynamic-subagents`
 * configures the self-generated sub-agents envelope (dynamic-subagents §D2).
 */
import type { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '@enterprise-agent/agent';
import type { SubAgentCapability } from '@enterprise-agent/agent-contract';
import { SUB_AGENT_CAPABILITIES } from '@enterprise-agent/agent-contract';
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
        print(`  maxConcurrency ${eff.maxConcurrency}`);
        print(`  maxSteps       ${eff.maxSteps}`);
        print(`  readRoots      ${formatReadRoots(eff.readRoots)}`);
        print(`  动态子Agent    ${formatDynamic(eff.dynamicSubAgents)}`);
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

  // Extra read-only roots (agent §4): a "read + run, never write" boundary on the
  // same channel as skill dirs — e.g. the config dir — without widening the
  // writable workspace. Writes the global `settings.readRoots`; a gateway channel
  // can also scope its own via gateway.json (merged global → scope).
  const readRoots = config
    .command('read-roots')
    .alias('rr')
    .description('管理只读根目录（读+运行、不可写、不经文件工具；写 global settings.json，agent §4）')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const roots = ctx.config.loadSettings().readRoots ?? [];
        print(color.bold('只读根目录（global settings.readRoots）'));
        if (!roots.length) {
          print(color.muted('  （未配置）'));
        } else {
          for (const r of roots) {
            print(`  ${existsSync(r) ? color.success('✓') : color.warning('⚠ 缺失')} ${r}`);
          }
        }
        printErr(
          color.muted(
            [
              '子命令：',
              '  ea config read-roots add <dir...>     新增（相对路径按当前目录解析为绝对路径）',
              '  ea config read-roots remove <dir...>  移除',
              '  ea config read-roots clear            清空',
              '说明：子进程可读、可作 cwd 运行，但不可写、agent 的 readFile/listDir 仍够不着。',
            ].join('\n'),
          ),
        );
      });
    });

  readRoots
    .command('add <dirs...>')
    .description('新增只读根目录（去重；相对路径解析为绝对路径）')
    .action(async (dirs: string[]) => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        const cur = settings.readRoots ?? [];
        const added = dirs.map((d) => resolve(d));
        const next = [...new Set([...cur, ...added])];
        settings.readRoots = next;
        ctx.config.saveSettings(settings);
        for (const r of added) {
          const tag = cur.includes(r) ? color.muted('（已存在）') : existsSync(r) ? color.success('✓') : color.warning('⚠ 目录不存在，构建会话时将被跳过');
          print(`  ${tag} ${r}`);
        }
      });
    });

  readRoots
    .command('remove <dirs...>')
    .alias('rm')
    .description('移除只读根目录（按解析后的绝对路径匹配）')
    .action(async (dirs: string[]) => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        const cur = settings.readRoots ?? [];
        const drop = new Set(dirs.map((d) => resolve(d)));
        const next = cur.filter((r) => !drop.has(r));
        if (next.length) settings.readRoots = next;
        else delete settings.readRoots; // empty → unset, keeps settings.json tidy
        ctx.config.saveSettings(settings);
        const removed = cur.length - next.length;
        print(removed ? color.success(`✓ 已移除 ${removed} 项，剩余 ${next.length} 项`) : color.muted('未匹配到任何项'));
      });
    });

  readRoots
    .command('clear')
    .description('清空只读根目录')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const settings = ctx.config.loadSettings();
        delete settings.readRoots;
        ctx.config.saveSettings(settings);
        print(color.success('✓ 已清空 readRoots'));
      });
    });

  // The former `ea config bypass` is gone — the classifier-skipping relaxation is
  // now the `full` execution mode (EXECUTION_MODE.FULL), selected live with
  // Shift+Tab in the TUI or via setExecutionMode, not a settings.json flag.

  // Self-generated sub-agents envelope (dynamic-subagents §D2). The orchestrator
  // synthesizes ephemeral workers; this envelope is the SOLE capability ceiling.
  // Off by default (enterprise opt-in); write/exec locked out until widened.
  const dyn = config
    .command('dynamic-subagents')
    .alias('dyn')
    .description('配置自生成式子 Agent 的能力包络（dynamic-subagents §D2，写 global settings.json）')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const eff = ctx.config.effective(undefined, []);
        print(color.bold('动态子 Agent 包络（global）'));
        print(`  enabled         ${eff.dynamicSubAgents.enabled ? color.success('✓ 启用') : color.danger('✗ 已关闭')}`);
        print(`  maxCapabilities ${formatNameList(eff.dynamicSubAgents.maxCapabilities)}`);
        print(`  mcpAllow        ${formatMcpAllow(eff.dynamicSubAgents.mcpAllow)}`);
        print(`  defaultModel    ${eff.dynamicSubAgents.defaultModel ?? color.muted('（orchestrator 模型）')}`);
        print(`  defaultTimeout  ${formatTimeout(eff.dynamicSubAgents.defaultTimeoutMs)}`);
        print(
          `  evaluation      ${eff.dynamicSubAgents.evaluation.enabled ? color.success('✓') : color.danger('✗')} ` +
            `when=${eff.dynamicSubAgents.evaluation.when}${
              eff.dynamicSubAgents.evaluation.model ? ` model=${eff.dynamicSubAgents.evaluation.model}` : ''
            }`,
        );
        printErr(
          color.muted(
            [
              '子命令：',
              '  ea config dyn on | off | default            熔断开关',
              `  ea config dyn caps <tokens...> | default     能力天花板（${SUB_AGENT_CAPABILITIES.join('/')}）`,
              '  ea config dyn mcp all | none | <servers...>  MCP 上限（all=不限/none=全禁/白名单）',
              '  ea config dyn timeout <ms|off>               缺省墙钟超时',
              '  ea config dyn model <alias> | default        缺省模型',
              '  ea config dyn eval on|off|always|on-failure|model <alias>  执行后评估',
            ].join('\n'),
          ),
        );
      });
    });

  dyn
    .command('on')
    .description('启用动态子 Agent')
    .action(async () => setDyn(getGlobal(), (d) => ({ ...d, enabled: true }), '✓ 动态子 Agent → 启用'));
  dyn
    .command('off')
    .description('关闭动态子 Agent（delegateToSubAgent 不再挂载）')
    .action(async () => setDyn(getGlobal(), (d) => ({ ...d, enabled: false }), '✓ 动态子 Agent → 已关闭'));
  dyn
    .command('default')
    .description('恢复动态子 Agent 包络默认（关闭、read+http）')
    .action(async () => setDyn(getGlobal(), () => undefined, '✓ 已恢复默认（关闭，read+http）'));

  dyn
    .command('caps [tokens...]')
    .description('设置能力天花板（read/write/exec/http），或 default 恢复默认')
    .action(async (tokens: string[]) => {
      if (tokens.length === 1 && tokens[0]!.toLowerCase() === 'default') {
        await setDyn(getGlobal(), (d) => ({ ...d, maxCapabilities: undefined }), '✓ maxCapabilities → 默认（read,http）');
        return;
      }
      const lower = tokens.map((t) => t.toLowerCase());
      const unknown = lower.filter((t) => !(SUB_AGENT_CAPABILITIES as readonly string[]).includes(t));
      if (unknown.length) {
        printErr(color.danger(`✗ 未知能力：${unknown.join(', ')}（可选：${SUB_AGENT_CAPABILITIES.join(', ')}）`));
        process.exitCode = 1;
        return;
      }
      const caps = [...new Set(lower)] as SubAgentCapability[];
      await setDyn(getGlobal(), (d) => ({ ...d, maxCapabilities: caps }), `✓ maxCapabilities → ${formatNameList(caps)}`);
    });

  dyn
    .command('mcp [servers...]')
    .description('设置 MCP 服务器白名单上限；all 不限 / none 全禁 / <servers...> 白名单')
    .action(async (servers: string[]) => {
      const first = (servers[0] ?? '').toLowerCase();
      if (first === 'all') {
        await setDyn(getGlobal(), (d) => ({ ...d, mcpAllow: true }), '✓ mcpAllow → all（不限服务器）');
        return;
      }
      if (servers.length === 0 || first === 'none' || first === 'off') {
        await setDyn(getGlobal(), (d) => ({ ...d, mcpAllow: false }), '✓ mcpAllow → none（全禁）');
        return;
      }
      const list = [...new Set(servers)];
      await setDyn(getGlobal(), (d) => ({ ...d, mcpAllow: list }), `✓ mcpAllow → ${formatNameList(list)}`);
    });

  dyn
    .command('timeout <value>')
    .description('设置缺省墙钟超时 ms（off=0 关闭）')
    .action(async (value: string) => {
      const ms = parseMs(value);
      if (ms === null) {
        printErr(color.danger(`✗ 非法毫秒值：${value}`));
        process.exitCode = 1;
        return;
      }
      await setDyn(getGlobal(), (d) => ({ ...d, defaultTimeoutMs: ms }), `✓ defaultTimeoutMs → ${formatTimeout(ms)}`);
    });

  dyn
    .command('model <alias>')
    .description('设置缺省模型（alias 或 provider:model）；default 恢复 orchestrator 模型')
    .action(async (alias: string) => {
      const v = alias.toLowerCase() === 'default' ? undefined : alias;
      await setDyn(getGlobal(), (d) => ({ ...d, defaultModel: v }), `✓ defaultModel → ${v ?? 'orchestrator 模型'}`);
    });

  dyn
    .command('eval <action> [model]')
    .description('执行后评估：on | off | always | on-failure | model <alias>')
    .action(async (action: string, model?: string) => {
      const a = action.toLowerCase();
      if (a === 'on' || a === 'off') {
        await setDyn(
          getGlobal(),
          (d) => ({ ...d, evaluation: { ...d.evaluation, enabled: a === 'on' } }),
          `✓ evaluation → ${a === 'on' ? '启用' : '关闭'}`,
        );
        return;
      }
      if (a === 'always' || a === 'on-failure' || a === 'on-failure-or-violation') {
        const when = a === 'always' ? 'always' : 'on-failure-or-violation';
        await setDyn(getGlobal(), (d) => ({ ...d, evaluation: { ...d.evaluation, when } }), `✓ evaluation.when → ${when}`);
        return;
      }
      if (a === 'model') {
        const v = !model || model.toLowerCase() === 'default' ? undefined : model;
        await setDyn(
          getGlobal(),
          (d) => ({ ...d, evaluation: { ...d.evaluation, model: v } }),
          `✓ evaluation.model → ${v ?? 'orchestrator 模型'}`,
        );
        return;
      }
      printErr(color.danger(`✗ 无法识别：${action}（on|off|always|on-failure|model <alias>）`));
      process.exitCode = 1;
    });
}

/** Mutate the global `dynamicSubAgents` settings block and persist. `undefined` → unset (defaults). */
async function setDyn(
  global: GlobalOpts,
  update: (d: NonNullable<import('@enterprise-agent/agent-contract').ScopedConfig['dynamicSubAgents']>) =>
    | NonNullable<import('@enterprise-agent/agent-contract').ScopedConfig['dynamicSubAgents']>
    | undefined,
  ok: string,
): Promise<void> {
  await withCtx(global, async (ctx) => {
    const settings = ctx.config.loadSettings();
    const next = update(settings.dynamicSubAgents ?? {});
    if (next === undefined) delete settings.dynamicSubAgents;
    else settings.dynamicSubAgents = next;
    ctx.config.saveSettings(settings);
    print(color.success(ok));
  });
}

/** Parse "off"/"0"/<ms> → a non-negative integer, or null if invalid. */
function parseMs(s: string): number | null {
  if (s.toLowerCase() === 'off') return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function formatTimeout(ms: number): string {
  return ms > 0 ? `${ms}ms` : color.muted('关闭');
}

function formatMcpAllow(mcp: boolean | string[]): string {
  if (mcp === true) return 'all（不限）';
  if (mcp === false) return color.muted('none（全禁）');
  return formatNameList(mcp);
}

function formatDynamic(d: {
  enabled: boolean;
  maxCapabilities: string[];
  mcpAllow: boolean | string[];
}): string {
  if (!d.enabled) return color.danger('✗ 关闭');
  const mcp = d.mcpAllow === true ? 'all' : d.mcpAllow === false ? 'none' : `[${d.mcpAllow.join(',')}]`;
  return `${color.success('✓ 启用')} caps=[${d.maxCapabilities.join(',')}] mcp=${mcp}`;
}

function formatExecutionMode(mode: string): string {
  // full is the riskiest (classifier skipped) → warn-colored; ask is the default.
  if (mode === 'full') return color.warning('⚡ full（边界关闭·仅提权/高危删除）');
  if (mode === 'auto') return color.accent('auto（分类器）');
  if (mode === 'plan') return color.accent('plan');
  return color.muted('ask（默认）');
}

function formatNameList(names: string[]): string {
  return names.length ? names.join(', ') : color.muted('（无）');
}

function formatReadRoots(roots: string[]): string {
  if (!roots.length) return color.muted('（无）');
  // Flag missing dirs — they're silently dropped at session build (agent §4).
  return roots.map((r) => (existsSync(r) ? r : color.warning(`${r}（缺失）`))).join(', ');
}

function summarizePermission(p: { allowCommands?: string[]; allowHosts?: string[]; allowPaths?: string[] }): string {
  const parts: string[] = [];
  if (p.allowCommands?.length) parts.push(`allowCmd=${p.allowCommands.length}`);
  if (p.allowHosts?.length) parts.push(`allowHosts=${p.allowHosts.length}`);
  if (p.allowPaths?.length) parts.push(`allowPaths=${p.allowPaths.length}`);
  return parts.join(' ') || color.muted('（默认）');
}
