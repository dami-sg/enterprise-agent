/**
 * Models view (cli §9.2). Two read-only lenses over the same config the agent
 * resolves from (agent §2.6): the effective alias map (global → workspace
 * override) with capability validation, and the per-provider discovery list
 * (`union(动态, 内置)`) used by the alias picker.
 */
import type { Command } from 'commander';
import type { ModelMeta } from '@dami-sg/agent-contract';
import type { GlobalOpts } from './util.js';
import { formatTable, print, printErr, withCtx } from './util.js';
import { fmtTok } from '../core/trace.js';
import { color } from '../core/color.js';

export function registerModels(program: Command, getGlobal: () => GlobalOpts): void {
  const models = program
    .command('models')
    .description('模型别名（生效值）或某 Provider 的发现列表（cli §9.2）')
    .option('--provider <id>', '列出该 Provider 发现到的模型（union 动态+内置）')
    .option('--refresh', '绕过 24h 缓存强制重拉（agent §2.6）')
    .action(async (opts: { provider?: string; refresh?: boolean }) => {
      await withCtx(getGlobal(), async (ctx) => {
        if (opts.provider) {
          const res = await ctx.host.listProviderModels(opts.provider, { refresh: !!opts.refresh });
          const rows = res.models.map((m) => {
            // Meta fields come straight off the discovery result (host-authoritative);
            // no separate ctx.meta lookup needed (agent §2.6).
            return [
              m.ref,
              m.contextWindow != null ? fmtTok(m.contextWindow) : color.muted('?'),
              m.hasMeta ? (m.capabilities ?? []).join(' ') : color.muted('?'),
              m.hasMeta ? color.success('✓meta') : color.warning('无定价'),
              m.source === 'dynamic' ? color.muted('动态') : color.muted('内置'),
            ];
          });
          print(
            color.muted(
              `${opts.provider} · 动态 ${res.models.filter((m) => m.source === 'dynamic').length} + 内置 ` +
                `${res.models.filter((m) => m.source === 'static').length}` +
                (res.cached ? ' · 缓存' : '') +
                (res.error ? color.warning(` · 回退兜底（${res.error}）`) : ''),
            ),
          );
          print(formatTable(['ref', 'ctx', '能力', 'meta', '来源'], rows));
          return;
        }

        // Effective alias map (global → workspace override merged).
        const eff = ctx.config.effective(undefined, []);
        const byAlias = new Map(eff.aliases.map((a) => [a.alias, a]));
        const aliasNames = new Set<string>([eff.orchestratorAlias, ...byAlias.keys()]);

        const rows: string[][] = [];
        const warnings: string[] = [];
        for (const name of aliasNames) {
          const a = byAlias.get(name);
          const ref = a?.ref ?? color.muted('（未定义）');
          const meta: ModelMeta | undefined = a ? ctx.meta.get(a.ref) : undefined;
          const caps = (a?.capabilities ?? meta?.capabilities ?? []).join(' ');
          rows.push([
            name,
            ref,
            meta ? fmtTok(meta.contextWindow) : '',
            caps || color.muted('—'),
            meta?.price ? `${meta.price.input}/${meta.price.output}` : color.muted('—'),
          ]);
          if (a && !caps.includes('tool_call')) {
            warnings.push(`⚠ ${name} 别名解析到的模型不含 \`tool_call\` 能力——子 Agent 会失败（agent §2.6 pt.2）`);
          }
        }
        print(formatTable(['别名', '→ ref', 'ctx', '能力', '$/Mtok'], rows));
        for (const w of warnings) printErr(color.warning(w));
      });
    });

  models
    .command('set <alias> <ref>')
    .description('绑定别名 → provider:model（写 global aliases.json，agent §2.6）')
    .action(async (alias: string, ref: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const [providerId] = ref.split(':');
        if (!ref.includes(':') || !providerId) throw new Error(`ref 须为 provider:model（收到 "${ref}"）`);
        const provider = ctx.config.loadProviders().find((p) => p.id === providerId);
        if (!provider) printErr(color.warning(`⚠ 未找到 provider "${providerId}"——先 \`ea provider add\``));
        else if (!provider.enabled) printErr(color.warning(`⚠ provider "${providerId}" 已停用，别名暂不会解析`));

        const aliases = ctx.config.loadGlobalAliases().filter((a) => a.alias !== alias);
        aliases.push({ alias, ref });
        ctx.config.saveGlobalAliases(aliases);
        print(color.success(`✓ ${alias} → ${ref}`));
        if (alias === 'orchestrator' || alias === (ctx.config.loadSettings().model?.orchestratorAlias ?? '')) {
          print(color.muted('  （这是 orchestrator 生效别名，新会话即用此模型）'));
        }
      });
    });

  models
    .command('rm <alias>')
    .description('删除一个别名绑定')
    .action(async (alias: string) => {
      await withCtx(getGlobal(), async (ctx) => {
        const before = ctx.config.loadGlobalAliases();
        const after = before.filter((a) => a.alias !== alias);
        if (after.length === before.length) throw new Error(`别名 "${alias}" 不存在`);
        ctx.config.saveGlobalAliases(after);
        print(color.success(`✓ 已删除别名 ${alias}`));
      });
    });
}
