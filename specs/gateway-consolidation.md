# Enterprise Agent — 单进程网关整合（Gateway Consolidation）

> 状态（2026-07）：**P1~P5 全部已落地并验证**（单进程单 host + `/rpc`、UI 常驻自动拉起+重启、access key 鉴权、删 Web 端、内置 SQLite 存储）。本文把「去掉 Web 端、所有通道共用一个 `AgentHost`、UI 常驻并能重启网关」这一系列决策沉淀为落地清单 + 实现记录。
>
> 关联文档：[gateway-architecture.md](gateway-architecture.md)、[app-server.md](app-server.md)、[web-app.md](web-app.md)、[cross-channel-memory.md](cross-channel-memory.md)。
>
> 阅读顺序：先看 §0 决策摘要与 §2 现状，再按 §5 落地清单（每阶段带「✅ 已落地」实现记录 + 验收）。§7 为已定决策。
>
> **遗留 / 后续小项**：无（面板 `web-auth` 死配置已在收尾中清理，见 §P4 注）。

---

## 0. 决策摘要

| 决策 | 取定 |
| --- | --- |
| 目标形态 | **数据面单进程**（一个 `AgentHost`：IM 通道 + `/rpc` 同挂）+ **控制面常驻**（UI 面板）两进程 |
| 客户端接入 | 富客户端（桌面 / 移动 / IDE）统一走 App Server 的 `WS /rpc`；聊天工具走 IM 通道 |
| 去掉 Web 端 | 删除 `ea-gateway web`（`chat-server.ts` + `/api/chat` SSE + `/api/auth/*` OAuth 登录） |
| 通道共用 host | `app-server` 不再自行 `bootstrapGateway`，改为复用 `start` 的 `ctx.host`；三个 bootstrap 收敛为一个数据面 host |
| 「只启动一个」 | 运维只手动启动 UI 面板；面板启动时自动拉起 runtime 子进程 |
| UI 常驻 + 能重启 | 保持 UI（控制面）/ runtime（数据面）两个 OS 进程；面板用 `GatewayProcessManager` spawn detached 子进程并 kill/respawn 重启，UI 全程不掉 |
| 认证收敛 | 单一凭据 = **每用户 access key**；两个执行点（`/rpc` Bearer + IM 通道入口绑定校验） |
| 管理面登录 | UI 面板加 admin key 登录（启动时打印一次），**仍只 bind localhost** |
| 运行模式 | 默认 `open`（免 key）；检测到非 loopback bind 自动切 `managed`（强制每用户 key） |
| admin secret | 存**配置文件**（0600）；控制面与数据面**共用同一份**，双方从该文件读取 |
| 存储 | 用户 / access key 落 **内置 SQLite**（`node:sqlite` / `bun:sqlite`，同步、零原生依赖，§P5 spike 后取代 async `sqlite` 与 `better-sqlite3`）；首启从旧 JSON 幂等迁移 |
| `apps/web` | 随 Web 端一并**删除退役**（富客户端由桌面 / 移动壳承载，走 `/rpc`） |
| 明确砍掉（v1） | 浏览器 / OAuth（Telegram OIDC）；gateway relay 到「远程 app-server」的联邦层 |

---

## 1. 背景与目标

当前 `apps/gateway` 对外有三个各自独立的 HTTP/入口，且各自 `bootstrapGateway` 出一个**独立的 `AgentHost`**：

| 入口 | 命令 | 端口 | 面向 | 认证 |
| --- | --- | --- | --- | --- |
| 配置面板 | `ea-gateway ui` | 7317 | 运维本人（localhost） | 无认证，Host 头 + 同源 |
| Web 聊天端 | `ea-gateway web` | 7318 | 浏览器（`apps/web`） | session cookie + Telegram OAuth |
| App Server | `ea-gateway app-server` | 7320 | Web / 桌面 / 移动 / IDE | cookie / bearer / loopback trusted |

目标是把**服务用户的数据面收敛成一个进程、一个 host**，只保留两类接入——富客户端（`/rpc`）和聊天工具（IM 通道），并去掉浏览器专属的 Web 端。同时保留「UI 常驻且能重启网关」的运维能力。

