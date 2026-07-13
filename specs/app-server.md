# Enterprise Agent — App Server 多客户端协议层

> 状态：MVP 已落地。本文定义 **Enterprise Agent App Server**：供 Web、桌面端、移动端、IDE 插件等富客户端共享的一层统一协议服务。它不重写 agent runtime，而是把现有 `@dami-sg/agent` 的 `AgentHost` 命令/事件契约包装成可远程连接、可鉴权、可重连的 client/server 接口。
>
> 关联文档：[agent-architecture.md](agent-architecture.md) §6、[gateway-architecture.md](gateway-architecture.md)、[web-app.md](web-app.md)。OpenAI Codex 的 App Server 是参照对象，但本项目不追求协议兼容；优先保持与本仓库既有 `Session` / `runId` / `AgentStreamEvent` 模型一致。

---

## 0. 决策摘要

| 决策 | 取定 |
| --- | --- |
| 目标 | 为 Web、桌面、移动、IDE/插件提供统一富客户端接入层 |
| 内核 | 复用 `AgentHost`；不让客户端直接调用 core |
| 新 package | 已新增 `packages/agent-server`：协议服务层；`packages/agent-client`：TypeScript 客户端 SDK |
| 首选传输 | JSON-RPC 2.0 over WebSocket，入口 `WS /rpc` |
| 辅助传输 | HTTP `/healthz` / `/readyz`；旧 HTTP+SSE daemon 模式不保留 |
| 账号鉴权 | Web/移动用 cookie 或 bearer session token；桌面/local 用 capability token 或 loopback trusted mode |
| 多租户边界 | 所有 session/history/turn/respond 操作必须按 `accountId` 校验归属 |
| CLI 接入 | `ea serve` 启动本地 app-server daemon，输出 `serve-ready` JSON（含 `rpcUrl`、`token`、`pid`） |
| Gateway 接入 | `ea-gateway app-server` 启动 gateway 复用版 app-server；鉴权沿用 Web cookie / bearer / loopback token |
| Web 接入 | ~~`apps/web` + `/api/chat` SSE~~ **已移除**（gateway-consolidation §P4）；所有富客户端统一走 `WS /rpc` + `@dami-sg/agent-client` |

---

## 1. 为什么需要这一层

当前项目已经有三类接入形态：

1. CLI/TUI：进程内直接调用 `createAgentHost()`。
2. Gateway/IM：`apps/gateway` 把 Telegram / WeChat / WhatsApp 入站消息路由到 `AgentHost`。
3. Web：`apps/gateway/src/web/chat-server.ts` 暴露 Web 专用 HTTP + SSE API。

当继续增加桌面端、移动端、IDE 插件时，如果每个客户端都各自实现会话列表、历史读取、turn 流式事件、审批、提问、计划确认、模型选择，就会出现协议分叉。App Server 的定位是把这些能力收敛到一套稳定接口：

```
Web / Desktop / Mobile / IDE
        │ JSON-RPC / WebSocket
        ▼
packages/agent-server
        │ AgentHost commands + AgentStreamEvent
        ▼
@dami-sg/agent
```

`apps/gateway` 仍然存在，但它的长期定位应更清楚：IM channel gateway + localhost admin。Web/桌面/移动共享的富客户端协议则下沉到 `agent-server`。

---

## 2. 包结构

```
packages/
  agent-contract/       # 已有：AgentHost + AgentStreamEvent 类型
  agent/                # 已有：runtime/core 实现
  agent-server/         # JSON-RPC 协议层 + connection/session fan-out
  agent-client/         # TS SDK，隐藏 JSON-RPC 细节

apps/
  gateway/              # IM 网关 + admin；可嵌入 agent-server 或复用其 helpers
  web/                  # Web client；默认 /api/chat，?rpc 使用 agent-client
  cli/                  # ea serve 启动本地 app-server daemon
  desktop/              # 后续：连接本地/远程 app-server
  mobile/               # 后续：连接公网 app-server
```

