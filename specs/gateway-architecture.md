# Enterprise Agent — Gateway 网关架构（即时通讯接入）

> 本文档定义 **Gateway 网关壳层**（`apps/gateway`，包名 `@enterprise-agent/gateway`）——把 Agent 核心模块（[agent-architecture.md](agent-architecture.md)）接到即时通讯平台（Telegram / WhatsApp / 微信…）的常驻服务壳。涵盖：架构定位与进程内嵌（§1）、进程与运行模型（§2）、通道抽象 `ChannelAdapter`（§3）、会话映射与作用域（§4）、出向渲染 `ChatRenderer`（§5）、聊天内审批与斜杠命令（§6）、配置与机密（§7）、**微信适配器（腾讯 iLink Bot 协议）**（§8）、Telegram 参照实现（§9）、落地阶段（§10）、接线对照（附录 A）、iLink 端点速查（附录 B）。同一个 gateway bootstrap 也可通过 `ea-gateway app-server` 暴露 app-server JSON-RPC 入口 `WS /rpc`，供 Web / 桌面 / 移动富客户端连接；协议细节见 [app-server.md](app-server.md)。
> **集成方式**：Gateway 与 CLI（cli §1）同philosophy——**不重新实现任何 Agent 逻辑**。运行时、工具、审批、MCP、压缩、文件存储全在 **`@enterprise-agent/agent`** 内，Gateway 只通过 **agent §6 的命令/事件契约**（`AgentHost` + `AgentStreamEvent`，[commands.ts](../packages/agent-contract/src/commands.ts) / [events.ts](../packages/agent-contract/src/events.ts)）驱动它，自己补「平台收发 + 会话路由 + 进程编排」。
> **核心取向：网关 = 又一个 host。** core 自我定位是 host-agnostic（README / agent §6）——一个聊天平台不过是**又一个驱动 core 的宿主**。所以「平台来消息要起会话」这件入向的事**不进 core**，而落在 Gateway 这个常驻、多会话的 headless host 里。它与 `ea run`（cli §5）是同一招式的放大版：`ea run` 是「一条 prompt → 一轮 → 退出」，Gateway 是「平台消息 → 路由到会话 `sendMessage` → 事件流回推平台」的**无限循环 + 多通道 + 多会话**。**core 零改动。**
> 编号：**本文件章节独立顺序编号**（§1–§10 + 附录 A/B）。本文件内引用用裸 `§x`；跨文件引用用 `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `cli §x`（[cli-architecture.md](cli-architecture.md)）限定。

---

## 1. 架构定位：常驻多会话 headless host

Gateway 是一个**常驻服务进程**，在自己进程里 `createAgentHost()` 内嵌 core，挂若干 `ChannelAdapter`，把平台收发桥接到 agent §6 契约。它和 CLI 的 headless 模式（cli §2.3 / [headless/run.ts](../apps/cli/src/headless/run.ts)）是同一层逻辑，只是把**输入**从「一条 `-p` prompt」换成「平台入向消息流」，把**输出**从「stdout printer」换成「平台 send/edit」，并且**常驻、多会话**。

```
平台 (Telegram / WhatsApp / 微信)
   │ 入向 (long-poll / webhook)        ▲ 出向 (send / edit / typing / 卡片)
   ▼                                   │
