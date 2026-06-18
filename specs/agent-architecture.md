# Enterprise Agent — Agent 核心模块架构

> 本文档定义一个**可独立构建/运行的 Agent 核心模块**（不依赖 Electron/UI），涵盖：领域模型 Workspace/Chat（§1）、运行时（§2）、工具系统（§3）、安全与沙箱（§4）、数据模型与持久化（§5）、**对外接口契约（§6）**、AI SDK API 注意事项（附录 A）。
> **集成方式**：桌面端（[desktop-architecture.md](desktop-architecture.md)）与未来的 CLI 都通过 **§6 的命令/事件契约**驱动本模块，各自只补壳层（进程/传输/UI）。本模块收敛为单一包 **`@enterprise-agent/agent`**，契约类型单列 **`@enterprise-agent/agent-contract`**（[architecture.md §3](architecture.md)）。
> 编号：**本文件章节独立顺序编号**（§1–§6 + 附录 A）。本文件内引用用裸 `§x`；跨文件引用用 `desktop §x`（[desktop-architecture.md](desktop-architecture.md)）/ `总览 §x`（[architecture.md](architecture.md)）限定。完整跨文件索引见 [architecture.md §0.3](architecture.md)。

---

## 1. 领域模型（Workspace / Chat）

### 1.1 Workspace（工作空间）模型

```
Workspace（顶层容器，可切换）
  ├─ rootPath        # 工作空间根目录（文件访问边界）
  ├─ config          # 模型 / MCP / 权限策略（覆盖全局默认）
  └─ Work[]          # 归属本 Workspace 的一组 Work
        └─ OrchestratorAgent → SubAgent...
```

| 维度 | 说明 |
| --- | --- |
| 归属关系 | 每个 Work 必属于且仅属于一个 Workspace（Work 目录嵌套在 Workspace 目录下，§5.2）。Work 不能跨 Workspace 移动（本期）。|
| 根目录 | 每个 Workspace 有一个 `root_path`；其下所有 Work 的文件操作都限制在该根目录内（§4）。Work 不再各自持有 `workspace_root`。|
| 配置作用域 | 模型默认、MCP server、权限策略、密钥引用按 **Workspace 维度**收敛；未配置项回退到全局默认。不同项目可用不同的 MCP / 模型 / 审批策略。|
| 活动状态 | 任一时刻 UI 有一个「当前活动 Workspace」；切换 Workspace 即切换可见的 Work 列表与生效配置。|
| 隔离 | 不同 Workspace 的 Work 互不可见、文件边界互不重叠；各 Work 仍是独立 utilityProcess（desktop §1），并发与崩溃隔离不变。|
| 默认 Workspace | 首次启动自动创建一个「Default」Workspace（指向用户选择的目录），保证「零配置可用」。|

> 设计取舍：Workspace 是**组织与边界**的容器，不是新的运行实体 —— 它不引入额外进程，只为 Work 提供「根目录 + 配置作用域 + 分组」。运行隔离单元仍是「每 Work 一个 utilityProcess」。

### 1.2 Chat（独立对话）

除 Workspace 外，再设一类**与 Workspace 并列的顶层实体 Chat**，用于与具体项目无关的通用事务（问答、查资料、调 MCP 发邮件/查 API、轻量脚本等）。

```
顶层
├─ Workspace[]   → Work[]（有项目根目录，围绕代码库）
└─ Chat[]        （无项目根目录，扁平、各自独立配置）
```

| 维度 | 说明 |
| --- | --- |
| 定位 | 一个 Chat = 一个**独立会话单元**，与 Work 同构（驱动 OrchestratorAgent、拥有会话树、可子 Agent、审批、压缩、todo、usage），但**不归属任何 Workspace**。 |
| 无项目目录 | Chat **没有 Workspace 工作目录**；文件/执行类工具以 Chat 私有 **scratch 目录**（`~/.enterprise-agent/chats/<id>/scratch/`）为边界，沙箱 `allowWrite` = scratch（§4/§4.1），**不接触任何用户项目**。 |
| 独立配置 | 每个 Chat 自带配置（模型别名、MCP、skills、沙箱开关、权限），作用域 **global → Chat**（与 Workspace 平级的两级回退）。 |
| 复用运行时 | Chat 复用 §2 的运行时：本质是「`rootPath = <scratch>`、配置取自 `chat.json`、无 Workspace 父」的会话。每 Chat 同样一个 utilityProcess（desktop §1）。 |
| 并列展示 | 左侧栏顶层并列「Workspaces」与「Chats」两组（desktop §2）。 |

> 取舍：Chat 不是新运行机制，而是**去掉「项目根目录 + Workspace 归属」后的会话**，把「与代码库无关的通用 Agent 任务」从 Workspace 体系里解耦出来，既不污染项目、又能独立配置。



---

## 2. Agent 运行时设计（AI SDK v6）

### 2.1 核心抽象

```ts
// 概念映射
Workspace       ──contains─▶ Work[]（共享 rootPath + config）
Work            ──drives──▶ OrchestratorAgent (ToolLoopAgent)
OrchestratorAgent ──spawns──▶ SubAgent #1, #2 ... (ToolLoopAgent，作为 tool 暴露)
Agent           ──uses────▶ Tools (tool())
Agent           ──emits───▶ Stream Events ──▶ UI 轨迹树
```

### 2.2 主 Agent（Orchestrator）

主 Agent 用 v6 的 `ToolLoopAgent` 构建，它自动管理「调用工具 → 把结果回灌 → 继续推理」的多步循环，直到满足 `stopWhen`。

```ts
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

export function createOrchestrator(ctx: WorkContext) {
  return new ToolLoopAgent({
    id: `work-${ctx.workId}-orchestrator`,
    model: anthropic('claude-sonnet-4.5'),
    instructions: ctx.systemPrompt, // Work 目标 + 约束 + 「多步任务先用 updateTodos 规划」引导（§3.7）
    tools: {
      ...buildLocalTools(ctx),       // 文件、命令、HTTP、updateTodos（§3.7）等
      ...buildMcpTools(ctx),         // MCP 动态工具
      delegateToSubAgent: spawnSubAgentTool(ctx), // 见 §2.3
    },
    // 默认最多 20 步；可按 Work 复杂度调高
    stopWhen: stepCountIs(ctx.maxSteps ?? 40),
  });
}
```

运行（流式）：

```ts
const agent = createOrchestrator(ctx);
const stream = agent.stream({
  prompt: userInput,        // 或 messages: 历史消息
  abortSignal: run.signal,  // 支持中断
});

for await (const part of stream.fullStream) {
  // part.type: 'text-delta' | 'tool-call' | 'tool-result' | 'step-finish' ...
  port.postMessage({ kind: 'agent-event', runId: run.id, part });
}
```

### 2.3 子 Agent 编排（Sub-Agent）

子 Agent 采用 **「Agent-as-Tool（编排者-工人模式）」**：主 Agent 拥有一个 `delegateToSubAgent` 工具，调用它即在运行时内创建一个新的 `ToolLoopAgent` 实例并运行，子 Agent 的最终输出作为工具结果返回给主 Agent。

