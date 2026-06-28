# Enterprise Agent — 声明式 Sub-Agent 与定时任务（改造 spec）

> ⚠️ **A 节（声明式 Sub-Agent）已被 v0.7 取代，仅作历史背景**。v0.7「自生成式 Sub-Agent」
> 取消了本节的全部机制——预定义 role 枚举、`ROLE_TOOL_POLICY`、`AgentRegistry`/种子、
> 磁盘 `AGENT.md` 发现、`delegateAgents` 嵌套委派、`agents` 白名单、CLI `ea agent` 命令——
> 改为 Orchestrator 在委派时**按需合成**临时子 Agent（能力 + prompt），受**管理员能力包络**
> （`dynamicSubAgents`）约束、用完即弃、不可嵌套。**当前权威设计见 [`dynamic-subagents.md`](dynamic-subagents.md)**。
> 下面 A 节内容不再反映实现，请勿据此开发。**B 节（定时任务）仍有效。**

> **状态：A 已被 v0.7 取代（见上）；B（定时任务）已实现**。原始落地记录（v0.6）：
> A-P1~P3（`AgentRegistry` + 种子 + 动态装配、`delegateRoles`→`delegateAgents` 改名 + `agents` 白名单、CLI `ea agent` + gateway Web「子Agent」面板）；
> B-P1~P4（`ScheduleRegistry`/`Scheduler`/`ScheduleStore`、零依赖 cron + tick + catch-up + gateway 常驻 timer、ask→deny fail-closed + `grants` 细粒度预授权 + channel 投递 + `schedule-fired`/`schedule-finished` 事件、gateway Web「定时」面板）。
> 架构回写见 [`agent-architecture.md`](agent-architecture.md) §2.3 / §7 / §6.2 与 [`cli-architecture.md`](cli-architecture.md) / [`cli-ui.md`](cli-ui.md) §9.4.1。下文为原始设计提案，保留作背景。

> 本文是对 [`agent-architecture.md`](agent-architecture.md) 的两项扩展提案，灵感来自
> Vercel **Eve**（"一个 agent 就是一个目录"）的目录式组织：
>
> 1. **声明式 Sub-Agent**：把 §2.3 写死在代码里的 5 个 role 枚举
>    （`SUB_AGENT_ROLE_NAMES`）演进为**运行期可发现的目录式 agent 定义**，
>    复用 §3.6 Skills 已有的「目录 + frontmatter + 渐进披露 + 多 root 合并」机制。
> 2. **定时任务（Schedules）**：新增 §7「定时编排」，让 Session 能按 cron
>    在**无人值守**下被触发（日报 / 周报 / 巡检），状态落盘、跨重启可恢复，
>    投递交回宿主（Channel 抽象）。
>
> 设计第一原则：**不破坏 §3.4 的安全不变量**——审批主体仍是用户、权限单调不增
> （子 ≤ 父）、role 硬门优先、文件边界与 sandbox 不被绕过。目录式定义只能在这些
> 约束内**收敛**能力，永远不能扩张。

---

## A. 声明式 Sub-Agent（Agent Definitions）

### A.1 动机与现状

现状（§2.3）：sub-agent 的「角色」是编译期常量。

| 关注点 | 现状 | 位置 |
|---|---|---|
| 角色集合 | `SUB_AGENT_ROLE_NAMES` 五元组 `as const` | [prompts.ts:11](../packages/agent/src/runtime/prompts.ts) |
| 角色 prompt | `SUB_AGENT_PROMPTS: Record<SubAgentRole, string>` | [prompts.ts:26](../packages/agent/src/runtime/prompts.ts) |
| 工具硬门 | `ROLE_TOOL_POLICY: Record<SubAgentRole, RoleToolPolicy>` | [prompts.ts:50](../packages/agent/src/runtime/prompts.ts) |
| 委派入参 | `role: z.enum(SUB_AGENT_ROLE_NAMES)` | [sub-agent.ts:25](../packages/agent/src/runtime/sub-agent.ts) |
| 工具装配 | `buildToolsForRole(role, ctx, …)` | [registry.ts:59](../packages/agent/src/tools/registry.ts) |
| MCP 硬门 | `mcpAllowForRole(role)` | [registry.ts:106](../packages/agent/src/tools/registry.ts) |

**痛点**：企业客户要加一个自定义角色（如 `compliance-reviewer`、`sql-runner`）必须
fork 我们的代码、改枚举、改三张表、重新编译发版。这违背了 README 的 host-agnostic /
可定制定位。