┌──────────────────────────────────────┴───────────────────────────┐
│  ea-gateway 进程（Node/Bun，单进程常驻）                            │
│  ┌───────────────┐   归一化    ┌──────────┐  §6 命令  ┌──────────┐ │
│  │ ChannelAdapter │──Inbound──▶│ Gateway   │─────────▶│ AgentHost │ │
│  │  (§3 每平台一个) │           │ Runtime   │ start/send│(agent §6)│ │
│  │                │◀──render──│ Router(§4)│◀─onEvent──│ core 无改动│ │
│  └───────────────┘ ChatRenderer│ Dispatcher│ Stream   └────┬─────┘ │
│        §5             §6 审批桥 └──────────┘                │        │
│                          运行时/工具/审批/MCP/沙箱  ~/.enterprise-agent/│
└────────────────────────────────────────────────────────────────────┘
```

| 维度 | 设计 |
| --- | --- |
| 同一运行时 | `ChannelAdapter` / Router / core 都是 JS/TS、同一进程，host 用 `createAgentHost()`（[index.ts](../packages/agent/src/index.ts)）构造，就是进程里一个普通对象。命令=直接 `await host.sendMessage(...)`，收事件=`host.onEvent(cb)`，**无 IPC、无序列化**。 |
| 零 core 改动 | Gateway 完全活在 §6 契约之上：`startSession` / `sendMessage` / `approveTool` / `answerQuestion` / `abortRun` 进，`AgentStreamEvent` 出。core 不感知「聊天平台」的存在。 |
| 复用 headless 内核 | 主循环就是 [headless/run.ts](../apps/cli/src/headless/run.ts) 的 `onEvent` 监听器**多会话化**；审批判定直接复用 [headless/policy.ts](../apps/cli/src/headless/policy.ts)；构建 host + keychain 复用 [host/bootstrap.ts](../apps/cli/src/host/bootstrap.ts)（cli §7）。 |
| 共享一套真相 | Gateway 与 CLI / 桌面端共用同一 app-data root（`~/.enterprise-agent/`，agent §5.2）：CLI 里配的 provider / key / skill / MCP，Gateway 直接生效；反之亦然。 |
| 安全边界不变 | 密钥（keychain）、文件边界、沙箱、三态审批全在 host 内强制（agent §4）。Gateway 只把审批「摆到聊天里、回传决策」，绝不触碰明文密钥。 |
| App-server 入口 | `ea-gateway app-server` 复用同一 bootstrap，启动 `/rpc`、`/healthz`、`/readyz`；鉴权沿用 Web cookie / bearer / loopback token。它是多客户端协议宿主，不替代 IM `ChannelAdapter`。 |

> 为什么单开 `apps/gateway` 而不塞进 core 或 CLI？因为 ① core 必须保持 host-agnostic，入向是 host 的事；② CLI 壳是交互式单用户终端（OpenTUI），Gateway 是无人值守多用户服务，进程模型、审批模型、渲染目标都不同。二者**共享 core 与 headless 内核**，但各自是独立壳——与 cli / desktop 两壳并列的第三个壳。

---

## 2. 进程与运行模型

### 2.1 单进程多路复用

`createAgentHost()` 是单进程多路复用器（cli §2.1）：内部一个 `sessions` Map 持有所有会话，`onEvent` 是全局流。Gateway 构造**一个 host** 即覆盖所有通道、所有用户会话：

```ts
import { createAgentHost } from '@enterprise-agent/agent';

