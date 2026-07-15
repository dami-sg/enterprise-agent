# Enterprise Agent — 桌面端（Desktop App）设计稿

> 状态：**P0–P2 已落地**（见 §14 实现记录与验收）。本文定义 `apps/desktop`：一个 Electron 桌面客户端，兑现 [app-server.md](app-server.md) §2 中 `apps/desktop # 后续：连接本地/远程 app-server` 的规划。它同时是**富客户端**（聊天，经 `@dami-sg/agent-client` 连 `WS /rpc`）和**本地控制面**（local 模式下托管常驻 gateway 的启动 / 重启 / 崩溃恢复，并承载配置界面）。
>
> 关联文档：[app-server.md](app-server.md)（协议与鉴权）、[gateway-architecture.md](gateway-architecture.md) §7/§10（PID 契约与面板）、[gateway-consolidation.md](gateway-consolidation.md) §P2/§P3（控制面拉起数据面、admin 登录）、[observability-and-diagnostics.md](observability-and-diagnostics.md)（日志与 doctor）。

---

## 0. 决策摘要

| 决策 | 取定 |
| --- | --- |
| 壳 | Electron（≥ 35：内置 Node ≥ 22.14，满足 gateway `engines >= 22.13` 与 `node:sqlite` builtin） |
| 新 app | `apps/desktop`：`main`（生命周期 + 管理）、`preload`（IPC 白名单）、`renderer`（UI） |
| 连接模式 | Connection profile 二态：`local`（sidecar 托管）/ `remote`（只连不管） |
| Sidecar | 复用 gateway 既有 PID 契约与 `GatewayProcessManager`；spawn 打包在 app 内的 `ea-gateway start`（`ELECTRON_RUN_AS_NODE=1`，无需第二份 Node） |
| 聊天协议 | `@dami-sg/agent-client` → `WS /rpc`（app-server spec §4–§6），不新增协议 |
| 管理面 | local 模式内嵌现有 Web 面板（admin secret 自动登录）；原生配置经 main 持有的 admin cookie 调面板 JSON API（**修订**：不进程内实例化 `GatewayAdmin`，理由见 §6.2） |
| Sidecar 打包 | esbuild 把 `ea-gateway` bundle 成单文件（无 native 依赖），随 `extraResources` 发布，bundled skills/agents 目录同行 |
| 更新 | electron-updater；app 升级后按版本对齐策略提示重启 sidecar |
| Remote 鉴权 | Bearer access key（`GatewayAdmin.issueAccessKey`）+ TLS；token 存 OS keychain（`safeStorage`） |
| Local 鉴权 | loopback `open` mode（auth-mode §4.1）；面板用 admin secret 自动登录，不用 `--no-auth` |

---

## 1. 目标与定位

桌面端要兑现三件事：

1. **连接 remote/local 两种 gateway**：切换只是换一个 connection profile，聊天协议完全一致。
2. **Local 模式托管 gateway 生命周期**：app 负责启动、崩溃检测、自动重启、配置变更后重启生效；gateway 作为独立 OS 进程（sidecar）运行，不嵌进 Electron 进程内。
3. **在 app 内配置 gateway**：模型 / provider / 密钥 / 通道 / 技能，与 CLI、Web 面板写同一份 on-disk truth（gateway §1：共享 `~/.enterprise-agent/`）。

**不是什么**：不是第二个 agent runtime（内核仍是 sidecar / remote server 里的 `AgentHost`）；不是公网管理面（管理类方法不进 app-server，见 app-server §7.2）；不是移动端（mobile 只连公网 app-server，另行规划）。

### 1.1 为什么 sidecar 而不是进程内嵌入

CLI/TUI 是进程内 `createAgentHost()`，桌面端理论上也可以。但 gateway 的核心价值是**常驻**（IM 通道 7×24 收消息、schedules 到点执行），而桌面 app 的生命周期跟随用户开关。进程内嵌入意味着"关掉窗口 = 微信/Telegram 掉线"。Sidecar + detached 让数据面独立于 UI 存活，这与 `ea-gateway ui` 面板已经验证过的"控制面拉起数据面"模型（gateway-consolidation §P2）完全一致——桌面端只是把浏览器面板换成常驻桌面壳。

