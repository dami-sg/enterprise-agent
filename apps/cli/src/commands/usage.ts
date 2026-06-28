/**
 * Usage analytics view (agent §2.7). A read-only lens over the durable usage
 * ledger: group token spend by any combination of dimensions (message / agent /
 * model / provider / system-overhead category / hour / day / month), with an
 * optional time range and equality filters.
 */
import type { Command } from 'commander';
import type { UsageDimension, UsageQuery } from '@enterprise-agent/agent-contract';
import type { GlobalOpts } from './util.js';
import { formatTable, print, printErr, withCtx } from './util.js';
import { fmtTok } from '../core/trace.js';
import { color } from '../core/color.js';

/** CLI dimension aliases → ledger dimensions (friendlier names). */
const DIM_ALIAS: Record<string, UsageDimension> = {
  message: 'entryId',
  msg: 'entryId',
  session: 'sessionId',
  agent: 'agentId',
  model: 'modelRef',
  provider: 'provider',
  category: 'category',
  system: 'category',
  hour: 'hour',
  day: 'day',
  month: 'month',
};

function parseDims(by?: string): UsageDimension[] {
  if (!by) return ['day'];
  const dims: UsageDimension[] = [];
  for (const raw of by.split(',').map((s) => s.trim()).filter(Boolean)) {
    const dim = DIM_ALIAS[raw.toLowerCase()];
    if (!dim) throw new Error(`未知维度 '${raw}'（可选：${Object.keys(DIM_ALIAS).join(', ')}）`);
    if (!dims.includes(dim)) dims.push(dim);
  }
  return dims;
}

/** Parse a date/time string to epoch ms, or undefined. Throws on a bad value. */
function parseTime(s: string | undefined, label: string): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) throw new Error(`无法解析${label}时间 '${s}'（用如 2026-06-01 或 2026-06-01T09:00）`);
  return t;
}

export function registerUsage(program: Command, getGlobal: () => GlobalOpts): void {
  program
    .command('usage')
    .description('Token 用量统计（按消息/agent/模型/系统开销/时段等维度，agent §2.7）')
    .option('--by <dims>', '分组维度，逗号分隔：message,agent,model,provider,category,hour,day,month', 'day')
    .option('--since <when>', '起始时间（含），如 2026-06-01')
    .option('--until <when>', '结束时间（不含），如 2026-07-01')
    .option('--model <ref>', '仅统计某模型 provider:model')
    .option('--provider <id>', '仅统计某 provider')
    .option('--category <cat>', '仅统计某类：orchestrator|sub-agent|compaction|classifier|title')
    .option('--session <id>', '仅统计某会话')
    .action(
      async (opts: {
        by?: string;
        since?: string;
        until?: string;
        model?: string;
        provider?: string;
        category?: string;
        session?: string;
      }) => {
        await withCtx(getGlobal(), async (ctx) => {
          let query: UsageQuery;
          try {
            query = {
              groupBy: parseDims(opts.by),
              from: parseTime(opts.since, '起始'),
              to: parseTime(opts.until, '结束'),
              filter: {
                ...(opts.model ? { modelRef: opts.model } : {}),
                ...(opts.provider ? { provider: opts.provider } : {}),
                ...(opts.category ? { category: opts.category } : {}),
                ...(opts.session ? { sessionId: opts.session } : {}),
              },
            };
          } catch (e) {
            printErr(color.warning(String((e as Error).message)));
            return;
          }

          const rows = await ctx.host.queryUsage(query);
          if (!rows.length) {
            print(color.muted('（无用量记录）'));
            return;
          }

          const dims = query.groupBy;
          const headers = [...dims, 'in', 'out', '推理', '缓存', '$', '次'];
          const table = rows.map((r) => [
            ...dims.map((d) => String(r.key[d] ?? '')),
            fmtTok(r.inputTokens),
            fmtTok(r.outputTokens),
            r.reasoningTokens ? fmtTok(r.reasoningTokens) : color.muted('—'),
            r.cachedInputTokens ? fmtTok(r.cachedInputTokens) : color.muted('—'),
            `$${r.cost.toFixed(4)}`,
            String(r.calls),
          ]);
          print(formatTable(headers, table));

          // Grand total footer.
          const sum = rows.reduce(
            (a, r) => ({ inp: a.inp + r.inputTokens, out: a.out + r.outputTokens, cost: a.cost + r.cost, calls: a.calls + r.calls }),
            { inp: 0, out: 0, cost: 0, calls: 0 },
          );
          print(
            color.muted(
              `合计：in ${fmtTok(sum.inp)} · out ${fmtTok(sum.out)} · $${sum.cost.toFixed(4)} · ${sum.calls} 次调用`,
            ),
          );
        });
      },
    );
}