const host = createAgentHost({
  root: process.env.ENTERPRISE_AGENT_HOME,   // 缺省 ~/.enterprise-agent（agent §5.2）
  keychain: osKeyStore,                      // 复用 CLI 的 OS keychain 后端（cli §7）
});
```

- 一条 `host.onEvent` 全局监听，Dispatcher 按 `runId → conversation` 把事件分发回正确通道/会话。
- 子 Agent（agent §2.3）在同进程 spawn，事件带 `parentRunId` / `parentAgentId`，并发交给 core 的 `maxConcurrency` 与会话隔离。

### 2.2 主循环 = 多会话 headless

入向（Router + Dispatcher）：

1. `adapter.start(onInbound)` 收到平台消息 → 归一化为 `InboundMessage`（§3.2）。
2. `router.resolve(channel, conversationId)` 查 `sessionId`：命中续用；未命中 `host.startSession(...)` 新建并写回 `routes.json`（§4.1），把通道作用域 `ScopedConfig`（§4.2）带入。
3. `host.sendMessage(sessionId, text)` → 拿 `runId`，登记为该会话的活跃 run。

出向（一条 `onEvent`，按 run 分发）：

| 事件（agent §6.2） | Gateway 处理 |
| --- | --- |
| `text-delta` | `ChatRenderer` 节流缓冲（§5）：有编辑 API 的平台增量 `edit`，否则攒到 `run-finish` 整条发 |
| `tool-approval-required` | 走审批桥（§6）：内联按钮 / `/approve` 文本 / auto 策略 |
| `user-question-required` | 发选项卡片；无人可答时 `answerQuestion(id, null)` 让 run 继续（与 headless 同精神） |
| `plan-proposed` | 发计划文本 + 等 `/approve`（plan 模式通道）；否则按 auto 推进 |
| `sub-agent-start` | 把子 run 并入该会话的 `turnRuns` 集合（见下） |
| `run-finish` / `error` | 定稿最终消息，置该 run 非活跃 |

> **`turnRuns` 不变量**（直接继承 headless）：子 Agent 事件带的是**子 run 自己的 `runId`**，不是该轮的 runId（agent §2.3）。审批 / 提问若只按本轮 runId 匹配，子 Agent 的高风险调用会一直挂到墙钟超时——这正是 [headless/run.ts](../apps/cli/src/headless/run.ts) 用 `turnRuns` 集合（`sub-agent-start.parentRunId` 命中即纳入）解决的坑。Gateway 按**会话**各持一份 `turnRuns`。

### 2.3 生命周期与部署

| 阶段 | 行为 |
| --- | --- |
| 启动 | `ea-gateway` → `createAgentHost()`（一次性连 MCP、建索引、读 providers）→ 按 `gateway.json` 拉起各 `adapter.start()` |
| 运行 | host 常驻，跨所有用户多轮复用；每平台**熔断器**：连续失败自动暂停，`/platform resume` 手动恢复（借鉴 Hermes） |
| 退出 | SIGINT → 各 `adapter.stop()`（落盘游标/状态）→ `host.dispose()`（关 MCP 子进程、flush 审计）→ 退出 |
| 部署 | 纯服务进程，无 OpenTUI 依赖，Node/Bun 均可。long-poll 平台（Telegram / 微信 iLink）**不需公网入口**；webhook 平台（WhatsApp）需 HTTPS（反代/隧道）。systemd / launchd / Docker 任选 |

---

## 3. 通道抽象：`ChannelAdapter`

每个平台只实现这一个接口，Runtime / Router / Dispatcher 全部平台无关。

### 3.1 接口

```ts
interface ChannelAdapter {
  readonly name: string;                                            // "telegram" | "weixin" | ...
  start(onInbound: (m: InboundMessage) => void): Promise<void>;     // 拉起 long-poll 或 webhook
  send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef>;
  edit?(ref: MessageRef, payload: OutboundPayload): Promise<void>;  // 流式编辑（无则不实现 → §5 退化）
  typing?(target: SendTarget, on: boolean): Promise<void>;          // "正在输入…" 指示
  renderApproval?(req: ApprovalReq): Promise<void>;                 // 内联按钮审批（无则走 §6 其它路径）
  stop(): Promise<void>;
}
```

### 3.2 归一化消息模型

```ts
interface InboundMessage {
  channel: string;              // 适配器 name
  conversationId: string;       // 会话/群/线程 id —— Router 的键
  userId: string;               // 发送者（鉴权 / admin 分权用）
  text: string;
  attachments?: Attachment[];   // 图片/语音/文件/视频（解密后）
  raw?: unknown;                // 平台原始对象（如微信 context_token，见 §8）
}
type OutboundPayload =
  | { kind: 'text'; text: string }                       // 含 Markdown
  | { kind: 'media'; media: Attachment; caption?: string }
  | { kind: 'buttons'; text: string; buttons: Button[] }; // 审批/提问卡片