---

## 2. 架构总览

```
┌─ Electron app (apps/desktop) ──────────────────────────────┐
│  renderer（沙箱，无 Node）                                   │
│    ├─ Chat UI          ── @dami-sg/agent-client ──┐         │
│    └─ Admin UI（P1 内嵌面板 / P2 原生）            │         │
│  preload：白名单 IPC bridge                        │         │
│  main                                             │         │
│    ├─ ProfileStore（local/remote 连接配置）        │         │
│    ├─ SidecarSupervisor（包 GatewayProcessManager）│         │
│    └─ GatewayAdmin（local 管理面，进程内直调）      │         │
└───────────────────────────────────────────────────┼─────────┘
              │ spawn/SIGTERM（仅 local）            │ WS /rpc
              ▼                                     ▼
   ea-gateway start（sidecar，detached）      local: 127.0.0.1:7320/rpc
     = IM channels + /rpc on one host        remote: wss://host/rpc + Bearer
              │
              ▼
   ~/.enterprise-agent/（与 CLI / 面板共享的 on-disk truth）
```

关键边界：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `main/SidecarSupervisor` | 进程生死、崩溃恢复、版本对齐 | 业务协议、配置语义 |
| `main/GatewayAdmin`（复用） | 配置读写、密钥、通道、access key 签发 | 进程管理（委托 supervisor） |
| `renderer` | UI 渲染、`agent-client` 会话 | 任何密钥明文、任何 `node:*` 能力 |
| sidecar（`ea-gateway start`） | `AgentHost` + IM 通道 + `/rpc` | 桌面 UI |

---

## 3. Connection profile

### 3.1 数据模型

```ts
interface ConnectionProfile {
  id: string;
  name: string;                  // "本机" / "公司服务器"
  mode: 'local' | 'remote';
  // local:
  root?: string;                 // App 数据根，默认 ~/.enterprise-agent
  rpcPort?: number;              // sidecar /rpc 端口（默认 7320）；与另一套网关并存时改用他值
  panelPort?: number;            // 配置面板端口（默认 7317）
  // remote:
  url?: string;                  // wss://host[:port]/rpc
  tokenRef?: string;             // OS keychain 引用，不落明文
}
```

- Profile 列表存 `app.getPath('userData')/profiles.json`；**其中不含任何秘密**。Remote 的 bearer token 经 Electron `safeStorage` 加密后单独存放，`tokenRef` 只是索引。
- 默认内置一个 `local` profile（root 为默认值），首启零配置可用。
- 同一时刻一个活动 profile；切换 = 断开 `agent-client` 重连，不影响 local sidecar 的存活。

### 3.2 rpcUrl 发现

- **local**：不硬编码端口。PID record（`gateway/gateway.pid`）里由 sidecar 回写的 `rpcUrl` 是权威（gateway-process.ts：`writeGatewayPid` 的 `rpcUrl` 字段，`/rpc` 监听后由子进程覆写）。Supervisor `status()` 拿到 `rpcUrl` 后再让 renderer 连接；拿不到（老版本 sidecar / `--no-rpc`）时回退默认 `ws://127.0.0.1:7320/rpc`。
- **remote**：profile 里的 `url` 即权威。非 loopback 地址强制 `wss://`（明文 `ws://` 仅允许 loopback，与 app-server §7.1 的 TLS 要求一致）。

### 3.3 鉴权

| Profile | Auth（对齐 app-server §7.1） |
| --- | --- |
| local | loopback `open` mode（auth-mode.ts：loopback bind 自动免 key）；无需 token |
| remote | `Authorization: Bearer <access key>`，由服务器侧管理员经 `GatewayAdmin.issueAccessKey`（面板 `/api/account/key/issue`）签发，用户粘贴进 app 一次，之后存 keychain |

