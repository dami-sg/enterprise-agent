# Enterprise Agent — 桌面端（Desktop App）设计稿

> 状态：设计稿（未实现）。本文定义 `apps/desktop`：一个 Electron 桌面客户端，兑现 [app-server.md](app-server.md) §2 中 `apps/desktop # 后续：连接本地/远程 app-server` 的规划。它同时是**富客户端**（聊天，经 `@dami-sg/agent-client` 连 `WS /rpc`）和**本地控制面**（local 模式下托管常驻 gateway 的启动 / 重启 / 崩溃恢复，并承载配置界面）。
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
| 管理面 | local 模式复用 `GatewayAdmin`；Phase 1 直接内嵌现有 Web 面板，Phase 2 原生化走 IPC |
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

### 6.1 Phase 1：内嵌现有 Web 面板（零新界面代码）

- main 进程内直接 `startWebUI({ root, port: 0, autostart: false })`——面板与 app 同进程、随机 loopback 端口、**关闭面板自己的 autostart**（拉起数据面归 SidecarSupervisor 统一管，避免两处 spawn 竞争；`GatewayProcessManager.start()` 本身对 already-running 幂等，但状态机应只有一个 owner）。
- 用 `WebContentsView`（或独立 BrowserWindow 标签"设置"）加载面板 URL。
- **登录不降级**：不用 `--no-auth`，main 进程读 `paths.adminSecret`（同用户、0600 可读）后对面板 `POST /api/admin/login` 换 cookie 注入 session，用户无感登录。面板的 Host/Origin/DNS-rebinding 防护（server.ts §P3c）原样保留。

这样"从 0 可视化配置：providers / 模型 / 通道 / 密钥 / 微信扫码 / 技能 / MCP / 账号"全部立即可用，且与 CLI 写同一份配置。

### 6.2 Phase 2：原生化（IPC 直调，去 HTTP）

- main 直接实例化 `GatewayAdmin`（barrel 已导出），preload 暴露白名单方法：`admin:state`、`admin:upsertChannel`、`admin:setSecret`、`admin:gatewayStatus` … 与面板 `/api/*` 一一对应（server.ts 的 route 表即 IPC 面清单）。
- 密钥语义保持"只写不读"：renderer 只能 `setSecret(ref, value)` 与 `checkSecret(ref) -> present: boolean`，永远拿不回明文（现有 `GatewayAdmin` 已是这个形状，IPC 层不得新增读取口）。
- 原生 UI 与聊天 UI 同一渲染栈（§10），面板 `APP_HTML` 单页逐步退役（CLI `ea-gateway ui` 场景仍保留它）。

---

## 7. 聊天客户端

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
2. **密钥永不进 renderer**：provider key / channel token 的写入走"只写不读"IPC（§6.2）；remote bearer token 由 main 持有，`agent-client` 若在 renderer 建连，token 仅在 upgrade 请求头出现——v1 取定 WS 连接由 renderer 直连但 header 由 main 经代理注入，或简化为 main 建连、事件经 IPC 转发（实现期二选一，验收标准不变：renderer 进程内存中无长期 token 明文）。
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

前置改动（都很小，随 P0 一起提）：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 导出 `GatewayProcessManager` 等 | `apps/gateway/src/index.ts` | 补进 barrel（§4.1） |
| `PidRecord.version` | `apps/gateway/src/runtime/gateway-process.ts` | 可选字段，`start` 时写入（§4.5） |
| bundled skills/agents 路径解析 | gateway 复制脚本/解析处 | 支持 bundle 相邻目录（§8.1） |

---

## 11. 分阶段实现

### P0 — Local MVP（跑通三件事）

- [ ] `apps/desktop` 骨架（electron-vite + electron-builder，macOS dev 可跑）
- [ ] 前置改动三项（§10）
- [ ] SidecarSupervisor：接管/启动/停止/重启 + 状态订阅 IPC（复用 PID 契约）
- [ ] 内嵌配置面板 + admin secret 自动登录（§6.1）
- [ ] 聊天 MVP：`agent-client` 连 local `/rpc`，session 列表 + turn 流式 + 三类 interactive respond
- [ ] sidecar bundle 进 `extraResources`，打包产物在干净机器可首启自举

### P1 — Remote + 健壮性

- [ ] Remote profile：URL + bearer key 录入、safeStorage、TLS 强制、失效引导
- [ ] 崩溃恢复退避 + crash-loop 熔断 + 日志尾部展示（§4.3）
- [ ] stale/重启 banner、重启中的聊天层衔接（§7）
- [ ] 退出策略设置项（§4.4）
- [ ] 版本对齐提示（§4.5）

### P2 — 原生化与发布

- [ ] 原生配置 UI（IPC 直调 `GatewayAdmin`，§6.2）
- [ ] electron-updater 自动更新 + 发版流程接入
- [ ] 多 profile 管理 UI、菜单栏 tray（留守模式下的状态入口）
- [ ] Windows/Linux 发布验证

---

## 12. 验收

1. 干净机器装包首启：自动拉起 sidecar → 面板从 0 配好 provider/模型 → 发起对话收到流式回复。
2. `kill -9` sidecar：app 在一个探测周期内转 `error` 态、展示 gateway.log 尾部，并自动重启恢复；连崩 3 次后熔断为手动。
3. 默认退出策略下退出 app：IM 通道消息仍被 gateway 处理；重开 app 无缝接管（不重复 spawn）。
4. 用 CLI（`ea-gateway start`）预先启动的 gateway，app 启动后正确显示 running 并可 stop/restart（契约的"无论谁启动"性质）。
5. 面板改配置 → stale banner → 一键重启后新配置生效；重启期间聊天层显示"重启中"并自动重连。
6. Remote profile：bearer key 连远端 app-server 聊天可用；生命周期与配置控件不出现；key 失效有明确引导。
7. App 升级后提示 sidecar 版本落后，重启后 `status().version` 与 bundled 一致。
8. 审计 renderer：拿不到任何明文密钥（provider key、bearer token、admin secret）；面板登录未降级。
9. 同账号桌面端 + Web 订阅同一 session，两端同时看到流式输出（app-server §11.2 复验）。

---

## 13. 暂不做

- 桌面端远程管理代理（在 app 里改远端 gateway 配置）——管理面保持 localhost-only。
- 进程内嵌入 `AgentHost`（放弃 sidecar）——违背常驻定位，见 §1.1。
- Tauri / 自带独立 Node 运行时——gateway 纯 Node 无 native 依赖，`ELECTRON_RUN_AS_NODE` 已是最短路径；Tauri 需要把 PID 契约在 Rust 侧重写一遍且二进制化打包链更长，收益（体积）不抵成本。
- 多 gateway 集群管理、mobile 客户端、离线推送。
- Sidecar 静默自动重启升级（版本对齐仅提示，不打断在途会话）。