```

### 3.3 平台能力矩阵（决定渲染与审批降级）

| 能力 | Telegram | WhatsApp(Cloud API) | **微信 (iLink, §8)** |
| --- | --- | --- | --- |
| 接入协议 | Bot API | Business Cloud API | 腾讯 iLink Bot（个人号官方） |
| 入向 | long-poll `getUpdates` / webhook | webhook | **long-poll `getupdates`(35s)** |
| 流式 `edit?` | ✓ `editMessageText` | ✗ | ✗ → 整条发 + typing |
| 内联按钮 `renderApproval?` | ✓ inline keyboard | 有限（交互模板） | ✗ → `/approve` 文本 或 auto |
| 群 | ✓ | ✓ | ✗（基本不可用，**先只做 DM**） |
| 公网入口 | 否（long-poll） | **是**（webhook + HTTPS） | 否（long-poll） |
| typing | ✓ | 受限 | ✓ `sendtyping` |

> 抽象设计原则：**弱能力平台靠"不实现可选方法"自然降级**，Runtime 不写平台分支。微信（无 edit / 无按钮 / DM-only）是检验抽象的最好样本——它能跑通，说明抽象对最弱平台也够用。

---

## 4. 会话映射与作用域（Router）

### 4.1 identity → session 映射

- `routes.json`（`~/.enterprise-agent/gateway/routes.json`）持久化 `channel:conversationId → sessionId`。
- 映射粒度：私聊=按 `userId`/`conversationId`；群=按群 id（或仅 `@提及` 触发）。
- 会话由 Gateway 用 `host.startSession({ name, workingDir, config })` 创建（agent §6.1），`name` 取首条消息前缀。

### 4.2 每通道作用域 = 复用 `ScopedConfig`

多租户隔离**不引入新机制**，直接用 core 现成的 `ScopedConfig`（agent §2.5，[domain.ts](../packages/agent-contract/src/domain.ts)）。新建会话时把通道配置塞进 `config`：

```jsonc
"session": {
  "executionMode": "auto",                          // 无人值守默认（§6）
  "workingDir": "/srv/agent-ws/telegram",           // 可写文件边界（agent §4）
  "readRoots": ["/etc/ops-agent"],                  // 只读根：可读+可运行、不可写（agent §4.2）
  "permission": { "allowHosts": ["api.internal"] }, // 网络/命令白名单
  "model": { "orchestratorAlias": "fast" }          // 该通道用更快的模型
}
```

于是「不同通道不同工作目录 / 只读根 / 权限 / 模型 / 可见技能」全部落在既有两级配置合并里——**别让 A 群的能力泄进 B 群**。

> **只读根按通道配（agent §4.2）**：`readRoots` 是 `ScopedConfig` 字段，与 `workingDir` 一样经 `sessionConfigFor` 原样注入该通道创建的会话，再与全局 `settings.readRoots` 按 **去重并集** 合并——**无需任何 gateway 专属代码**。该通道会话的子进程获得这些目录的**只读 + 可作 cwd**能力（落盘仍只能回 `workingDir`，agent 的 `readFile`/`listDir` 仍够不着）。
>
> 多租户须知：`readRoots` 的目录对该会话子进程**全部可读**。务必**按通道**收窄，**不要**把含跨会话数据/密钥的目录（如整个 `~/.enterprise-agent/`，内含 `providers.json`、其它会话的 transcript/audit）经全局 `readRoots` 暴露给共享/匿名通道；需要共享时单建一个窄目录。详见 [docs/read-roots.md](../docs/read-roots.md)。

> 同理,这里的 `channel:conversationId` / `userId` 也是 Gateway 喂给跨会话记忆能力的**作用域 key**（memory §4）：Gateway 只负责「这是谁」,记忆机制（检索注入 / 捕获钩子）全在 core,见 [memory-architecture.md](memory-architecture.md)。

### 4.3 会话重置策略（借鉴 Hermes）

聊天会话会无限增长，需可配置重置（否则上下文与成本失控）：

| 策略 | 默认 | 行为 |
| --- | --- | --- |
| `daily` | 04:00 | 每日定时清空，next 消息起新会话（保留旧会话树存档） |
| `idle` | 1440 分钟 | 空闲 N 分钟后下一条消息起新会话 |
| `command` | — | 用户 `/new` / `/reset` 手动重置（§6.3） |

按通道覆盖，配置进 `gateway.json`（§7）。重置=`router` 解绑旧 `sessionId`、下条消息走 §4.1 新建路径；旧会话树仍可在 CLI/桌面端回看（agent §5.4）。

---

## 5. 出向渲染 `ChatRenderer`

相当于 headless 的 `LineRenderer`（[headless/render.ts](../apps/cli/src/headless/render.ts)）的聊天版，把 `AgentStreamEvent` 投影成平台消息：

- **流式 vs 整条**：`adapter.edit` 存在 → `text-delta` 节流（约每 1s）增量编辑同一条消息；不存在（微信/WhatsApp）→ 攒到 `run-finish` 整条发，运行中用 `typing` 维持"正在输入…"。
- **长文切分**：按平台上限分块（Telegram 4096 / 微信 4000 字，§8），在自然边界（段落/代码块）切，避免截断 Markdown。
- **限速退避**：平台 429 → 指数退避 + 队列；与 §2.3 熔断器联动。
- **Markdown 转换**：core 输出 Markdown → 各平台格式（Telegram MarkdownV2 / 微信纯文 + 轻排版）。
- **轨迹压缩**：工具调用、子 Agent 进度可选压成轻量状态行（"🔧 检索中…"），默认不把完整轨迹刷进聊天（可 `config.yaml` 开 verbose）。

---

## 6. 聊天内审批与人机协同

agent §3.3 的**三态审批**（`once` / `session` / `reject`）由 core 强制；Gateway 负责把它「摆进聊天、回传决策」。无人值守 + 多用户场景下，有三条互补路径：

### 6.1 三条审批路径

| 路径 | 适用 | 实现 |
| --- | --- | --- |
| **内联按钮** | 平台支持（Telegram） | `tool-approval-required` → `renderApproval` 渲染 [允许once][本会话][拒绝] → 点击回 `host.approveTool(toolCallId, decision)` |
| **斜杠命令** | 无按钮平台（微信） | 用户回 `/approve` / `/deny` → Dispatcher 映射成 `approveTool(id, 'session'\|'reject')`。借鉴 Hermes 的 `/approve` `/deny` |
| **auto 策略** | 完全无人值守 | 通道设 `executionMode:'auto'`，交给 core 的 [AutoClassifier](../packages/agent/src/runtime/auto-classifier.ts)（agent §3.8.5）+ 收紧的 `permission` 白名单裁决；不确定 → 降级为上面两条之一或 `reject` |

> 无论哪条，**沙箱（agent §4.1）与审计（`audit.jsonl`）照常生效**——只是把「终端前按键」换成「聊天里点按钮 / 回命令 / 分类器裁决」，不绕过任何内核边界。安全默认是 `reject`（复用 [headless/policy.ts](../apps/cli/src/headless/policy.ts) 的 `parseApprovePolicy` / `decide`，含 `policy:<file>` 按 argv0/host/path 白名单匹配）。

### 6.2 斜杠命令面

注册到所有平台，统一动词（借鉴 Hermes，落到 §6.1 契约方法）：

| 命令 | 作用 | `AgentHost` |
| --- | --- | --- |
| `/new` `/reset` | 重置会话（§4.3） | Router 解绑 → 下条新建 |
| `/approve` `/deny` | 审批高风险调用（§6.1） | `approveTool(id, session\|reject)` |
| `/stop` | 中断当前 run | `abortRun(runId)`（agent §6.3） |
| `/model [ref]` | 临时切模型 | 会话 `updateSessionConfig`（agent §2.6） |
| `/mode [ask\|auto\|plan]` | 切执行模式 | `setExecutionMode`（agent §3.8） |
| `/<skill>` | 触发技能 | 注入到下条消息（agent §3.6） |
| `/platform <ls\|pause\|resume>` | 适配器管控（§2.3 熔断） | 网关本地 |

### 6.3 提问与计划

- `user-question-required`（askUserQuestion，agent §2.4）→ 渲染选项（按钮或编号文本"回复 1/2/3"）→ `answerQuestion(id, answers)`；超时/无人 → `null` dismiss。
- `plan-proposed`（plan 模式，agent §3.8.4）→ 发计划 Markdown → `/approve` 切出 plan 模式执行 / `/deny` 放弃。

### 6.4 鉴权与分权

借鉴 Hermes 的 admin/user 分权：`gateway.json` 按通道 + 范围（私聊/群）配 `allow_admin_from` / `user_allowed_commands`，限制谁能触发高风险命令、谁只能 `status` / `model`。`userId`（§3.2）是判定主体。

---

## 7. 配置与机密

与 mcp / providers 同一流派（agent §5.2）：配置文件描述通道，**密钥只存 `keyRef`，明文进 keychain**。

`gateway.json`（`~/.enterprise-agent/gateway.json`）：

```jsonc
{
  "channels": [
    {
      "name": "telegram",
      "enabled": true,
      "token": { "keyRef": "telegram-bot-token" },
      "session": { "executionMode": "auto", "workingDir": "/srv/ws/tg", "readRoots": ["/etc/ops-agent"] },
      "approval": "policy:/etc/ea/approve.json",
      "reset": { "mode": "idle", "idleMinutes": 240 }
    },
    {
      "name": "weixin",
      "enabled": true,
      "accountId": "bot-xxx",
      "token": { "keyRef": "weixin-bot-token-bot-xxx" },   // QR 登录得到的 bot_token
      "baseURL": "https://ilinkai.weixin.qq.com",           // 登录返回的 baseurl
      "session": { "executionMode": "auto" },
      "group": "disabled"                                   // iLink 群基本不可用（§8.6）
    }
  ]
}
```

- 机密注入复用 [mcp/client.ts](../packages/agent/src/mcp/client.ts) 的 `resolveSecrets`（`{ keyRef }` → keychain 取值）与 `childBaseEnv` 隔离思路（agent §4）。
- token 用现有 CLI 的 `ea secret set <ref>`（cli §3.1）写 keychain；Gateway 只做 `keyRef` 解析。
- `channels[].session` 是一份 `ScopedConfig`（§4.2），原样注入该通道的会话——含 `readRoots`（只读根，agent §4.2）。全局默认仍来自共享的 `settings.json`（与 CLI 同一份，可用 `ea config read-roots` 写）；通道值与全局**去重并集**合并。多租户下务必按通道收窄 `readRoots`，勿全局暴露敏感目录。

存储路径布局（沿用 `~/.enterprise-agent/`）：

```
gateway.json                                  # 通道配置（含 reset / 分权）
gateway/routes.json                           # channel:conversationId → sessionId（§4.1）
gateway/<channel>/accounts/<id>.json          # 适配器状态（如 iLink get_updates_buf 游标，§8.5）
gateway/<channel>/accounts/<id>.context-tokens.json  # 微信每会话 context_token（§8.5）
keychain: <keyRef>                            # bot token，仅 keyRef 进配置
```

---

## 8. 微信适配器（腾讯 iLink Bot 协议）

> **不接企业微信**。本节走腾讯 2026-03 通过 `@tencent-weixin/openclaw-weixin`（"微信 ClawBot" 插件）放出的**个人微信官方 Bot 协议 iLink**，接入域名 `https://ilinkai.weixin.qq.com`，纯 HTTP/JSON、可脱离 OpenClaw 独立调用。它正好套进 §3 的 `ChannelAdapter`（long-poll 模型与 Telegram `getUpdates` 同构）。

