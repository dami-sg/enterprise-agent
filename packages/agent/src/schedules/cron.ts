/**
 * Minimal cron / interval evaluation for schedules (§7 定时编排). Self-contained
 * (no dependency): a standard 5-field cron expression
 * `minute hour day-of-month month day-of-week`, each field supporting a star, a
 * step ("star slash n"), an `a-b` range, and an `a,b` list; or a coarse
 * `every: <n><s|m|h|d>` interval.
 *
 * Next-fire is found by scanning forward minute-by-minute from `from + 1min`
 * (cron has minute granularity) until a match, capped at ~366 days so an
 * unsatisfiable expression returns undefined instead of looping forever.
 *
 * NOTE: evaluated in the HOST's local timezone. A `timezone:` field is accepted by
 * the registry but not yet honored here (best-effort; a tz-correct pass is future
 * work). Classic cron day-of-month/day-of-week semantics apply: when BOTH are
 * restricted, a match on EITHER fires.
 */

/** Parse `every: <n><unit>` (s|m|h|d) to milliseconds; undefined if malformed. */
export function parseEvery(spec: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(spec.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

/** A parsed cron field = the set of integers it matches within [min,max]. */
function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const stepM = /^(.+?)(?:\/(\d+))?$/.exec(part.trim());
    if (!stepM) return undefined;
    const base = stepM[1]!.trim();
    const hasStep = stepM[2] !== undefined;
    const step = hasStep ? Number(stepM[2]) : 1;
    if (!Number.isInteger(step) || step <= 0) return undefined;
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      // A bare number WITH a step (`N/step`) is standard cron for "start at N,
      // then every `step` up to max" — e.g. `0/15` → {0,15,30,45}. Without a step
      // it's a single value. Previously `0/15` collapsed to just {0}.
      lo = Number(base);
      hi = hasStep ? max : lo;
    } else {
      const r = /^(\d+)-(\d+)$/.exec(base);
      if (!r) return undefined;
      lo = Number(r[1]);
      hi = Number(r[2]);
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : undefined;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether dom/dow were both restricted (≠ '*') → OR semantics. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a 5-field cron expression; undefined if malformed. */
export function parseCron(expr: string): CronSpec | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const minute = parseField(f[0]!, 0, 59);
  const hour = parseField(f[1]!, 0, 23);
  const dom = parseField(f[2]!, 1, 31);
  const month = parseField(f[3]!, 1, 12);
  const dow = parseField(f[4]!, 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: f[2] !== '*',
    dowRestricted: f[4] !== '*',
  };
}

/** Whether a Date (local time) matches the cron spec. */
function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  // Classic cron: both restricted → OR; otherwise the unrestricted one is '*'.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

const MAX_SCAN_MINUTES = 366 * 24 * 60;

/**
 * Next fire time strictly after `fromMs` for a cron expression, or undefined if
 * unparseable / unsatisfiable within ~366 days. Minute granularity (seconds zeroed).
 */
export function nextCronAfter(expr: string, fromMs: number): number | undefined {
  const spec = parseCron(expr);
  if (!spec) return undefined;
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (matches(spec, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

/**
 * Next fire time after `fromMs` for a schedule's `cron` or `every` spec, or
 * undefined when neither is set / valid (the schedule then only runs manually).
 */
export function nextRunAfter(
  spec: { cron?: string; every?: string },
  fromMs: number,
): number | undefined {
  if (spec.cron) return nextCronAfter(spec.cron, fromMs);
  if (spec.every) {
    const ms = parseEvery(spec.every);
    return ms === undefined ? undefined : fromMs + ms;
  }
  return undefined;
}