### 1.1 目标（Goals）

- 运维只需启动一个东西；所有通道（IM + app）共用同一个 `AgentHost`，会话与记忆天然共享。
- 桌面 / 移动 / IDE 客户端统一走 `WS /rpc`（复用 `@dami-sg/agent-client`）。
- UI 面板常驻、可登录、可 start/stop/restart 数据面网关，且重启期间自己不掉线。
- 认证收敛为「每用户 access key」，管理员在 UI 上签发 / 吊销。

### 1.2 非目标（Non-Goals，v1 不做）

- 不再支持浏览器客户端，不做 OAuth / OIDC 登录。
- 不做「gateway 作为客户端连接远程 app-server 再转发」的联邦 / relay 层（`AgentHost` 仍是本进程内核）。
- 不追求与 OpenAI Codex App Server 协议兼容（沿用既有 §app-server 决策）。

---

## 2. 现状（实现前的事实基线）

以下为当前代码事实，实现时以此为改造起点：

- **三处 bootstrap**：`runStart`（[bin.ts:274](../apps/gateway/src/bin.ts)）、`startGatewayAppRpcServer`（[app-rpc-server.ts:30](../apps/gateway/src/web/app-rpc-server.ts)）、`startWebUI`（[server.ts:28](../apps/gateway/src/web/server.ts)）各调一次 `bootstrapGateway` → **三个独立的内存态 `AgentHost`**，只共享磁盘（config / routes.json / identityDir / sessions），不共享活会话与实时事件。
- **`AgentHost` 由 `bootstrapGateway` 建**（[host/bootstrap.ts](../apps/gateway/src/host/bootstrap.ts)），返回 `ctx.host`；`GatewayRuntime`（[runtime/gateway.ts](../apps/gateway/src/runtime/gateway.ts)）接收注入的 `host`。
- **App Server 已支持注入 host**：`startNodeAppServer({ agentHost, ... })`（[agent-server/src/node.ts](../packages/agent-server/src/node.ts)）；HTTP 面仅 `/healthz`、`/readyz`、`WS /rpc`。RPC 方法覆盖 `session/*`、`turn/*`、`approval|question|plan/respond`、`mode/*`、`models/list`、`event/*`（[agent-server/src/server.ts](../packages/agent-server/src/server.ts)）。
- **认证原语已存在**：`SessionStore.issue/resolve`（签发 / 校验 per-account token，[accounts/session-store.ts](../apps/gateway/src/accounts/session-store.ts)）、`IdentityStore`（账号 + `provider:userId → accountId` 绑定，含 `telegram:*`，[accounts/identity-store.ts](../apps/gateway/src/accounts/identity-store.ts)）、`authenticateRpc`（cookie → bearer → loopback trusted，[app-rpc-server.ts](../apps/gateway/src/web/app-rpc-server.ts)）。
- **进程管理已存在**：面板通过 `GatewayProcessManager`（[runtime/gateway-process.ts](../apps/gateway/src/runtime/gateway-process.ts)）spawn detached 的 `ea-gateway start`、读 PID 文件报状态、kill/respawn 重启；`admin.startGateway/stopGateway/restartGateway`（[web/admin.ts](../apps/gateway/src/web/admin.ts)）。
- **Web 迁移半成品**：`apps/web` 已有 `RpcChatView.tsx`（连 `/rpc`）与旧 `ChatView.tsx`（连 `/api/chat`）并存，`App.tsx` 当前渲染旧的 `ChatView`；`api.ts` / `LoginPage.tsx` 仍依赖 `/api/auth/*`。

### 2.1 关键认知（避免走错方向）

- **`app-server` 不是独立服务，它是 gateway 的 RPC 面。** app 连 `/rpc` 即连 gateway；本地不存在「gateway 转发给 app-server」的网络跳。
- **「能重启网关的一方，必须在重启期间自己活着。」** 因此 UI（控制面）与 runtime（数据面）必须是两个进程——这不是缺陷，正是重启能力的前提。把 UI 折进 runtime 会毁掉重启能力。

---

## 3. 目标架构