```ts
function spawnSubAgentTool(ctx: WorkContext) {
  return tool({
    description:
      '把一个边界清晰的子任务委派给一个专注的子 Agent。' +
      '用于：调研、代码生成、数据分析等可独立完成的工作。',
    inputSchema: z.object({
      role: z.enum(['researcher', 'coder', 'analyst', 'writer']),
      objective: z.string().describe('子任务的明确目标'),
      context: z.string().optional().describe('完成任务所需的背景信息'),
    }),
    execute: async ({ role, objective, context }, { abortSignal }) => {
      const sub = new ToolLoopAgent({
        id: `work-${ctx.workId}-sub-${role}-${ctx.nextSubId()}`,
        model: ctx.modelFor(role),
        instructions: SUB_AGENT_PROMPTS[role],
        tools: buildToolsForRole(role, ctx), // 子 Agent 拥有受限工具集
        stopWhen: stepCountIs(20),
      });

      // 子 Agent 也流式上报，UI 中以「嵌套节点」展示
      const result = await sub.generate({
        prompt: [objective, context].filter(Boolean).join('\n\n'),
        abortSignal,
        onStepFinish: step =>
          ctx.emitSubEvent(sub.id, { type: 'step', step }),
      });

      return { role, output: result.text, steps: result.steps.length };
    },
  });
}
```

设计要点：

1. **嵌套深度限制**：`ctx.depth` 透传，超过 `MAX_DEPTH`（默认 3）时禁用 `delegateToSubAgent`，防止无限递归 spawn。
2. **工具集分层**：子 Agent 默认**不**拥有 `delegateToSubAgent`（除非显式开启），且按 `role` 收敛工具权限（如 `researcher` 只读、不能写文件）。
3. **并行委派**：若主 Agent 在一个 step 内发起多个 `delegateToSubAgent` 调用，运行时用 `Promise.all` 并行执行（受全局并发上限约束）。
4. **可观测**：每个子 Agent 拥有独立 `id`，所有事件带上该 id，UI 据此渲染**运行轨迹树**（父 → 子 → 孙）。
5. **可中断**：`abortSignal` 从 Work 级别向下传递，中止 Work 即级联中止所有子 Agent。
6. **权限与审批**：子 Agent 的高风险工具走与主 Agent 同一套三态审批；遵循「用户为审批主体、权限单调不增、role 硬门优先」。详见 §3.4。

> 备选模式：当任务需要主 Agent 在子任务之间插入自定义逻辑（重试、外部系统对账等）时，使用 **Manual Agent Loop**（`streamText` + 手动检查 `finishReason === 'tool-calls'` 并手动执行工具），换取完全控制权。`ToolLoopAgent` 用于大多数标准场景；Manual Loop 用于需要细粒度控制的高级场景。

### 2.4 结构化输出

需要把 Work 结果落库为结构化数据时，用 `Output.object`：

```ts
import { Output } from 'ai';

const reportAgent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4.5'),
  output: Output.object({
    schema: z.object({
      summary: z.string(),
      deliverables: z.array(z.object({ title: z.string(), path: z.string() })),
      openQuestions: z.array(z.string()),
    }),
  }),
  stopWhen: stepCountIs(10),
});
const { output } = await reportAgent.generate({ prompt: '...' });
```

> 注意：结构化输出会多消耗一个 step，`stopWhen` 的步数预算需相应留余量。

### 2.5 Workspace 上下文注入

`WorkContext` 由所属 Workspace 派生 —— Work 启动时，main 进程把「Workspace 配置 + Work 自身参数」合并后下发给 utilityProcess：

```ts
interface WorkspaceContext {
  workspaceId: string;
  rootPath: string;                 // 文件访问边界（§4 路径校验的根）
  modelDefaults: ModelConfig;       // 默认 provider/model
  mcpServers: McpServerConfig[];    // 本 Workspace 启用的 MCP
  permissionPolicy: PermissionPolicy; // 审批/白名单策略
  sandboxEnabled: boolean;          // OS 级沙箱开关（§4.1，缺省回退全局默认=true）
}

interface WorkContext extends WorkspaceContext {
  workId: string;
  systemPrompt: string;             // Work 目标 + 约束
  maxSteps?: number;
  depth: number;                    // 子 Agent 嵌套深度
  // 工具构造、子 Agent 模型选择等都从合并后的上下文读取
  modelFor(role: string): LanguageModel;
  nextSubId(): number;
  emitSubEvent(agentId: string, evt: unknown): void;
}
```

要点：

1. **配置就近覆盖**：`modelDefaults` / `mcpServers` / `permissionPolicy` 先取 Workspace 级，缺失项回退全局默认。
2. **根目录单一来源**：`buildLocalTools(ctx)` 里的文件工具一律以 `ctx.rootPath` 为根做规范化校验，不再读 Work 级目录。
3. **切换无副作用**：切换活动 Workspace 只影响「新建/可见 Work」和「下次启动的 Work 运行时」；已在运行的 Work 持有其启动时快照的上下文，不被热切换打断。

### 2.6 模型 Provider 与模型注册表（Model Registry）

直接在代码里写死 `anthropic('claude-sonnet-4.5')` 不可扩展。模型层用三层抽象：**Provider（厂商接入）→ 语义别名（角色用什么模型）→ 注册表（统一解析）**，底层落在 AI SDK v6 的 `createProviderRegistry` + `customProvider`。

**第一层：Provider 接入配置（持久化）**

```ts
interface ProviderConfig {
  id: string;                  // 'anthropic' | 'openai' | 'my-proxy' ...
  kind: 'anthropic' | 'openai' | 'google'
      | 'openai-compatible'    // 本地/代理：Ollama、OpenRouter、vLLM...
      | 'gateway';             // Vercel AI Gateway 透传
  baseURL?: string;            // 自定义端点（openai-compatible 必填）
  keyRef?: string;             // OS keychain 中密钥的引用名，非明文（§4）
  headers?: Record<string, string>;
  enabled: boolean;
}
```

**第二层：语义别名 —— 把「角色用什么模型」与「具体模型 id」解耦**

角色（orchestrator / 子 Agent role / report...）引用**语义别名**而非裸模型名；别名映射到 `providerId:modelId` + 默认参数。换模型只改别名映射，不动业务代码。

```ts
interface ModelAlias {
  alias: string;               // 'orchestrator' | 'fast' | 'reasoning' | 'vision'
  ref: string;                 // 'anthropic:claude-sonnet-4.5'
  params?: {                   // 经 defaultSettingsMiddleware 注入
    maxOutputTokens?: number;
    temperature?: number;
    providerOptions?: Record<string, unknown>; // 如 anthropic.thinking / openai.reasoningEffort
  };
  capabilities?: ('tools' | 'structured-output' | 'vision' | 'reasoning')[];
}
```

**第三层：注册表构造（运行时，仅在 utilityProcess）**

