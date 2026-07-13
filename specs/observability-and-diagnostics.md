# Enterprise Agent — 可观测性与诊断（运行日志 / 错误持久化 / 自检）

> 本文档定义 **可观测性与诊断层**——补齐当前缺失的「运行日志 + 崩溃可排障 + 运行自检」三件事，并把已有的强诊断面（审计、成本、run 树、事件流）串成一个一致的可观测体系。涵盖：现状与缺口（§1）、错误持久化 `ErrorLog`（§2，P0）、进程级错误兜底（§3，P0）、网关日志落盘与轮转（§4，P0）、统一日志抽象 `Logger`（§5，P1）、关联 id 贯穿（§6，P2）、`doctor` 自检命令（§7，P2）、OpenTelemetry 选配（§8，P2）、机密脱敏（§9）、落地阶段与接线对照（附录 A）。
>
> **设计原则**：core（[agent-architecture.md](agent-architecture.md)）保持 **host-agnostic、零内部日志**——它通过 `AgentStreamEvent`（agent §6.2）向 host 汇报，自己不打文本日志。本层新增的「文本运行日志 / 轮转 / 兜底」全部落在 **host 壳**（CLI / Gateway）；core 侧只新增**结构化错误的持久化存储**（与已有 `audit.jsonl` / `runs.jsonl` 同性质，agent §5.2/§5.3），不引入 logger。
>
> 编号：本文件章节独立顺序编号（§1–§9 + 附录 A）。本文件内引用用裸 `§x`；跨文件引用用 `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `cli §x`（[cli-architecture.md](cli-architecture.md)）/ `gateway §x`（[gateway-architecture.md](gateway-architecture.md)）限定。

---

## 1. 现状与缺口

当前仓库的「诊断面」很强、「运行日志面」几乎空白——两者是不同的层，必须分开看。

| 维度 | 现状 | 评价 |
| --- | --- | --- |
| 结构化事件流 | [events.ts](../packages/agent-contract/src/events.ts) `AgentStreamEvent` 覆盖 tool/approval/step/usage/sub-agent/compaction/`error`/auto-classified 全生命周期 | 强，不动 |
| 审计日志 | [audit-store.ts](../packages/agent/src/storage/audit-store.ts) append-only `audit.jsonl`（每次工具调用 + 审批决定） | 强，不动 |
| Run 树 | [run-store.ts](../packages/agent/src/storage/run-store.ts) `runs.jsonl`，按 `parentRunId` 串委派树 | 强，不动 |
| Token / 成本核算 | [accountant.ts](../packages/agent/src/runtime/accountant.ts) + [meta.ts](../packages/agent/src/models/meta.ts)，per-run/agent/model + USD | 强，不动 |
| **错误持久化** | `error` 事件只在 UI 以 toast 展示，**不落盘**；网关崩溃后无事后排障依据 | **缺（§2）** |
| **进程级兜底** | 全仓无 `uncaughtException` / `unhandledRejection` 处理器，只有 SIGINT/SIGTERM 优雅退出 | **缺（§3）** |
| **运行日志落盘** | [paths.ts](../apps/gateway/src/config/paths.ts) 已定义 `gateway.log` 路径但**无人写入**；39 处 `process.stderr.write` 直出，进程退出即丢 | **缺（§4）** |
| **日志抽象 / 级别** | 无 logger，无 level，无结构化，无时间戳；CLI 15 处 / Gateway 39 处 ad-hoc | **弱（§5）** |
| **运行自检** | 有 `ea config`（只读配置），无 health-check 式 `doctor` | **缺（§7）** |
| OTel / metrics endpoint | 无 OpenTelemetry / Sentry / `/metrics` | 选配（§8） |

**矛盾焦点**：`apps/gateway` 是**常驻守护进程**（Telegram / 微信 / Web 等通道），却没有持久日志、没有崩溃兜底——半夜挂掉后没有任何事后排障手段。这是本层的首要目标（P0：§2–§4）。

**范围边界**：`apps/web` 是浏览器端，错误留在 DOM / 浏览器 console，不在本层落盘范围内。

---

## 2. 错误持久化 `ErrorLog`（P0）

**目标**：core 发出的每一个 `kind:'error'` 事件（会话运行错误、上下文溢出重试失败、MCP 连接失败 `runId='mcp'`、abort）都**落一份结构化记录**，崩溃后可回溯。

**设计**：与 `audit.jsonl` / `runs.jsonl` 同性质的 append-only JSONL，但**全局一份**（不挂在某个 session 下）——因为 `error` 事件（尤其 MCP `runId='mcp'`）不总能映射到 session。落点 `~/.enterprise-agent/logs/errors.jsonl`。

- 新增 `paths.errorsLog = join(base, 'logs', 'errors.jsonl')`（[agent/config/paths.ts](../packages/agent/src/config/paths.ts)）。
- 新增 `ErrorLog` 存储类（[agent/storage/error-log.ts](../packages/agent/src/storage/error-log.ts)），复用 crash-safe 的 `appendJsonl`（agent §5.3）。
- 新增契约 `ErrorRecord`（[agent-contract/storage.ts](../packages/agent-contract/src/storage.ts)）：
  ```ts
  interface ErrorRecord {
    ts: number;
    runId?: string;        // 'mcp' 表示 MCP 故障；否则为 run id
    sessionId?: string;    // 能解析时带上（host 侧 live session 反查）
    source: 'agent' | 'mcp' | 'process' | 'gateway';
    message: string;       // 已脱敏（§9）
    stack?: string;        // 进程级兜底（§3）+ agent 运行错误（error 事件携带 stack）
  }
  ```
- **接线（host 侧，零侵入 emit 点）**：`EnterpriseAgentHost` 构造时自挂一个内部监听器（[agent/src/index.ts](../packages/agent/src/index.ts) 构造函数）：
  ```ts
  this.onEvent((e) => {
    if (e.kind === 'error') this.errorLog.record({
      ts: Date.now(), runId: e.runId, source: e.runId === 'mcp' ? 'mcp' : 'agent',
      sessionId: this.sessionForRun(e.runId), message: redact(e.message),
    });
  });
  ```
  这样**所有** `error` 事件在一个地方落盘，无需改散落在 session.ts / stream-events.ts / mcp 的多个 emit 点（保持 core 「事件驱动、单一汇报通道」的取向）。
- **读取**：`ErrorLog.recent(n)` 供 `doctor`（§7）与网关面板读取最近错误。

> 为什么不做成 per-session？per-session `errors.jsonl` 对「回放某会话」更顺手，但 MCP / 进程级错误天然无会话；全局一份 + `sessionId` 字段两头兼顾，且只加一个写入点。

---

## 3. 进程级错误兜底（P0）

**目标**：未捕获异常 / 未处理 Promise 拒绝不再静默杀进程——先记录，再决定退出。

**设计**：一个可复用的安装器 `installProcessGuards`（放 [agent/src/util/process-guards.ts](../packages/agent/src/util/process-guards.ts)，host 共用），在每个长驻进程入口安装：

```ts
installProcessGuards({
  logger,                       // §5；写 gateway.log
  errorLog,                     // §2；写 errors.jsonl（source:'process'，带 stack）
  onFatal: async () => runtime.stop(),  // 优雅收尾后退出
});
```

- `uncaughtException`：记录（含 stack）→ 尝试 `onFatal` 收尾 → `process.exit(1)`（不可恢复，必须退出）。
- `unhandledRejection`：记录（含 stack）→ **不退出**（多为可恢复的异步漏 catch），但留痕以便发现真漏洞。
- **安装点**：
  - 网关常驻：[gateway/src/bin.ts](../apps/gateway/src/bin.ts) `runStart`（含 `web` / `ui` 子命令的常驻分支）。
  - CLI 常驻：[cli serve](../apps/cli/src/commands/serve.ts) daemon 与 [headless/run.ts](../apps/cli/src/headless/run.ts)。
  - CLI TUI 交互进程同样安装（崩溃前留痕，避免终端直接白屏退出）。
- 与已有 SIGINT/SIGTERM 优雅退出（gateway §2.3）**叠加**，不替换。

---

## 4. 网关日志落盘与轮转（P0）

**目标**：把网关的 39 处 stderr 输出收敛进一个**带时间戳、可轮转、可事后 tail** 的文件——`gateway.log`（路径已存在，§1）。

**设计**：由 §5 的 `Logger` 提供「文件 sink + 按大小轮转」，网关把现有的 `log?: (line)=>void` 回调**背后接到 logger**，调用点零改动：

- [gateway/src/runtime/gateway.ts](../apps/gateway/src/runtime/gateway.ts) 的 `this.log` 默认实现从 `(l)=>process.stderr.write` 换成 `(l)=>logger.info(l)`；logger 同时写 stderr（TTY 时）与 `gateway.log`。
- 轮转策略：单文件超过 `EA_LOG_MAX_BYTES`（默认 5 MiB）→ `gateway.log` 重命名为 `gateway.log.1`（最多保留 `EA_LOG_KEEP` 份，默认 3），原子 `rename`（参照 [fs.ts](../packages/agent/src/util/fs.ts) `writeJson` 的 write-then-rename 思路）。
- 启动横幅（`[gateway] 已启动…`）与关闭横幅同样进文件，便于界定一次进程生命周期。

---

## 5. 统一日志抽象 `Logger`（P1）

**目标**：一个**极简**（非 pino/winston 级）的 logger，提供 level + 结构化字段 + 时间戳 + 文件/stderr 双 sink，供 host 壳复用。core **不使用**（保持零内部日志）。

**位置**：[agent/src/util/logger.ts](../packages/agent/src/util/logger.ts)，经 `@dami-sg/agent` 导出（gateway / cli 已依赖该包）。

**接口**：
```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;   // 关联 id 贯穿（§6）
}
interface LoggerOptions {
  level?: Level;                 // 默认取 LOG_LEVEL，再默认 'info'
  format?: 'text' | 'json';      // 默认：TTY→text，非 TTY→json（EA_LOG_FORMAT 覆盖）
  file?: { path: string; maxBytes?: number; keep?: number };  // 轮转 sink（§4）
  stderr?: boolean;              // 默认 true
  redact?: boolean;              // 默认 true（§9）
}
function createLogger(opts?: LoggerOptions): Logger;
```

- **级别过滤**：`LOG_LEVEL=debug|info|warn|error`，低于阈值的不输出。
- **text 格式**（TTY，人读）：`2026-06-27T10:00:00.000Z INFO [gateway] 通道已启动：telegram {runId=r_ab}`，颜色复用 CLI 的 `NO_COLOR` 约定。
- **json 格式**（非 TTY / 采集）：`{"ts":...,"level":"info","msg":"...","runId":"r_ab",...}` 单行 ndjson。
- **child(fields)**：派生一个带固定字段的子 logger（§6），用于把 `runId` / `sessionId` / `channel` 自动带进每一行。
- **不引入第三方依赖**——纯 Node `fs` 实现，约 80 行；轮转与 §4 共用一份逻辑。

**改造范围（最小 churn）**：
- 网关：构造一个 logger（带 file sink），`GatewayRuntime` 的 `log` 回调接到 `logger.info`；39 处 `this.log(...)` 不动。
- CLI：`serve` daemon / `headless` 用 logger（接 stderr，可选 file）；TUI 交互态默认 `level:'warn'`（不污染终端 UI），仅崩溃/错误进 logger。

---

## 6. 关联 id 贯穿（P2）

**目标**：让文本日志行与结构化 run 树（§1）能对齐排障——日志带 `runId` / `sessionId` / `channel`。

- `Logger.child({ runId, sessionId })`：在网关 dispatcher（[gateway/src/runtime/dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts)）每轮 `turnRun` 起一个子 logger，本轮所有日志自动带 id。
- 入向消息日志带 `channel` + 归一化后的 `conversationId`，便于按通道/会话 grep。
- `error` 事件落 `errors.jsonl` 时已带 `runId`（§2），与日志行的 `runId` 同源，可双向跳转。

---

## 7. `doctor` 自检命令（P2）

**目标**：一条命令给出「这套环境现在能不能正常跑」的体检表——补 `ea config`（只读配置）之外的**连通性 + 完整性**自检。

**命令**：`ea doctor`（[cli/src/commands/doctor.ts](../apps/cli/src/commands/doctor.ts)）与 `ea-gateway doctor`（网关侧，复用同一批检查 + 通道检查）。

**检查项（每项输出 ✓ / ⚠ / ✗ + 一行说明）**：
1. **Provider 密钥**：已配置的 provider 是否都有 keychain 中的 key（不打印明文，复用 `secret check` 逻辑）。
2. **沙箱**：landstrip 二进制是否可解析（managed pinned / PATH）；沙箱是否启用（关闭时 ⚠，对齐 `ea config` 的醒目告警）。
3. **MCP 服务器**：逐个尝试连接（复用 [mcp/client.ts](../packages/agent/src/mcp/client.ts) 的连接 + stderr tail），报告 ok / 超时 / 失败原因。
4. **磁盘与存储**：`~/.enterprise-agent` 可写；各 `*.jsonl`（sessions / runs / audit / errors）可解析，报告坏行数（`readJsonl` 已容忍坏行，这里只统计）。
5. **模型目录**：models.dev 缓存是否存在/可读；orchestrator alias 是否解析得到可用模型。
6. **最近错误**：`ErrorLog.recent(5)`（§2）——把最近 5 条错误直接贴出来，省去手动翻日志。
7. **网关专属（`ea-gateway doctor`）**：`gateway.pid` 是否在跑、配置 staleness（[admin.ts](../apps/gateway/src/web/admin.ts) `gatewayStatus` 已有逻辑）、各通道 token 是否就绪。

**退出码**：全 ✓→0；有 ⚠ 无 ✗→0（仅提示）；有 ✗→1（CI / systemd 可据此判健康）。

---

## 8. OpenTelemetry 选配（P2）

**目标**：给未来接 APM 留一个**低成本、零默认开销**的切入点——不绑定重依赖。

- AI SDK v6 原生支持 `experimental_telemetry`（generateText / streamText）。新增 host 选项 `telemetry?: boolean`（或 `EA_OTEL=1` / `settings.telemetry.enabled`），开启时给每次模型调用传 `experimental_telemetry: { isEnabled: true, functionId, metadata: { runId, agentId } }`（[agent/runtime/session.ts](../packages/agent/src/runtime/session.ts) + sub-agent.ts 的调用点）。
- **不在本仓打包 `@opentelemetry/*`**——由运维在宿主进程按需 `--require` 一个 OTel NodeSDK；AI SDK 的 span 会自动被采集。文档说明在 [gateway docs](../apps/gateway/docs/) 给一个 collector 接入示例。
- 默认 `EA_OTEL` 未设 ⇒ 完全不传该参数 ⇒ 零额外开销。

> 这是「留口子」而非「内建 APM」：本仓已有的 accountant（成本/token）+ errors.jsonl + run 树已覆盖大部分自运维需求；OTel 只服务接入企业级 APM 的场景。

---

## 9. 机密脱敏（§9）

结构化 logger 与 ErrorLog 都可能写入任意 `fields` / 错误消息，必须防密钥外泄（core 现状是「密钥从不进日志」，本层新增写入点后需主动维持该不变量）。

- `redact(value)`（[agent/src/util/redact.ts](../packages/agent/src/util/redact.ts)）：
  - 对 key 命中 `/token|secret|api[-_]?key|authorization|password|cookie/i` 的字段，值替换为 `***`。
  - 字符串中形如 `ENTERPRISE_AGENT_KEY_*`、`sk-…`、Bearer token 的子串打码。
- Logger / ErrorLog 默认 `redact:true`；写入前对 `msg` 与 `fields` 跑一遍。
- 与现有约定一致：MCP 子进程 env 已剥离 `ENTERPRISE_AGENT_KEY_*`（[mcp/client.ts](../packages/agent/src/mcp/client.ts)），本层是日志侧的对称防线。

---

## 附录 A — 落地阶段与接线对照

**P0（崩溃可排障，先做）**
| 步骤 | 文件 | 动作 |
| --- | --- | --- |
| A1 | `agent-contract/src/storage.ts` | 加 `ErrorRecord` 类型 |
| A2 | `agent/src/config/paths.ts` | 加 `errorsLog` 路径 |
| A3 | `agent/src/util/redact.ts` | 脱敏工具（§9） |
| A4 | `agent/src/storage/error-log.ts` | `ErrorLog`（append/recent） |
| A5 | `agent/src/index.ts` | host 构造挂内部监听 → `error` 事件落 `errors.jsonl` |
| A6 | `agent/src/util/process-guards.ts` | `installProcessGuards`（§3） |
| A7 | `agent/src/util/logger.ts` | `createLogger` + 文件轮转 sink（§4/§5 同源） |
| A8 | `gateway/src/bin.ts` | 装 guards + 构造 file logger + `log` 回调接 logger |
| A9 | `agent/src/index.ts` exports | 导出 logger / guards / ErrorLog / redact |

**P1（统一日志）**
| 步骤 | 文件 | 动作 |
| --- | --- | --- |
| B1 | `gateway/src/runtime/gateway.ts` | `log` 默认走 logger；保留回调签名 |
| B2 | `cli/src/commands/serve.ts` / `headless/run.ts` | 用 logger；`LOG_LEVEL` 生效 |
| B3 | `cli/src/bin.ts` | 顶层 catch 经 logger.error + errors.jsonl |

**P2（诊断增强）**
| 步骤 | 文件 | 动作 |
| --- | --- | --- |
| C1 | `gateway/src/runtime/dispatcher.ts` | 每轮 `logger.child({runId,sessionId,channel})`（§6） |
| C2 | `cli/src/commands/doctor.ts` + program 注册 | `ea doctor`（§7） |
| C3 | `gateway/src/bin.ts` | `ea-gateway doctor` 子命令（§7） |
| C4 | `agent/src/runtime/session.ts` + `sub-agent.ts` | `experimental_telemetry` 选配 passthrough（§8） |
| C5 | `apps/gateway/docs/` | OTel collector 接入示例 |

**测试**
- `agent/test/logger.test.ts`：级别过滤、json/text 格式、轮转（超阈值 rename、保留份数）、redact。
- `agent/test/error-log.test.ts`：append + recent + 坏行容忍。
- `agent/test/redact.test.ts`：各类密钥模式打码。
- `cli/test/doctor.test.ts`：各检查项 ✓/⚠/✗ 与退出码。