```
运维只手动启动这一个：
  ea-gateway ui                         ← 控制面（常驻 / localhost / admin key 登录）
    │  用 GatewayProcessManager 管理下面这个子进程
    │  面板 boot 时若检测未运行则自动 spawn（detached）
    ▼
  ea-gateway start                      ← 数据面（唯一 AgentHost，可被重启）
    ├─ GatewayRuntime：挂所有 IM 通道（Telegram / 微信 …）
    └─ /rpc（WebSocket）：桌面 / 移动 / IDE 客户端连这里
         ↑ 二者共用同一个 ctx.host

重启网关 = 面板 kill + respawn 数据面子进程；UI 全程不掉。
```

- **数据面（1 host / 1 进程）**：`start` 内 `bootstrapGateway` 一次 → `ctx.host`；`GatewayRuntime` 挂 IM 通道，同时对 **同一个 `ctx.host`** 开 `/rpc`。
- **控制面（常驻）**：UI 面板负责配置读写、模型发现、用户 / key 管理、以及 start/stop/restart 数据面。它可以有自己的轻量上下文（config + keychain + 模型发现），**不承担服务用户的 host**。

---

## 4. 认证模型

去掉浏览器后，认证大幅简化——原生客户端可直接带 `Authorization` 头，不再有「浏览器 WebSocket 不能设自定义头、必须换 cookie」的约束。

### 4.1 两种运行模式

**默认 `open`**（决策 A）。运行模式按 bind 地址自动决定，无需运维显式配置：

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| `open`（默认） | bind 为 loopback（127.0.0.1 / ::1） | 免 key 直连（本地开发）。**非 loopback 一律不允许 open。** |
| `managed` | 检测到非 loopback bind | 自动切换；强制每用户 access key，无有效 key 一律拒绝 |

原则：**「不带 key」绝不等于「对公网敞开」**——`open` 只在 loopback 生效，一旦 bind 到非 loopback 即自动升级为 `managed`。

### 4.2 单一凭据：每用户 access key

- 管理员在 UI 上为每个用户签发一个 access key（可命名、可吊销、可设 TTL），落 SQLite（§6）。
- key 解析为 `accountId`；所有 `session/*`、`turn/*`、`respond` 操作按 `accountId` 做多租户归属校验（沿用 app-server 既有多租户边界）。

### 4.3 两个执行点

| 入口 | 执行点 | 逻辑 |
| --- | --- | --- |
| 桌面 / 移动 / IDE | `/rpc` 的 `authenticateRpc` | `Authorization: Bearer <key>` → 查 SQLite → `accountId`；无效则 WS 升级 401 |
| Telegram / 微信 | IM 通道入站处理 | `provider:userId → accountId`（`IdentityStore`）→ 账号是否持有效 key；无则回「请先获取访问秘钥」，不进入 host |

### 4.4 管理面（UI）登录

- **admin secret 存配置文件**（决策 B）：0600 权限，位于 gateway 数据根下；首次缺失时生成并打印到 stderr，之后从文件读取。
- **控制面与数据面共用同一份 secret**（决策 E）：两进程都从该配置文件读取，无需在进程间另行传递。轮换 = 改文件后重启数据面（面板会话失效需重新登录）。
- 管理员在 UI 输入 secret 并保存后登录（会话态）。
- **UI 面板仍只 bind localhost。** 它能装 skill / agent（≈ 任意代码执行）、明文读写 provider 密钥，属 RCE 级别面；admin key 只作纵深防御，**不作为暴露公网的通行证**。远程管理请走 VPN / SSH 隧道或后续单独设计的强认证。

---

## 5. 落地清单（按阶段，文件 / 函数级）

> 每个阶段尽量可独立合入、可回滚。建议顺序：P1 → P2 → P3 → P4 →（可选）P5。

### P1. 数据面合一：`/rpc` 折进 `start`，共用一个 host ✅ 已落地