职责边界：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `agent-contract` | 核心命令/事件类型 | 网络传输、鉴权 |
| `agent` | runtime、工具、审批内核、存储 | 客户端协议 |
| `agent-server` | 鉴权后把 RPC 映射到 `AgentHost`，fan-out 事件 | UI 渲染、IM 平台适配 |
| `agent-client` | 连接、请求/响应、通知订阅、重连辅助 | 业务 UI |
| `gateway` | IM adapters、admin、本地配置 | 多客户端通用协议的唯一实现 |

---

## 3. 概念映射

OpenAI Codex App Server 使用 `thread / turn / item`。本项目已有模型如下：

| 通用客户端概念 | 本项目现有概念 | 说明 |
| --- | --- | --- |
| Conversation / Thread | `Session` | 一个可继续的会话单元 |
| Turn | `runId` | 一次用户输入触发的 agent 运行 |
| Item | `AgentStreamEvent` + session tree `Entry` | v1 不重构 item 存储；先从事件投影 |
| Approval request | `tool-approval-required` | 客户端通过 `approval/respond` 解决 |
| User question | `user-question-required` | 客户端通过 `question/respond` 解决 |
| Plan confirmation | `plan-proposed` | 客户端通过 `plan/respond` 解决 |

v1 保持 `Session` 为服务端真实实体。客户端可以在 UI 里命名为 thread/conversation，但协议字段优先使用 `sessionId`，避免引入第二套 ID 语义。

---

## 4. 传输与连接生命周期

### 4.1 WebSocket JSON-RPC

主入口：

```
GET /healthz
GET /readyz
WS  /rpc
```

消息格式采用 JSON-RPC 2.0 的 request/response/notification 模型，但 wire 上允许省略 `"jsonrpc":"2.0"`，客户端 SDK 应统一补齐/解析。

Request：

```json
{ "id": 1, "method": "session/list", "params": {} }
```

Response：

```json
{ "id": 1, "result": { "sessions": [] } }
```

Error：

```json
{ "id": 1, "error": { "code": -32004, "message": "session not found" } }
```

Notification：

```json
{ "method": "item/textDelta", "params": { "sessionId": "s_1", "runId": "r_1", "text": "hello" } }
```

### 4.2 Initialize

每条连接必须先发送一次 `initialize`：

```json
{
  "id": 0,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "enterprise_web",
      "title": "Enterprise Agent Web",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimental": false
    }
  }
}
```

服务端返回：

```json
{
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "accountId": "acct_abc",
    "serverInfo": {
      "name": "enterprise_agent_app_server",
      "version": "0.0.6"
    }
  }
}
```

在 `initialize` 前收到其他方法，返回 `-32000 Not initialized`。重复 `initialize` 返回 `-32000 Already initialized`。

### 4.3 订阅模型

连接初始化后默认只接收由该连接启动的 turn 事件。客户端可调用：

```txt
event/subscribe
event/unsubscribe
```

订阅范围：

```ts
type SubscriptionScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'account' };
```

`account` 订阅仅允许可信桌面端或显式授权客户端使用；公网 Web/移动默认不开放，避免一个连接接收过多事件。

---

## 5. RPC 方法

### 5.1 Session

```txt
session/list
session/create
session/resume
session/rename
session/delete
session/history
session/compact
session/todos
```

`session/create`：

```json
{
  "method": "session/create",
  "id": 10,
  "params": {
    "name": "Mobile chat",
    "workingDir": "/srv/agent-ws/acct_abc",
    "config": {
      "memoryNamespace": "acct_abc",
      "executionMode": "ask"
    }
  }
}
```

返回：

```json
{ "id": 10, "result": { "session": { "id": "s_1", "name": "Mobile chat" } } }
```

### 5.2 Turn

```txt
turn/start
turn/steer
turn/interrupt
```

`turn/start`：

```json
{
  "method": "turn/start",
  "id": 20,
  "params": {
    "sessionId": "s_1",
    "input": [
      { "type": "text", "text": "Summarize this repo." }
    ],
    "model": "fast"
  }
}
```

映射：

1. 校验 `sessionId` 属于当前 `accountId`。
2. 把 input 转为 `text` + `UserPart[]`。
3. 调 `host.sendMessage(sessionId, text, parts)`。
4. 自动订阅该 `runId`。

返回：

```json
{ "id": 20, "result": { "runId": "r_1" } }
```

