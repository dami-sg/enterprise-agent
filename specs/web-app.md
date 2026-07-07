# Enterprise Agent — Web 端（账号 / OAuth / 聊天）改造 spec

> ⚠️ **已废弃 / 已移除（2026-07，见 [gateway-consolidation.md](gateway-consolidation.md) §P4）**：`ea-gateway web` 公网 Web 聊天端、`/api/chat` SSE、Telegram OAuth 登录（`/api/auth/*`）及 `apps/web` 前端**均已删除**。富客户端统一走 App Server 的 `WS /rpc`（[app-server.md](app-server.md)），认证收敛为**每用户 access key**（`/rpc` Bearer + IM `/bind`），管理走 `ea-gateway ui` 面板。以下内容仅作历史设计存档。
>
> **状态：设计提案（draft）**。本 spec 负责把产品推向**公网多用户的 Web 聊天端**,并建立其底座——**账号体系 + OAuth 登录 + 渠道身份绑定**。Web 端作为与 Telegram/WeChat 平级的一个 **Channel**,复用同一进程内 `AgentHost`。
>
> **配套 spec**:跨渠道记忆见 [`cross-channel-memory.md`](cross-channel-memory.md)。本 spec **拥有**账号与身份层(`accountId`、OAuth、`identities` 表、`resolveAccount()`),记忆 spec 仅**消费**它。两份 spec 的边界:本文负责「这个人是谁、怎么登录、怎么聊天」;记忆 spec 负责「这个人的记忆怎么存取」。
>
> 设计第一原则：**不破坏安全不变量**(沿用 [`declarative-agents-and-schedules.md`](declarative-agents-and-schedules.md))——审批主体仍是用户、权限单调不增、文件边界/sandbox 不被绕过;Web 暴露公网后,**鉴权与多租户隔离是新增的硬约束**。
>
> 关联架构：[`agent-architecture.md`](agent-architecture.md) §7（Channel 抽象）。借鉴 [Vercel ai-chatbot](https://github.com/vercel/ai-chatbot) 的**聊天 UX 与 AI SDK 流协议**,但**不照搬**其 Next.js + Neon + Vercel Blob 基础设施(与本仓库的进程内 `AgentHost`、自托管定位不符)。

---

## 0. 决策摘要（已拍板）

| 决策 | 取定 |
|---|---|
| 前端形态 | **独立精致 Web App**(`apps/web`),非嵌入现有 admin 面板 |
| 部署 | **公网多用户** |
| 登录方式 | **OAuth**:Google 登录 + Telegram 登录(Telegram Login Widget) |
| 与 Telegram 渠道 | Telegram 登录 → **自动绑定** bot 渠道身份(同一 user id);Google 登录 → `/link` 绑定 |
| 多身份绑定 | **允许多对一**:一人的多个身份(多 Telegram 号、Google + IM)归一 `accountId` |
| 前端栈 | Vite + React + TS + Tailwind + shadcn/ui + `@ai-sdk/react` `useChat` |
| 后端 | gateway 进程内 `AgentHost`;默认 `POST /api/chat` SSE(AI SDK UI message stream 协议);实验入口 `?rpc` 通过 app-server `WS /rpc` |
| Web session vs IM session | **独立**(连续性靠记忆,见记忆 spec) |
| 工作区隔离 | 按 **`accountId`** 隔离(替换现按 conversationId) |

---

## 1. 现状盘点

| 关注点 | 现状 | 位置 |
|---|---|---|
| HTTP 服务 | 原生 Node `http`,`127.0.0.1:7317`,**localhost-only + Host 头校验**(防 DNS rebinding) | [server.ts](../apps/gateway/src/web/server.ts) |
| 现有 Web UI | **纯 admin/config 面板**,vanilla JS + 模板字符串,**无构建步骤、无聊天** | [app-html.ts](../apps/gateway/src/web/app-html.ts) |
| 聊天入口 | **仅 IM 渠道**(Telegram/WeChat/WhatsApp);Web 无聊天端点 | [channels/](../apps/gateway/src/channels) |
| 流式输出 | `ConversationRenderer` 把 agent delta 推给 IM(Telegram 编辑消息、WeChat 整段) | [chat-render.ts](../apps/gateway/src/render/chat-render.ts) |
| 入站 → run | `handleInbound` 路由 `channel:conversationId → sessionId`,`startSession`/`sendMessage` | [dispatcher.ts:170](../apps/gateway/src/runtime/dispatcher.ts) |
| Telegram 身份 | `conversationId=chat.id`、`userId=from.id` | [telegram.ts:173](../apps/gateway/src/channels/telegram.ts) |
| 账号 / 鉴权 | **无** | — |
| 工作区 | `workspaceFor` 按 `conversationId` | [dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts) |

**关键缺口**:① 无账号/鉴权;② 无 Web 聊天端点与前端;③ localhost 假设不适配公网;④ 工作区按会话而非账号隔离(多租户会串台)。

---

## 2. 架构总览

```
┌─────────────── apps/web (新, 独立 SPA) ───────────────┐
│ Vite + React + Tailwind + shadcn                       │
│ 登录: Google / Telegram OAuth → 拿 session token        │
│ 聊天: @ai-sdk/react useChat ──POST /api/chat (SSE)──┐   │
│       ?rpc: agent-client ───────WS /rpc─────────────┤   │
│ 记忆面板: 列表 / 删除                                │   │
└────────────────────────────────────────────────────│───┘
                                                      ▼
┌─────────────── apps/gateway (扩展) ──────────────────────┐
│ Web 鉴权中间件 (校验 session token → accountId)            │
│ WebChannel  : 作为 Channel 抽象的一员,接 dispatcher        │
│ 账号层 : accounts / identities / oauth / link              │
│   resolveAccount(channel,userId) → accountId  (供记忆 spec)│
│ POST /api/chat (SSE, AI SDK 协议) · /api/sessions · 历史    │
│ WS /rpc (app-server JSON-RPC, 可由 ea-gateway app-server 提供)│
│ workspaceFor(accountId)  多租户隔离                         │
│ 同一进程内 AgentHost (与 IM 渠道共用)                       │
└───────────────────────────────────────────────────────────┘
```

**与记忆 spec 的接缝**:登录建立 `accountId` → Web 请求即带账号 → `memoryNamespace=accountId`(记忆 spec §3 直接消费)。Telegram 渠道入站时由 `resolveAccount(telegram, from.id)` 解析账号。

---

## 3. 账号与身份层（本 spec 拥有）

### 3.1 数据模型

沿用 gateway JSON-on-disk 风格(公网规模化可平滑替换为 DB,接口不变):

```
accounts.json      Account   { accountId, displayName, createdAt, prefs }
identities.json    Identity  { provider, providerUserId } → accountId
                              google:108…        → acct_abc
                              telegram:111111    → acct_abc   // = bot from.id
oauth-sessions     Session   { token, accountId, expiresAt }   // 登录态(httpOnly cookie)
link-pending.json  LinkToken { token, accountId, expiresAt, used }  // Google 用户绑 Telegram bot
```

- `accountId`:不透明稳定 id(`acct_<rand>`),首次 OAuth 登录时建立。
- `Identity` 唯一约束:`(provider, providerUserId)` 唯一(一个外部身份只属一个账号);**反向多对一**:一个 `accountId` 可绑任意多身份,含**同一 provider 多个号**。已被占用的身份再绑 → 拒绝,提示先解绑。
- **provider 命名统一**:`telegram` 的 `providerUserId` == Telegram 用户 id == bot 收到的 `from.id`——这是「登录身份」与「渠道身份」天然合一的关键(§3.3)。

### 3.2 OAuth 登录

- **Google**:标准 OAuth 2.0 / OIDC(authorization code + PKCE)。回调拿到 Google `sub` → `identities.lookup('google', sub)`,命中则登录,否则建账号。
- **Telegram**:**Telegram Login Widget**(或 bot `/start` deep-link 授权)。校验 Telegram 回传 payload 的 `hash`(用 bot token 派生密钥做 HMAC-SHA256,**必须验签**,防伪造)→ 拿 `id`(Telegram user id)→ `identities.lookup('telegram', id)`。
- 成功后签发 `oauth-session` token(httpOnly + Secure + SameSite cookie),后续请求据此解析 `accountId`。

### 3.3 渠道身份绑定（关键设计）

目标:让 Telegram **bot 私聊**的 `from.id` 能解析到 `accountId`。两条路径:

1. **Telegram 登录即自动绑定**(零额外步骤):用户用 Telegram Login 登录 Web,拿到的 `id` 与 bot 私聊的 `from.id` **是同一个值** → 登录写入的 `identities{telegram, id}` 直接让该 bot 私聊命中账号。**用 Telegram 登录的人,Telegram 渠道身份自动就绪。**
2. **Google 登录者补绑 Telegram**(`/link` 流):
   - Web 已登录(`accountId`)→「绑定 Telegram」→ 签发 `LinkToken`(短 TTL、单次)。
   - 展示 deep-link `https://t.me/<bot>?start=<token>`。
   - 用户点开 → bot 收 `/start <token>` → 校验 token → 写 `identities{telegram, from.id} → accountId`,标记已用。

> 解绑、查看已绑身份:账号设置页提供;解绑同一 provider 最后一个身份需保留至少一种登录方式。

### 3.4 `resolveAccount`（供记忆 spec 消费）

```ts
// 账号层导出;记忆 spec §3 的 resolveNamespace 调用它
export function resolveAccount(provider: string, providerUserId: string): string | undefined {
  return identities.lookup(provider, providerUserId);  // 未绑定 → undefined
}
```

dispatcher 处理 Telegram 入站时:`resolveAccount('telegram', msg.userId)`。未绑定 → 记忆 spec 据此**不记忆**(§3 不变量)。

---

## 4. Web 聊天端

### 4.1 WebChannel:接入 Channel 抽象

Web 不另搞一套对话栈,而是实现一个 `WebChannel`,与 Telegram/WeChat 平级接入 [dispatcher](../apps/gateway/src/runtime/dispatcher.ts):

- **入站**:`POST /api/chat` 把 `{ message }` 构造为 `InboundMessage{ channel:'web', conversationId:<webThreadId>, userId:<accountId>, ... }` 交 dispatcher。
- **路由**:沿用 `channel:conversationId → sessionId`;Web 的 `conversationId` = 该账号的某条 Web 会话线(支持一个账号多条 Web 会话)。
- **出站/流式**:`ConversationRenderer` 的 Web 实现把 agent stream events 写成 **AI SDK UI message stream 协议**(见 §4.2)。

### 4.2 流式端点（AI SDK 协议)

agent 自产 delta(非 `streamText`),因此用 `createUIMessageStream` 的 `writer` **手动把 stream events 翻成协议 parts**:

```
POST /api/chat            body { conversationId?, message }  → SSE: start / text-start / text-delta /
                                                                      text-end / data-tool / data-memory / finish
GET  /api/sessions                                          → 该账号会话列表
GET  /api/session/:id/history                               → 历史(从 session.jsonl 读)
```

```ts
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
const stream = createUIMessageStream({ execute: async ({ writer }) => {
  writer.write({ type: 'start' });
  const id = crypto.randomUUID();
  writer.write({ type: 'text-start', id });
  await host.sendMessage(sessionId, message);             // 复用 IM 同款 run
  // 订阅该 session stream events,逐个翻译:
  //   text delta            → { type:'text-delta', id, delta }
  //   tool-approval/调用     → { type:'data-tool', data }
  //   memory-captured(记忆)  → { type:'data-memory', data }   // 见 §5
  writer.write({ type: 'text-end', id });
}});
pipeUIMessageStreamToResponse({ stream, response: res });
```

前端标准 `useChat({ transport: new DefaultChatTransport({ api: '/api/chat' }) })`,与 Vercel 模板几乎一致。

> 说明:本 spec 的 Web session 与 IM session **独立**(决策),Web 不订阅 IM 触发的轮次、IM 也不订阅 Web。跨端连续性由记忆承担。若将来要「同账号多端实时同 session」,再引入 `GET /api/session/:id/sse` 全量订阅(非本期)。

### 4.2.1 App-server RPC 实验入口

当前代码同时保留旧 Web 聊天流和新 app-server 接入路径：

- 默认 `ChatView` 仍使用 `@ai-sdk/react` 的 `/api/chat` SSE。
- URL 带 `?rpc` 时切到 `RpcChatView`，通过 `@enterprise-agent/agent-client` 连接 same-origin `/rpc`。
- Vite dev server 已把 `/rpc` WebSocket 代理到 `localhost:7320`；服务端由 `ea-gateway app-server` 提供。
- `RpcChatView` 覆盖 approval / question / plan 的 prompt responder，使交互响应走 `approval/respond`、`question/respond`、`plan/respond`，而不是旧 `/api/respond`。

### 4.3 工作区多租户隔离

`workspaceFor` 由按 `conversationId` 改为按 **`accountId`** 隔离([dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts)),每账号独立工作目录,杜绝用户间文件读写串台。IM 渠道同账号共享同一账号工作区。

---

## 5. 记忆在 Web 的呈现（消费记忆 spec）

记忆能力归 [`cross-channel-memory.md`](cross-channel-memory.md);本 spec 只负责 Web 上的**呈现与入口**:

- **写入感知**(默认开):订阅 `memory-captured` 事件 → 对话流内轻量卡片「🧠 已记住:_…_」+「撤销」按钮(撤销调记忆治理删除)。
- **「我的记忆」面板**:列表(记忆 spec `MemoryPort.list`)+ 逐条删除(`MemoryPort.forget`);仅作用于当前 `accountId`(鉴权校验)。
- 账号偏好 `memoryNoticeEnabled`(默认 `true`)在设置页可关。

---

## 6. 安全硬化（公网新增硬约束）

| 项 | 要求 |
|---|---|
| 传输 | 强制 **TLS**;替换「localhost-only + Host 头」假设为真实鉴权 |
| 鉴权 | OAuth + httpOnly/Secure/SameSite cookie session;所有 `/api/*`(除登录/回调)校验 `accountId` |
| CSRF | 状态变更端点加 CSRF token 或严格 SameSite |
| 多租户隔离 | 工作区按 `accountId`(§4.3);记忆按 `accountId`(记忆 spec);会话/历史读写校验归属 |
| Telegram 验签 | Login Widget payload 必须 HMAC 验签(§3.2),`/link` token 短 TTL 单次 |
| 限流/审计 | 按账号限流;登录、绑定、记忆删除等敏感操作审计日志 |
| 越权 | `list/forget/历史/会话` 一律校验资源属当前账号 |
| 现有 admin 面板 | 公网部署时与聊天端**分离鉴权域**或仅内网可达,避免配置面板暴露公网 |

---

## 7. 分阶段实现

| 阶段 | 内容 | 验收 |
|---|---|---|
| **W1a OAuth 核心**（无凭证可测部分）✅ | `IdentityStore` ✅;`SessionStore`(令牌哈希存、TTL、单/批量撤销)✅;`verifyTelegramLogin`(HMAC-SHA256 验签)✅;`resolveLogin`(找/建账号+自动绑定+发会话,provider 无关)✅ | ✅ 已完成:session 6 测试、Telegram 验签 6 测试(篡改/错token/过期/缺hash 全拒)、login 4 测试;共 221 gateway 测试通过 |
| **W1b 鉴权中间件 + logout**（可测部分）✅ | `auth-http.ts`:cookie 解析、`authenticate`(cookie→accountId/401)、`sessionCookie`/`clearSessionCookie`(HttpOnly/SameSite/Secure)、`logout`(服务端撤销+清 cookie) | ✅ 已完成:10 测试(解析/鉴权/过期/登录登出 cookie/撤销);共 231 gateway 测试 |
| **W1c OAuth 接线** ✅（Telegram 真 / Google mock）| **后端**:`auth-endpoint.ts` —— `POST /api/auth/telegram`(验签→`resolveLogin`→Set-Cookie)、`POST /api/auth/google/mock`(dev,邮箱登录)、`/logout`、`GET /api/auth/me`、`/config`;loopback 自动开 devAuth + 非 Secure cookie;telegram bot token 从渠道配置解析;**前端**:登录页(Telegram Login Widget 挂载 + Google mock 表单 + 令牌 fallback)、`/me` 鉴权、侧栏账号 + 退出 | ✅ **后端 271 测试 + curl 全链路**(me 401→google mock 登录→Set-Cookie→me 200→同邮箱同账号→logout→401);**前端浏览器端到端**(截图:登录页→Google mock 登录→已登录聊天界面 + 账号/退出) |
| **W1c-tg 现代 Telegram OIDC** ✅ | 按官方文档(core.telegram.org/bots/telegram-login)接**现代 OIDC**:`telegram-oidc.ts` 用 `jose` 验 `id_token`(JWKS `oauth.telegram.org/.well-known/jwks.json`、`iss`=`https://oauth.telegram.org`、`aud`=Bot Client ID、`exp`),取 `id`(==bot from.id)→`resolveLogin`;`/api/auth/telegram` 按 body 分流(`id_token`→OIDC / `hash`→旧 HMAC);env `EA_TELEGRAM_CLIENT_ID`;`/config` 暴露 `telegramClientId`;前端 `Telegram.Login.auth` 按钮(库由运营按 BotFather「Web Login」片段引入) | ✅ **后端 279 测试**(OIDC 验签 8:自签合法/sub 回退/错aud/错iss/过期/伪造密钥/garbage/未配置503);**curl 验证**(config 暴露 clientId、garbage id_token→401);**前端截图**(✈ Telegram 按钮渲染)。**待做**:Google 真 OAuth、CSRF、公网 Secure cookie |
| **W2 身份绑定 + `resolveAccount`** | `bind`/`unbind`/`resolveAccount`/link-token ✅(many-to-one、同 provider 多号、单次时限 token);dispatcher 已接 `resolveAccount` ✅;`ea-gateway account` CLI ✅;**待做**:Telegram 登录自动绑定、`/start <token>` 接 bot(需 OAuth/web) | store 层 ✅(11 测试);Telegram 私聊 `from.id` 经 dispatcher 命中账号 ✅(4 测试);Web 端自动绑定待 W1 |
| **W3a 协议编码器** ✅ | `ui-message-stream.ts`:`UiMessageStreamEncoder`(AgentStreamEvent→AI SDK SSE parts:start/text-start/text-delta/text-end/finish/error/data-*/[DONE])、`UI_MESSAGE_STREAM_HEADERS`(`x-vercel-ai-ui-message-stream: v1`);按 runId+orchestrator 过滤 | ✅ 已完成:8 测试(完整序列、跨run/子agent 过滤、error、memory-captured、空轮、幂等);共 239 gateway 测试 |
| **W3b 端点核心** ✅ | `resolveWebTurn`(web:threadId→session 路由,新建带 `memoryNamespace=accountId`+按账号 workspace,续聊复用);`streamRun`(订阅 host 事件→编码器→`SseSink`,run-finish/error 关闭);`runChatTurn` 编排;`handleChatRequest` Node http 外壳(authenticate→401、body 上限、disconnect→abortRun) | ✅ 已完成:6 测试(新建/续聊/多线程路由、跨run过滤、流式到sink并关闭、编排);共 245 gateway 测试 |
| **W3c sessions/历史 API** ✅ | `listAccountSessions`(按 `config.memoryNamespace==accountId` 筛 + 路由反查 threadId)、`readSessionHistory`(head→root 线性路径→user/assistant 文本,**账号鉴权:他人 session→404**);`handleSessionsRequest`/`handleHistoryRequest` Node http 外壳 | ✅ 已完成:4 测试(账号自限列表、线性历史、越权404、未知404);共 249 gateway 测试 |
| **W3d 端点挂载 + server** ✅ | `matchWebRoute`(method+path 派发,5 测试);`startWebChat`(独立公网 server,与 admin 分鉴权域,cookie 鉴权);`ea-gateway web` 启动 + `ea-gateway account login <id>`(dev 令牌,免 OAuth) | ✅ **真实端到端验证**(curl):无cookie→401、有效cookie→200`{sessions:[]}`、未知→404、错方法→405、越权历史→404;共 254 gateway 测试。**仅 SSE 聊天流待配模型验证** |
| **W4a 前端脚手架** ✅ | `apps/web`:Vite+React19+TS+`@ai-sdk/react` `useChat`(`DefaultChatTransport`→`/api/chat`);dev 登录(粘贴令牌设 cookie);暗色 CSS;vite 代理 `/api`→:7318 | ✅ 构建通过 + 预览渲染确认 |
| **W4b 前端打磨** ✅ | **Markdown + 代码高亮**(react-markdown+remark-gfm+rehype-highlight,hljs token CSS);**多会话切换 + 历史恢复**(`ChatView` keyed by threadId、`fetchHistory`→`setMessages`)+ **新建会话**;`data-memory`/`data-tool` chip;打字指示;`?demo` 预览种子 | ✅ 构建通过 + 预览截图确认(代码高亮/粗体/列表/记忆 chip) |
| **W4c 会话管理 + UX** ✅ | **后端**:`renameAccountSession`/`deleteAccountSession`(账号鉴权,删除连带 unbind 路由)+ `POST /rename`、`DELETE /:id` 端点 + 路由;**前端**:侧栏行内重命名 + 删除确认、**停止生成**(useChat.stop)、**多行自增输入框**(Enter发/Shift+Enter换行)、**消息复制** | ✅ 后端 257 测试(rename/delete 鉴权 + 路由);前端 tsc 0、vite build、DOM/截图确认(textarea/复制/新建均渲染) |
| **W4d 附件/多模态** ✅ | **后端**:`toUserParts`(AI SDK file part 的 base64 data URL → agent `UserPart`,image/file 分流)贯通 `extractMessage`→`resolveWebTurn`→`host.sendMessage/startSession`,空文本+附件可发;**前端**:📎 文件选择(multiple,image/pdf/txt/md)+ 缩略图预览 + 清除 + 消息内图片渲染(`<img>`) | ✅ 后端 **262 测试**(toUserParts 5:image/file/缺mediaType/跳过远程URL/data字段);前端 tsc 0、vite build、**截图确认**(用户气泡内图片渲染、📎 按钮、file input multiple+accept) |
| **W4e 思考卡 + 重新生成** ✅ | **后端**:编码器把 `reasoning-delta` 映射为原生 `reasoning-start/delta/end` parts(useChat 自动累积),text 前自动闭合 reasoning;**前端**:`reasoning` part → 🤔 思考过程折叠卡;末条 Agent 消息 **重新生成**(useChat.regenerate) | ✅ 后端 **264 测试**(encoder reasoning 序列 2:reasoning→text 闭合、纯 reasoning finish 闭合);前端 tsc 0、vite build、**截图确认**(思考卡展开 + 重新生成/复制按钮) |
| **W4f 体验细节** ✅ | 侧栏**会话搜索**(按名过滤,有会话才显示);**空态建议卡**(4 个 prompt 一点即发);**回到底部**悬浮按钮(滚动离底时出现,自动滚动只在贴底时触发,不打断阅读) | ✅ 前端 tsc 0、vite build、**截图确认**(空态标题/副标题/4 建议卡/composer 完整渲染) |
| **W4g 时间戳/字数/模型选择器** ✅ | **后端**:`GET /api/models`(配置别名)+ chat body `model` 贯通 `resolveWebTurn`(新会话设 `config.model`,续聊 read-merge-write `updateSessionConfig`);**前端**:消息**时间戳**(history 用原 ts、live 客户端首见时间)、composer **字数计数**、header **模型下拉**(`prepareSendMessagesRequest` 动态注入,始终取当前选择) | ✅ 后端 **265 测试**(/api/models 路由 + model 注入新/旧会话);前端 tsc 0、vite build、**截图/DOM 确认**(时间戳 22:59、字数计数=4、header 存在) |
| **W4h Tailwind/shadcn 重构** ✅ | Tailwind v4(`@tailwindcss/vite` + `@theme` 设计令牌)替换手写 CSS;`cn`(clsx+tailwind-merge)+ shadcn 风格 `Button`(cva variants)/`Input`/`Textarea` primitives;全部组件改用 Tailwind utilities;markdown/hljs/动画保留为自定义层 | ✅ 前端 tsc 0、vite build、**截图确认**(令牌色/圆角/边框一致渲染)、**控制台零警告/错误** |
| **W4i App-server RPC 实验入口** ✅ | `apps/web` 增加 `@enterprise-agent/agent-client`;`ChatView` 在 `?rpc` 下切到 `RpcChatView`;Vite 代理 `/rpc`;approval/question/plan responder 改走 RPC context;默认 `/api/chat` SSE 不变 | ✅ 前端 typecheck/build 通过;与 `packages/agent-client` WebSocket 集成测试通过 |
| **W5 记忆呈现** | `data-memory` 渲染卡片 + 撤销;「我的记忆」面板;偏好开关 | 写入可见、可逐条删除(依赖记忆 spec M3) |
| **W6 公网硬化** | TLS、CSRF、限流、审计、admin 面板隔离;安全 review | 安全 review 通过 |

> 依赖:W2 的记忆生效依赖记忆 spec M1/M2;W5 依赖记忆 spec M3。W1/W3/W4(纯 Web 链路)可与记忆并行推进。

---

## 8. 非目标 / 未来扩展

- **非目标**:Web 不镜像 IM 逐字 transcript;Web 与 IM session 不合并、不实时互订阅(本期);不跨 `accountId` 共享任何数据。
- **同账号多端实时同 session**:`GET /api/session/:id/sse` 全量订阅(§4.2 留口)。
- **更多 OAuth provider**(微信开放平台、GitHub 等):`identities` 模型已可扩展。
- **存储替换**:`accounts/identities` JSON → DB(接口不变)。
- **组织/团队**:`Account` 之上加 org 概念(对应记忆 spec 的 `tenant`)。

---

## 9. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| 1 | 前端形态 | **独立 `apps/web`**(Vite+React+shadcn+useChat) |
| 2 | 登录 | **OAuth**:Google + Telegram(Login Widget,验签) |
| 3 | Telegram 渠道绑定 | 登录**自动绑定**;Google 用户走 `/link` |
| 4 | 多身份 | **多对一**,含同 provider 多号 |
| 5 | session 模型 | Web 与 IM **独立**,连续性靠记忆 |
| 6 | 工作区 | 按 **`accountId`** 隔离 |

### 仍待定（实现期细化）

1. Google OAuth 用自建回调 vs 现成库(如 `@auth/core`/Lucia/自写);倾向轻量自写或 `@auth/core` 适配进程内 Node。
2. Web 会话(`conversationId`)的生成与「新建会话/重命名/删除」交互。
3. admin 面板在公网部署下的归置(独立端口+内网 / 并入账号鉴权且限管理员)。
4. 前端部署形态:`apps/web` 静态产物由 gateway 直接 serve,还是独立托管 + CORS。
