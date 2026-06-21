/**
 * WhatsApp adapter (gateway §10 P2) — placeholder. Unlike the long-poll channels
 * (Telegram / WeChat), WhatsApp's Business Cloud API is webhook-only and needs a
 * public HTTPS ingress (§3.3), so it lands in P2 alongside the channels-as-plugin
 * work. The class exists so the registry (gateway.ts) is uniformly extensible;
 * `start` fails loud rather than pretending to poll.
 */
import type {
  ChannelAdapter,
  InboundMessage,
  MessageRef,
  OutboundPayload,
  SendTarget,
} from './adapter.js';

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp';
  readonly maxChars = 4096;

  async start(_onInbound: (m: InboundMessage) => void): Promise<void> {
    throw new Error(
      'WhatsApp 适配器尚未实现（gateway §10 P2：需 webhook + HTTPS 公网入口）。当前仅支持 telegram / weixin。',
    );
  }

  async send(_target: SendTarget, _payload: OutboundPayload): Promise<MessageRef> {
    throw new Error('WhatsApp 适配器尚未实现（gateway §10 P2）。');
  }

  async stop(): Promise<void> {
    /* nothing started */
  }
}