### 8.1 iLink 是什么 & 合规

- **官方个人号 Bot 接口**：微信历史上无面向个人开发者的官方 Bot API，iLink 是首个。有官方《微信 ClawBot 功能使用条款》（深圳南山管辖、适用大陆法律）——**合规路径，非灰产**。
- 条款边界：腾讯「仅提供信息传输、不存储输入输出」，并保留「限制 AI 服务类型、内容过滤、终止连接」之权。**属新接口、稳定性/限速待验证**，生产前需自测降级。
- 不依赖 OpenClaw：凭证经扫码登录拿到后，直接打 `ilinkai.weixin.qq.com` 即可（多个开源实现均如此）。

### 8.2 协议封装

**鉴权头（每个请求都带）**

```
Content-Type: application/json
AuthorizationType: ilink_bot_token            # 固定串
X-WECHAT-UIN: base64(String(randomUint32()))  # 每次请求重新生成
Authorization: Bearer {bot_token}
```

**核心调用**（完整端点见附录 B）

- **登录**：`GET /ilink/bot/get_bot_qrcode?bot_type=3` → `{ qrcode, qrcode_img_content }`；轮询 `GET /ilink/bot/get_qrcode_status?qrcode=` 到 `status="confirmed"`，得 `bot_token` / `baseurl` / `ilink_bot_id` / `ilink_user_id`。
- **收消息（长轮询 35s）**：`POST /ilink/bot/getupdates`，body `{ get_updates_buf, base_info:{ channel_version:"1.0.2" } }` → `{ msgs[], get_updates_buf, longpolling_timeout_ms:35000 }`。**`get_updates_buf` 游标必须每次更新并持久化**，否则重收历史消息。
- **发消息（15s）**：`POST /ilink/bot/sendmessage`，body `{ msg:{ to_user_id, message_type:2, message_state:2, context_token, item_list:[...] } }`。**`context_token` 必须回填**入向消息携带的值，否则「发送成功但不出现在对应会话窗口」。
- **typing**：`POST /ilink/bot/getconfig`（取 `typing_ticket`）+ `POST /ilink/bot/sendtyping`。
- **媒体**：`POST /ilink/bot/getuploadurl`；CDN `https://novac2c.cdn.weixin.qq.com/c2c`，**AES-128-ECB**。出向=本地随机 AES key 加密 → PUT 上传 → `sendmessage` 带 `aes_key`。**坑**：图片 `aeskey` 是 32 位 hex（16 字节，直接解，勿 base64）；文件/音视频 `aes_key` 是 base64——混用会得 24 字节乱码、解密失败。