`ModelRegistry` 用启用的 `ProviderConfig`（密钥从 keychain 现取）构造 v6 registry，再叠一层 `customProvider` 实现语义别名与默认参数：

```ts
import { createProviderRegistry, customProvider, wrapLanguageModel,
         defaultSettingsMiddleware } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

function buildRegistry(providers: ProviderConfig[], aliases: ModelAlias[]) {
  const base: Record<string, any> = {};
  for (const p of providers.filter(p => p.enabled)) {
    const apiKey = p.keyRef ? keychain.get(p.keyRef) : undefined; // 仅此进程可读
    base[p.id] =
      p.kind === 'anthropic'         ? createAnthropic({ apiKey, headers: p.headers })
    : p.kind === 'openai'            ? createOpenAI({ apiKey, headers: p.headers })
    : p.kind === 'openai-compatible' ? createOpenAICompatible({ name: p.id, apiKey, baseURL: p.baseURL! })
    : /* gateway/google... */          createProviderFor(p);
  }
  // 语义别名层：alias → 具体模型 + 默认参数
  base.alias = customProvider({
    languageModels: Object.fromEntries(aliases.map(a => [
      a.alias,
      a.params
        ? wrapLanguageModel({
            model: registry0.languageModel(a.ref),
            middleware: defaultSettingsMiddleware({ settings: a.params }),
          })
        : registry0.languageModel(a.ref),
    ])),
  });
  return createProviderRegistry(base);
}

// 用法：ctx.modelFor('orchestrator') => registry.languageModel('alias:orchestrator')
```

**解析顺序（`modelFor(role)`）**

```
role 显式覆盖 → Work 覆盖 → Workspace 默认 → 全局默认 → 内置兜底(anthropic:claude-sonnet-4.5)
```

**要点**

1. **密钥只进 utilityProcess**：`ProviderConfig.keyRef` 存引用，明文在 OS keychain，注册表构造时现取，绝不入 renderer / config_json（§4）。
2. **能力校验**：orchestrator 与「会调工具的子 Agent role」必须解析到带 `tools` 能力的模型；结构化输出（§2.4）需 `structured-output`。配置时校验，避免运行期才报错。
3. **配置作用域**：Provider 接入是**全局**的（含密钥）；语义别名映射与角色→别名绑定可被 **Workspace 覆盖**（不同项目用不同强弱模型）。与 §2.5 配置就近覆盖一致。
4. **变更生效时机**：注册表按需懒构造并缓存；配置变更后**对下一个启动的 run 生效**，运行中的 Work 持有启动时快照（与 §2.5 / §4.1 一致）。
5. **多形态接入**：`openai-compatible` + 自定义 `baseURL` 覆盖本地（Ollama/vLLM）、聚合（OpenRouter）；`gateway` 走 Vercel AI Gateway 统一计费/路由。
6. **模型元数据（`ModelMeta`）**：每个模型登记 `{ contextWindow, maxOutputTokens, price: { input, output, cachedInput } /* 每 Mtok */ }`。这是 **Token 统计成本核算（§2.7）** 与 **压缩 threshold 触发（§5.5）** 的前置数据；内置常见模型的元数据，`openai-compatible`/本地模型允许用户手填（缺省给保守默认）。

### 2.7 Token 用量统计

数据源：v6 `streamText`/`ToolLoopAgent` 的 **`onStepFinish`** 回调，每步给 `usage`（本步）与 `totalUsage`（累计），字段：`inputTokens` / `outputTokens` / `totalTokens` / `reasoningTokens?` / `cachedInputTokens?`。

```ts
new ToolLoopAgent({
  /* ... */
  onStepFinish: ({ usage, totalUsage, finishReason }) => {
    accountant.record(ctx.runId, agentId, usage);        // 累加到 run/work/workspace/model 维度
    port.postMessage({ kind: 'usage', runId: ctx.runId, agentId, usage, totalUsage,
                       cost: accountant.cost(usage, modelMeta) });
    // 用真实 inputTokens 设压缩标志，下一步 prepareStep 再压（§5.5，无本地估算）
    if (usage.inputTokens >= modelMeta.contextWindow * COMPACT_RATIO) ctx.needsCompaction = true; // COMPACT_RATIO 全局配置，默认 0.9
  },
});
```

**统计维度与落盘**
- **每 entry**：`usage` 写入 `entry`（§5.1），cached/reasoning 分列。
- **滚动汇总**：utilityProcess 内存累计「本 run / 本 Work（含子 Agent）/ 本 Workspace / 按模型」四个维度；Work 维度汇总镜像到 `work.json.usage`，关闭后可直接读，不必重扫 `session.jsonl`。
- **成本**：`cost = ((inputTokens − cachedInputTokens)·price.input + outputTokens·price.output + cachedInputTokens·price.cachedInput) / 1e6`，单价取 `ModelMeta.price`。注意 provider 回报的 `cachedInputTokens` 是 `inputTokens` 的**子集**，故缓存部分按 cachedInput 单价计、并从全价 input 中扣除，避免双重计费；本地/未知单价模型成本记 0 并标注「无定价」。
- **子 Agent 归集**：子 Agent 的 usage 上卷进所属 Work 总量，同时按 `agentId` 可分项展示（轨迹树节点上显示该子 Agent 的 token/成本）。

**事件**：新增 `usage`（§6.2），携本步 usage + 累计 + 成本，驱动 UI 实时更新；Work 列表与详情显示累计 token / 成本。


---

## 3. 工具系统（Tools）

### 3.1 工具分类

| 类别 | 示例 | 风险 | 是否需审批 |
| --- | --- | --- | --- |
| 只读本地 | `readFile`, `listDir`, `search` | 低 | 否 |
| 写本地 | `writeFile`, `applyPatch` | 中 | 可配置 |
| 执行 | `runCommand`, `runScript` | 高 | **默认是** |
| 网络 | `httpFetch`, `webSearch` | 中 | 可配置 |
| 规划 | `updateTodos`（内置任务规划，§3.7） | 无副作用 | 否 |
| MCP 动态工具 | 由连接的 MCP server 提供（§3.5） | 取决于 server（`riskTier`） | 按策略 |

### 3.2 工具定义规范

- 所有工具用 `tool({ description, inputSchema, execute })` 定义；`inputSchema` 必须是 Zod schema。
- `execute` 在 Agent UtilityProcess 内运行，但**受 main 进程权限策略门控**（见 §4）。
- 工具实现保持纯粹：副作用集中、返回可序列化结果（JSON-safe）。

### 3.3 Human-in-the-loop（人工审批）

高风险工具（如 `runCommand`）不直接提供 `execute`，而是走 v6 的审批流。审批结果有 **三态**：

| 决策 | 枚举 | 含义 | 作用域 |
| --- | --- | --- | --- |
| **单次批准** | `APPROVAL.ONCE` | 仅放行当前这一次调用，下次同类调用仍需审批 | 本次 tool-call |
| **本任务批准** | `APPROVAL.TASK` | 放行当前这一次，并在**当前任务窗口期内**对匹配的后续调用自动放行、不再弹框 | 当前 Work 的运行会话 |
| **拒绝** | `APPROVAL.REJECT` | 拒绝本次调用，把拒绝信息作为工具结果回灌 Agent | 本次 tool-call |