**目标**：一个 sub-agent 就是一个目录。客户在 agent root 丢一个目录即可新增 / 覆盖
角色，零编译。内置 5 role 退化为**种子定义**，行为完全不变。

### A.2 目录结构与 `AGENT.md`

完全对齐 §3.6 Skills 的约定（`SKILL.md` → `AGENT.md`），可直接复用
[`parseFrontmatter`](../packages/agent/src/skills/loader.ts) 与 `listDirs`。

```
agents/
└── compliance-reviewer/
    ├── AGENT.md          # frontmatter（能力策略 + 模型）+ body（系统 prompt）
    └── （可选）references/、scripts/  —— 与 skills 同构，read+run 不可 write
```

`AGENT.md` 示例：

```markdown
---
name: compliance-reviewer
description: 审阅变更是否违反内部合规红线；只读 + 只读命令 + 指定 MCP。
tools: read, exec            # 能力 token：read | write | exec | http
mcp: policy-server           # true | false | 逗号分隔的 server 白名单
delegate: false              # 是否可嵌套委派（仍受 delegateAgents 配置 + MAX_DEPTH 双重约束）
model: sonnet                # 可选：alias 或 provider:model，省略=用 role 默认解析
timeout-ms: 180000           # 可选：覆盖该 agent 的墙钟超时，0=禁用
---

You are a compliance review sub-agent. Read the diff and the referenced policy
docs, then report any violations with file:line citations. You CANNOT write files.
...
```

frontmatter 字段映射到 `RoleToolPolicy`（[prompts.ts:35](../packages/agent/src/runtime/prompts.ts)）：

| frontmatter | → `RoleToolPolicy` | 说明 |
|---|---|---|
| `tools` 含 `read` | `file.read: true` | 缺省 `false` |
| `tools` 含 `write` | `file.write: true` | |
| `tools` 含 `exec` | `exec: true` | |
| `tools` 含 `http` | `http: true` | |
| `mcp: true` | `mcp: true` | 全部已连 MCP |
| `mcp: a, b` | `mcp: ['a','b']` | server 白名单，喂给 `mcpAllowForRole` 同款谓词 |
| `mcp: false` / 省略 | `mcp: false` | 无 MCP |
| `delegate: true` | `delegate: true` | |

**未知 token 一律丢弃**（fail-closed），不报错——与 skills `allowed-tools` 的容错一致。

### A.3 `AgentRegistry`（新增，镜像 `SkillRegistry`）

新文件 `src/agents/registry.ts`，结构照搬 [`SkillRegistry`](../packages/agent/src/skills/loader.ts)：

```ts
export interface AgentDef {
  name: string;                 // kebab id，= 委派时的 role 名
  description: string;          // 注入 delegateToSubAgent 描述，供编排者选择
  policy: RoleToolPolicy;       // 由 frontmatter 解析而来
  prompt: string;               // AGENT.md body = 系统 prompt
  model?: string;               // 可选模型覆盖（alias / ref）
  timeoutMs?: number;           // 可选超时覆盖
  dir: string;                  // 目录（references/scripts 沿用 skills 边界规则）
  builtin: boolean;             // 是否种子定义（不可被磁盘误删，仅可被覆盖）
}

export class AgentRegistry {
  // 1) 先注册 5 个内置种子（A.5），2) 再按 root 顺序合并磁盘定义，后者覆盖同名
  constructor(seeds: AgentDef[], agentRoots: string[]) { … }
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  names(): string[];            // 用于动态构造 z.enum
  catalog(): string;            // delegateToSubAgent 描述里的 "可用 agents" 列表
}
```

发现与合并顺序与 skills 完全一致（§3.6）：**内置种子 → 全局
`~/.enterprise-agent/agents/` → workspace → session `sessions/<id>/agents/`**，
后者覆盖前者。新增 paths（[paths.ts](../packages/agent/src/config/paths.ts)）：
`agents: join(base, 'agents')` 与 `sessionAgents(id)`。

### A.4 装配改造（保持硬门语义不变）

- `buildToolsForRole(role, ctx, …)` → `buildToolsForAgent(def: AgentDef, ctx, …)`。
  函数体几乎不变：把读 `ROLE_TOOL_POLICY[role]` 改为读 `def.policy`，其余
  （只构造被允许的工具、skill 工具按最终 toolNames 过滤）原样保留。
  **out-of-scope 工具永不被构造**这一硬门语义零改动。