Token 失效（`-32002 Unauthorized`）→ UI 引导重新粘贴，不做自动续期（v1）。

---

## 4. Local 模式：sidecar 生命周期

### 4.1 复用 PID 契约（不发明新机制）

gateway 已有完整的跨进程契约（gateway-process.ts 头注释）：`ea-gateway start` 启动写 PID、优雅退出清除；观察者由"PID 文件 + 存活探测"推导三态——**file 存在 + 进程活 = running；file 不存在 = stopped；file 存在 + 进程死 = error（崩溃）**。该契约的设计初衷就是"无论谁启动的都成立"（面板、CLI、systemd），桌面 app 是第四个天然的参与者：

- app 启动时若发现 gateway 已在跑（用户此前用 CLI 或面板启动的），直接接管展示，不重复拉起；
- app 退出后 gateway 留守，下次启动重新接管。

**前置小改动**：`GatewayProcessManager` 目前未进 `@dami-sg/gateway` 的 barrel（index.ts 只导出了 `createGatewayPaths` / `startWebUI` / `GatewayAdmin`）。需补导出 `GatewayProcessManager`、`writeGatewayPid`、`clearGatewayPid` 及相关类型。

### 4.2 启动（Electron 特有的注入）

`GatewayProcessManager` 的 `exec` / `bin` / `spawn` 都是注入点，正好覆盖 Electron 的差异，不需要改它的逻辑：

```ts
new GatewayProcessManager({
  paths: createGatewayPaths(profile.root),
  root: profile.root,
  exec: process.execPath,                       // Electron 自身二进制
  bin: join(process.resourcesPath, 'sidecar/gateway.mjs'),
  spawn: (cmd, args, opts) =>
    nodeSpawn(cmd, args, {
      ...opts,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },  // 以纯 Node 语义运行
    }),
});
```

要点：

- **不打包第二份 Node**：`ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以其内置 Node 运行 sidecar 脚本。Electron ≥ 35 内置 Node 22.14+，满足 gateway `engines >= 22.13` 及 `node:sqlite` unflagged 的要求（accounts/db.ts 对 22.5–22.12 的 flag 处理自然不触发）。
- 默认 `bin = process.argv[1]` 在 Electron 下指向 app 入口而非 gateway，**必须显式注入**打包路径。
- `detached: true` + `stdio: 'ignore'` 沿用现状：日志由 sidecar 自己的 logger 写 `gateway/gateway.log`（带轮转，observability §4），supervisor 不重定向（避免双写，见 gateway-process.ts 注释）。

### 4.3 健康监控与崩溃恢复

Supervisor 在 main 进程维护一个状态机，UI 经 IPC 订阅：

```
stopped ──start()──▶ running ──进程死+PID残留──▶ error（crashed）
   ▲                    │                            │
   └────stop()──────────┘          自动重启（退避）◀──┘