```ts
const APPROVAL = { ONCE: 'once', TASK: 'task', REJECT: 'reject' } as const;
type ApprovalDecision = typeof APPROVAL[keyof typeof APPROVAL];
```

审批流：

1. Agent 产生 tool-call（`state: 'input-available'`），运行时**先查任务级放行表**（见下）；命中则直接执行，不打扰用户。
2. 未命中 → 运行时**暂停**该工具执行，事件经 main → renderer，UI 弹出审批框（展示工具名 + 入参 + 三个按钮）。
3. 用户点「单次批准 / 本任务批准 / 拒绝」→ renderer 调 `window.zt.approveTool(toolCallId, APPROVAL.ONCE | TASK | REJECT)`。
4. main 把决策回传运行时：
   - `ONCE` / `TASK`：执行真正逻辑并写回输出（`tool-output-available`）；若是 `TASK`，把该工具登记进**任务级放行表**。
   - `REJECT`：返回拒绝信息，不执行。
5. Agent 拿到工具结果后继续循环。

**任务级放行表（task-scoped grants）**

- 存储位置：Work 的运行会话内存中（main 进程持有，随 run 生命周期），**不落库、不跨重启、不跨 Work**。
- 匹配键（**授权键 / grant key**）：由每个工具自己从入参提取一个**有意义的粒度**作为放行范围，而非「工具名（太宽）」或「入参精确哈希（太窄，Agent 几乎不会原样重复命令，导致每条都要点）」两个极端：

  | 工具 | 授权键 | 自动放行范围示例 |
  | --- | --- | --- |
  | `runCommand` | argv[0]（可执行名） | 本任务内所有 `git ...`；`rm` 仍需审批 |
  | `writeFile` / `applyPatch` | 路径目录前缀 | 本任务内写 `src/` 下文件；写 `~/.ssh` 仍需审批 |
  | `httpFetch` | host / 域名 | 本任务内请求 `api.github.com` |
  | 其它通用工具 | 工具名（退化为最宽） | —— |

  `runCommand` 的默认粒度为 **可执行名（argv[0]）**；可配置收紧到 **子命令**（`git push` 与 `git commit` 分别授权）以提升安全性、代价是更多点击。审批框需明确展示本次授权的范围（如「本任务内自动批准 `git *`」），让用户知情。
- 失效：run 结束 / Work 关闭 / 用户在审批栏点「撤销本任务放行」/ 应用重启 → 放行表清空。
- 子 Agent：放行表**默认按 Work 维度共享**，子 Agent 的同名工具调用同样受惠（仍须先过 §2.3 的 role 工具硬门）；敏感授权可标记 `agentScoped` 不向子 Agent 继承。详见 §3.4。
- 审计：`TASK` 授权本身写一条审计；其后每次「自动放行」的调用照常记 `tool_call`，并标注 `approval = 'task-auto'` 以便回溯。

```ts
// 渲染进程：审批待定时禁用输入（三态不改变此判断）
const pendingApproval = messages.some(m =>
  m.parts?.some(
    p => isToolUIPart(p) &&
         p.state === 'input-available' &&
         toolsRequiringConfirmation.includes(getToolName(p)),
  ),
);
```

> 该机制对应 v6 cookbook 的 human-in-the-loop 模式（`addToolOutput` + `APPROVAL`），本应用将其从二态扩展为三态：`ONCE`/`REJECT` 是无状态决策，`TASK` 额外维护一张任务级放行表。「审批 UI 在 renderer、执行在 utilityProcess、放行表在 main」用 IPC 串起来。

### 3.4 子 Agent 的审批与权限

子 Agent（§2.3）的审批**复用** §3.3 同一套三态流程，但遵循三条不变量：

**1. 审批主体永远是用户，父 Agent 不是授权方。**
子 Agent 请求高风险工具时弹框给**用户**，而非让父 Agent「替用户批准」。父 Agent 是编排者，不是信任边界。

**2. 权限单调不增（沿运行树向下只减不增）。**

```
子 Agent 有效权限 = 父 Agent 权限 ∩ role 工具集 ∩ Work 策略 ∩ sandbox 策略
```

子 Agent 永远不可能比父 Agent 权限更大。这是核心安全不变量，由 spawn 时构造的工具集与策略保证。

**3. 两道门，顺序固定。**
- **硬门 = role 工具白名单**：spawn 时锁死，子 Agent 根本拿不到范围外的工具（如 `researcher` 无 `writeFile`），与审批无关、不可被放行表绕过。
- **软门 = 三态审批 + 任务级放行表**：过了硬门的高风险调用再走审批。

**审批流（子 Agent 版）**

子 Agent 是同一 utilityProcess 内的 `ToolLoopAgent`，其高风险 tool-call 走同一暂停 → IPC → 弹框流程，事件带子 Agent 的 `agentId` / `parentAgentId`：

- 审批节点**渲染在轨迹树该子 Agent 节点下**，展示调用链（`Orchestrator → Sub#researcher → runCommand`），让用户知道「是谁在请求」。
- 此时父的 `delegateToSubAgent` 工具调用处于「运行中」（阻塞在 `sub.generate()`），正常等待，无需特殊处理。
- 全局 `pendingApproval` 判断已覆盖任意层级的 `input-available`，输入照常禁用。

**放行表继承（混合方案）**

| 情形 | 行为 |
| --- | --- |
| 默认 | 放行表 **Work 级共享** —— 主 Agent 阶段授予的「本任务批准」，子 Agent 同 grant key 的调用自动放行（仍须先过 role 硬门）。|
| 敏感授权 | 授权时可标记 `agentScoped: true`，则该 grant **只对授予它的那个 agent 生效**，不向子 Agent 继承。|
| 记录 | 每条 grant 记录**授予时的 agentId**；自动放行的子 Agent 调用照常记 `tool_call(approval='task-auto')`，审计可还原「哪个 agent 凭哪条 grant 放行」。|

**沙箱**：子 Agent 与 Work 共享同一 utilityProcess，**天然在同一 sandbox 策略下**（§4.1），无法越过 Work 的内核边界，无需额外处理。

> 取舍：role 硬门已经挡住「子 Agent 拿到不该有的工具」，所以放行表默认共享是安全的便利项；`agentScoped` 标记给少数「即使同一任务也想让子 Agent 单独确认」的高敏感授权留了出口。

### 3.5 MCP 工具接入

通过 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）client 接入外部工具生态，把第三方工具动态并入 Agent 工具集。

**配置（文件，§5.2）**

每个 MCP server 一份 JSON，分布在 `~/.enterprise-agent/mcp/`（全局）与 Workspace 的 `mcp/`（覆盖），两级合并、Workspace 优先：