**消息 schema**：`from_user_id` 形如 `xxx@im.wechat`，`to_user_id` 形如 `xxx@im.bot`；`message_type` 1=用户/2=bot；`item_list[].type` 1=文本 2=图片 3=语音 4=文件 5=视频。

### 8.3 登录命令

新增 `ea-gateway weixin login`：跑 QR 流程（终端渲染 `qrcode_img_content`，轮询到 `confirmed`）→ `bot_token` 写 keychain（`keyRef`，复用 cli §7 keychain）→ `baseurl` / `accountId` 写 `gateway.json`（§7）。

### 8.4 映射到 `ChannelAdapter`

| `ChannelAdapter` | iLink 实现 |
| --- | --- |
| `start(onInbound)` | 读凭证（bot_token / baseurl / 游标）→ 循环 `POST getupdates`(35s) → 解密媒体 → 5 分钟 msgId 滑窗去重 → 发 `InboundMessage`（`conversationId = from_user_id`，`raw.context_token` 留存） |
| `send(target, payload)` | 查该会话 `context_token`（§8.5）→ 文本 type=1 / 媒体先 `getuploadurl`+AES 上传 → `POST sendmessage`，**文本按 4000 字切分**（§5） |
| `edit?` | **不实现**（无编辑 API）→ ChatRenderer 退化为 `run-finish` 整条发 |
| `typing?` | `getconfig` → `sendtyping` |
| `renderApproval?` | **不实现**（无按钮）→ 审批走 `/approve` 文本 或 auto（§6.1） |
| `stop()` | 停轮询、落盘游标 |

