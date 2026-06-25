#!/usr/bin/env node
/**
 * `ea-gateway` entry point (gateway §10). A plain Node service — no OpenTUI — so
 * it runs under systemd / launchd / Docker. Commands: `start` (default, run the
 * resident gateway), `status`, `route`, and `weixin login` (§8.3). Reuses the
 * CLI bootstrap for the host + keychain so the gateway sees the same providers /
 * keys / sessions the CLI configured (gateway §1).
 */
import { Command } from 'commander';
import { bootstrapGateway, keychainOnly } from './host/bootstrap.js';
import { readSecretInput } from './host/secret-input.js';
import { createGatewayPaths } from './config/paths.js';
import { loadGatewayConfig, enabledChannels } from './config/gateway-config.js';
import { GatewayRuntime } from './runtime/gateway.js';
import { writeGatewayPid, clearGatewayPid } from './runtime/gateway-process.js';
import { Router } from './runtime/router.js';
import { IdentityStore } from './accounts/identity-store.js';
import { SessionStore } from './accounts/session-store.js';
import { runWeixinLogin } from './weixin/login.js';
import { startWebUI } from './web/server.js';
import { startWebChat } from './web/chat-server.js';

interface GlobalOpts {
  root?: string;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ea-gateway')
    .description('Enterprise Agent Gateway — 常驻多会话即时通讯网关（gateway-architecture.md）')
    .version('0.0.1')
    .option('--root <dir>', 'App 数据根目录（默认 ~/.enterprise-agent）');

  const global = (): GlobalOpts => ({ root: program.opts<{ root?: string }>().root });

  program
    .command('start', { isDefault: true })
    .description('启动网关：连 host、按 gateway.json 拉起各通道适配器')
    .action(async () => {
      await runStart(global());
    });

  program
    .command('status')
    .description('查看通道配置与会话路由')
    .action(async () => {
      runStatus(global());
    });