```jsonc
{
  "name": "github",
  "transport": "stdio",                 // 'stdio' | 'sse' | 'http'
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": { "keyRef": "mcp.github.token" } },  // 密钥用 keyRef→keychain，不入文件
  "enabled": true,
  "riskTier": "network"                 // 决定默认审批策略（§3.1/§3.3）
}
// sse/http: 用 "url" + 可选 "headers"（同样支持 keyRef）
```

**接入流程**

1. Work 启动时，按合并后的生效配置连接各 MCP client（`buildMcpTools(ctx)`，§2.2）。
2. 拉取 server 的 tool 列表，以 **`mcp__<server>__<tool>`** 前缀命名（避免冲突），转成 v6 `tool()` 并入 Agent 工具集。
3. 工具调用同样走 **§3.3 三态审批**（默认风险由 `riskTier` 归类）；调用与审批写 `audit.jsonl`。
4. 断线重连、按 server 隔离；某 server 崩溃不影响其它工具。

**安全**

- 连接外部 MCP server 需用户**显式启用**（`enabled`）；密钥仅以 `keyRef` 存于 keychain、只在 utilityProcess 解析（§4）。
- **stdio server 是子进程** → 受 §4.1 沙箱包裹；网络型 server 出站受网络白名单约束。
- MCP 工具对子 Agent 同样遵循 role 硬门（§3.4）：子 Agent 只见其 role 允许的 MCP 工具。

### 3.6 Skills（技能）

采用 **Agent Skills 标准**（与 Anthropic/Claude、pi agent 兼容）：技能是「按需加载的知识 / 流程」，不是工具本身。

**磁盘格式（目录 + `SKILL.md`）**

```
<skill-name>/
├─ SKILL.md        # 必需，YAML frontmatter + 正文
├─ scripts/        # 可选：可执行脚本
├─ references/     # 可选：参考文档
└─ assets/         # 可选：素材
```

```yaml
---
name: pdf-extract                 # 必需，max 64，小写 a-z/0-9/连字符
description: 从 PDF 抽取文本与表格；当用户提到 .pdf 或要解析 PDF 时使用。  # 必需，决定何时加载
allowed-tools: [readFile, runCommand]   # 可选：收敛本技能可用工具
disable-model-invocation: false         # 可选：是否禁止模型自动调用
---
（正文：完成该技能的步骤 / 提示 / 约束）
```

**发现与加载（progressive disclosure）**

- 发现路径：全局 `~/.enterprise-agent/skills/` 与 Workspace `…/skills/`（覆盖），两级合并、Workspace 优先。技能由用户在 app 内安装/导入（兼容 Anthropic/pi 的 `SKILL.md` 包，可直接拷入）。
- **渐进式披露**：启动只把各技能的 `description` 注入系统提示（「可用技能」清单）；当 Agent 判断任务匹配时，**按需加载完整 `SKILL.md` 正文**为额外 instructions。用户可 `/skill:<name>` 强制加载。
- 加载的正文进入会话上下文 → 受 §5.5 压缩管理。

**与工具 / 子 Agent / 安全的关系**

- 技能可声明 `allowed-tools` 收敛其可用工具；可被子 Agent 继承（仍受 §3.4 role 硬门约束）。
- 技能可携带脚本；**执行脚本走与普通命令相同的审批 + 沙箱**（§3.3/§4.1），不因来自技能而豁免。
- 技能均由用户主动安装于 App 数据，视为可信来源；其脚本的实际危险性仍由执行期审批 + 沙箱兜底。

### 3.7 内置任务规划（Todo List）

每个 Work **自带一份结构化计划**：编排 Agent 通过内置 `updateTodos` 工具把任务目标拆成待办、并随进展更新状态。让长任务可规划、可追踪、对用户透明。

**工具定义（无副作用、无需审批）**

```ts
const updateTodos = tool({
  description:
    '维护本任务的结构化计划（待办清单）。在多步任务开始时把目标拆成待办，' +
    '完成一项就标记 completed、开始下一项标记 in_progress。用于复杂/多步任务。',
  inputSchema: z.object({
    todos: z.array(z.object({
      id: z.string(),
      content: z.string().describe('待办内容，祈使句'),
      status: z.enum(['pending', 'in_progress', 'completed']),
    })),
  }),
  execute: async ({ todos }) => {
    ctx.setTodos(todos);                                  // 全量替换当前清单
    ctx.emit({ kind: 'todo-update', workId: ctx.workId, todos }); // 实时推 UI（§6.2）
    return { ok: true, counts: tally(todos) };
  },
});
```

**约定与语义**

- **全量替换**：每次调用提交完整清单（非增量），最新一次调用的 `todos` 即当前计划。
- **单焦点**：同一时刻至多一个 `in_progress`，引导 Agent 串行推进、状态清晰。
- **作用域 = Work（编排 Agent）**：计划属于整个 Work；子 Agent 默认**不**持有 `updateTodos`（它们专注被委派的单一目标）。编排 Agent 可把某个待办 `delegateToSubAgent`，二者天然衔接（计划项 → 子 Agent 任务）。
- **提示引导**：编排 Agent 的 `instructions`（§2.2）加入「多步任务先用 `updateTodos` 制定计划、再逐项执行并更新」，使「自带规划」成为默认行为而非偶发。

**持久化与恢复（文件存储，§5）**

- `updateTodos` 的调用本就作为 tool-call 记在 `session.jsonl`（会话路径上）；**当前 todo 状态 = 活动路径上最后一次 `updateTodos` 的入参**，无需独立存储。
- 为 UI 快速读取与恢复，把当前快照镜像到 `work.json.todos`。
- **与分支一致**：todo 状态**派生自活动会话路径**，故 fork / 切分支 / 压缩回退后，todo 自动回到该路径对应的状态（切换时重算快照）。压缩摘要应保留「未完成待办」要点，避免压缩后丢失计划。

**UI**：Work 主区/侧栏显示计划清单（勾选式），随 `todo-update` 实时刷新；进度（n/m 完成）显示在 Work 标题旁。




---

## 4. 安全模型

> 完整安全模型如下表。其中**「渲染进程 / 桥接面」两行属于宿主壳层**（由桌面端 Electron 实现，见 [desktop-architecture.md §1](desktop-architecture.md)），列此以呈现端到端全貌；其余各行（密钥、工具门控、文件边界、沙箱、审批、审计）是 **Agent 核心模块自身强制**的，与宿主无关。