`turn/steer` 是 v2 能力。当前 MVP 返回 `-32601 Method not found`。

### 5.3 Interactive responses

```txt
approval/respond
question/respond
plan/respond
```

`approval/respond`：

```json
{
  "method": "approval/respond",
  "id": 30,
  "params": {
    "toolCallId": "tc_1",
    "decision": "once"
  }
}
```

服务端必须确认该 `toolCallId` 属于当前账号可见的 pending approval，否则返回 `-32005 Forbidden` 或 `-32004 Not found`。

`question/respond`：

```json
{
  "method": "question/respond",
  "id": 31,
  "params": {
    "questionId": "q_1",
    "answers": [{ "selected": ["opt_a"] }]
  }
}
```

`plan/respond`：

```json
{
  "method": "plan/respond",
  "id": 32,
  "params": {
    "planId": "p_1",
    "decision": "approve",
    "targetMode": "ask"
  }
}
```

### 5.4 Mode and models

```txt
mode/get
mode/set
models/list
usage/query
```

`models/list` 返回当前账号/部署可见的模型 alias，不泄露密钥或 provider private config。

---

## 6. Server notifications

通知是 `AgentStreamEvent` 的稳定客户端投影，不直接把所有内部字段裸透出。v1 支持：

```txt
session/updated
turn/started
turn/completed
item/textDelta
item/reasoningDelta
item/toolCall
item/toolResult
item/approvalRequired
item/questionRequired
item/planProposed
item/subAgentSpawned
item/subAgentStarted
item/subAgentFinished
item/subAgentEvaluated
item/usage
item/memoryCaptured
item/error
```

示例：

```json
{
  "method": "item/approvalRequired",
  "params": {
    "sessionId": "s_1",
    "runId": "r_1",
    "toolCallId": "tc_1",
    "toolName": "execCommand",
    "grantScope": "npm test"
  }
}
```

投影规则：

| `AgentStreamEvent.kind` | Notification |
| --- | --- |
| `text-delta` | `item/textDelta` |
| `reasoning-delta` | `item/reasoningDelta` |
| `tool-call` | `item/toolCall` |
| `tool-result` | `item/toolResult` |
| `tool-approval-required` | `item/approvalRequired` |
| `user-question-required` | `item/questionRequired` |
| `plan-proposed` | `item/planProposed` |
| `usage` | `item/usage` |
| `run-finish` | `turn/completed` |
| `error` | `item/error` |

所有通知必须带足够的 `{ sessionId, runId }` 让客户端合并到正确会话。若原始事件只有 `runId`，server 用内部 `runId -> sessionId/accountId` 索引补齐。

---

## 7. 鉴权与权限

### 7.1 Auth modes

| 场景 | Auth |
| --- | --- |
| Web 公网 | httpOnly cookie session；WebSocket upgrade 时读取 cookie |
| Mobile | `Authorization: Bearer <session-token>` |
| Desktop local | loopback + capability token |
| Desktop remote | signed bearer token 或用户登录 session |
| Tests/dev | 显式 `devAuth`，仅 loopback |

### 7.2 归属校验

所有方法都经过：

```ts
authorize(accountId, method, params) -> allowed | denied
```

最低要求：

- `session/list` 只返回当前账号拥有的 sessions。
- `session/history` / `delete` / `rename` 越权返回 404，避免枚举。
- `turn/start` 的 `sessionId` 必须属于当前账号。
- `approval/respond` / `question/respond` / `plan/respond` 的 pending id 必须属于当前账号。
- 管理类方法默认不进入 app-server；仍由 localhost admin 或未来 admin-server 处理。

### 7.3 Pending registry

server 维护 pending registry：

```ts
Pending {
  id: string;
  kind: 'approval' | 'question' | 'plan';
  accountId: string;
  sessionId: string;
  runId: string;
  expiresAt: number;
}
```

收到对应 `AgentStreamEvent` 时登记；收到 respond 后 claim 并删除。run 完成、run 中断、连接断开不一定删除 pending；run 结束必须清理，避免旧审批被误用。

---

## 8. 重连与背压

### 8.1 重连