### 8.5 状态持久化（必做）

- `gateway/weixin/accounts/<id>.json`：`get_updates_buf` 游标 + 账号信息。**进程重启必须续用游标**，否则重放历史。
- `gateway/weixin/accounts/<id>.context-tokens.json`：每会话最新 `context_token`。回复时回填，保证消息落到正确会话窗口、跨重启延续。

### 8.6 限制与风险

- **群基本不可用**：iLink bot 通常无法被拉进普通微信群、也不推送群事件；多数情况只有发给 bot 的私信（DM）可靠。`group` 默认 `disabled`，开启在启动打 WARNING。→ **微信通道先只做 1v1 助理 bot，不承诺群机器人。**
- **无历史 API**：只能游标向前轮询。
- **无编辑 / 无按钮**：流式编辑与按钮审批用不了（§8.4 已降级）。
- **限速未公开**、`bot_type=3` 语义未文档化 → 自测 + 退避 + §2.3 熔断兜底。

---

## 9. Telegram 适配器（P0 参照实现）

最成熟、最简单，用于先跑通 §1–§7 主框架，无需公网入口：

- `start`：long-poll `getUpdates`（或 webhook）→ `InboundMessage`（`conversationId = chat.id`）。
- `send` / `edit`：`sendMessage` + `editMessageText`（**支持流式编辑**，ChatRenderer 走增量路径）。
- `renderApproval`：inline keyboard 三按钮 → `callback_query` 回 `approveTool`。
- token：`ea secret set telegram-bot-token` → keychain。

Telegram 把"全能力路径"（edit + 按钮 + 群 + long-poll）跑通；微信（§8）把"最弱能力路径"跑通——两者一起验证 §3 抽象的上下限。

---

## 10. 落地阶段与改动清单