| 面 | 措施 |
| --- | --- |
| 渲染进程（宿主壳） | `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、严格 CSP |
| 桥接面（宿主壳） | preload 只暴露白名单函数，不暴露 `ipcRenderer`/`require` |
| 密钥管理 | API key 存 OS keychain（`safeStorage` / keytar），**绝不**进 renderer，仅在 utilityProcess 读取 |
| 工具门控 | main 维护权限策略（路径白名单、命令白名单/黑名单、需审批清单），按 **Workspace 维度**收敛；运行时调用工具前请求授权 |
| 文件访问 | 工具的文件操作限制在边界内：Work = 所属 **Workspace 的 `root_path`**；Chat = 其私有 **scratch 目录**（§1.2）。路径需规范化校验防穿越；不能访问其它 Workspace 根目录或他人项目 |
| Workspace 隔离 | 不同 Workspace 的文件边界、MCP 连接、密钥引用互不重叠；切换 Workspace 不泄露上一空间的可访问路径 |
| **OS 级沙箱** | 在应用层门控之上，再用内核级沙箱强制文件/网络边界（§4.1）；可随时开关 |
| 命令执行 | 默认需审批；审批三态（单次 / 本任务 / 拒绝，§3.3）；「本任务批准」仅在当前 Work 运行会话内放行、不跨重启；全程记审计日志 |
| 子 Agent | 按 role 收敛工具权限；限制嵌套深度与并发；级联中断 |
| 网络 | 出站请求可配置域名白名单；MCP server 连接需用户显式授权 |
| 审计 | 所有工具调用与审批决策写入 `audit.jsonl`（append-only），可回溯 |

### 4.1 OS 级沙箱（Sandbox）

应用层门控（JS 路径校验 + 审批）能防住「Agent 直接调文件工具」，但挡不住「`runCommand` 起的子进程在 JS 校验之外乱跑」。为此叠加一层**内核级强制沙箱**作为纵深防御。

**抽象优先：`Sandbox` 接口，后端可替换**

不直接耦合任何具体沙箱实现，而是定义统一接口；[landstrip](https://github.com/landstrip/landstrip) 作为首个实现。

```ts
interface Sandbox {
  // 由 Workspace 上下文生成沙箱策略（Anthropic Sandbox Runtime JSON 子集）
  buildPolicy(ctx: WorkspaceContext): SandboxPolicy;
  // 用沙箱包裹要执行的命令/进程（如 landstrip -p policy <cmd>）
  wrapCommand(cmd: string, args: string[], policy: SandboxPolicy): SpawnSpec;
  // 解析沙箱的拒绝事件（trap），含 suggested_grant，驱动审批闭环
  parseTrap(line: string): SandboxDenial | null;
}
```

- **首个实现 `LandstripSandbox`**：macOS Seatbelt / Linux Landlock+seccomp / Windows AppContainer。**锁定版本**（如 `@landstrip/landstrip@0.15.5`），不浮动跟最新，避免 pre-1.0 频繁变更打穿核心安全路径。
- **策略来源**：`allowWrite =` 会话边界（Work → `workspace.root_path`；Chat → 私有 `scratch/`，§1.2）、`network` 取生效网络白名单 —— 把 §1.1/§1.2/§4 的边界从「JS 校验」下沉到内核强制。
- **审批闭环**：沙箱拒绝时输出的 `suggested_grant`（如 `{"allowWrite":"/repo/out"}`）直接喂给 §3.3 三态审批 —— 用户点「本任务批准」即把该 grant 并入当前 Work 的沙箱策略并重试。

**沙箱开关（可随时开 / 关）**

| 维度 | 说明 |
| --- | --- |
| 作用域 | 全局默认开关（`setting`）+ **Workspace 级覆盖**（`workspace.config_json.sandbox`）。某个 Workspace 可单独关沙箱（如调试需要不受限的工具环境）。|
| 默认 | **默认开启**（安全优先）。关闭是显式、知情的降级操作。|
| 生效时机 | 沙箱在进程启动时套上，无法对已启动的进程树追加/摘除。故开关**对「下一个启动的 run / Work」生效**；正在运行的 Work 保持其启动时快照（与 §2.5「切换无副作用」一致）。UI 需提示「将于下次运行生效」。|
| 关闭时行为 | 回退到**纯应用层门控**（JS 路径校验 + 三态审批仍在）；并在该 Work / Workspace 顶部显著标注 **「⚠ 沙箱已关闭」** 风险提示，审计记录该状态。|
| 平台差异 | Windows 网络策略粒度粗（allow-all / deny-all，按 host/port 过滤需提权，不支持）；跨平台策略需接受此差异，UI 在 Windows 上标注网络为粗粒度。|

> 设计取舍：沙箱是**纵深防御的第二层**，不是唯一防线。即使关闭，应用层门控与审批依然生效，只是少了内核强制。开关存在的意义是：某些工具链/JIT/GUI helper 可能与沙箱限制冲突，需要临时无沙箱环境排查 —— 但这应是显式、可见、可审计的选择。




---

## 5. 数据模型与持久化

> v0.4 重构：**放弃 SQLite，改为纯文件存储**（local-first、人类可读、可备份可 diff），延续 pi agent 的「JSONL 会话 + 目录式配置」。文件存储天然容纳 **Skills**（目录 + `SKILL.md`，§3.6）与 **MCP**（JSON 配置，§3.5）。会话树/分支/压缩语义同 v0.3，仅落盘形式由表改为 append-only 日志。

### 5.0 两棵正交的树

本应用有两棵**互相独立**的树，勿混淆：

| 树 | 链接字段 | 维度 | 作用 |
| --- | --- | --- | --- |
| **会话树** | `entry.parentId` | 时间（历史/分支） | 一个 Work 内消息/轮次的树，支持 fork 与压缩 checkpoint；用户可见可导航 |
| **运行树** | `run.parentRunId` | 空间（委派） | 主 Agent → 子 Agent 的委派层级；驱动轨迹树观测（§2.3/desktop §2） |

二者通过 `entry.runId` / `entry.agentId` 关联：每条 entry 记录「由哪个 run / agent 产生」。一个 Work = 一棵会话树（= 一个 session）。

### 5.1 存储位置

所有数据由 app 统一管理于 **`~/.enterprise-agent/`**（App 数据根）—— Workspace 注册表、Work、会话、全局配置、用户安装的 skills / MCP / providers 都在此。配置作用域沿用实体两级：**全局 → Workspace**（缺省回退全局，与 §2.5 一致）。

> `workspace.rootPath` 仅是 Agent 操作的**代码库目录**（文件访问边界，§4），Enterprise Agent 不在其中写入任何状态/配置文件 —— 不污染用户仓库。

### 5.2 目录布局

```
~/.enterprise-agent/                           # App 数据根（唯一存储位置）
├─ settings.json                      # 全局默认：model 默认、sandbox.enabled、权限策略、compactRatio(默认 0.9)...
├─ providers.json                     # model_provider[]（含 keyRef 引用，不含明文密钥，§2.6/§4）
├─ aliases.json                       # 全局 model_alias[]
├─ skills/<skill>/SKILL.md            # 全局 skills（Agent Skills 标准，§3.6）
├─ mcp/<server>.json                  # 全局 MCP server 配置（§3.5）
├─ workspaces/<workspace-id>/
│  ├─ workspace.json                  # { name, rootPath, isActive, config:{model,sandbox,permission 覆盖} }
│  ├─ aliases.json                    # 该 Workspace 的别名覆盖（可选）
│  ├─ mcp/<server>.json               # 该 Workspace 的 MCP（可选）
│  ├─ skills/<skill>/...              # 该 Workspace 的 skills（可选）
│  └─ works/<work-id>/
│     ├─ work.json                    # { title, goal, status, headEntryId, todos, usage }（todos/usage 为快照镜像，§3.7/§2.7）
│     ├─ session.jsonl                # 会话树：append-only 事件日志（§5.3）
│     ├─ runs.jsonl                   # 运行树：每行一个 run（含 parentRunId、rootEntryId、status）
│     └─ audit.jsonl                  # tool_call 审计（tool/input/output/approval/grantKey/agentScoped）
└─ chats/<chat-id>/                    # 独立对话（§1.2），与 workspaces/ 并列、扁平
   ├─ chat.json                       # { name, config:{model,sandbox,permission}, headEntryId, todos, usage }（配置内联）
   ├─ session.jsonl                   # 同 Work：会话树
   ├─ runs.jsonl / audit.jsonl        # 同 Work
   └─ scratch/                        # Chat 私有工作目录（文件/执行工具的边界 = 沙箱 allowWrite）
