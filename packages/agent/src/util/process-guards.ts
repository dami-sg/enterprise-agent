/**
 * Process-level error guards (observability §3). Without these an uncaught
 * exception or unhandled rejection silently kills a resident daemon (gateway /
 * serve) with no trace. We install handlers that record first (to gateway.log
 * AND errors.jsonl, with stack), then for a truly fatal uncaughtException run a
 * best-effort graceful shutdown and exit(1). Unhandled rejections are recorded
 * but do NOT exit — most are a recoverable missing `.catch`, and tearing the
 * daemon down on one would be worse than leaving a trace to fix.
 *
 * Stacks: redaction happens inside ErrorLog/Logger, so secrets in a stack are
 * masked before they land (§9).
 */
import type { ErrorRecord } from '@dami-sg/agent-contract';
import type { Logger } from './logger.js';

export interface ProcessGuardOptions {
  logger: Logger;
  /** Sink for the structured record (ErrorLog.record). Optional. */
  recordError?: (rec: Omit<ErrorRecord, 'ts'>) => void;
  /** Best-effort graceful shutdown before exit on a fatal uncaughtException. */
  onFatal?: () => Promise<void> | void;
  /** Override exit (tests). Default process.exit. */
  exit?: (code: number) => void;
}

/** Returns an uninstall fn (removes the listeners). */
export function installProcessGuards(opts: ProcessGuardOptions): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const onUncaught = (err: unknown): void => {
    const e = err as Error;
    opts.logger.error(`uncaughtException: ${e?.message ?? String(err)}`, { fatal: true });
    opts.recordError?.({
      source: 'process',
      message: `uncaughtException: ${e?.message ?? String(err)}`,
      stack: e?.stack,
    });
    void Promise.resolve(opts.onFatal?.())
      .catch(() => {})
      .finally(() => exit(1));
  };

  const onRejection = (reason: unknown): void => {
    const e = reason as Error;
    opts.logger.error(`unhandledRejection: ${e?.message ?? String(reason)}`);
    opts.recordError?.({
      source: 'process',
      message: `unhandledRejection: ${e?.message ?? String(reason)}`,
      stack: e?.stack,
    });
    // intentionally no exit — recoverable, just留痕
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}
