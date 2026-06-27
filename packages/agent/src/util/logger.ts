/**
 * Minimal structured logger for host shells (observability §5). NOT used by
 * core — core stays event-driven and logs nothing internally (agent §6.2);
 * this serves the CLI / Gateway daemons that need an operational, file-backed,
 * level-filtered log. Deliberately ~no deps (pure node:fs) — not pino/winston.
 *
 * Sinks: stderr (text, for a TTY) and/or a size-rotated file (json or text).
 * Levels gate by `LOG_LEVEL`. Secrets are redacted on the way out (§9).
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact, redactString } from './redact.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface FileSinkOptions {
  path: string;
  /** Rotate once the file exceeds this many bytes (default 5 MiB). */
  maxBytes?: number;
  /** How many rotated files to keep: `.log.1` … `.log.<keep>` (default 3). */
  keep?: number;
}

export interface LoggerOptions {
  /** Min level to emit; defaults to `LOG_LEVEL` env, then 'info'. */
  level?: Level;
  /** 'text' (human) or 'json' (ndjson). Default: stderr-is-TTY → text, else json. */
  format?: 'text' | 'json';
  file?: FileSinkOptions;
  /** Write to stderr too (default true). */
  stderr?: boolean;
  /** Mask secrets in msg/fields (default true, §9). */
  redact?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derive a logger that stamps `fields` onto every line (observability §6). */
  child(fields: Record<string, unknown>): Logger;
}

function envLevel(): Level | undefined {
  const v = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : undefined;
}

function envFormat(): 'text' | 'json' | undefined {
  const v = (process.env.EA_LOG_FORMAT ?? '').toLowerCase();
  return v === 'text' || v === 'json' ? v : undefined;
}

/** Positive integer env override, else undefined. */
function envInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Shared, dependency-free size rotation (also used by §4's gateway.log). */
function rotateIfNeeded(opt: FileSinkOptions): void {
  const max = opt.maxBytes ?? envInt('EA_LOG_MAX_BYTES') ?? 5 * 1024 * 1024;
  const keep = opt.keep ?? envInt('EA_LOG_KEEP') ?? 3;
  let size = 0;
  try {
    size = statSync(opt.path).size;
  } catch {
    return; // no file yet → nothing to rotate
  }
  if (size < max) return;
  // gateway.log.(keep-1) → .keep, … , gateway.log → .1  (oldest dropped)
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${opt.path}.${i}`, `${opt.path}.${i + 1}`);
    } catch {
      /* missing rung is fine */
    }
  }
  try {
    renameSync(opt.path, `${opt.path}.1`);
  } catch {
    /* lost the race / vanished — next write recreates */
  }
}

interface Sink {
  format: 'text' | 'json';
  stderr: boolean;
  file?: FileSinkOptions;
  redact: boolean;
  ensuredDir: boolean;
}

function formatText(ts: string, level: Level, msg: string, fields: Record<string, unknown>): string {
  const keys = Object.keys(fields);
  const tail = keys.length ? ` {${keys.map((k) => `${k}=${stringifyField(fields[k])}`).join(', ')}}` : '';
  return `${ts} ${level.toUpperCase()} ${msg}${tail}`;
}

function stringifyField(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[unserializable]';
    }
  }
  return String(v);
}

function write(sink: Sink, level: Level, msg: string, fields: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safeMsg = sink.redact ? redactString(msg) : msg;
  const safeFields = sink.redact ? (redact(fields) as Record<string, unknown>) : fields;
  const line =
    sink.format === 'json'
      ? JSON.stringify({ ts, level, msg: safeMsg, ...safeFields })
      : formatText(ts, level, safeMsg, safeFields);
  if (sink.stderr) process.stderr.write(line + '\n');
  if (sink.file) {
    try {
      if (!sink.ensuredDir) {
        mkdirSync(dirname(sink.file.path), { recursive: true });
        sink.ensuredDir = true;
      }
      rotateIfNeeded(sink.file);
      appendFileSync(sink.file.path, line + '\n', 'utf8');
    } catch {
      // never let a logging failure crash the daemon
    }
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? envLevel() ?? 'info'];
  const sink: Sink = {
    format: opts.format ?? envFormat() ?? (process.stderr.isTTY ? 'text' : 'json'),
    stderr: opts.stderr ?? true,
    file: opts.file,
    redact: opts.redact ?? true,
    ensuredDir: false,
  };
  const make = (base: Record<string, unknown>): Logger => {
    const at = (level: Level) => (msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[level] < min) return;
      write(sink, level, msg, { ...base, ...fields });
    };
    return {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make({});
}

/** A no-op logger for tests / contexts that want to opt out cheaply. */
export const NULL_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NULL_LOGGER;
  },
};