```

> 配置作用域由「全局 → Workspace」两级合并实现（Workspace 缺省回退全局），取代了 SQLite 时代的 `workspace_id` 可空字段；Provider 接入（含密钥引用）是全局的。

### 5.3 会话文件（append-only 会话树）

`session.jsonl` 是**追加式事件日志**：不就地改写、崩溃安全、append 近似原子。每行一条记录：

```jsonc
{"type":"entry","id":"e12","parentId":"e11","runId":"r3","agentId":"orch","kind":"assistant","content":[/* v6 parts */],"usage":{...},"ts":1718...}
{"type":"label","entryId":"e12","label":"works-baseline"}   // 命名 checkpoint（pi appendLabelChange）
{"type":"head","entryId":"e12"}                              // 活动叶子移动（fork / 切分支 / 压缩后）
{"type":"entry","id":"e13","parentId":"e12","kind":"summary","summary":{"reason":"threshold","firstKeptEntryId":"e09","tokensBefore":150000,"tokensAfter":4000},"ts":1718...}
```

- `kind`: `user` | `assistant` | `tool_result` | `summary`（压缩 checkpoint）。`content` = v6 UIMessage/ModelMessage parts。
- **加载**：顺序折叠日志 → 重建 `entry` 树 + 当前 `head` + labels。`head` 同时镜像到 `work.json.headEntryId` 便于快速定位。
- **Fork / 压缩 / 改名** 全是**追加事件**，旧状态永不丢失，天然支持分支与回溯。
- **单写者**：每 Work 一个 utilityProcess 独占该 Work 目录的写权（与 desktop §1 进程模型一致），避免并发写冲突；读侧（UI 列表）只读快照。

### 5.4 会话树与分支（参考 pi agent）

- **活动路径**：`headEntryId` 沿 `parentId` 回溯到根（或最近 summary，§5.5），即当前喂给 Agent 的上下文。
- **Fork（分支）**：选树上任一历史 entry `E`，追加 `parentId = E` 的新 entry → 旁出新分支，再追加 `head` 事件指向新叶。旧分支保留、可随时切回。用于「换个问法 / 换条路」而不丢历史。
- **Checkpoint**：追加 `label` 事件标记命名锚点（pi `appendLabelChange`）。
- **Clone**：把某叶→根的路径抽取为新 Work 目录（pi `createBranchedSession` 等价物）。
- **导航 API**：`getPath(head)` 取活动上下文；`getTree(workId)` 取全树供 UI 树形导航；`getChildren(id)` 取分叉。

### 5.5 上下文压缩（context compaction）

长对话用**摘要式压缩**而非截断，并保留树的可探索性：

| 方面 | 设计 |
| --- | --- |
| 触发 | `manual`（用户）/ `threshold`（超过模型上下文窗口的设定比例）/ `overflow`（provider 报超限后兜底）|
| 机制 | 把活动路径「基点 → 切点」的消息摘要为一条 `kind='summary'` entry（追加），作为**新压缩 checkpoint**；其后轮次挂其下。被摘要的旧 entry **仍在树中**（可导航、可从更早 checkpoint 分支），只是不再回放 |
| 回放规则 | 构造模型上下文时从 `head` 回溯到**最近的 summary 祖先（含）**，即「摘要 + 其后消息」，而非全量历史 —— summary 节点即压缩基线 |
| 记录 | `summary = { reason, firstKeptEntryId, tokensBefore, tokensAfter }`（写在 summary entry 内）|
| 事件 | `compaction-start{reason}` / `compaction-end{summaryEntryId, firstKeptEntryId, tokensBefore, tokensAfter}`（§6.2）|
| 自动压缩 | `threshold` 在 `prepareStep` 内判定并执行（见下），对用户透明（轨迹树标注压缩节点）|

**触发逻辑（需要实打实的代码支持，依赖 §2.6 `ModelMeta.contextWindow`）**

`threshold` 与 `overflow` **都需要逻辑支持**，分别对应 v6 的两个机制：

- **`threshold`（主动，事前）—— 真实 token 设标志 + 下一步 `prepareStep` 压缩**：**不做本地 token 估算**，直接用 provider 在 `onStepFinish` 回报的真实 `usage.inputTokens` 判定，超过 `contextWindow × COMPACT_RATIO` 即置标志。`COMPACT_RATIO` 是**全局配置**（`settings.json`，默认 **0.9**）。代价是判定**滞后一步**（本步发现超阈值，下一步才压），由 `overflow` 兜底。

  ```ts
  // onStepFinish：用真实 inputTokens 判定，只设标志，不在此压缩
  onStepFinish: ({ usage }) => {
    if (usage.inputTokens >= modelMeta.contextWindow * COMPACT_RATIO) {  // 全局配置，默认 0.9
      ctx.needsCompaction = true;
    }
  },
  // prepareStep：每步前检查标志，命中才压缩（prepareStep 在循环中途也生效）
  prepareStep: async ({ messages }) => {
    if (!ctx.needsCompaction) return {};
    ctx.needsCompaction = false;
    const { summaryMsg, summaryEntry, tokensBefore } = await compactor.summarize(messages, modelMeta);
    appendSummaryEntry(ctx.workId, summaryEntry, { reason: 'threshold', tokensBefore });
    return { messages: [messages[0], summaryMsg, ...recentTail(messages)] };  // 系统 + 摘要 + 近段
  }
  ```
  同一次压缩**既改写在途 messages、又追加 `summary` entry**（§5.3），二者保持一致。

- **`overflow`（兜底，事后）—— 捕获 provider 超限错误后重试**：threshold 滞后一步，若那一步内又注入超大 tool 结果就可能真的爆窗。包裹模型调用，捕获 provider 的「上下文超长」错误（按各 provider 错误码识别；注意区别于 `finishReason==='length'` 那是输出截断、另行续写），触发**紧急压缩**（立即置标志并在重试前的 `prepareStep` 生效，或直接压一次）后重试该步；若单条消息本身超限则降级（截断该 tool 结果 / 上报错误）。

> 注意：压缩与子 Agent 解耦 —— 主 Agent 会话路径压缩，不影响已结束的子 Agent 转写（它们是工具调用的执行细节）。threshold 判定**只信 provider 回报的真实 `inputTokens`**，无本地估算；滞后一步的窗口由 `overflow` 兜住。

### 5.6 可恢复性

- **消息历史**：v6 `ModelMessage`/UIMessage parts 持久化于 `entry.content`。
- **恢复 Work**：折叠 `session.jsonl` → 取 `head` 活动路径（遵循最近 summary）→ 回放给主 Agent，在已有上下文继续。
- **运行树还原**：`runs.jsonl` 的 `parentRunId` + `entry.agentId` 重建主/子 Agent 关系，驱动轨迹树。
- **子 Agent 转写**：子 Agent 的 entry 同写在该 Work 的 `session.jsonl`（`agentId` 区分，`parentId` 挂在其 `delegateToSubAgent` 工具 entry 之下），仅用于轨迹树回放；**分支/压缩只作用于主 Agent 的会话路径**，子 Agent 转写视为该工具调用的执行细节，不独立可分支。

### 5.7 为什么文件而非 SQLite

| 取舍 | 说明 |
| --- | --- |
| 选文件的理由 | local-first 可读可 diff、可备份；**天然容纳 skills（目录）/ MCP（JSON）**；与 pi 生态互通；零迁移成本 |
| 代价 | 无事务 / 索引 / 复杂查询 |
| 缓解 | 会话/运行/审计用 **append-only JSONL**（崩溃安全、写入即追加）；小配置用 JSON；**加载时建内存索引**；每 Work 单写者消除并发写；跨 Work 搜索靠启动扫描 + 内存索引（本地个人量级，可接受）|

### 5.8 迁移

文件存储为首版落地形态，无历史库迁移负担。若已有 v0.1–v0.3 的 SQLite 原型：按表导出为对应文件 —— `workspace/work` → `workspace.json/work.json`，`entry` → `session.jsonl`（补 `head` 事件指向末条），`run` → `runs.jsonl`，`tool_call` → `audit.jsonl`，`setting/provider/alias/mcp_server` → 对应 JSON。



---

## 6. 模块接口契约（命令 + 事件 + 中断）

本节定义 Agent 核心模块的**对外接口**：宿主（桌面端 / CLI）通过它驱动模块、接收流式输出。接口是**传输无关**的 —— 桌面端用 Electron IPC 承载（`contextBridge` invoke + `MessagePort`，见 [desktop-architecture.md §1.2](desktop-architecture.md)），CLI 可用 stdio/JSON-RPC 承载，契约本身不变。

### 6.1 命令（宿主 → 模块，请求式）

- 容器管理：Workspace CRUD/切换（`listWorkspaces`、`createWorkspace`、`switchWorkspace`、`updateWorkspaceConfig`）、Chat CRUD（`listChats`、`createChat`、`updateChatConfig`、§1.2）。
- 会话驱动：`startWork`、`sendMessage`、`approveTool`、`abortRun`、Work CRUD。
- 会话树操作：`forkFrom(entryId)`、`labelEntry(entryId, label)`、`compact(reason?)`、`getSessionTree(sessionId)`、`cloneToWork(leafId)`。
- 会话类操作以统一的 `sessionId`（Work 或 Chat）寻址。

### 6.2 事件（模块 → 宿主，单向流式）

模块对每个 step / 工具调用 / 子 Agent / token / 压缩等实时回报 `AgentStreamEvent`；宿主据 `agentId`/`parentAgentId` 归并为轨迹树（桌面端见 desktop §2，CLI 可打印或转 JSON）。

```ts
type AgentStreamEvent =
  | { kind: 'text-delta'; runId: string; agentId: string; text: string }
  | { kind: 'tool-call'; runId: string; agentId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool-approval-required'; runId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool-result'; runId: string; toolCallId: string; output: unknown }
  | { kind: 'step-finish'; runId: string; agentId: string; usage: TokenUsage }
  | { kind: 'usage'; runId: string; agentId: string; usage: TokenUsage; totalUsage: TokenUsage; cost: number }
  | { kind: 'todo-update'; workId: string; todos: Todo[] }
  | { kind: 'sub-agent-start'; runId: string; parentAgentId: string; agentId: string; role: string }
  | { kind: 'sub-agent-finish'; runId: string; agentId: string; summary: string }
  | { kind: 'compaction-start'; runId: string; reason: 'manual' | 'threshold' | 'overflow' }
  | { kind: 'compaction-end'; runId: string; summaryEntryId: string; firstKeptEntryId: string; tokensBefore: number; tokensAfter: number }
  | { kind: 'run-finish'; runId: string; finishReason: string }
  | { kind: 'error'; runId: string; message: string };
