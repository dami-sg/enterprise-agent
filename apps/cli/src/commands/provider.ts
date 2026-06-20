/**
 * Provider & auth commands (cli §9.1 / §10). A provider is the access config
 * for a model source — a `kind` + user-chosen `id` + optional `baseURL` +
 * `keyRef`. The three security rules hold throughout: masked input, only the
 * `keyRef` is persisted to `providers.json`, and plaintext lands only in the
 * keychain (agent §4).
 */
import type { Command } from 'commander';
import type { ProviderConfig, ProviderKind } from '@enterprise-agent/agent-contract';
import { BUILTIN_PROVIDERS, findProviderPreset } from '@enterprise-agent/agent';
import type { GlobalOpts } from './util.js';
import { formatTable, print, printErr, withCtx } from './util.js';
import { readSecret } from './secret.js';
import type { CliContext } from '../host/bootstrap.js';
import { color } from '../core/color.js';

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'gateway'];

function keyRefFor(id: string): string {
  return `${id}.key`;
}

/** A baseURL pointing at localhost needs no key (agent §2.6 discovery table). */
export function isLocalBase(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const h = new URL(baseURL).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

export function registerProvider(program: Command, getGlobal: () => GlobalOpts): void {
  const provider = program.command('provider').description('Provider 接入管理（cli §9.1/§10）');

  provider
    .command('ls')
    .description('列出已配置的 Provider 及模型发现数')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const providers = ctx.config.loadProviders();
        if (!providers.length) {
          printErr(color.muted('（无 Provider — `ea provider add` 添加模型来源，§10）'));
          return;
        }
        const rows = await Promise.all(
          providers.map(async (p) => {
            const keyCell = keyStatus(ctx.keychain.get(p.keyRef ?? keyRefFor(p.id)), p);
            let count = '—';
            try {
              const res = await ctx.host.listProviderModels(p.id);
              count = res.fetchedAt === 0 && p.kind === 'anthropic' ? `${res.models.length}*` : String(res.models.length);
            } catch {
              count = '?';
            }
            return [
              p.id,
              p.kind,
              p.baseURL ?? color.muted('—（官方）'),
              keyCell,
              count,
              p.enabled ? color.success('● 启用') : color.muted('○ 停用'),
            ];
          }),
        );
        print(formatTable(['id', 'kind', 'baseURL', 'key', '模型', '状态'], rows));
      });
    });

  provider
    .command('presets')
    .description('列出内置 Provider 预设（已知来源 + 端点，§9.1）')
    .action(() => {
      const rows = BUILTIN_PROVIDERS.map((p) => [
        p.id,
        p.name,
        p.kind,
        p.baseURL ?? color.muted('—（官方）'),
        p.requiresKey ? 'key' : color.muted('本地'),
        p.note ? color.muted(p.note) : '',
      ]);
      print(formatTable(['preset', 'name', 'kind', 'baseURL', 'key', '备注'], rows));
      printErr(color.muted('用 `ea provider add --preset <preset>` 一键接入。'));
    });

  provider
    .command('add')
    .description('新增 Provider（§10 向导：preset 或 kind → id/baseURL → key → 发现模型）')
    .option('--preset <preset>', '内置预设（见 `ea provider presets`）')
    .option('--kind <kind>', `接入类型：${KINDS.join(' | ')}`)
    .option('--id <id>', 'Provider id（providers.json 键 + 模型 ref 前缀；预设默认取其 id）')
    .option('--base-url <url>', 'openai-compatible/gateway 必填（含版本前缀，如 …/v1）')
    .action(async (opts: { preset?: string; kind?: string; id?: string; baseUrl?: string }) => {
      let kind: ProviderKind;
      let id: string;
      let baseUrl: string | undefined;

      if (opts.preset) {
        const preset = findProviderPreset(opts.preset);
        if (!preset) throw new Error(`未知预设 "${opts.preset}"（见 \`ea provider presets\`）`);
        kind = preset.kind;
        id = opts.id ?? preset.id;
        baseUrl = opts.baseUrl ?? preset.baseURL;
        printErr(color.muted(`预设 ${preset.name}（${preset.kind}${preset.baseURL ? ` · ${preset.baseURL}` : ''}）`));
      } else {
        if (!opts.kind || !opts.id) throw new Error('需 --preset，或同时给 --kind 与 --id');
        kind = opts.kind as ProviderKind;
        id = opts.id;
        baseUrl = opts.baseUrl;
      }

      if (!KINDS.includes(kind)) throw new Error(`未知 kind: ${kind}`);
      if ((kind === 'openai-compatible' || kind === 'gateway') && !baseUrl) {
        throw new Error(`${kind} 必须提供 --base-url（含版本前缀，§10）`);
      }

      await withCtx(getGlobal(), async (ctx) => {
        const keyRef = keyRefFor(id);
        const needKey = !isLocalBase(baseUrl);
        if (needKey) {
          const key = await readSecret('输入 API Key（输入即掩码，本地端点可留空回车）: ');
          if (key) ctx.keychain.set(keyRef, key);
          else printErr(color.muted('（未输入 key —— 可稍后 `ea auth login` 补）'));
        } else {
          printErr(color.muted('（本地端点 → 跳过 key，agent §2.6）'));
        }
        const cfg: ProviderConfig = {
          id,
          kind,
          baseURL: baseUrl,
          keyRef: needKey ? keyRef : undefined,
          enabled: true,
        };
        const providers = ctx.config.loadProviders().filter((p) => p.id !== id);
        providers.push(cfg);
        ctx.config.saveProviders(providers);
        print(color.success(`✓ 写入 providers.json（id=${id}，keyRef=${needKey ? keyRef : '—'}，仅引用不含明文）`));
        await discover(ctx, id);
      });
    });

  provider
    .command('enable <id>')
    .description('启用 Provider（写 providers.json）')
    .action((id: string) => toggle(getGlobal(), id, true));

  provider
    .command('disable <id>')
    .description('停用 Provider')
    .action((id: string) => toggle(getGlobal(), id, false));

  provider
    .command('rm <id>')
    .description('删除 Provider 及其 keychain 密钥')
    .action(async (id: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const providers = ctx.config.loadProviders();
        const target = providers.find((p) => p.id === id);
        if (!target) throw new Error(`provider ${id} not found`);
        ctx.config.saveProviders(providers.filter((p) => p.id !== id));
        if (target.keyRef) ctx.keychain.delete(target.keyRef);
        print(color.success(`✓ 已删除 provider ${id} 及其密钥`));
      });
    });

  // -- auth: key-only shortcuts (cli §10) --
  const auth = program.command('auth').description('Provider 密钥管理（cli §10）');

  auth
    .command('login [id]')
    .description('设置/更新已存在 Provider 的 Key（跳到 §10 步骤 3）')
    .action(async (id?: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const providers = ctx.config.loadProviders();
        const target = id ? providers.find((p) => p.id === id) : providers[0];
        if (!target) throw new Error(id ? `provider ${id} not found` : '无 Provider — 先 `ea provider add`');
        const keyRef = target.keyRef ?? keyRefFor(target.id);
        const key = await readSecret(`输入 ${target.id} 的 API Key: `);
        if (!key) throw new Error('未输入 key');
        ctx.keychain.set(keyRef, key);
        if (!target.keyRef) {
          ctx.config.saveProviders(providers.map((p) => (p.id === target.id ? { ...p, keyRef } : p)));
        }
        print(color.success(`✓ 已写入 keychain（keyRef=${keyRef}）`));
      });
    });

  auth
    .command('logout [id]')
    .description('删除 Provider 的 Key（保留 provider 配置）')
    .action(async (id?: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const providers = ctx.config.loadProviders();
        const target = id ? providers.find((p) => p.id === id) : providers[0];
        if (!target?.keyRef) throw new Error('未找到对应 keyRef');
        ctx.keychain.delete(target.keyRef);
        print(color.success(`✓ 已删除 ${target.id} 的密钥`));
      });
    });

  auth
    .command('ls')
    .description('列出 Provider 的 keyRef 与是否已配（绝不显明文）')
    .action(async () => {
      await withCtx(getGlobal(), async (ctx) => {
        const rows = ctx.config.loadProviders().map((p) => {
          const ref = p.keyRef ?? keyRefFor(p.id);
          const present = ctx.keychain.get(ref) !== undefined;
          return [p.id, ref, present ? color.success('✓ 已配') : color.muted('—')];
        });
        print(formatTable(['id', 'keyRef', 'key'], rows));
        if (ctx.keychainInfo.insecure) {
          printErr(color.warning('⚠ 当前使用文件密钥库（非系统 keychain）— 见 cli §7'));
        }
      });
    });
}

async function toggle(global: GlobalOpts, id: string, enabled: boolean): Promise<void> {
  await withCtx(global, async (ctx) => {
    const providers = ctx.config.loadProviders();
    if (!providers.some((p) => p.id === id)) throw new Error(`provider ${id} not found`);
    ctx.config.saveProviders(providers.map((p) => (p.id === id ? { ...p, enabled } : p)));
    print(color.success(`✓ ${id} → ${enabled ? '启用' : '停用'}`));
  });
}

async function discover(ctx: CliContext, id: string): Promise<void> {
  try {
    const res = await ctx.host.listProviderModels(id, { refresh: true });
    if (res.error) {
      printErr(color.muted(`  （模型发现回退兜底：${res.error}）`));
    }
    print(color.success(`✓ 发现 ${res.models.length} 个模型${res.fetchedAt ? ' · 已缓存 24h' : '（内置）'}`));
  } catch (err) {
    printErr(color.muted(`  （模型发现失败，已静默忽略：${(err as Error).message}）`));
  }
}

function keyStatus(value: string | undefined, p: ProviderConfig): string {
  if (value !== undefined) return color.success('✓');
  if (isLocalBase(p.baseURL)) return color.muted('—');
  return color.danger('✗');
}