| 阶段 | 内容 | core 改动 |
| --- | --- | --- |
| **P0** | 新建 `apps/gateway` + Telegram（long-poll + 内联按钮审批 + 流式编辑）+ Router + 复用 headless policy | **0** |
| **P1** | 抽出 `ChannelAdapter` 稳定接口 + **微信 iLink 适配器**（§8，DM-only / `/approve` 审批 / 整条发）+ `ChatRenderer` 节流切分 + 会话重置（§4.3）+ 熔断/分权 | 0（可选给 `Session.source` 打标签便于审计） |
| **P2** | 接 WhatsApp（webhook + HTTPS）；把 adapter 升级为「插件」的 `channels[]` 统一注册/配置（见独立的插件化方案） | contract + 插件宿主（可选） |

**要动的真实文件基本只在 `apps/gateway/` 下**，包结构对齐 `apps/cli`：

```
apps/gateway/
  package.json            # @enterprise-agent/gateway, bin: ea-gateway
  src/
    bin.ts                # commander: start / status / route / weixin login
    host/bootstrap.ts     # createAgentHost + keychain（复用 cli/host）
    runtime/{gateway,router,dispatcher,approval}.ts
    channels/{adapter,telegram,weixin,whatsapp}.ts
    render/chat-render.ts
    config/gateway-config.ts
```

复用项：[headless/policy.ts](../apps/cli/src/headless/policy.ts)（审批判定）、[headless/run.ts](../apps/cli/src/headless/run.ts)（turnRuns 主循环）、[host/bootstrap.ts](../apps/cli/src/host/bootstrap.ts) / [host/keychain.ts](../apps/cli/src/host/keychain.ts)（host + 机密）、[mcp/client.ts](../packages/agent/src/mcp/client.ts) 的 `resolveSecrets`（keyRef 注入）、§6 `AgentHost`（[commands.ts](../packages/agent-contract/src/commands.ts)）。**core 零改动。**

---

## 附录 A：`ChannelAdapter` ↔ `AgentHost` 接线对照

| 平台动作 | Gateway | `AgentHost` 方法（agent §6.1） |
| --- | --- | --- |
| 收到消息（已映射会话） | Router 命中 | `sendMessage(sessionId, text)` → `{ runId }` |
| 收到消息（新会话） | Router 未命中 → 建会话 | `startSession({ name, workingDir, config })` |
| 点按钮 / 回 `/approve` | Dispatcher 解析 | `approveTool(toolCallId, once\|session\|reject)` |
| 回 `/stop` | Dispatcher | `abortRun(runId)` |
| 回选项 / 回数字 | Dispatcher | `answerQuestion(questionId, answers)` |
| 回 `/approve`（计划） | Dispatcher | `approvePlan(planId, approve)` |
| `/model` `/mode` | Dispatcher | `updateSessionConfig` / `setExecutionMode` |
| 出向渲染 | ChatRenderer | `onEvent(cb)`（`AgentStreamEvent` 流，agent §6.2） |
| 关停 | 生命周期 | `dispose()` |

## 附录 B：iLink 端点速查（`https://ilinkai.weixin.qq.com`）

| 端点（`/ilink/bot/...`） | 方法 | 作用 | 关键字段 / 超时 |
| --- | --- | --- | --- |
| `get_bot_qrcode?bot_type=3` | GET | 取登录二维码 | `qrcode`, `qrcode_img_content` |
| `get_qrcode_status?qrcode=` | GET | 轮询扫码状态 | `confirmed` → `bot_token`,`baseurl`,`ilink_bot_id`,`ilink_user_id` |
| `getupdates` | POST | 长轮询收消息 | in `{get_updates_buf, base_info:{channel_version:"1.0.2"}}`；out `{msgs[], get_updates_buf}`；35s |
| `sendmessage` | POST | 发消息 | `{msg:{to_user_id, message_type:2, message_state:2, context_token, item_list[]}}`；15s |
| `getconfig` | POST | 取 `typing_ticket` | 10s |
| `sendtyping` | POST | "正在输入…" | 10s |
| `getuploadurl` | POST | 媒体上传地址 | 配合 CDN `novac2c.cdn.weixin.qq.com/c2c`，AES-128-ECB |

> 头：`AuthorizationType: ilink_bot_token` + `Authorization: Bearer {bot_token}` + `X-WECHAT-UIN: base64(randomUint32())`（每请求重生成）。游标 `get_updates_buf` 与每会话 `context_token` 必须持久化（§8.5）。