- `mcpAllowForRole(role)` → `mcpAllowForPolicy(policy)`，谓词逻辑不变。
- `sub-agent.ts`：
  - 入参 `role: z.enum(SUB_AGENT_ROLE_NAMES)` → 在 `spawnSubAgentTool` 构造时
    用 `z.enum(registry.names() as [string, ...string[]])` **动态生成**——
    既保留严格校验，又把可选 agent 列给模型。
  - `description` 从 `registry.catalog()` 拼装，替换当前硬编码的 role 串。
  - `SUB_AGENT_PROMPTS[role]` → `def.prompt`；`modelFor(role)` → 若
    `def.model` 存在则解析它，否则回退现有 role→model 解析（§2.6）。
  - 超时：`subAgentTimeoutMs(role)` 仍是基线，`def.timeoutMs` 若存在则覆盖
    （沿用 `timeoutForRole` 的「per-x 覆盖优先」语义，[store.ts:107](../packages/agent/src/config/store.ts)）。
  - 嵌套委派门：`ctx.shared.delegateRoles` → `delegateAgents`（同名配置语义，
    见 A.6），与 `def.policy.delegate` 取**逻辑与**，再叠加 `MAX_DEPTH`。

### A.5 内置种子 = 现有 5 role

把 `SUB_AGENT_PROMPTS` + `ROLE_TOOL_POLICY` 在构造期映射成 5 个 `builtin: true`
的 `AgentDef` 注入 registry。**完全向后兼容**：没有任何磁盘 `agents/` 目录时，
`registry.names()` 仍是 `['researcher','coder','analyst','writer','generalist']`，
prompt、策略、委派行为逐字节不变。同名磁盘定义可覆盖内置（如客户想收紧
`coder` 的 MCP 白名单），但**不能删除内置**（被覆盖而非消失，避免误配置打穿编排者
的默认委派能力）。

### A.6 配置与企业管控

复用 §2.3 pt.2 的 `delegateRoles` 既有模型（`ScopedConfig`，全局可设 / 按 session
覆盖，未知名在 `effective()` 合并时过滤）：

- `delegateRoles` 改名/扩展为 **`delegateAgents`**：哪些 agent 可嵌套委派。
- 新增 **`agents`**（可选白名单）：限定**哪些磁盘 agent 被启用**。省略 = 全部启用；
  `[]` = 仅内置种子。这是企业「只允许审过的自定义角色」的开关，类比 skills 若未来
  加同款门。未知名在 `effective()` 过滤，过期配置不会误放权。
- CLI（**与 skills 对称**，镜像现有 `ea skill <ls|add|show>`，
  [skill.ts](../apps/cli/src/commands/skill.ts) / cli-ui §9.4）：
  - `ea agent ls [--session <id>]`——列出可用 agent（标注 builtin / 来源 root / 是否启用）。
  - `ea agent show <name>`——打印某 agent 的策略 + prompt + 解析后的模型/超时。
  - `ea agent add <dir>`——校验目录含 `AGENT.md` 后 `cpSync` 安装到 `ctx.paths.agents`
    （全局 agent root），与 `ea skill add` 装进 `ctx.paths.skills` 完全同构。
  - 管控开关：`ea config agents <name...> | none | all`（准入白名单）、
    `ea config delegate-agents <name...> | none | default`（沿用既有
    `ea config delegate …` 写全局 `settings.json` 的语义，§2.3 pt.2）。
  - CLI 规范新增小节 **cli-ui §9.5「Agents（生效作用域）」**，命令表登记
    `ea agent <ls|add|show>`，与 §9.4 技能条目并列。

### A.7 安全论证（为什么不破坏不变量）

1. **不能提权**：`AGENT.md` 只能声明能力的**子集**；任何工具仍走同一三态审批门
   （§3.3）、sandbox（§4.1）、文件边界（§4）。一个声明 `write+exec+http+mcp:true`
   的自定义 agent 至多等价于 `generalist`，而 generalist 本就受「子 ≤ 父」约束。
   故磁盘定义**无法**让 sub-agent 获得编排者本身没有的权限。
2. **fail-closed**：未知能力 token、缺失 `name`/`description`、解析失败 → 该定义
   被丢弃，绝不「默认全开」。
3. **可审计**：`agentId` 仍为 `sub-<name>-<n>`，审计/事件不变；自定义 agent 的每次
   工具调用照旧落 `audit.jsonl`。
4. **企业管控**：`agents` 白名单让管理员对「可加载的角色」做准入。

### A.8 改动清单

