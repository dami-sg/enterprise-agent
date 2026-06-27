/**
 * `ea serve` (cli §8 daemon 模式): start the in-process host behind an HTTP+SSE
 * transport so other shells — most of all a desktop app that does
 * `spawn('ea', ['serve'])` — can drive it as a sidecar. Foreground by default
 * (lives and dies with the parent that spawned it); `--detach` backgrounds it.
 *
 * On boot it prints ONE handshake line to stdout — `{"event":"serve-ready",
 * url, token, pid}` — so the parent can wait for readiness and learn the bearer
 * token without scraping logs. All human-facing logging goes to stderr to keep
 * stdout a clean machine channel.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import type { GlobalOpts } from './util.js';
import { printErr } from './util.js';
import { color } from '../core/color.js';
import { EXIT } from '../headless/run.js';
import { bootstrap } from '../host/bootstrap.js';
import { startServeServer } from '../serve/server.js';
import { createLogger, installProcessGuards, ErrorLog, createPaths } from '@enterprise-agent/agent';

interface ServeOpts {
  port?: string;
  host?: string;
  token?: string;
  detach?: boolean;
}

export function registerServe(program: Command, getGlobal: () => GlobalOpts): void {
  program
    .command('serve')
    .description('启动 HTTP+SSE 服务，把 host 暴露给桌面 app 当 sidecar（cli §8）')
    .option('--port <port>', 'TCP 端口（默认 4096）', '4096')
    .option('--host <addr>', '绑定地址（默认 127.0.0.1，勿对外暴露）', '127.0.0.1')
    .option('--token <token>', 'Bearer token（默认随机生成）')
    .option('--detach', '后台运行（默认前台，随父进程生命周期）')
    .action(async (opts: ServeOpts) => {
      const port = Number(opts.port ?? '4096');
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        printErr(color.danger(`无效端口：${opts.port}`));
        process.exitCode = EXIT.bootstrap;
        return;
      }
      if (opts.detach) return runDetached(getGlobal(), opts, port);
      await runForeground(getGlobal(), opts, port);
    });
}

/** Foreground: own the host for the process's lifetime; tear down on a signal. */
async function runForeground(global: GlobalOpts, opts: ServeOpts, port: number): Promise<void> {
  const ctx = bootstrap({ root: global.root });
  // Crash guard for the resident sidecar (observability §3): record an uncaught
  // exception / unhandled rejection (gateway.log-style stderr + errors.jsonl)
  // before it would otherwise kill the daemon silently. stderr stays the human
  // channel; stdout is the machine handshake, so the logger writes stderr only.
  const logger = createLogger({ stderr: true });
  const errorLog = new ErrorLog(createPaths(global.root).errorsLog);
  installProcessGuards({
    logger,
    recordError: (rec) => errorLog.record(rec),
    onFatal: () => ctx.dispose(),
  });
  const handle = await startServeServer({
    host: ctx.host,
    port,
    bindHost: opts.host,
    token: opts.token,
    log: (l) => printErr(color.muted(l)),
  });

  // The machine-readable readiness handshake (stdout, single line). Parents that
  // spawn the sidecar parse this; humans read the stderr log above.
  process.stdout.write(
    JSON.stringify({ event: 'serve-ready', url: handle.url, token: handle.token, pid: process.pid }) + '\n',
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    printErr(color.muted(`[serve] ${signal} 收到，正在关闭…`));
    await handle.close();
    await ctx.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // The listening server keeps the event loop alive; return and idle until a signal.
}

/** `--detach`: re-spawn ourselves in the background and report where it landed. */
function runDetached(global: GlobalOpts, opts: ServeOpts, port: number): void {
  // Mint the token in the PARENT so we can report it even though the child owns
  // the server; pass it down so both sides agree.
  const token = opts.token ?? randomBytes(24).toString('hex');
  const bindHost = opts.host ?? '127.0.0.1';

  const args = [process.argv[1]!, 'serve', '--port', String(port), '--host', bindHost, '--token', token];
  if (global.root) args.push('--root', global.root);

  const child = spawn(process.argv[0]!, args, {
    detached: true,
    stdio: 'ignore', // fully背景化；前台 child 自己的 handshake 无人读取
  });
  child.unref();

  const url = `http://${bindHost}:${port}`;
  process.stdout.write(JSON.stringify({ event: 'serve-detached', url, token, pid: child.pid }) + '\n');
  printErr(color.success(`[serve] 已后台启动（pid ${child.pid}）：${url}`));
}