- [x] 重构：拆出注入式核心 `startGatewayAppRpc({ agentHost, sessions, host, port, log })`（[app-rpc-server.ts](../apps/gateway/src/web/app-rpc-server.ts)），不再内部 `bootstrapGateway`；标准命令 `startGatewayAppRpcServer` 改为薄封装（bootstrap → 委托 → 一并 dispose）。
- [x] 在 `runStart`（[bin.ts](../apps/gateway/src/bin.ts)）里 `runtime.start()` 后，对 **同一个 `ctx.host`** 调 `startGatewayAppRpc`；`/rpc` 绑定失败只告警不退出（不影响 IM 通道）。
- [x] 关停顺序：SIGINT/SIGTERM 与 `onFatal` 均先 `rpcHandle.dispose()` 再 `runtime.stop()` 再 `ctx.dispose()`。
- [x] `--rpc-port`（默认 7320）/ `--rpc-host`（默认 127.0.0.1）/ `--no-rpc` 挂到 `start`。
- **验收**（已通过）：单个 `ea-gateway start` 进程同时起 `GatewayRuntime` 与 `/rpc`（同一 host）；`/healthz` 200；未认证 `/rpc` 升级被拒（auth 已生效）；关停顺序正确、PID 文件清除；`typecheck` 通过、315 项测试全绿。

### P2. UI 常驻 + 自动拉起 + 能重启 ✅ 已落地

- [x] `startWebUI`（[server.ts](../apps/gateway/src/web/server.ts)）boot 时：`gatewayStatus()` 非 `running` 则 `admin.startGateway()`（spawn detached，已在跑则 no-op）；`ea-gateway ui --no-autostart` 可关。
- [x] `admin.restartGateway()` 在 P1 后仍正确：kill+respawn 整个数据面（含 `/rpc`）；验证 PID 变更且 `/rpc` 重新绑定成功。
- [x] `writeGatewayPid` / `clearGatewayPid` 语义不变（PID 文件仍是唯一状态源）；PID 记录新增可选 `rpcUrl` 字段（子进程 `/rpc` 起来后回写）。
- [x] 面板 `/rpc` 端点展示：`GatewayStatus.rpcUrl` 经 `/api/gateway/status` → [gateway.ts](../apps/gateway/src/web/ui/components/gateway.ts) 在运行态显示（i18n `gwRpc`）。
- **验收**（已通过）：只运行 `ea-gateway ui` 即自动拉起数据面（日志 `已自动拉起数据面`）；`/api/gateway/status` 返回 `running` + `rpcUrl`；`/rpc` `/healthz` 200；面板点重启后 PID 变更、`/rpc` 重绑 200、面板全程在线；`typecheck` 通过、315 项测试全绿。

### P3. 认证收敛为 access key

> **存储决策（实现期定）**：access key 复用现有 `SessionStore`（`issue`/`resolve` per-account token，只存 hash）——它已经是「每用户 key」。**不在 P3 引入 SQLite**，迁移留到 §P5。因此 P3 的 key「查表」= `SessionStore.resolve(bearer)`。

拆为 P3a（运行模式 + `/rpc` key，纯后端）/ P3b（IM 通道入口）/ P3c（admin secret + 面板登录）/ P3d（面板 key 管理 UI）。

**P3a. 运行模式 + `/rpc` key 强制 ✅ 已落地**
- [x] 新增 [auth-mode.ts](../apps/gateway/src/accounts/auth-mode.ts)：`resolveAuthMode(host)` —— 默认 `open`，非 loopback bind 自动 `managed`，`EA_GATEWAY_AUTH_MODE` 可覆盖；`isLoopbackHost` / `isLoopbackPeer`。
- [x] 重写 `authenticateRpc`（[app-rpc-server.ts](../apps/gateway/src/web/app-rpc-server.ts)）：cookie → Bearer key(`SessionStore.resolve`) → `open`+loopback peer 才 trusted；`managed` 无有效凭据一律拒。移除旧 `EA_APP_SERVER_TRUSTED_TOKEN` 路径。`startGatewayAppRpc` 按 bind host 定 mode 并打印。
- [x] 单测 [app-rpc-auth.test.ts](../apps/gateway/test/app-rpc-auth.test.ts)（8 例，覆盖 mode 推导 + 认证矩阵）。
- **验收**（已通过）：`managed`（loopback+override）无 key / 错误 key 的 `/rpc` 升级被拒、有效 Bearer key → 101；`open`（loopback）免 key → 101；`typecheck` 通过、323 项测试全绿。