| 文件 | 改动 |
|---|---|
| `src/agents/registry.ts` | **新增** `AgentRegistry` + `AgentDef` + frontmatter→policy 解析 |
| `src/runtime/prompts.ts` | 保留 5 role 字符串作为种子来源；`RoleToolPolicy` 不动 |
| `src/tools/registry.ts` | `buildToolsForRole`→`buildToolsForAgent`，`mcpAllowForRole`→`mcpAllowForPolicy` |
| `src/runtime/sub-agent.ts` | 动态 enum、catalog 描述、def.prompt/model/timeout |
| `src/runtime/context.ts` | `SessionServices` 加 `agents: AgentRegistry` 访问 |
| `src/config/paths.ts` | 加 `agents` / `sessionAgents` |
| `src/config/store.ts` | `delegateRoles`→`delegateAgents`、新增 `agents` 白名单 |
| `apps/cli/src/commands/agent.ts` | **新增** `ea agent <ls\|show\|add>`（镜像 `skill.ts`） |
| `apps/cli/src/commands/config.ts` | 加 `ea config agents` / `delegate-agents` |
| `apps/cli/src/commands/program.ts` | 注册 `agent` 命令组 |
| `apps/gateway/src/web/agents-store.ts` | **新增** 安装/管理（镜像 `skills-store.ts`） |
| `apps/gateway/src/web/bundled-agents.ts` + `scripts/copy-bundled-agents.mjs` | **新增** 内置 agent 打包（镜像 bundled-skills） |
| `specs/cli-architecture.md` | 命令表登记 `ea agent <ls\|add\|show>`，新增 cli-ui §9.5 |
| `specs/agent-architecture.md` | §2.3 改写为「目录式 agent 定义」，5 role 记为内置种子 |

### A.9 分期

- **P1**：`AgentRegistry` + 种子注入 + 动态 enum/装配，磁盘 `agents/` 可被发现。
  内置行为零回归（既有 sub-agent e2e 全绿）。
- **P2**：配置白名单 `agents` + `delegateAgents` 改名 + **CLI `ea agent <ls|show|add>`**
  与 `ea config agents/delegate-agents`（镜像 `ea skill` + `ea config delegate`，A.6）。
- **P3（CLI 与 gateway 对称安装/管理）**：agent 的安装/管理要在**两个宿主都齐备**，
  与 skills 现状一致（CLI `ea skill add` ↔ gateway Web skills 面板）：
  - **CLI 侧**：`ea agent add <dir>` 落地（校验 `AGENT.md` + `cpSync` 到
    `ctx.paths.agents`），headless 可脚本化安装。
  - **gateway 侧**：Web 面板「安装/管理 agents」——复用 skills 的安装器与打包思路
    （[skills-store.ts](../apps/gateway/src/web/skills-store.ts) 的 `installFrom`/
    zip 解包、`scripts/copy-bundled-skills.mjs` 的内置打包），新增对称的
    `agents-store.ts` + `bundled-agents.ts`，把内置/上传的 agent 目录装进 agent root。
  - 二者共享同一套 core 校验（`AgentRegistry` 的 frontmatter→policy 解析 + fail-closed），
    宿主只负责「把目录放进 root」，发现与生效一律走 core，避免两套逻辑漂移。

---

## B. 定时任务（Schedules）—— 新增 §7

### B.1 动机

Eve 的 `schedules/`：cron 触发 agent 自动跑（日报、周报、巡检），"work continues
durably without an active session"。我们 core 完全没有。企业场景刚需：每天 9 点出
一份运维巡检、每周一汇总 PR。

**不照搬 Vercel Workflows**（那是把你锁进它基础设施的 checkpoint 引擎）。我们的
durable 底座就是既有的**append-only 会话树**（§5）+ **磁盘调度状态**：重启后重算
下次触发即可，不需要外部 workflow 引擎。

### B.2 关键约束：无人值守 = 没有 human-in-the-loop

定时运行时**没有人**点审批。因此审批必须由**策略**裁决，不能弹窗挂起：

