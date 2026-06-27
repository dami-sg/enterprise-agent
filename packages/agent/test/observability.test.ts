import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, NULL_LOGGER } from '../src/util/logger.js';
import { ErrorLog } from '../src/storage/error-log.js';
import { redact, redactString } from '../src/util/redact.js';
import { installProcessGuards } from '../src/util/process-guards.js';
import { telemetryOption } from '../src/runtime/telemetry.js';
import { stackOf } from '../src/util/errors.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'zt-obs-'));
}

describe('redact (observability §9)', () => {
  it('masks secret-looking field keys', () => {
    const out = redact({ apiKey: 'abc', Authorization: 'Bearer x', nested: { token: 't', ok: 1 } });
    expect(out).toEqual({ apiKey: '***', Authorization: '***', nested: { token: '***', ok: 1 } });
  });

  it('masks credential substrings in strings', () => {
    expect(redactString('failed with sk-ABCDEFGH12345678 boom')).toContain('sk-***');
    expect(redactString('ENTERPRISE_AGENT_KEY_OPENAI=sk-zzzzzzzzzzz')).not.toContain('sk-zzz');
    expect(redactString('Authorization: Bearer abcdef123456')).toContain('Bearer ***');
  });

  it('tolerates cycles', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe('Logger (observability §5)', () => {
  it('filters below the configured level', () => {
    const file = join(tmp(), 'l.log');
    const log = createLogger({ level: 'warn', file: { path: file }, stderr: false, format: 'json' });
    log.debug('nope');
    log.info('nope2');
    log.warn('yes');
    log.error('yes2');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe('warn');
    expect(JSON.parse(lines[1]).msg).toBe('yes2');
  });

  it('child() stamps correlation fields onto every line', () => {
    const file = join(tmp(), 'c.log');
    const log = createLogger({ file: { path: file }, stderr: false, format: 'json' }).child({
      runId: 'r_1',
    });
    log.info('hi', { channel: 'telegram' });
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(rec.runId).toBe('r_1');
    expect(rec.channel).toBe('telegram');
  });

  it('redacts secrets before they hit disk', () => {
    const file = join(tmp(), 'r.log');
    const log = createLogger({ file: { path: file }, stderr: false, format: 'json' });
    log.info('boot', { token: 'super-secret' });
    expect(readFileSync(file, 'utf8')).not.toContain('super-secret');
  });

  it('rotates the file once it exceeds maxBytes', () => {
    const dir = tmp();
    const file = join(dir, 'rot.log');
    const log = createLogger({ file: { path: file, maxBytes: 200, keep: 2 }, stderr: false });
    for (let i = 0; i < 50; i++) log.info(`line number ${i} with some padding to grow the file`);
    // primary file exists and a rotated .1 was produced
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(statSync(`${file}.1`).size).toBeGreaterThan(0);
  });
});

describe('ErrorLog (observability §2)', () => {
  it('appends, redacts, and returns recent records', () => {
    const file = join(tmp(), 'errors.jsonl');
    const log = new ErrorLog(file);
    log.record({ runId: 'mcp', source: 'mcp', message: 'token=sk-AAAAAAAA12345678 failed' });
    log.record({ runId: 'r1', source: 'agent', message: 'boom' });
    const recent = log.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].message).toBe('boom');
    expect(log.all()[0].message).not.toContain('sk-AAAA');
  });

  it('tolerates a torn line', () => {
    const file = join(tmp(), 'errors.jsonl');
    writeFileSync(file, '{"ts":1,"source":"agent","message":"ok"}\n{bad json\n');
    expect(new ErrorLog(file).all()).toHaveLength(1);
  });

  it('persists (redacted) stack traces for post-mortem', () => {
    const file = join(tmp(), 'errors.jsonl');
    const log = new ErrorLog(file);
    const err = new Error('failed with sk-ABCDEFGH12345678');
    log.record({ source: 'process', message: err.message, stack: stackOf(err) });
    const [rec] = log.all();
    expect(rec.stack).toContain('Error:');
    expect(rec.stack).not.toContain('sk-ABCDEFGH'); // stack is redacted too
  });
});

describe('stackOf (observability §2/§3)', () => {
  it('returns a stack for Errors and undefined for non-Errors', () => {
    expect(stackOf(new Error('x'))).toContain('Error: x');
    expect(stackOf('just a string')).toBeUndefined();
    expect(stackOf(undefined)).toBeUndefined();
  });
});

describe('process guards (observability §3)', () => {
  it('records + exits on uncaughtException, records but does NOT exit on rejection', async () => {
    const recorded: string[] = [];
    let exitCode: number | undefined;
    const uninstall = installProcessGuards({
      logger: NULL_LOGGER,
      recordError: (r) => recorded.push(`${r.source}:${r.message}`),
      onFatal: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });

    process.emit('unhandledRejection', new Error('async oops'), Promise.resolve());
    expect(recorded.some((r) => r.includes('async oops'))).toBe(true);
    expect(exitCode).toBeUndefined(); // rejection must not exit

    process.emit('uncaughtException', new Error('fatal boom'));
    await new Promise((r) => setTimeout(r, 0)); // onFatal runs on a microtask
    expect(recorded.some((r) => r.includes('fatal boom'))).toBe(true);
    expect(exitCode).toBe(1);

    uninstall();
  });
});

describe('telemetry opt-in (observability §8)', () => {
  it('is off by default and on when EA_OTEL is set', () => {
    delete process.env.EA_OTEL;
    expect(telemetryOption('orchestrator', { runId: 'r1' })).toEqual({});
    process.env.EA_OTEL = '1';
    const opt = telemetryOption('orchestrator', { runId: 'r1', agentId: 'orch' }) as {
      experimental_telemetry: { isEnabled: boolean; functionId: string; metadata: Record<string, string> };
    };
    expect(opt.experimental_telemetry.isEnabled).toBe(true);
    expect(opt.experimental_telemetry.functionId).toBe('orchestrator');
    expect(opt.experimental_telemetry.metadata).toEqual({ runId: 'r1', agentId: 'orch' });
    delete process.env.EA_OTEL;
  });
});