**P3b. IM 通道入口 key 校验（带内 /bind 绑定流）✅ 已落地**
- [x] dispatcher 入站口加 `imBindGate`（[dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts)）：`managed` + 私聊 + 未绑定时拦截。`/bind <key>` 始终拦截（key 不进 agent transcript）→ `SessionStore.resolve(key)` 校验 → `IdentityStore.bind(channel,userId,accountId)`；成功回「绑定成功」，无效回提示，未绑定的普通消息回「请发送 /bind <秘钥>」。绑定后身份→账号持久化，后续消息直接放行。
- [x] 装配（[gateway.ts](../apps/gateway/src/runtime/gateway.ts)）：`authMode = resolveAuthMode(undefined)`（gateway-wide，env override，默认 `open` 即不 gate，向后兼容）；`resolveKey`/`bindIdentity` 注入，store 每次读盘（跨进程签发即时生效）。
- [x] 单测 [im-bind-gate.test.ts](../apps/gateway/test/im-bind-gate.test.ts)（8 例）。
- **作用域**：仅私聊（DM）。群聊 gate 跳过——群策略（allowlist）另作为独立事项。
- **验收**（已通过）：managed 未绑定→提示且不进 agent；有效 `/bind`→绑定且不进 agent；无效 key→拒；已绑定→正常对话；open→不 gate。331 项测试全绿。
- **注**：粘贴的 key 会留在用户 IM 聊天记录里（带内绑定固有）。可选增强：绑定后自动删除该 `/bind` 消息（Telegram 支持 deleteMessage）——未做，待需要时加。

**P3c. admin secret + 面板登录 ✅ 已落地**
- [x] `paths.adminSecret`（`gateway/admin-secret`，0600）+ [admin-auth.ts](../apps/gateway/src/accounts/admin-auth.ts)：`loadOrCreateAdminSecret`（缺失则生成 + 打印一次）、无状态 cookie（`sha256(secret|admin)`，随秘钥轮换、跨面板重启存活）、常量时间校验。
- [x] 面板 [server.ts](../apps/gateway/src/web/server.ts)：`/api/admin/me`·`login`·`logout`（登录前放行），其余 `/api/*` 需有效 admin cookie（401）；`GET /` shell 不 gate（用于渲染登录浮层）。`ui --no-auth` 关闭。
- [x] 控制面 + 数据面共用同一份秘钥文件（`runStart` 也 `loadOrCreate`，谁先起谁生成并打印，决策 §7-B/E）。
- [x] SPA 登录浮层 [login.ts](../apps/gateway/src/web/ui/components/login.ts) + i18n（`loginTitle`…）+ header 退出按钮（仅 authed 显示）；boot 前 `adminGate` 决定放行/弹窗。
- [x] 单测 [admin-auth.test.ts](../apps/gateway/test/admin-auth.test.ts)（4 例）。
- **验收**（已通过）：HTTP —— 无 cookie `/api/state` 401、错误/空秘钥登录 401、正确秘钥→cookie→`/api/state` 200、logout 后 401、`GET /` 200、`--no-auth` 免登录；浏览器 —— 登录浮层渲染、填秘钥登录后面板加载、退出按钮登录后出现、无 console 错误。335 项测试全绿。

**P3d. 面板 key 管理 UI ✅ 已落地**
- [x] `GatewayAdmin`（[admin.ts](../apps/gateway/src/web/admin.ts)）新增 `listAccounts` / `createAccount` / `issueAccessKey`（返回明文一次）/ `revokeAccessKeys` / `unbindIdentity`，底层 `IdentityStore` + `SessionStore`。
- [x] 面板端点（[server.ts](../apps/gateway/src/web/server.ts)，均在 admin 登录门后）：`GET /api/accounts`、`POST /api/account/create`·`/api/account/key/issue`·`/api/account/key/revoke`·`/api/identity/unbind`。
- [x] Access 标签 [access.ts](../apps/gateway/src/web/ui/components/access.ts)：账号列表 + 绑定身份（可解绑）+ 新建账号 + 签发 key（绿框一次性展示）+ 吊销全部 key；i18n（`navAccess`/`acc*`）。
- [x] 单测：`web-admin.test.ts` +5 例（含"签发的 key 经 SessionStore 解析为该账号""吊销后停止解析"）。
- **验收**（已通过）：单元 —— 5 例；集成 —— **面板签发的 key 认证 managed `/rpc`→OPEN(101)、无 key 被拒**；浏览器 —— 登录→Access 标签→新建账号 Alice→签发 key（一次性绿框展示 43 字符）无 console 错误。340 项测试全绿、全 monorepo typecheck 通过。