- 默认 **`auto` 模式**：安全分类器（§3.8.5）裁决 allow/deny/**ask**；
  在无人会话里 **`ask` 一律降级为 deny**（fail-closed）——绝不静默等待一个永不到来的
  审批。（`full` 模式同理：非高危直接放行，高危集落 ask→deny；见 docs/full-mode.md。）
- 高风险操作（write/exec/network/MCP）默认**拒绝**，除非该 schedule 携带**预授权
  grant scope**（复用 §3.8.4 plan-mode 的 pre-grant 机制：按 executable / dir 前缀 /
  host 预先授予），由人在创建 schedule 时显式批准。
- 这把「定时任务」天然导向**只读 / 汇报型**默认安全姿态；要让它动手，必须显式预授权。

### B.3 定义：`schedules/<name>/SCHEDULE.md`

与 skills/agents 同构（目录 + frontmatter）。**定义是声明，状态是运行时**——两者分离。

```markdown
---
name: daily-ops-digest
cron: "0 9 * * *"            # 标准 5 段 cron；或 every: 1d / 1h
timezone: Asia/Shanghai      # 省略=宿主本地时区
mode: auto                   # 无人值守强制 auto（其余值在校验期被纠正并告警）
agent: analyst               # 可选：用某个 agent 定义作为编排起点；省略=普通编排者
session: fresh               # fresh=每次新建 session | reuse:<sessionId>=续跑固定会话
deliver-to: weixin:ops-group # 宿主投递目标（Channel 抽象，见 B.6）；省略=仅落库
grants:                      # 可选：预授权（无则高风险一律 deny）
  - exec: git, gh            # 形如 §3.8.4 pre-grant 的 scope 列表
enabled: true
---

每天汇总：昨天合并的 PR、CI 失败、未关闭的高优 issue。用 gh 只读查询，输出 Markdown 日报。
（body = 触发时发给 Session 的 goal/prompt 文本）
```

### B.4 `ScheduleRegistry` + `Scheduler`（core，host-agnostic）

```ts
// src/schedules/registry.ts —— 镜像 AgentRegistry，发现 + 合并多 root
export class ScheduleRegistry { list(): ScheduleDef[]; get(name): ScheduleDef|undefined }

// src/storage/schedule-store.ts —— 运行时状态，落盘 → 跨重启 durable
interface ScheduleState { name: string; lastRunAt?: number; lastRunId?: string;
  lastStatus?: 'done'|'error'|'skipped'; nextRunAt: number }

// src/schedules/scheduler.ts
export class Scheduler {
  constructor(deps: { registry, store, host: AgentHost, clock, deliver }) {}
  // 宿主按节律调用（或 core 起自己的 timer）；纯函数式：用 clock 算 due，不依赖 Date.now 隐式
  async tick(now: number): Promise<void> {
    for (const def of this.registry.list().filter(d => d.enabled)) {
      const st = this.store.get(def.name);
      if (st.nextRunAt > now) continue;
      await this.fire(def, now);                 // 见 B.5
      this.store.put({ ...st, nextRunAt: nextCron(def, now) });
    }
  }
  async runNow(name: string): Promise<void>;     // 手动触发（CLI / Web）
}
```

- **cron 解析**：引入轻量依赖 `cron-parser`（或自带最小 5 段解析器 `src/schedules/cron.ts`）。
  通过 Context7 拉取 `cron-parser` 当前 API 后再定版本。
- **durable**：状态在 `~/.enterprise-agent/schedules-state.jsonl`（append-only，
  与 §5.7「文件而非 SQLite」一致）。重启后 `tick` 按 `nextRunAt` 重算。
- **错过的触发（catch-up）**：重启后若 `nextRunAt < now`，默认 **run-once 补一次**
  （不补齐全部错过窗口，避免风暴）；可在 def 加 `on-missed: skip|run-once`。

### B.5 触发（`fire`）

```ts
private async fire(def: ScheduleDef, now: number) {
  // 1) 会话：fresh → host.createSession；reuse → host.openSession(id)
  const sid = def.session === 'fresh' ? (await host.createSession({…})).id : def.reuseId;
  const live = await host.openSession(sid);
  live.session.setExecutionMode('auto');         // 无人值守强制 auto（B.2）
  // 2) 预授权：把 def.grants 注入审批表（等价 plan-mode pre-grant，§3.8.4）
  applyPreGrants(live, def.grants);
  // 3) 跑一轮：等价 session.send(def.body)，但 ask→deny（B.2）
  const { runId, completion } = live.session.send(def.body);
  await completion;
  // 4) 汇报：生成结构化 Report（复用 generateReport / ReportSchema），交宿主投递
  const report = await live.session.report();
  await this.deliver(def.deliverTo, report);     // B.6
}
```

`schedule-fired` / `schedule-finished` 作为新事件并入 §6.2 事件流，宿主据此渲染。

### B.6 投递（交回宿主 —— Channel 抽象）

core 只产出 `Report`，**不知道**怎么发到微信/Telegram。投递经宿主的 Channel 抽象
（见 memory「gateway channel abstraction」与 [adapter.ts](../apps/gateway/src/channels/adapter.ts)）：

- gateway：`deliver-to: weixin:<chat>` → 用对应 channel adapter 的 `format?`+`prompt?`
  把 Report 拆分/格式化后推送。
- CLI（短生命周期）：仅当 CLI 在跑时 tick；投递= 打到 stdout / 通知。
- 省略 `deliver-to`：仅落库（会话树里可回看），不主动推送。

### B.7 谁来 tick？（宿主生命周期）

调度需要**常驻进程**。因此：

- **gateway** 是天然宿主（长驻 server）：bootstrap 时 `host.startScheduler()`，
  内部 `setInterval` 每分钟 `scheduler.tick(now)`。这是定时任务的主场景。
- **CLI** 短生命周期：仅在打开期间 tick（adhoc）；不承诺常驻调度——文档明示
  「持续调度请用 gateway」。
- core 暴露 `AgentHost`：`listSchedules()` / `runScheduleNow(name)` /
  `startScheduler()` / `stopScheduler()`，宿主自选是否启用。

### B.8 安全论证

1. **无静默挂起**：`ask`→`deny`，定时任务永不卡在一个无人应答的审批上。
2. **默认只读**：无 `grants` 即高风险全 deny，巡检/汇报型任务零额外授权即可跑。
3. **显式预授权**：要动手必须人创建 schedule 时写明 `grants`，scope 化（同 §3.8.4），
   且仍受 sandbox + 文件边界 + 「子 ≤ 父」约束。
4. **可审计**：每次触发是一棵正常的会话运行，`audit.jsonl` / 会话树照常记录；
   `lastRunId` 可回溯。
5. **防风暴**：catch-up 默认只补一次；`tick` 幂等（靠 `nextRunAt` 单调推进）。

### B.9 改动清单

| 文件 | 改动 |
|---|---|
| `src/schedules/registry.ts` | **新增** `ScheduleRegistry` + `ScheduleDef` |
| `src/schedules/scheduler.ts` | **新增** `Scheduler`（tick / fire / runNow / catch-up） |
| `src/schedules/cron.ts` 或依赖 | cron 解析（`cron-parser` 或自带最小实现） |
| `src/storage/schedule-store.ts` | **新增** durable 状态（`schedules-state.jsonl`） |
| `src/config/paths.ts` | 加 `schedules` / `schedulesState` |
| `src/runtime/report.ts` | 复用既有 `generateReport`/`ReportSchema`（无需改） |
| `src/index.ts`（AgentHost） | 加 `startScheduler`/`stopScheduler`/`listSchedules`/`runScheduleNow` |
| `agent-contract` events | 加 `schedule-fired`/`schedule-finished`（§6.2） |
| `apps/gateway` | bootstrap 启动 scheduler；按 `deliver-to` 路由 Report 到 channel |
| `specs/agent-architecture.md` | 新增 §7「定时编排」并在 §6.2 登记新事件 |

### B.10 分期

- **P1（core）**：`ScheduleRegistry` + `Scheduler` + `schedule-store`，`runScheduleNow`
  手动触发跑通一棵只读会话并产出 Report（先不接 cron timer）。
- **P2**：cron 解析 + `tick` + catch-up + 状态持久化；gateway bootstrap 起 timer。
- **P3**：`grants` 预授权 + `ask→deny` 降级；`deliver-to` 经 channel adapter 投递。
- **P4**：gateway Web 面板「创建/启停/手动跑」schedule（复用 admin 面板）。

---

## C. 两者的关系

声明式 agent（A）与定时任务（B）正交但互补：schedule 的 `agent:` 字段可指向 A 的某个
自定义 agent 定义，于是「每天用 `compliance-reviewer` 跑一遍合规巡检并发到群」成为
两个目录 + 一段 frontmatter 的纯声明配置——这正是 Eve「一个 agent 就是一个目录」在
我们安全模型下的落地形态。

## D. 明确不做（对齐 Eve 的取舍）

- **不引入 Vercel Workflows / 外部 checkpoint 引擎**：保持 host-agnostic，durable 靠
  既有会话树 + 磁盘状态。
- **不做 `tools/` 文件名即工具的零注册**：`registry.ts` 承担 role 策略 + risk tier
  绑定，是安全必需层，不为「零注册」牺牲。
- **不把 channels/connections 纳入本次改造**：我们已有 gateway channel 抽象与 MCP/
  keychain，概念已覆盖（见首次对照表）。
