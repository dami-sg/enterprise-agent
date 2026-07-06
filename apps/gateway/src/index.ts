/**
 * @enterprise-agent/gateway — the Gateway shell (gateway-architecture.md). This
 * barrel exports the reusable pieces a host or test drives: the channel
 * abstraction (§3), the Router / Dispatcher / Runtime (§2/§4), the ChatRenderer
 * (§5), the config surface (§7), and the Telegram / WeChat adapters (§8/§9).
 */
export * from './channels/adapter.js';
export { TelegramAdapter, type TelegramOptions } from './channels/telegram.js';
export { WeixinAdapter, type WeixinOptions } from './channels/weixin.js';
export { WhatsAppAdapter } from './channels/whatsapp.js';
export {
  ILinkClient,
  ILINK_DEFAULT_BASE,
  ILINK_ITEM,
  ILINK_CHANNEL_VERSION,
  wechatUin,
  type ILinkMessage,
  type ILinkItem,
} from './channels/weixin-ilink.js';
export { parseAesKey, aesEcbDecrypt } from './channels/weixin-media.js';
export { WeixinStateStore, type AccountState } from './channels/weixin-state.js';

export { GatewayRuntime, type GatewayRuntimeOptions } from './runtime/gateway.js';
export { Dispatcher, type DispatcherOptions, type PlatformControl } from './runtime/dispatcher.js';
export { Router, shouldReset, routeKey, type RouteEntry } from './runtime/router.js';
export { isAdmin, commandAllowed } from './runtime/auth.js';
export {
  approvalView,
  approvalTextPrompt,
  approvalAutoNotice,
  type ApprovalView,
  type ApprovalChoice,
} from './runtime/approval.js';
export {
  questionPrompt,
  parseAnswer,
  renderTodoList,
  renderSubAgentCard,
  type SubAgentProgress,
} from './runtime/interactive.js';

export { ConversationRenderer, type RendererOptions } from './render/chat-render.js';
export { splitForLimit } from './render/split.js';
export { identity, toPlainish } from './render/markdown.js';

export { parseSlash, isBuiltin, BUILTIN_COMMANDS, ADMIN_COMMANDS, type SlashCommand } from './commands/slash.js';

export {
  loadGatewayConfig,
  saveGatewayConfig,
  resolveToken,
  enabledChannels,
  type GatewayConfig,
  type ChannelConfig,
  type ChannelSessionConfig,
  type ResetConfig,
  type ResetMode,
  type KeyRef,
} from './config/gateway-config.js';
export { createGatewayPaths, type GatewayPaths } from './config/paths.js';

export { bootstrapGateway, keychainOnly, type GatewayContext } from './host/bootstrap.js';
export {
  runWeixinLogin,
  completeWeixinLogin,
  weixinKeyRef,
  type WeixinLoginResult,
  type WeixinConfirmedStatus,
} from './weixin/login.js';

export { startWebUI, type WebUiOptions, type WebUiHandle } from './web/server.js';
export { startGatewayAppRpcServer, type GatewayAppRpcOptions, type GatewayAppRpcHandle } from './web/app-rpc-server.js';
export { GatewayAdmin, providerKeyRef, isLocalBase, type AdminDeps } from './web/admin.js';