```

- **探测**：轮询 `status()`（PID 存活探测是 `kill(pid, 0)`，纯本地、廉价，5s 间隔足够）；`running` 且有 `rpcUrl` 时辅以 `GET /healthz` 确认 RPC 面可用。
- **崩溃恢复**：进入 `error` 态即展示 `status().detail`（gateway.log 尾部 = 崩溃原因），并自动 `start()` 重试，指数退避（1s/5s/30s），窗口期内连崩 3 次转为手动模式（避免 crash-loop 烧日志），UI 呈现"已停止自动重启，查看日志"。
- **stale**：配置写入后 supervisor 置 `stale`（语义同现有面板：`GatewayStatus.stale` 由知道配置面的一方设置，见 gateway-process.ts 注释），UI 顶部 banner"配置已变更，重启网关生效"→ 一键 `restart()`。

### 4.4 退出策略

默认**留守**（与 `ea-gateway ui` 一致：sidecar detached、unref，数据面独立于控制面存活——IM 通道不因关窗口掉线）。设置项"退出时停止网关"供单机纯桌面用户选择，勾选后 app quit 钩子里 `stop()`（SIGTERM，gateway 已有优雅退出路径清 PID）。

### 4.5 版本对齐（app 自动更新的连带义务）

App 升级会带来新的 bundled sidecar，但留守的旧 sidecar 还在跑旧代码。契约扩展：

- `PidRecord` 增加可选 `version` 字段（`ea-gateway start` 启动时写入自身包版本；老记录无此字段视为 unknown）。向后兼容——面板与 CLI 不感知也不受影响。
- App 启动/更新完成后比对 `status().version` 与 bundled 版本，不一致 → banner"网关版本落后（0.0.11 → 0.0.12），重启以升级"→ `restart()`。不做静默自动重启（用户可能有在途会话）。

---

## 5. Remote 模式：只连不管

- 仅使用 `agent-client` 连 profile 的 `url`；**生命周期控件、配置面全部隐藏**——远端 gateway 的启停归远端运维（systemd / 面板），管理类方法本就不进 app-server（§7.2）。
- 需要改远端配置时，UI 提示"请在服务器的配置面板（`ea-gateway ui`）操作"，不做远程管理代理（见 §12 暂不做）。
- 连接失败 / token 失效的重连遵循 app-server §8.1：`initialize` → `session/history` → `event/subscribe`。

---

## 6. 配置面（app 内配置 gateway）

只在 local profile 下可用。分两阶段：

### 6.1 面板窗口（**实现修订**：链接弹窗，不做内嵌）

设置页只保留「连接」和「应用」两个原生区块；「网关配置」是一行说明 + **"打开网关配置 ↗"按钮**，点击在独立 BrowserWindow 中打开完整 Web 面板（曾实现过 WebContentsView 内嵌 + 原生 admin 区块，后按产品决策撤除——面板窗口更简单且能力等价）。

- 面板进程：sidecar 子进程 `gateway.mjs ui --no-autostart --port <panelPort>`（拉起数据面归 SidecarSupervisor 统一管，状态机单 owner）；随 app 退出。
- **登录不降级**：不用 `--no-auth`。admin cookie 是确定性的 `sha256(secret + '|ea-admin')`（admin-auth.ts），main 读 0600 的 `paths.adminSecret` 本地算出 cookie 注入 Electron session——面板窗口共享 defaultSession，打开即已登录；外部浏览器则会看到登录页（这正是选 BrowserWindow 而非 `shell.openExternal` 的原因）。面板的 Host/Origin/DNS-rebinding 防护（server.ts §P3c）原样保留。

这样"从 0 可视化配置：providers / 模型 / 通道 / 密钥 / 微信扫码 / 技能 / MCP / 账号"全部立即可用，且与 CLI 写同一份配置。

### 6.2 原生化（**已撤除**，保留决策记录）

原方案（main 内实例化 `GatewayAdmin` → 后改为 admin bridge 代理面板 `/api/*`）曾完整落地并通过验收，
但最终按产品决策撤除：**网关配置不做原生 UI**，设置页只留「连接」和「应用」，其余全部指向面板窗口（§6.1）。
撤除的理由：两套配置 UI（原生区块 + 面板）意味着双份维护和状态同步（stale 语义在两处对不齐）。
若未来要恢复原生化，走 admin-bridge 路线（main 持 cookie 代理白名单 `/api/*`、密钥只写不读、
封死 `/api/admin/login|logout`）——不要在 Electron main 里 bootstrap `AgentHost`。
gateway 侧配置变更的 stale/重启提示由面板窗口自身承载；app 的 `GatewaySnapshot.stale` 字段保留（供未来接入）。

---

## 7. 聊天客户端

> **实现修订（UI 栈与 CLI 对齐）**：renderer 为 React + Tailwind v4 + shadcn/ui（手工 vendored 组件，`components/ui/`）。
> 聊天状态**直接复用 CLI 的 trace reducer**（`@dami-sg/cli/trace` 子路径导出，cli §5.3——纯逻辑、仅依赖 agent-contract）：
> `reduceTrace` 折叠事件流、`reconstructTrace` 沿 root→head 路径重建历史、tool/审批/提问/sub-agent 嵌套重归/todo/usage/压缩
> 语义与 TUI 完全一致（含 CLI 侧 60 个既有测试的保障）。app-server 通知按 projectEvent 的投影规则映射回
> `AgentStreamEvent`（多数通知 spread 原事件、自带 `kind`；deltas/turn-completed/session-updated 需重整形）。
> 渲染：assistant 文本走 react-markdown+GFM，tool call 为折叠卡（状态图标/输入/输出/嵌套 sub-agent 卡），
> todo 面板悬浮于转录区，loading 为"思考中/生成中"spinner+skeleton，运行中禁止二次发送（mid-run guard，cli §6.2）并提供中断。

- `agent-client` 连接活动 profile 的 `/rpc`；`initialize.clientInfo.name = 'enterprise_desktop'`。
- 订阅：桌面端属于可信客户端，允许 `event/subscribe { kind: 'account' }`（app-server §4.3 明文豁免桌面端），会话列表可实时联动；单会话视图仍以 `session` scope 为主。
- 能力覆盖 app-server §5 的 MVP 集：session 列表/创建/历史、`turn/start`、流式渲染（`item/textDelta`、`item/toolCall`…）、审批 / 提问 / 计划三类 interactive respond、`turn/interrupt`。
- 断线重连按 §8.1；`-32001 Overloaded` 由 SDK 退避，UI 只做提示。

Local profile 下有一个桌面特有的衔接：sidecar `restart()` 必然掉线，supervisor 把"重启中"状态推给 renderer，聊天层显示"网关重启中…"并在 `rpcUrl` 重新可用后自动重连——避免用户把预期内的重启误读为故障。

---

## 8. 打包与更新

### 8.1 Sidecar 打包

gateway 依赖链（`@dami-sg/agent` → ai-sdk / MCP SDK / zod）**没有任何 native module**——SQLite 走 `node:sqlite` builtin（accounts/db.ts）。因此取定 **esbuild 单文件 bundle**：

```
apps/desktop/resources/
  sidecar/
    gateway.mjs        # esbuild bundle of apps/gateway/src/bin.ts（外置 node:* builtins）
    skills/            # copy-bundled-skills.mjs 的产物（bundled skills 是目录资产，不进 bundle）
    agents/            # copy-bundled-agents.mjs 同理
```

- 经 electron-builder `extraResources` 发布到 `process.resourcesPath/sidecar/`（不进 asar：需要被 spawn 为独立脚本）。
- sidecar 里定位 bundled skills/agents 的路径解析需支持从 bundle 相邻目录读取（现有 copy 脚本已把它们放 dist 旁边，bundle 后保持同构）。
- 备选方案 `pnpm deploy` 整棵 node_modules 进 `extraResources` 作为逃生舱：若未来引入 native 依赖或 bundle 出兼容问题时切换，接口（`bin` 注入路径）不变。

### 8.2 App 更新

- electron-updater 标准通道（GitHub Releases，随现有 `chore/release-v*` 流程发版）。
- 更新下载完成 → 重启 app 生效 → 触发 §4.5 版本对齐提示。Sidecar 是 detached 进程，app 更新期间数据面不中断——这是留守策略的额外红利。

### 8.3 平台

macOS 优先（当前团队环境），签名/公证走 electron-builder 常规配置；Windows/Linux 构建保持可编译但 P2 前不做发布验证。

---

## 9. 安全

1. **Renderer 零特权**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；preload 只暴露白名单 IPC。webview/外链一律 `shell.openExternal`。
2. **密钥永不进 renderer**：provider key / channel token 的写入走"只写不读"IPC（§6.2）；remote bearer token 由 main 持有。**已取定：main 建连**（`src/main/connection.ts` 用 `ws` 在 upgrade 头注入 `Authorization: Bearer`，浏览器 WebSocket 本就设不了该头），请求/通知经 IPC 转发；renderer 中 token 仅在用户粘贴瞬间存在。
3. **面板不降级**：内嵌面板保留 admin secret 登录（自动注入，§6.1），不使用 `--no-auth`；Host/Origin 防护原样生效。
4. **Loopback 纪律**：local 一切面（面板、/rpc）绑 127.0.0.1；desktop 不提供"把本机 gateway 暴露公网"的开关。
5. **Remote token 存储**：`safeStorage`（macOS Keychain / Windows DPAPI / Linux libsecret），`profiles.json` 明文里只有 `tokenRef`。

---

## 10. 包结构与前置改动

```
apps/desktop/
  package.json           # @dami-sg/desktop；deps: @dami-sg/gateway, @dami-sg/agent-client (workspace)
  electron.vite.config.ts
  src/
    main/
      index.ts           # app 生命周期、窗口
      profiles.ts        # ProfileStore + safeStorage
      supervisor.ts      # SidecarSupervisor（包 GatewayProcessManager + 退避 + 版本对齐）
      admin-bridge.ts    # P2：GatewayAdmin IPC 面
      panel.ts           # P1：startWebUI 内嵌 + admin secret 自动登录
    preload/index.ts
    renderer/            # Solid + Vite（与 TUI 的 OpenTUI+Solid 迁移同栈，组件心智共享）
  resources/sidecar/     # 构建产物，见 §8.1
  scripts/bundle-sidecar.mjs
```

前置/配套改动（均已落地）：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| ✅ 导出 `GatewayProcessManager` 等 | `apps/gateway/src/index.ts` + 子路径 exports（`./process` `./paths` `./admin-auth` `./version`） | main 只引轻模块，不拖整棵 gateway 图（§4.1） |
| ✅ `PidRecord.version` | `apps/gateway/src/runtime/gateway-process.ts` + `src/version.ts` | `start` 时写入包版本；bundle 经 esbuild `define` 注入（§4.5） |
| ✅ bundled skills/agents 路径解析 | `web/bundled-skills.ts` / `web/bundled-agents.ts` | 新增 bundle 相邻目录候选（§8.1） |
| ✅ `ProcessManagerDeps.extraArgs` | `gateway-process.ts` | spawn 时附加 `--rpc-port`（profile 定制端口，§3.1） |
| ✅ app-server 优雅关闭修复 | `packages/agent-server/src/node.ts` | dispose 先 `terminate()` 全部 WS 客户端 + `closeAllConnections()`——否则桌面端自己的连接会把旧进程卡死在关闭中，新进程 EADDRINUSE 崩溃循环；同时 `listen` 错误改为 reject，让 `ea-gateway start` 的"bind 失败不拖垮 IM 通道"语义真正成立 |

---

## 11. 分阶段实现

### P0 — Local MVP（跑通三件事）

- [x] `apps/desktop` 骨架（electron-vite + electron-builder，macOS dev 可跑）
- [x] 前置改动（§10，含实现期新增两项）
- [x] SidecarSupervisor：接管/启动/停止/重启 + 状态订阅 IPC（复用 PID 契约）
- [x] 内嵌配置面板 + admin secret 自动登录（§6.1）
- [x] 聊天 MVP：`agent-client` 连 local `/rpc`，session 列表 + turn 流式 + 三类 interactive respond
- [x] sidecar bundle 进 `extraResources`，打包产物在干净机器可首启自举

### P1 — Remote + 健壮性

- [x] Remote profile：URL + bearer key 录入、safeStorage、TLS 强制、失效引导（upgrade 401/403 → -32002 语义，停止重连）
- [x] 崩溃恢复退避 + crash-loop 熔断 + 日志尾部展示（§4.3）
- [x] stale/重启 banner、重启中的聊天层衔接（§7）
- [x] 退出策略设置项（§4.4）
- [x] 版本对齐提示（§4.5）

### P2 — 原生化与发布

- [x] 原生配置区块（admin bridge，§6.2 修订版；完整面板保留为右侧后备）
- [x] electron-updater 接入（GitHub Releases feed；下载后 banner 提示安装；CJS interop 兜底不阻塞启动）
- [x] 多 profile 管理 UI、菜单栏 tray（留守模式下的状态入口）
- [ ] Windows/Linux 发布验证（配置可编译；发布验证仍待 CI/真机，§8.3 原计划即如此）

---

## 12. 验收（2026-07-14 实测记录；隔离环境：scratch root + rpc 17320 / panel 17317，mock OpenAI-compatible LLM）

1. ✅ 冷启动自举：**打包产物**（electron-builder .app，sidecar 在 `Contents/Resources/sidecar/`）首启自动拉起 sidecar（PID 记录含 `rpcUrl` + `version`），经 admin bridge 从 0 配置 provider（mock）+ orchestrator，UI 发消息收到流式回复 + usage 统计。
2. ✅ `kill -9` sidecar：轮询周期内转 `error`，8s 内自动拉起新 PID；熔断逻辑（连崩 3 次转手动 + 日志尾部展示）由单测覆盖（`test/supervisor.test.ts`）。
3. ✅ 默认退出策略：SIGTERM 退出 app 后 gateway 进程与 `/healthz` 均存活；面板子进程随 app 退出。勾选"退出时停止网关"后退出 → 进程终止、PID 文件清除。
4. ✅ 接管：app 重启后正确显示既有 gateway（跨 app 实例存活的 PID）为 running，未重复 spawn；stop/restart 可用。
5. ✅ stale → 重启生效：admin bridge 写 provider/model 后 `stale:true` + banner；一键重启（修复了旧进程被客户端连接卡死导致 EADDRINUSE 的 bug 后）新 PID 就绪、RPC 自动重连、mock 模型对话可用（即新配置已生效）。
6. ✅ Remote profile：向 managed 模式 app-server 用 bearer access key 连接成功（accountId 与签发账号一致）；remote 下网关生命周期/配置控件隐藏；无效 key → upgrade 401 → `-32002` banner 引导且不再重连风暴；重粘贴有效 key 即恢复。
7. ✅ 版本对齐：伪造 PID 记录 `version:0.0.1` → 一个轮询周期内出"网关版本落后（运行 0.0.1 → 内置 0.0.12），重启以升级"banner → 点击重启后 version 对齐、banner 消失。
8. ✅ Renderer 审计：`window.ea` 仅白名单 API；profiles 无 token 读口（list 只带 `hasToken`）；`require`/`process` 不存在（sandbox+contextIsolation）；admin bridge 封死 `/api/admin/login`；RPC 方法白名单拦截非聊天方法（如 `shutdown`）；内嵌面板 `authed:true` 且 `required:true`（登录未降级）。
9. ✅ 双端订阅：独立第二 WS 客户端订阅同一 session，与桌面 UI 同时收到同一 turn 的全部 `item/textDelta`（5 段、文本一致）。

> 未覆盖：真实 IM 通道（验收环境无 bot token）、electron-updater 的真实下载安装（需签名产物 + GitHub feed，接入代码与 banner 流程已就绪）、Windows/Linux 真机。

---

## 13. 暂不做

- 桌面端远程管理代理（在 app 里改远端 gateway 配置）——管理面保持 localhost-only。
- 进程内嵌入 `AgentHost`（放弃 sidecar）——违背常驻定位，见 §1.1。
- Tauri / 自带独立 Node 运行时——gateway 纯 Node 无 native 依赖，`ELECTRON_RUN_AS_NODE` 已是最短路径；Tauri 需要把 PID 契约在 Rust 侧重写一遍且二进制化打包链更长，收益（体积）不抵成本。
- 多 gateway 集群管理、mobile 客户端、离线推送。
- Sidecar 静默自动重启升级（版本对齐仅提示，不打断在途会话）。

---

## 14. 实现记录（与设计稿的偏差及原因）

| 偏差 | 设计稿 | 实现 | 原因 |
| --- | --- | --- | --- |
| 原生管理面 | main 进程内实例化 `GatewayAdmin` | admin bridge：main 持 admin cookie 代理面板 `/api/*` | `GatewayAdmin` 依赖 bootstrap 出的完整 `AgentHost`，嵌入 main 会在桌面进程再开一个 host（重且与 sidecar 重复）；见 §6.2 修订 |
| WS 归属 | renderer 直连或 main 建连二选一 | **main 建连**（`ws` + upgrade 头注 Bearer），IPC 转发 | 浏览器 WebSocket 设不了 `Authorization` 头；同时天然满足"token 不进 renderer" |
| 面板宿主 | `startWebUI` 在 main 进程内跑 | 面板作为 sidecar 子进程（`gateway.mjs ui --no-autostart`），main 只注 cookie | 同上——`startWebUI` 也要 bootstrap host；子进程方案让 gateway 代码只存在于 sidecar bundle 一处 |
| Profile 端口 | 未设计 | `rpcPort`/`panelPort` 字段 + `GatewayProcessManager.extraArgs` | 验收时发现与开发机上已有的常驻网关（7317/7320）冲突；多网关并存是真实场景 |
| barrel 导出 | 全量进 index.ts | 另加子路径 exports（`./process` 等） | main 的 bundle 不应拖入 IM adapters 整棵图 |
| 设置页形态 | 内嵌面板 + 原生 admin 区块 | 仅「连接」+「应用」，网关配置=面板弹窗链接（§6.1/§6.2） | 双份配置 UI 的维护与 stale 同步成本；面板窗口共享 session cookie 天然免登录 |
| 图标 | 未设计 | `scripts/gen-icons.mjs` 程序化生成（纯 Node PNG 编码器 + iconutil 出 icns）：托盘 template 图标、Dock/打包图标 | 无设计资产依赖；托盘 template 随菜单栏深浅色自适应 |
| Renderer 栈 | Solid（与 TUI 同栈） | React + Tailwind v4 + shadcn/ui；聊天状态复用 `@dami-sg/cli/trace`（新增子路径导出） | shadcn 官方生态是 React；trace reducer 本就渲染无关，复用后 tool/审批/提问/sub-agent/todo/历史重建与 CLI 严格一致且免双份维护 |

实现期修出的既有 bug（非桌面代码）：

1. `packages/agent-server/src/node.ts` dispose 不终止已连接的 WS 客户端 → 常驻网关优雅关闭被任意存活客户端无限卡住，重启的替身进程 EADDRINUSE 崩溃循环。已修（terminate + closeAllConnections）。
2. 同文件 `server.listen` 无 error 监听 → EADDRINUSE 变成 uncaughtException 直接 fatal，绕过了 `ea-gateway start` 里"bind 失败不拖垮 IM 通道"的 try/catch。已修（reject）。
3. `ea-gateway --version` 硬编码 `0.0.1` 与包版本漂移。已改为 `gatewayVersion()`（package.json / `EA_GATEWAY_VERSION` 注入）。

打包要点（§8 的落地细节）：Electron 43（内置 Node ≥22 含 `node:sqlite`）；sidecar bundle 2.7MB 单文件 + skills/agents 目录 + version.json；`apps/desktop` 的运行时依赖只留 `electron-updater`（bundle 外部化），其余全走 devDependencies——electron-vite 默认外部化 `dependencies`，若把 workspace 包留在 dependencies，asar 会被整棵 node_modules 灌到 60MB+。electron-updater 是 CJS，动态 import 需做 `mod.autoUpdater ?? mod.default?.autoUpdater` interop 且失败不得阻塞启动（打包环境实测踩过）。