---

> **P3 完成。** 认证已收敛为「每用户 access key」：`/rpc` Bearer（P3a）+ IM `/bind`（P3b）两执行点，admin 面板登录（P3c）+ key 签发/吊销 UI（P3d）。存储复用 `SessionStore`/`IdentityStore`（JSON），SQLite 迁移见 §P5。

### P4. 删除 Web 端 ✅ 已落地

- [x] 删除 `ea-gateway web` 命令 + 整个 web-chat 服务簇：`chat-server`/`chat-endpoint`/`chat-routes`/`chat-session`/`run-stream`/`ui-message-stream`/`pending`/`sessions-api`/`auth-endpoint`/`http`，以及随之孤立的 OAuth 工具 `accounts/{login,telegram-login,telegram-oidc,replay-cache}`（依赖图核对：仅这簇互相引用 + 各自测试）。删除对应 11 个测试文件。
- [x] **删除 `apps/web`**（决策 D）：整体退役。无其他包依赖 `@dami-sg/web`；`pnpm install` 已同步 lockfile（-141 包）。移除 gateway 现已无用的 `jose` 依赖（仅 telegram-oidc 用过）。
- [x] 保留共享件：`accounts/{session-store,identity-store,auth-http,admin-auth,auth-mode}`（app-server + access key + IM 仍用）、`render/chat-render`（IM）。
- [x] 同步更新 [web-app.md](web-app.md)（顶部「已废弃/移除」横幅）与 [app-server.md](app-server.md)（`/api/chat` SSE 与 `apps/web` 标为已移除）。
- **验收**（已通过）：monorepo typecheck 全绿；gateway 干净重建（dist 无 web-chat 产物，`bin.js` 无 `web` 命令、保留 `app-server`）；248 gateway 测试全绿（-11 web 测试文件）；`ea-gateway --help` 无 `web`；`start` 正常起 `/rpc` + admin secret。
- **注**：面板遗留的 `web-auth`（Telegram OAuth 配置）已**清理完毕**：删除 `admin.setWebAuth` / `/api/web-auth` 路由 / `gateway-config.webAuth` 类型与解析 / 面板 UI 卡片（`channels.ts`）+ i18n + 两个测试（面板 Channels 标签浏览器复验无异常、无 console 错误）。`.claude/launch.json` 原仅指向已删的 `apps/web`，已改指 `gateway-ui`。

### P5. 存储迁移到 SQLite ✅ 已落地（2026-07，用内置 SQLite）