客户端断线时，agent run 默认继续。重连后客户端应：

1. `initialize`
2. `session/history` 拉当前 session 历史
3. `event/subscribe { kind:'session', sessionId }`

v1 不保证补发断线期间的逐 token delta；历史是权威状态。后续可引入 durable event cursor。

### 8.2 背压

每个连接有 bounded outbound queue。队列满时：

- 丢弃低价值高频事件：`item/textDelta` 可合并。
- 不丢关键事件：approval/question/plan/run completed/error。
- 仍满则关闭连接，并发送 close reason `client too slow`。

服务端 request ingress 队列满时返回：

```json
{ "error": { "code": -32001, "message": "server overloaded; retry later" } }
```

客户端 SDK 对 `-32001` 做指数退避 + jitter。

---

## 9. 错误码

| Code | Name | 说明 |
| --- | --- | --- |
| `-32700` | Parse error | JSON 无法解析 |
| `-32600` | Invalid request | 请求形状错误 |
| `-32601` | Method not found | 未实现方法 |
| `-32602` | Invalid params | 参数不合法 |
| `-32603` | Internal error | 未分类服务端错误 |
| `-32000` | Bad lifecycle | 未 initialize / 重复 initialize 等 |
| `-32001` | Overloaded | 队列满或服务繁忙 |
| `-32002` | Unauthorized | 未登录或 token 无效 |
| `-32003` | Forbidden | 已登录但无权限 |
| `-32004` | Not found | 资源不存在或越权隐藏 |
| `-32005` | Conflict | pending 已被处理、session 正忙等 |

---

## 10. 当前实现状态

| 范围 | 状态 |
| --- | --- |
| Spec + packages | 已新增本文档、`packages/agent-server`、`packages/agent-client`。`agent-server` 根导出协议/核心，Node listener 通过 `@dami-sg/agent-server/node` 子路径导出，避免浏览器包误打入 `node:http`。 |
| Server MVP | 已实现 `initialize`、`session/list`、`session/create`、`session/history`、`turn/start`、`turn/interrupt`、`approval/respond`、`question/respond`、`plan/respond`、`event/subscribe`、`event/unsubscribe`。 |
| Gateway integration | `startGatewayAppRpc`（注入式，折进 `ea-gateway start`，与 IM 通道共用一个 host）+ 独立 `ea-gateway app-server`，入口 `/rpc`，健康检查 `/healthz` / `/readyz`。~~`/api/chat` SSE~~ **已移除**（gateway-consolidation §P4）。鉴权：cookie / Bearer access key / open-mode loopback。 |
| Web integration | ~~`apps/web` + `/api/chat`~~ **已移除**（§P4）。富客户端统一经 `WS /rpc` + `@dami-sg/agent-client`；浏览器用 cookie，桌面/移动用 Bearer access key。 |
| CLI integration | `ea serve` 已接入 app-server daemon，仅保留 JSON-RPC WebSocket 模式；旧 HTTP+SSE serve 文件与 `--transport` 选项已移除。 |
| Desktop/mobile | 尚未落地客户端。Desktop 预期优先连接本地 app-server；Mobile 只连接公网 app-server，必须 bearer auth + TLS。 |

---

## 11. MVP 验收

1. 两个客户端同时订阅不同 session，事件不串线。
2. 同账号 Web + 桌面订阅同一 session，能同时看到新 turn 的流式输出。
3. A 账号读取 B 账号 session/history 返回 404。
4. `tool-approval-required` 只投递给有权限的客户端。
5. 客户端断线后 turn 继续；重连后可读历史并继续新 turn。
6. 慢客户端不会阻塞 `AgentHost.onEvent`。
7. `approval/respond` / `question/respond` 的 pending id 只能 claim 一次。
8. 真实 `WS /rpc` `initialize` 可通。
9. 现有 gateway/web/cli 构建与类型检查不因新增 package 破坏。

---

## 12. 暂不做

- 完整兼容 OpenAI Codex app-server schema。
- 持久 event cursor / replay。
- 旧 HTTP+SSE daemon 兼容层。
- 多端实时协同编辑输入框。
- 移动端离线推送。
- 管理面板公网化。
- item 级历史存储重构。