  program
    .command('ui')
    .description('启动本地 Web 配置面板（从 0 可视化配置：模型 / 通道 / 密钥 / 微信扫码）')
    .option('--port <n>', '端口（默认 7317）', (v) => Number(v))
    .option('--host <addr>', '监听地址（默认 127.0.0.1，请勿暴露公网）')
    .action(async (opts: { port?: number; host?: string }) => {
      const handle = await startWebUI({ root: global().root, port: opts.port, host: opts.host });
      process.stderr.write(`在浏览器打开 ${handle.url} 进行配置（Ctrl-C 退出）。\n`);
      await new Promise<void>((resolve) => {
        let shutting = false;
        const shutdown = async (): Promise<void> => {
          if (shutting) return;
          shutting = true;
          await handle.dispose();
          resolve();
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      });
    });

  const route = program.command('route').description('管理会话路由表（routes.json）');
  route
    .command('ls')
    .description('列出所有 channel:conversationId → sessionId 映射')
    .action(() => {
      const gp = createGatewayPaths(global().root);
      const entries = new Router(gp.routes).entries();
      if (entries.length === 0) {
        process.stdout.write('（无路由）\n');
        return;
      }
      for (const { key, entry } of entries) {
        process.stdout.write(`${key} → ${entry.sessionId}\n`);
      }
    });
  route
    .command('rm <channel> <conversationId>')
    .description('删除一条路由（下条消息将新建会话）')
    .action((channel: string, conversationId: string) => {
      const gp = createGatewayPaths(global().root);
      new Router(gp.routes).unbind(channel, conversationId);
      process.stdout.write(`✓ 已删除 ${channel}:${conversationId}\n`);
    });

  const secret = program.command('secret').description('网关机密管理（keychain，仅引用进配置，§7）');
  secret
    .command('set <ref>')
    .description('把一个 token/密钥写入 keychain（如 telegram-bot-token）')
    .option('--value <v>', '直接提供值（否则从 stdin 管道或交互掩码读取）')
    .action(async (ref: string, opts: { value?: string }) => {
      const { keychain, insecure } = keychainOnly(global().root);
      const value = opts.value ?? (await readSecretInput(`输入 ${ref} 的值（输入即掩码）: `));
      if (!value) {
        process.stderr.write('值为空，未写入。\n');
        return;
      }
      keychain.set(ref, value);
      process.stdout.write(`✓ 已写入 keychain（keyRef=${ref}${insecure ? '，0600 文件后备' : ''}）\n`);
    });
  secret
    .command('check <ref>')
    .description('检查某 keyRef 是否已存在（不打印明文）')
    .action((ref: string) => {
      const { keychain } = keychainOnly(global().root);
      process.stdout.write(keychain.get(ref) !== undefined ? `✓ 存在：${ref}\n` : `✗ 不存在：${ref}\n`);
    });
  secret
    .command('rm <ref>')
    .description('从 keychain 删除一个 keyRef')
    .action((ref: string) => {
      const { keychain } = keychainOnly(global().root);
      keychain.delete(ref);
      process.stdout.write(`✓ 已删除：${ref}\n`);
    });

  const weixin = program.command('weixin').description('微信 iLink 通道工具');
  weixin
    .command('login')
    .description('扫码登录微信 iLink Bot，写入 keychain + gateway.json（§8.3）')
    .option('--account <id>', '账号 id（默认取 ilink_bot_id）')
    .option('--base-url <url>', 'iLink 接入域名（默认 https://ilinkai.weixin.qq.com）')
    .action(async (opts: { account?: string; baseUrl?: string }) => {
      const { keychain, insecure, paths } = keychainOnly(global().root);
      if (insecure) {
        process.stderr.write('⚠ 未检测到系统 keychain，bot_token 将以 0600 文件存储（安全性较低）。\n');
      }
      await runWeixinLogin({
        keychain,
        paths,
        accountId: opts.account,
        baseURL: opts.baseUrl,
      });
    });

  const account = program
    .command('account')
    .description('账号与跨渠道身份绑定（cross-channel-memory §3 / web-app §3）');
  account
    .command('create')
    .description('创建账号，打印 accountId')
    .option('--name <displayName>', '显示名')
    .action((opts: { name?: string }) => {
      const store = identityStore(global().root);
      const a = store.createAccount({ displayName: opts.name });
      process.stdout.write(`✓ 已创建账号：${a.accountId}${a.displayName ? `（${a.displayName}）` : ''}\n`);
    });
  account
    .command('bind <provider> <userId> <accountId>')
    .description('把渠道身份绑定到账号（如：account bind telegram 111 acct_xxx）')
    .action((provider: string, userId: string, accountId: string) => {
      const store = identityStore(global().root);
      try {
        store.bind(provider, userId, accountId);
        process.stdout.write(`✓ 已绑定 ${provider}:${userId} → ${accountId}\n`);
      } catch (err) {
        process.stderr.write(`✗ ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    });
  account
    .command('unbind <provider> <userId>')
    .description('解绑一个渠道身份')
    .action((provider: string, userId: string) => {
      const store = identityStore(global().root);
      const ok = store.unbind(provider, userId);
      process.stdout.write(ok ? `✓ 已解绑 ${provider}:${userId}\n` : `（无此绑定：${provider}:${userId}）\n`);
    });
  account
    .command('ls')
    .description('列出账号及其绑定的渠道身份')
    .action(() => {
      const store = identityStore(global().root);
      const accounts = store.listAccounts();
      if (accounts.length === 0) {
        process.stdout.write('（无账号）\n');
        return;
      }
      for (const a of accounts) {
        const ids = store.listIdentities(a.accountId).map((i) => `${i.provider}:${i.providerUserId}`);
        process.stdout.write(`${a.accountId}${a.displayName ? `（${a.displayName}）` : ''}\n`);
        process.stdout.write(ids.length ? `  ${ids.join(', ')}\n` : '  （无绑定）\n');
      }
    });
  account
    .command('login <accountId>')
    .description('为账号签发开发用会话令牌（curl/浏览器测试，免 OAuth）')
    .option('--ttl <days>', '有效期天数（默认 30）', (v) => parseInt(v, 10))
    .action((accountId: string, opts: { ttl?: number }) => {
      const store = identityStore(global().root);
      if (!store.getAccount(accountId)) {
        process.stderr.write(`✗ 账号不存在：${accountId}（先 ea-gateway account create）\n`);
        process.exitCode = 1;
        return;
      }
      const sessions = new SessionStore(createGatewayPaths(global().root).identityDir);
      const { token } = sessions.issue(accountId, { ttlMs: (opts.ttl ?? 30) * 24 * 60 * 60_000 });
      process.stdout.write(`✓ 会话令牌（请求带 Cookie: ea_session=<令牌>）：\n${token}\n`);
    });

  program
    .command('web')
    .description('启动公网 Web 聊天端（独立于 admin 面板，§4/§6）')
    .option('--port <n>', '端口（默认 7318）', (v) => parseInt(v, 10))
    .option('--host <addr>', '绑定地址（默认 127.0.0.1）')
    .option('--workspace <dir>', '按账号隔离的工作区根目录')
    .action(async (opts: { port?: number; host?: string; workspace?: string }) => {
      const handle = await startWebChat({
        root: global().root,
        port: opts.port,
        host: opts.host,
        workspaceBase: opts.workspace,
      });
      process.stderr.write(`[gateway] Web 聊天端：${handle.url}（Ctrl-C 退出）\n`);
      await new Promise<void>((resolve) => {
        const shutdown = async (): Promise<void> => {
          await handle.dispose();
          resolve();
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      });
    });

  return program;
}

function identityStore(root?: string): IdentityStore {
  return new IdentityStore(createGatewayPaths(root).identityDir);
}

async function runStart(global: GlobalOpts): Promise<void> {
  const ctx = bootstrapGateway(global.root);
  const config = loadGatewayConfig(ctx.paths.gatewayConfig);
  const runtime = new GatewayRuntime({
    host: ctx.host,
    keychain: ctx.keychain,
    config,
    root: global.root,
    memory: ctx.memory,
  });

  await runtime.start();
  // Record our PID so the Web panel can see "running" and stop/restart us (§7).
  writeGatewayPid(ctx.paths, process.pid, Date.now());
  process.stderr.write('[gateway] 已启动，等待消息（Ctrl-C 退出）。\n');

  await new Promise<void>((resolve) => {
    let shutting = false;
    const shutdown = async (): Promise<void> => {
      if (shutting) return;
      shutting = true;
      process.stderr.write('\n[gateway] 正在关闭…\n');
      clearGatewayPid(ctx.paths); // absence ⇒ "stopped" (a clean exit, not a crash)
      await runtime.stop();
      await ctx.dispose();
      resolve();
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}

function runStatus(global: GlobalOpts): void {
  const gp = createGatewayPaths(global.root);
  const config = loadGatewayConfig(gp.gatewayConfig);
  process.stdout.write(`gateway.json: ${gp.gatewayConfig}\n`);
  if (config.channels.length === 0) {
    process.stdout.write('（未配置通道）\n');
  } else {
    process.stdout.write('通道：\n');
    for (const c of config.channels) {
      const on = c.enabled !== false ? '启用' : '停用';
      const tok = c.token ? `keyRef=${c.token.keyRef}` : '无 token';
      process.stdout.write(`  · ${c.name}${c.accountId ? `(${c.accountId})` : ''} [${on}] ${tok}\n`);
    }
  }
  const routes = new Router(gp.routes).entries();
  process.stdout.write(`路由（${routes.length}）：\n`);
  for (const { key, entry } of routes) {
    process.stdout.write(`  · ${key} → ${entry.sessionId}\n`);
  }
  // touch enabledChannels so a misconfig (0 enabled) is visible at a glance.
  if (enabledChannels(config).length === 0 && config.channels.length > 0) {
    process.stdout.write('⚠ 没有已启用的通道。\n');
  }
}

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`ea-gateway: ${(err as Error).message}\n`);
    process.exit(1);
  });