**driver 决策（spike 改写了决策 C）**：先前定的 async [`sqlite`](https://www.npmjs.com/package/sqlite) 会把同步 store 及其安全关键调用点（`authenticateRpc`、IM `/bind`、`resolveNamespace`、dispatcher）全部染成 async，风险大。spike 又发现 **`better-sqlite3` 在 Bun 下加载不了**（Bun #4290），而 gateway `dev` 就是 `bun src/bin.ts`。最终选**运行时内置 SQLite**：`node:sqlite`（Node，`DatabaseSync`）/ `bun:sqlite`（Bun，`Database`）——**两者都同步 + 零原生依赖**，一举消掉异步涟漪 + 原生打包 + 跨运行时三个问题。

- [x] 同步适配器 [db.ts](../apps/gateway/src/accounts/db.ts)：`createRequire` 按运行时选内置模块（保持同步），每路径进程内**共享连接**，WAL + `busy_timeout`，schema（`accounts`/`identities`/`access_keys`/`meta`），首启**幂等**从旧 JSON（`accounts.json`/`identities.json`/`sessions.json`）导入。
- [x] [SessionStore](../apps/gateway/src/accounts/session-store.js)（access_keys）+ [IdentityStore](../apps/gateway/src/accounts/identity-store.js)（accounts/identities）改 SQLite 后端，**逐字保留同步 API** → 零 call site 改动。删除 P4 已孤立的 link-token 代码。
- [x] `engines.node` 抬到 `>=22.5.0`（node:sqlite 需 22.5，实验特性，启动打一行 `ExperimentalWarning`，无害）。
- [x] 测试：store/迁移单测重写（`_resetDbCache` 关连接避免 WAL fd 泄漏）；跨连接可见性、TTL、吊销、hash-at-rest（含 WAL sidecar）、幂等迁移。
- **验收（已通过）**：247 gateway 测试全绿（含 2 迁移）、579 monorepo 测试全绿、全 typecheck 通过；**node（prod）**签发 key → 重启后同 key `/rpc` 仍 `OPEN(101)`（`identity.db` 持久化）；**bun（dev）**真实启动 `bun:sqlite` 正常、healthz 200。

**注**：`node:sqlite` 的实验警告未在代码里强行抑制（避免全局副作用）；需静音可在 node 启动加 `--disable-warning=ExperimentalWarning`。旧 JSON 文件保留作备份（DB 为准，`meta.json_imported` 防重导）。

---

## 6. 数据与存储

- 用户与 access key 存**内置 SQLite** `identity.db`（`accounts`/`identities`/`access_keys` 表，只存 key hash，签发时一次性展示明文）；`SessionStore`/`IdentityStore` 同步接口不变，首启从旧 JSON 幂等迁移（§P5）。
- admin secret 存 gateway 数据根下的独立配置文件（0600），控制面 / 数据面共用同一份（§4.4）。
- 现有磁盘真相（`gateway.json` / `routes.json` / providers / settings）保持不变；本整合不改配置格式。
- SQLite 文件与 secret 配置文件均位于 gateway 数据根（`~/.enterprise-agent/gateway/`）下，权限 0600。

---

## 7. 已定决策

以下 5 项已拍板，实现按此执行（对应 §0 摘要与各章节）：

- **A. 运行模式默认值 → `open`。** 默认免 key；按 bind 地址自动判定，检测到非 loopback 自动切 `managed`。详见 §4.1。
- **B. admin secret 存储 → 配置文件。** gateway 数据根下的 0600 配置文件，缺失则生成并打印一次，之后从文件读取；轮换 = 改文件后重启数据面。详见 §4.4。
- **C. SQLite 驱动 → [`sqlite`](https://www.npmjs.com/package/sqlite)**（Promise 封装）+ 底层 `sqlite3`。注意 `sqlite3` 为原生模块，须纳入多架构打包流程。详见 §P5 / §6。
- **D. `apps/web` → 删除退役。** 不保留浏览器前端；富客户端由桌面 / 移动壳承载，走 `/rpc`。详见 §P4。
- **E. 面板与数据面 admin secret → 同一份。** 两进程共读同一个配置文件（对应 B），不在进程间另行传递。详见 §4.4。

---

## 8. 验收标准（Definition of Done）

1. 运维仅启动 `ea-gateway ui` 一个东西，数据面自动起；面板可重启数据面且自身不掉线。
2. 一个数据面进程内，IM 通道与 `/rpc` 客户端共用同一个 `AgentHost`；同账号跨通道共享会话与记忆。
3. `managed` 模式下，无 access key 的 `/rpc` 与无绑定的 IM 用户均被拒绝并提示；`open`（loopback）本地直连可用。
4. 仓库中不再存在 `/api/chat` SSE 与 OAuth 登录的活代码路径。
5. UI 面板 localhost + admin key 登录；未暴露 RCE 级别管理面到非 loopback。
6. 相关 spec（本文件、gateway-architecture、app-server、web-app）与实现一致。

---

## 附：与既有文档的关系

- 本文是对 [gateway-architecture.md](gateway-architecture.md) 中 §7（Web 面板）/§10（进程形态）与 [app-server.md](app-server.md)「Gateway 接入」一节的**收敛提案**：把 `ui` / `web` / `app-server` 三入口整合为「控制面 + 单 host 数据面」两进程，并以 access key 统一认证。实现落地后应回填这两篇文档并将本文状态改为「已落地」。
