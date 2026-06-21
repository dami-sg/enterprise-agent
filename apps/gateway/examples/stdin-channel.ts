/**
 * 本地终端通道示例（无需任何 IM 账号）。
 *
 * 它实现一个最弱能力的 `ChannelAdapter`（无 edit / 无按钮，像微信 §8），把终端
 * stdin 当作入向消息、stdout 当作出向，直接驱动真实的 GatewayRuntime 链路：
 * Router → Dispatcher → AgentHost → ChatRenderer。于是你可以在终端里和真实 agent
 * 对话，端到端验证路由、审批、问答、计划、命令、会话重置 —— 全程不碰 Telegram。
 *
 * 运行（需先 `pnpm -r build` 并用 CLI 配好 provider + orchestrator 模型）：
 *   cd apps/gateway && bun examples/stdin-channel.ts
 *
 * 退出：Ctrl-C。审批：高风险调用会提示 `/approve` 或 `/deny`。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  bootstrapGateway,
  Dispatcher,
  Router,
  identity,
  type ChannelAdapter,
  type InboundMessage,
  type MessageRef,
  type OutboundPayload,
  type SendTarget,
} from '@enterprise-agent/gateway';

const CONVERSATION = 'local';

class StdinChannel implements ChannelAdapter {
  readonly name = 'local';
  readonly maxChars = 100_000;
  private mid = 0;

  async start(_onInbound: (m: InboundMessage) => void): Promise<void> {
    /* messages are fed in by the readline loop below */
  }

  async send(_target: SendTarget, payload: OutboundPayload): Promise<MessageRef> {
    const text = payload.kind === 'text' ? payload.text : payload.kind === 'buttons' ? payload.text : '[media]';
    process.stdout.write(`\n🤖 ${text}\n> `);
    return { conversationId: CONVERSATION, messageId: `m${++this.mid}` };
  }

  // typing 指示（可选）：弱通道也能实现
  async typing(_target: SendTarget, on: boolean): Promise<void> {
    if (on) process.stdout.write('  …(thinking)\n');
  }

  async stop(): Promise<void> {}
}

async function main(): Promise<void> {
  const ctx = bootstrapGateway();
  const channel = new StdinChannel();
  const router = new Router(join(tmpdir(), `ea-gateway-local-routes-${process.pid}.json`));
  const dispatcher = new Dispatcher({
    host: ctx.host,
    router,
    verbose: true,
    onError: (err) => process.stderr.write(`[err] ${(err as Error).message}\n`),
  });
  dispatcher.registerChannel(
    channel,
    // 弱通道（无按钮）+ reject 策略 → 高风险调用走 /approve 文本审批。
    // 想测“完全无人值守自动放行”，把 approval 改成 'auto:session'。
    { name: 'local', session: { executionMode: 'ask' }, approval: 'reject' },
    identity,
  );
  dispatcher.subscribe();
  await channel.start(() => {});

  process.stdout.write('本地网关已就绪。输入消息回车发送；高风险调用用 /approve /deny；Ctrl-C 退出。\n> ');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      process.stdout.write('> ');
      return;
    }
    void dispatcher.handleInbound('local', {
      channel: 'local',
      conversationId: CONVERSATION,
      userId: 'me',
      text,
    });
  });

  const shutdown = async (): Promise<void> => {
    rl.close();
    dispatcher.dispose();
    await ctx.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
}

void main();
