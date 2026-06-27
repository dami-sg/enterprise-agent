/**
 * `ea doctor` (observability §7): a health-check on top of `ea config`'s
 * read-only view. Where `config` shows the effective settings, `doctor` probes
 * connectivity + integrity — provider keys, the sandbox binary, MCP servers,
 * disk writability, the model catalog — and tails the recent error log. Each
 * line is ✓ / ⚠ / ✗; the process exits 1 if any ✗, so systemd / CI can gate on
 * health.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { McpHub, resolveLandstripBinary, type KeyStore } from '@enterprise-agent/agent';
import type { GlobalOpts } from './util.js';
import { print, withCtx } from './util.js';
import { color } from '../core/color.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  status: Status;
  label: string;
  detail: string;
}

function line(c: Check): string {
  const mark =
    c.status === 'ok' ? color.success('✓') : c.status === 'warn' ? color.warning('⚠') : color.danger('✗');
  return `  ${mark} ${c.label.padEnd(14)} ${c.detail}`;
}

export function registerDoctor(program: Command, getGlobal: () => GlobalOpts): void {
  program
    .command('doctor')
    .description('运行环境自检：密钥 / 沙箱 / MCP / 磁盘 / 模型 + 最近错误（observability §7）')
    .option('--session <id>', '按某 Session 作用域检查（MCP / 配置）')
    .action(async (opts: { session?: string }) => {
      await withCtx(getGlobal(), async (ctx) => {
        const checks: Check[] = [];
        const all = await ctx.host.listSessions();
        const target = opts.session ? all.find((s) => s.id === opts.session) : all.find((s) => s.isActive);
        const eff = ctx.config.effective(target?.config, target ? ctx.config.loadSessionAliases(target.id) : []);

        // 1. App data root writable.
        checks.push(checkDiskWritable(ctx.paths.root));

        // 2. Sandbox: enabled + binary resolvable.
        if (!eff.sandboxEnabled) {
          checks.push({ status: 'warn', label: 'sandbox', detail: '已关闭——工具写/执行无 landstrip 边界（agent §4.1）' });
        } else {
          const bin = await resolveLandstripBinary(ctx.paths.cache).catch(() => undefined);
          checks.push(
            bin
              ? { status: 'ok', label: 'sandbox', detail: `启用，landstrip：${bin}` }
              : { status: 'fail', label: 'sandbox', detail: '启用但无法解析 landstrip 二进制（平台不支持或下载失败）' },
          );
        }

        // 3. Provider keys.
        const providers = ctx.config.loadProviders().filter((p) => p.enabled);
        if (providers.length === 0) {
          checks.push({ status: 'warn', label: 'providers', detail: '未配置任何启用的 provider（ea provider add）' });
        } else {
          for (const p of providers) {
            if (!p.keyRef) {
              // openai-compatible local endpoints may legitimately need no key.
              checks.push({ status: 'warn', label: `provider:${p.id}`, detail: '无 keyRef（本地端点可忽略）' });
              continue;
            }
            const has = ctx.keychain.get(p.keyRef) !== undefined;
            checks.push(
              has
                ? { status: 'ok', label: `provider:${p.id}`, detail: `keyRef=${p.keyRef} 已就绪` }
                : { status: 'fail', label: `provider:${p.id}`, detail: `keyRef=${p.keyRef} 在 keychain 中缺失` },
            );
          }
        }

        // 4. Orchestrator model alias resolves to an enabled provider.
        checks.push(checkOrchestrator(eff.orchestratorAlias, providers.map((p) => p.id)));

        // 5. MCP servers — attempt a live connect (per-server isolation, agent §3.5).
        checks.push(...(await checkMcp(ctx.config.mcpConfigPaths(target?.id), ctx.keychain)));

        // 6. Recent errors from the durable log (observability §2).
        const recent = ctx.host.recentErrors(5);
        checks.push({
          status: recent.length ? 'warn' : 'ok',
          label: 'errors.jsonl',
          detail: recent.length ? `最近 ${recent.length} 条错误（见下）` : '无近期错误',
        });

        // -- render --
        print(color.bold(`运行自检${target ? `（${target.name}）` : ''}`));
        for (const c of checks) print(line(c));
        if (recent.length) {
          print('');
          print(color.muted('最近错误：'));
          for (const e of recent) {
            const when = new Date(e.ts).toISOString();
            print(color.muted(`  · ${when} [${e.source}${e.runId ? `/${e.runId}` : ''}] ${e.message}`));
          }
        }

        const fails = checks.filter((c) => c.status === 'fail').length;
        const warns = checks.filter((c) => c.status === 'warn').length;
        print('');
        if (fails) {
          print(color.danger(`✗ ${fails} 项失败，${warns} 项警告`));
          process.exitCode = 1;
        } else if (warns) {
          print(color.warning(`⚠ ${warns} 项警告，无失败`));
        } else {
          print(color.success('✓ 全部检查通过'));
        }
      });
    });
}

function checkDiskWritable(root: string): Check {
  try {
    const dir = mkdtempSync(join(root, '.doctor-'));
    writeFileSync(join(dir, 'probe'), 'ok');
    rmSync(dir, { recursive: true, force: true });
    return { status: 'ok', label: 'disk', detail: `${root} 可写` };
  } catch (err) {
    return { status: 'fail', label: 'disk', detail: `${root} 不可写：${(err as Error).message}` };
  }
}

function checkOrchestrator(alias: string, providerIds: string[]): Check {
  if (!alias) return { status: 'fail', label: 'model', detail: 'orchestrator alias 为空' };
  // Aliases are `provider/model` or a bare alias name; only the provider-qualified
  // form is checkable here without resolving the full alias table.
  const slash = alias.indexOf('/');
  if (slash > 0) {
    const prov = alias.slice(0, slash);
    return providerIds.includes(prov)
      ? { status: 'ok', label: 'model', detail: `orchestrator=${alias}` }
      : { status: 'warn', label: 'model', detail: `orchestrator=${alias}，但 provider '${prov}' 未启用` };
  }
  return { status: 'ok', label: 'model', detail: `orchestrator=${alias}` };
}

async function checkMcp(paths: string[], keychain: KeyStore): Promise<Check[]> {
  const configs = McpHub.loadConfigs(paths);
  if (configs.length === 0) return [{ status: 'ok', label: 'mcp', detail: '未配置 MCP server' }];
  const hub = new McpHub(keychain);
  const errors = new Map<string, string>();
  await hub.connect(configs, (server, message) => errors.set(server, message));
  await hub.close().catch(() => {});
  return configs.map((cfg) =>
    errors.has(cfg.name)
      ? { status: 'fail', label: `mcp:${cfg.name}`, detail: errors.get(cfg.name)!.slice(0, 120) }
      : { status: 'ok', label: `mcp:${cfg.name}`, detail: '连接成功' },
  );
}