```

UI 依据 `agentId` / `parentAgentId` 把事件归并到轨迹树的对应节点，子 Agent 显示为可折叠的嵌套块。

### 6.3 中断

`abortRun(runId)` 命令触发模块内对应 `AbortController.abort()`，AI SDK v6 的 `stream`/`generate` 接收 `abortSignal` 后停止，级联到所有子 Agent。（桌面端经 main 转发到 utilityProcess，见 [desktop-architecture.md §1.2](desktop-architecture.md)。）



---

## 附录 A：版本与 API 注意事项

- 本设计基于 `ai@6.0.0-beta`，核心类为 **`ToolLoopAgent`**（v6 引入），方法为 `.generate()` / `.stream()`。
- v6 工具入参字段为 `inputSchema`（非 v4 的 `parameters`）；停止条件用 `stopWhen` + `stepCountIs(n)` 或自定义 `async ({ steps }) => boolean`。
- 结构化输出用 `Output.object({ schema })`，会额外占用一个 step。
- 模型层 API 已对照 `ai@6.0.0-beta.128` 核实（2026-06-18）：`createProviderRegistry(providers, { separator })`、`customProvider({ languageModels, fallbackProvider })`、`wrapLanguageModel` + `defaultSettingsMiddleware({ settings })`，`registry.languageModel('providerId:modelId')`。Provider 包：`@ai-sdk/anthropic`(`createAnthropic`)、`@ai-sdk/openai`(`createOpenAI`)、`@ai-sdk/openai-compatible`(`createOpenAICompatible`)。
- Token 统计与压缩 API 已对照 `ai@6.0.0-beta.128` 核实（2026-06-18）：`onStepFinish({ usage, totalUsage, finishReason })`，`LanguageModelUsage = { inputTokens, outputTokens, totalTokens, reasoningTokens?, cachedInputTokens? }`；`ToolLoopAgent` 的 **`prepareStep({ stepNumber, steps, messages }) => { messages? }`** 可在每步前改写消息（官方示例即「压缩历史 / 摘要超长 tool 结果」），用于 §5.5 主动压缩。
- 升级 beta 版本前请用 Context7 复核 `ToolLoopAgent` / `streamText` / `Output` / `createProviderRegistry` / `prepareStep` / `onStepFinish` 的签名是否有变化。
