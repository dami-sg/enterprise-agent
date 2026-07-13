# Enterprise Agent — Agent 核心模块架构

> 本文档定义一个**可独立构建/运行的 Agent 核心模块**（不依赖 Electron/UI），涵盖：领域模型 Session（§1）、运行时（§2）、工具系统（§3）、安全与沙箱（§4）、数据模型与持久化（§5）、**对外接口契约（§6）**、AI SDK API 注意事项（附录 A）。
> **集成方式**：桌面端（[desktop-architecture.md](desktop-architecture.md)）与未来的 CLI 都通过 **§6 的命令/事件契约**驱动本模块，各自只补壳层（进程/传输/UI）。本模块收敛为单一包 **`@dami-sg/agent`**，契约类型单列 **`@dami-sg/agent-contract`**（[architecture.md §3](architecture.md)）。
> 编号：**本文件章节独立顺序编号**（§1–§6 + 附录 A）。本文件内引用用裸 `§x`；跨文件引用用 `desktop §x`（[desktop-architecture.md](desktop-architecture.md)）/ `总览 §x`（[architecture.md](architecture.md)）限定。完整跨文件索引见 [architecture.md §0.3](architecture.md)。

---

## 1. 领域模型（Session）

把原先的 **Workspace / Work / Chat** 三类实体**统一收敛为单一实体 Session**。一个 Session = 一个独立会话单元：驱动 OrchestratorAgent、拥有会话树、可 spawn 子 Agent，走审批、压缩、todo、usage。工作目录从「实体」降级为 **Session 的一个可选属性**。

### 1.1 Session（会话）模型

```
Session（唯一顶层实体，扁平、各自独立配置）
  ├─ workingDir?     # 可选工作目录（文件访问边界）；不指定 → 默认工作目录
  ├─ config          # 模型 / MCP / skills / 权限策略 / 别名（覆盖全局默认）
  ├─ 会话树（session.jsonl，§5.3）
  └─ OrchestratorAgent → SubAgent...
```

| 维度 | 说明 |
| --- | --- |
| 工作目录（可选） | 创建 Session 时**可指定一个工作目录**（即原 Workspace 根目录），作为文件/执行类工具的访问边界（§4），适合围绕某代码库工作（原 Work）。**不指定**则用**默认工作目录**（见下），适合与项目无关的通用事务（问答、查资料、调 MCP 发邮件/查 API、轻量脚本，原 Chat）。|
| 默认工作目录 | 未指定工作目录的 Session 落在**默认工作目录**：取全局配置 `settings.defaultWorkingDir`，**缺省为该 Session 的私有 scratch 目录**（`~/.enterprise-agent/sessions/<id>/scratch/`）—— 沙箱 `allowWrite` = 该目录（§4/§4.1），隔离、不污染任何用户项目。|
| 配置作用域 | 模型默认、MCP server、skills、权限策略、密钥引用按 **global → Session** 两级合并；Session 未配置项回退全局默认。不同 Session 可用不同的 MCP / 模型 / 审批策略。|
| 独立运行 | 每个 Session 是独立运行单元（驱动 OrchestratorAgent、独立 utilityProcess，desktop §1），并发与崩溃隔离。|
| 边界隔离 | 不同 Session 的文件边界、MCP 连接、密钥引用互不重叠；指定不同工作目录的 Session 互不可见对方的可访问路径。|
| 列表与活动态 | 顶层是一个**扁平的 Session 列表**（UI 可按工作目录/最近活动分组展示，desktop §2）；任一时刻可有一个「当前活动 Session」。|
| 零配置可用 | 首启即可直接新建一个 Session（不指定工作目录 → 私有 scratch），无需先建容器。|

> 设计取舍：**取消 Workspace 容器与 Work/Chat 二分**，把「项目根目录」从一类实体降级为 Session 的可选属性。指定工作目录 = 围绕某代码库工作（原 Work 语义）；不指定 = 通用对话（原 Chat 语义）。两者**共用同一套运行时、会话树、审批、压缩、todo、usage**，唯一区别是「文件边界落在指定项目目录，还是私有 scratch」。



---

## 2. Agent 运行时设计（AI SDK v6）

### 2.1 核心抽象

```ts
// 概念映射
Session         ──has──────▶ workingDir?（指定 → 项目目录；否则默认工作目录）+ config
Session         ──drives───▶ OrchestratorAgent (ToolLoopAgent)
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

export function createOrchestrator(ctx: SessionContext) {
  return new ToolLoopAgent({
    id: `session-${ctx.sessionId}-orchestrator`,
    model: anthropic('claude-sonnet-4.5'),
    instructions: ctx.systemPrompt, // Session 目标 + 约束 + 「多步任务先用 updateTodos 规划」引导（§3.7）
    tools: {
      ...buildLocalTools(ctx),       // 文件、命令、HTTP、updateTodos（§3.7）等
      ...buildMcpTools(ctx),         // MCP 动态工具
      delegateToSubAgent: spawnSubAgentTool(ctx), // 见 §2.3
    },
    // 默认最多 20 步；可按 Session 复杂度调高
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

> **v0.7 演进 — 自生成式 Sub-Agent（已实现，当前模型）**：取消**预定义子 Agent**（不再有固定 role 枚举、`ROLE_TOOL_POLICY` 表、`AgentRegistry`/`buildSeedAgents`、磁盘 `AGENT.md` 发现）。改由 **Orchestrator 在委派那一刻按需合成**一个临时子 Agent——`delegateToSubAgent` 入参从 `role` 枚举改为 inline **`spec`**（`name` + `capabilities`(read/write/exec/http) + `mcp` 白名单 + 任务 prompt + 可选 model/timeout）；能力经 `granted = requested ∩ 管理员包络` 收敛后构造一个**临时 `AgentDef`（绝不注册，跑完即弃）**喂给同一套硬门装配。关键变化：① 能力天花板从"枚举"迁到新配置 **`dynamicSubAgents` 包络**（`ea config dynamic-subagents`），默认**开启 + 全能力**，运营方按需收敛/熔断；② **子 Agent 不可再嵌套**（永不获得 `delegateToSubAgent`，委派树深度恒为 1）——故下文点 1/3 的"嵌套/MAX_DEPTH"与点 2/5 的 role 工具映射、`delegateRoles`/`roleTimeoutMs` 等**均已废弃**；③ 每次合成发 `sub-agent-spawn`(全量配置审计) + 跑完发 `sub-agent-eval`(执行后评估，会话内反馈)。**§3.4 安全不变量全部保留**（用户为审批主体、子 ≤ 父、能力硬门优先）——"role 硬门"现读作"能力硬门"（按 spec 能力装配工具，越权工具不构造）。**当前权威设计见 [`dynamic-subagents.md`](dynamic-subagents.md)**；实现见 [sub-agent.ts](../packages/agent/src/runtime/sub-agent.ts) / [agents/registry.ts](../packages/agent/src/agents/registry.ts)。下文 §2.3 余下段落为**历史（v0.6 role 模型）背景**，编排语义（agent-as-tool、超时安全网、空产出显式化、审批透传）仍适用，但"role"一词应理解为"合成的能力集"。

子 Agent 采用 **「Agent-as-Tool（编排者-工人模式）」**：主 Agent 拥有一个 `delegateToSubAgent` 工具，调用它即在运行时内创建一个新的 `ToolLoopAgent` 实例并运行，子 Agent 的最终输出作为工具结果返回给主 Agent。

```ts
function spawnSubAgentTool(ctx: SessionContext) {
  return tool({
    description:
      '把一个边界清晰的子任务委派给一个专注的子 Agent。' +
      '用于：调研、代码生成、数据分析等可独立完成的工作。',
    // v0.7：入参是合成的 spec，不再是 role 枚举（见 dynamic-subagents.md §D1）。
    inputSchema: z.object({
      spec: z.object({
        name: z.string(),
        capabilities: z.array(z.enum(['read', 'write', 'exec', 'http'])),
        mcp: z.union([z.literal(false), z.array(z.string())]),
        prompt: z.string(),
        model: z.string().optional(),
        timeoutMs: z.number().optional(),
      }),
      objective: z.string().describe('子任务的明确目标'),
      context: z.string().optional().describe('完成任务所需的背景信息'),
    }),
    execute: async ({ spec, objective, context }, { abortSignal }) => {
      const sub = new ToolLoopAgent({
        id: `session-${ctx.sessionId}-sub-${spec.name}-${ctx.nextSubId()}`,
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
2. **工具集分层**：子 Agent 默认**不**拥有 `delegateToSubAgent`，且按 `role` 收敛工具权限（如 `researcher` 只读、不能写文件）。
   role 工具映射（`ROLE_TOOL_POLICY`）：`researcher`（读 + http + MCP）、`coder`（读写 + 执行 + MCP）、`analyst`（读 + 只读执行 + MCP）、`writer`（读写 + MCP）、`generalist`（**最大化工具集**：读写 + 执行 + http + 全部 MCP + 可见全部技能）。`generalist` 让编排者在子任务确实需要「读代码 + 跑命令 + 联网 + 调 MCP」的混合能力时，一次性把**完整工具集**交给 worker，而非被迫塞进某个窄 role —— 给「它需要的最大集，而非最小集」。它依旧受同一套审批门 + sandbox + 「子 ≤ 父」单调不增约束（§3.4），不破坏安全不变量。新增 role 名由单一来源 `SUB_AGENT_ROLE_NAMES` 派生（union 类型、`ROLE_TOOL_POLICY` 键、`delegateToSubAgent` 入参 enum、config role 列表全部据此，避免漂移）。
   嵌套委派由配置 `delegateRoles`（`ScopedConfig`，可全局设或按 Session 覆盖）显式开启：仅列出的 role 才在工具装配期（`buildToolsForRole`）获得 `delegateToSubAgent`，且依旧受 `MAX_DEPTH` 约束（点 1）。省略=内置默认（无 role 嵌套），`[]`=显式全关；未知 role 名在 `effective()` 合并时被过滤，避免过期配置意外放权。CLI 用 `ea config delegate <role...> | none | default` 读写该开关（写入全局 `settings.json`）。
3. **并行委派**：若主 Agent 在一个 step 内发起多个 `delegateToSubAgent` 调用，运行时用 `Promise.all` 并行执行（受全局并发上限约束）。
4. **可观测**：每个子 Agent 拥有独立 `id`，所有事件带上该 id，UI 据此渲染**运行轨迹树**（父 → 子 → 孙）。
5. **可中断 + 超时**：`abortSignal` 从 Session 级别向下传递，中止 Session 的 run 即级联中止所有子 Agent。此外每个 `delegateToSubAgent` 受**墙钟超时**约束（`subAgentTimeoutMs`，默认 300000ms，`0` 关闭；可按 role 用 `roleTimeoutMs` 覆盖，如 researcher 联网调研给更长、coder 给更短，解析见 `timeoutForRole`）：运行时把 `AbortSignal.any([父信号, AbortSignal.timeout(ms)])` 同时喂给子 Agent 的 `stream` 与其工具上下文（`ctx.abortSignal`），所以超时会**级联中止子 Agent 在飞的工具调用**（如卡住的 httpFetch / MCP）。超时后工具返回结构化 `{ error: 'timeout', timeoutMs, output: <部分文本> }`，编排 Agent 据此重试/收窄范围，而非无限阻塞在 `execute` 上。> **澄清**：编排 Agent **不会**在 spawn 后立刻读取子 Agent 输出——`delegateToSubAgent` 的 `execute` 是 `async`，AI SDK 的 `ToolLoopAgent` 在该 step 内 `await` 所有工具 `execute` 完成后才把结果回灌模型；`execute` 内部 `for await(...fullStream)` + `await stream.text` 走完整条子 Agent 运行，故「等子 Agent 做完再返回主 Agent」本就是默认语义，超时是其安全网。
6. **权限与审批**：子 Agent 的高风险工具走与主 Agent 同一套三态审批；遵循「用户为审批主体、权限单调不增、role 硬门优先」。详见 §3.4。
7. **联网检索靠 MCP，core 不内置 `web_search`**：`researcher`（`mcp: true`）的网络能力来自 `httpFetch` + **连接的搜索类 MCP server**（§3.5）——core **没有** `web_search` 工具，prompt 也明确告知子 Agent 不要假设其存在。要让 researcher 真正能查资料，需先 `ea mcp add` 一个搜索 MCP（否则它只能 `httpFetch` 已知 URL，或如实说明无法联网）。
8. **空产出显式化**：子 Agent 跑完却没有任何文本时，`delegateToSubAgent` 返回带 `note` 的结果（而非静默 `output: ''`），提示「可能缺少所需工具（如未接搜索 MCP）」，避免编排 Agent 把「没产出」误判为「卡住」而静默接管。AI SDK 在「子 Agent 只调了工具、没产出 assistant 文本」时会抛 `AI_NoOutputGeneratedError`（`stream.text` 访问处）；运行时**捕获并转成上述结构化结果**（连同已流式出的部分文本），不让裸错误冒泡成 "No output generated"（`isNoOutputError`，[sub-agent.ts](../packages/agent/src/runtime/sub-agent.ts)）。
9. **大负载走文件、勿塞工具参数**：工具调用的入参是在**输出 token 预算内**生成的，把大段数据塞进 `objective` / `writeFile` 的 `content` 会被截断成非法 JSON（"Unterminated string"）。正确做法：先把数据写文件，委派时只传**路径**，子 Agent 用 `readFile` 读取——prompt 已把此约束写进编排者与 writer 指引。
10. **文件边界软失败**：文件工具（read/list/search/write/applyPatch）越界访问时**返回结构化 `{error:'out_of_boundary', path, roots}`**（不再抛 `PathBoundaryError`），子 Agent 可读到 `roots` 后在边界内重试，而非因未捕获异常崩成「无产出」（§4）。

> 备选模式：当任务需要主 Agent 在子任务之间插入自定义逻辑（重试、外部系统对账等）时，使用 **Manual Agent Loop**（`streamText` + 手动检查 `finishReason === 'tool-calls'` 并手动执行工具），换取完全控制权。`ToolLoopAgent` 用于大多数标准场景；Manual Loop 用于需要细粒度控制的高级场景。

### 2.4 结构化输出

需要把 Session 结果落库为结构化数据时，用 `Output.object`：

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

### 2.5 Session 上下文注入

`SessionContext` 在 Session 启动时由 main 进程构造下发给 utilityProcess —— 把「全局默认 + Session 自身覆盖」合并、并解析出生效的工作目录：

```ts
interface SessionContext {
  sessionId: string;
  rootPath: string;                 // 文件访问边界（§4 路径校验的根）：
                                    //   指定的 workingDir，或默认工作目录(私有 scratch)
  readRoots: string[];              // 额外只读根（§4.2）：global ∪ scope 去重；
                                    //   子进程可读 + 可作 cwd，不可写、文件工具够不着
  systemPrompt: string;             // Session 目标 + 约束
  modelDefaults: ModelConfig;       // 默认 provider/model
  mcpServers: McpServerConfig[];    // 本 Session 生效的 MCP（global + Session 覆盖）
  permissionPolicy: PermissionPolicy; // 审批/白名单策略
  sandboxEnabled: boolean;          // OS 级沙箱开关（§4.1，缺省回退全局默认=true）
  maxSteps?: number;
  depth: number;                    // 子 Agent 嵌套深度
  // 工具构造、子 Agent 模型选择等都从合并后的上下文读取
  modelFor(role: string): LanguageModel;
  nextSubId(): number;
  emitSubEvent(agentId: string, evt: unknown): void;
}
```

要点：

1. **配置就近覆盖**：`modelDefaults` / `mcpServers` / `permissionPolicy` 先取 Session 级覆盖，缺失项回退全局默认（global → Session 两级）。
2. **根目录单一来源**：`buildLocalTools(ctx)` 里的文件工具一律以 `ctx.rootPath` 为根做规范化校验。`rootPath` 由「Session 指定的 `workingDir`，否则默认工作目录」唯一确定（§1.1）。`readRoots` 是**正交的只读旁路**（§4.2）——只进沙箱 `allowRead` 与 exec cwd 白名单，**不进**文件工具的 `rootPath` 校验集，故文件工具仍只认可写根。
3. **快照不被热切换打断**：已在运行的 Session 持有其启动时快照的上下文；改全局/Session 配置只对**下次启动的 run** 生效。

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
role 显式覆盖 → Session 覆盖 → 全局默认 → 内置兜底(anthropic:claude-sonnet-4.5)
```

**要点**

1. **密钥只进 utilityProcess**：`ProviderConfig.keyRef` 存引用，明文在 OS keychain，注册表构造时现取，绝不入 renderer / config_json（§4）。
2. **能力校验**：orchestrator 与「会调工具的子 Agent role」必须解析到带 `tools` 能力的模型；结构化输出（§2.4）需 `structured-output`。配置时校验，避免运行期才报错。
3. **配置作用域**：Provider 接入是**全局**的（含密钥）；语义别名映射与角色→别名绑定可被 **Session 覆盖**（不同 Session 用不同强弱模型）。与 §2.5 配置就近覆盖一致。
4. **变更生效时机**：注册表按需懒构造并缓存；配置变更后**对下一个启动的 run 生效**，运行中的 Session 持有启动时快照（与 §2.5 / §4.1 一致）。
5. **多形态接入**：`openai-compatible` + 自定义 `baseURL` 覆盖本地（Ollama/vLLM）、聚合（OpenRouter）；`gateway` 走 Vercel AI Gateway 统一计费/路由。
6. **模型元数据（`ModelMeta`）**：每个模型登记 `{ contextWindow, maxOutputTokens, price: { input, output, cachedInput } /* 每 Mtok */ }`。这是 **Token 统计成本核算（§2.7）** 与 **压缩 threshold 触发（§5.5）** 的前置数据；内置常见模型的元数据，`openai-compatible`/本地模型允许用户手填（缺省给保守默认）。

**模型发现（Model Discovery，动态拉取可用模型）**

Provider 接入后，「**有哪些模型可选**」尽量动态拉取，而非纯硬编码。由 core 的 **`ModelCatalog`** 统一负责（不放壳层，桌面端/CLI 共用），经 §6.1 `listProviderModels(providerId)` 暴露。

1. **发现 ≠ 元数据**（关键边界）：端点只返回**模型 id 列表**；`ModelMeta`（contextWindow/price/能力）仍由 `BUILTIN_MODEL_META` 或用户手填提供（pt.6）。发现到无 meta 的 id → 落 `FALLBACK_META`（保守窗口、无价 → 成本记 0 并标「无定价」，§2.7）。**发现喂「选择器」，meta 管「算钱/压缩」，两者正交**——动态列表新鲜度高，但不替代 meta。
2. **端点与解析按 `kind` 分**（一张内部表，**不进 `ProviderConfig`**）：

   | kind | 发现端点（相对 baseURL） | 响应解析 | 需 key |
   | --- | --- | --- | --- |
   | `openai` / `openai-compatible` | `/models`（OpenAI 兼容） | `data[].id` | 是（本地 Ollama/vLLM 否） |
   | `google` | `/v1beta/models` | `models[].name`（形状不同） | 是 |
   | `gateway` | 同兼容端点（按网关而定） | `data[].id` | 是 |
   | `anthropic` | **无端点** | 纯静态 `BUILTIN_MODEL_META` | — |

   `openai-compatible` 的 `baseURL` 已含版本前缀（如 `…/v1`、`…/compatible-mode/v1`），故端点取 `${baseURL}/models`；Ollama 优先用 OpenAI 兼容的 `/v1/models`（非原生 `/api/tags`）以统一解析。
3. **静态兜底、动态求新，合并不替换**：选择器显示 `union(动态拉到, 静态已知)`。部分 provider 动态返回不全/不稳（如混元、MiniMax、星火），合并保证不丢内置模型；某 provider 可标记「仅静态」。
4. **缓存与时机**：结果缓存到 `~/.enterprise-agent/cache/models-<providerId>.json`，TTL（默认 24h）；触发 = 用户配置/更新 key 后一次（cli-ui §10）或显式 `ea models --refresh`。
5. **静默回退**：拉取失败（网络/鉴权/超时）不打扰用户，直接用静态兜底；错误仅记日志，不阻塞配置流程。

> `ProviderConfig` 保持精简（`id/kind/baseURL/keyRef/headers/enabled`）——发现端点、是否需 key、兜底列表都从 `kind` + `BUILTIN_MODEL_META` 派生，**不新增持久化字段**。

### 2.7 Token 用量统计

数据源：v6 `streamText`/`ToolLoopAgent` 的 **`onStepFinish`** 回调，每步给 `usage`（本步）与 `totalUsage`（累计），字段：`inputTokens` / `outputTokens` / `totalTokens` / `reasoningTokens?` / `cachedInputTokens?`。

```ts
new ToolLoopAgent({
  /* ... */
  onStepFinish: ({ usage, totalUsage, finishReason }) => {
    accountant.record(ctx.runId, agentId, usage);        // 累加到 run/session/model 维度
    port.postMessage({ kind: 'usage', runId: ctx.runId, agentId, usage, totalUsage,
                       cost: accountant.cost(usage, modelMeta) });
    // 用真实 inputTokens 设压缩标志，下一步 prepareStep 再压（§5.5，无本地估算）
    if (usage.inputTokens >= modelMeta.contextWindow * COMPACT_RATIO) ctx.needsCompaction = true; // COMPACT_RATIO 全局配置，默认 0.9
  },
});
```

**统计维度与落盘**
- **每 entry**：`usage` 写入 `entry`（§5.1），cached/reasoning 分列。
- **滚动汇总**：utilityProcess 内存累计「本 run / 本 Session（含子 Agent）/ 按模型」三个维度；Session 维度汇总镜像到 `session.json.usage`，关闭后可直接读，不必重扫 `session.jsonl`。
- **成本**：`cost = ((inputTokens − cachedInputTokens)·price.input + outputTokens·price.output + cachedInputTokens·price.cachedInput) / 1e6`，单价取 `ModelMeta.price`。注意 provider 回报的 `cachedInputTokens` 是 `inputTokens` 的**子集**，故缓存部分按 cachedInput 单价计、并从全价 input 中扣除，避免双重计费；本地/未知单价模型成本记 0 并标注「无定价」。
- **子 Agent 归集**：子 Agent 的 usage 上卷进所属 Session 总量，同时按 `agentId` 可分项展示（轨迹树节点上显示该子 Agent 的 token/成本）。

**事件**：新增 `usage`（§6.2），携本步 usage + 累计 + 成本，驱动 UI 实时更新；Session 列表与详情显示累计 token / 成本。


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
| 时钟 | `getCurrentTime`（内置，返回本地日期/时间、星期、时区；可选 IANA 时区入参） | 无副作用 | 否 |
| MCP 动态工具 | 由连接的 MCP server 提供（§3.5） | 取决于 server（`riskTier`） | 按策略 |

### 3.2 工具定义规范

- 所有工具用 `tool({ description, inputSchema, execute })` 定义；`inputSchema` 必须是 Zod schema。
- `execute` 在 Agent UtilityProcess 内运行，但**受 main 进程权限策略门控**（见 §4）。
- 工具实现保持纯粹：副作用集中、返回可序列化结果（JSON-safe）。

### 3.3 Human-in-the-loop（人工审批）

高风险工具（如 `runCommand`）不直接提供 `execute`，而是走 v6 的审批流。审批结果有 **三态**：（注：这是 **Ask 模式**的逐项人工审批；Ask / Plan / Auto 三种执行模式如何决定「由谁裁决」见 §3.8。）

| 决策 | 枚举 | 含义 | 作用域 |
| --- | --- | --- | --- |
| **单次批准** | `APPROVAL.ONCE` | 仅放行当前这一次调用，下次同类调用仍需审批 | 本次 tool-call |
| **本会话批准** | `APPROVAL.SESSION` | 放行当前这一次，并在**当前 Session 会话内**对匹配的后续调用自动放行、不再弹框；**跨本 Session 的多轮对话 / 多个 run 持续**，直到 Session 关闭 | 当前 Session |
| **拒绝** | `APPROVAL.REJECT` | 拒绝本次调用，把拒绝信息作为工具结果回灌 Agent | 本次 tool-call |

```ts
const APPROVAL = { ONCE: 'once', SESSION: 'session', REJECT: 'reject' } as const;
type ApprovalDecision = typeof APPROVAL[keyof typeof APPROVAL];
```

审批流：

1. Agent 产生 tool-call（`state: 'input-available'`），运行时**先查会话级放行表**（见下）；命中则直接执行，不打扰用户。
2. 未命中 → 运行时**暂停**该工具执行，事件经 main → renderer，UI 弹出审批框（展示工具名 + 入参 + 三个按钮）。
3. 用户点「单次批准 / 本会话批准 / 拒绝」→ renderer 调 `approveTool(toolCallId, APPROVAL.ONCE | SESSION | REJECT)`。
4. main 把决策回传运行时：
   - `ONCE` / `SESSION`：执行真正逻辑并写回输出（`tool-output-available`）；若是 `SESSION`，把该工具登记进**会话级放行表**。
   - `REJECT`：返回拒绝信息，不执行。
5. Agent 拿到工具结果后继续循环。

**会话级放行表（session-scoped grants）**

- 存储位置：Session 内存中（main 进程持有，**随 Session 生命周期 —— 跨本 Session 的多轮对话/多个 run 持续**），**不落库、不跨重启、不跨 Session**。
- 匹配键（**授权键 / grant key**）：由每个工具自己从入参提取一个**有意义的粒度**作为放行范围，而非「工具名（太宽）」或「入参精确哈希（太窄，Agent 几乎不会原样重复命令，导致每条都要点）」两个极端：

  | 工具 | 授权键 | 自动放行范围示例 |
  | --- | --- | --- |
  | `runCommand` | argv[0]（可执行名） | 本会话内所有 `git ...`；`rm` 仍需审批 |
  | `writeFile` / `applyPatch` | 路径目录前缀 | 本会话内写 `src/` 下文件；写 `~/.ssh` 仍需审批 |
  | `httpFetch` | host / 域名 | 本会话内请求 `api.github.com` |
  | 其它通用工具 | 工具名（退化为最宽） | —— |

  `runCommand` 的默认粒度为 **可执行名（argv[0]）**；可配置收紧到 **子命令**（`git push` 与 `git commit` 分别授权）以提升安全性、代价是更多点击。审批框需明确展示本次授权的范围（如「本会话内自动批准 `git *`」），让用户知情。
- 失效：Session 关闭 / 用户在审批栏点「撤销本会话放行」/ 应用重启 → 放行表清空。
- 子 Agent：放行表**默认按 Session 维度共享**，子 Agent 的同名工具调用同样受惠（仍须先过 §2.3 的 role 工具硬门）；敏感授权可标记 `agentScoped` 不向子 Agent 继承。详见 §3.4。
- 审计：`SESSION` 授权本身写一条审计；其后每次「自动放行」的调用照常记 `tool_call`，并标注 `approval = 'session-auto'` 以便回溯。

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

> 该机制对应 v6 cookbook 的 human-in-the-loop 模式（`addToolOutput` + `APPROVAL`），本应用将其从二态扩展为三态：`ONCE`/`REJECT` 是无状态决策，`SESSION` 额外维护一张会话级放行表（随 Session 生命周期）。「审批 UI 在 renderer、执行在 utilityProcess、放行表在 main」用 IPC 串起来。

### 3.4 子 Agent 的审批与权限

子 Agent（§2.3）的审批**复用** §3.3 同一套三态流程，但遵循三条不变量：

**1. 审批主体永远是用户，父 Agent 不是授权方。**
子 Agent 请求高风险工具时弹框给**用户**，而非让父 Agent「替用户批准」。父 Agent 是编排者，不是信任边界。

**2. 权限单调不增（沿运行树向下只减不增）。**

```
子 Agent 有效权限 = 父 Agent 权限 ∩ role 工具集 ∩ Session 策略 ∩ sandbox 策略
```

子 Agent 永远不可能比父 Agent 权限更大。这是核心安全不变量，由 spawn 时构造的工具集与策略保证。

**3. 两道门，顺序固定。**
- **硬门 = role 工具白名单**：spawn 时锁死，子 Agent 根本拿不到范围外的工具（如 `researcher` 无 `writeFile`），与审批无关、不可被放行表绕过。
- **软门 = 三态审批 + 会话级放行表**：过了硬门的高风险调用再走审批。

**审批流（子 Agent 版）**

子 Agent 是同一 utilityProcess 内的 `ToolLoopAgent`，其高风险 tool-call 走同一暂停 → IPC → 弹框流程，事件带子 Agent 的 `agentId` / `parentAgentId`：

- 审批节点**渲染在轨迹树该子 Agent 节点下**，展示调用链（`Orchestrator → Sub#researcher → runCommand`），让用户知道「是谁在请求」。
- 此时父的 `delegateToSubAgent` 工具调用处于「运行中」（阻塞在 `sub.generate()`），正常等待，无需特殊处理。
- 全局 `pendingApproval` 判断已覆盖任意层级的 `input-available`，输入照常禁用。

**放行表继承（混合方案）**

| 情形 | 行为 |
| --- | --- |
| 默认（被动继承） | 放行表 **Session 级共享** —— 主 Agent 阶段授予的「本会话批准」，子 Agent 同 grant key 的调用自动放行（仍须先过 role 硬门）。|
| 敏感授权 | 授权时可标记 `agentScoped: true`，则该 grant **只对授予它的那个 agent 生效**，默认不向子 Agent 继承。|
| **主动委派（B，opt-in）** | `delegateToSubAgent` 传 `inheritScopedGrants: true` 时，spawn 处把**父自己持有的 `agentScoped` grant** 复制成**子作用域**副本（`agentScoped:true` + `delegatedFrom=父agentId`）下发给该子 Agent —— 父的 worker 复用父的敏感批准、不再逐次弹框。**严格受父已持有的范围约束（子 ≤ 父，永不提权）**，且副本仅对该子生效、不泄漏给兄弟/其它 agent。每条委派写一条 `audit(approval='delegated')`。|
| 记录 | 每条 grant 记录**授予时的 agentId**（及委派来源 `delegatedFrom`）；自动放行的子 Agent 调用照常记 `tool_call(approval='session-auto')`，审计可还原「哪个 agent 凭哪条 grant、由谁委派而放行」。|

**沙箱**：子 Agent 与 Session 共享同一 utilityProcess，**天然在同一 sandbox 策略下**（§4.1），无法越过 Session 的内核边界，无需额外处理。

**Skills 下发（A）**：子 Agent 也获得**技能目录**（§3.6），但按其 role 工具集**过滤** —— 只列出 `allowed-tools` 全部落在子 Agent 工具集内的技能（如 `researcher` 只读，就不会看到需要 `writeFile` 的技能），目录追加到该 role 的 system prompt，与编排者获得目录的方式一致。

> 取舍：role 硬门已经挡住「子 Agent 拿到不该有的工具」，所以放行表默认共享是安全的便利项；`agentScoped` 给「即使同一会话也想让子 Agent 单独确认」的高敏感授权留出口；`inheritScopedGrants`（B）则把这层「继承」**从被动改主动**——由编排者显式决定是否把自己的敏感批准下放给某个 worker，运行时强制「子 ≤ 父」不变量，仍由用户作为唯一的新授权来源。

### 3.5 MCP 工具接入

通过 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）client 接入外部工具生态，把第三方工具动态并入 Agent 工具集。

**配置（文件，§5.2）**

每个 MCP server 一份 JSON，分布在 `~/.enterprise-agent/mcp/`（全局）与 Session 的 `mcp/`（覆盖），两级合并、Session 优先：

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

1. Session 启动时，按合并后的生效配置连接各 MCP client（`buildMcpTools(ctx)`，§2.2）。
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

- 发现路径：全局 `~/.enterprise-agent/skills/` 与 Session `…/skills/`（覆盖），两级合并、Session 优先。技能由用户在 app 内安装/导入（兼容 Anthropic/pi 的 `SKILL.md` 包，可直接拷入）。
- **渐进式披露**：启动只把各技能的 `description` 注入系统提示（「可用技能」清单）；当 Agent 判断任务匹配时，调用内置 `useSkill(name)` 工具**按需加载完整 `SKILL.md` 正文**作为该工具结果进入上下文。`useSkill` 只读、不过审批，但仍受调用策略约束（见下）。用户可经 CLI（`ea skill show`）强制查看正文。
- 加载的正文进入会话上下文 → 受 §5.5 压缩管理。
- **动态发现 / 语义搜索**（skill-search 计划）：可见技能超过阈值（默认 12）时，清单不再全量 dump，而是降级为「搜索优先」——提示模型用内置 `searchSkills(query)` 按相关性检索，并就本回合（用户消息 / 子 Agent objective）预取 top-K 最相关项内联进清单。检索为本地词法排序（`name`/`keywords`/`description` 加权打分，零依赖、确定性）；阈值以下保持全量清单（无回归）。CLI `ea skill search <query>` 复用同款排序。
- **调用策略**：`searchSkills`/`useSkill` 都过 `disable-model-invocation` 与 role 工具硬门（§3.4）过滤——模型只能发现并加载它本就被许可、且其 role 能执行的技能（`useSkill` 命中外返回 `not_found` / `not_available`）。`searchSkills`/`useSkill` 作为普通工具，其调用与结果已在 trace 树可见，无需额外事件。

**与工具 / 子 Agent / 安全的关系**

- 技能可声明 `allowed-tools` 收敛其可用工具；可被子 Agent 继承（仍受 §3.4 role 硬门约束）。
- 技能可携带脚本；**执行脚本走与普通命令相同的审批 + 沙箱**（§3.3/§4.1），不因来自技能而豁免。
- 技能均由用户主动安装于 App 数据，视为可信来源；其脚本的实际危险性仍由执行期审批 + 沙箱兜底。

### 3.7 内置任务规划（Todo List）

每个 Session **自带一份结构化计划**：编排 Agent 通过内置 `updateTodos` 工具把任务目标拆成待办、并随进展更新状态。让长任务可规划、可追踪、对用户透明。

**工具定义（无副作用、无需审批）**

```ts
const updateTodos = tool({
  description:
    '维护本会话的结构化计划（待办清单）。在多步任务开始时把目标拆成待办，' +
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
    ctx.emit({ kind: 'todo-update', sessionId: ctx.sessionId, todos }); // 实时推 UI（§6.2）
    return { ok: true, counts: tally(todos) };
  },
});
```

**约定与语义**

- **全量替换**：每次调用提交完整清单（非增量），最新一次调用的 `todos` 即当前计划。
- **单焦点**：同一时刻至多一个 `in_progress`，引导 Agent 串行推进、状态清晰。
- **作用域 = Session（编排 Agent）**：计划属于整个 Session；子 Agent 默认**不**持有 `updateTodos`（它们专注被委派的单一目标）。编排 Agent 可把某个待办 `delegateToSubAgent`，二者天然衔接（计划项 → 子 Agent 任务）。
- **提示引导**：编排 Agent 的 `instructions`（§2.2）加入「多步任务先用 `updateTodos` 制定计划、再逐项执行并更新」，使「自带规划」成为默认行为而非偶发。

**持久化与恢复（文件存储，§5）**

- `updateTodos` 的调用本就作为 tool-call 记在 `session.jsonl`（会话路径上）；**当前 todo 状态 = 活动路径上最后一次 `updateTodos` 的入参**，无需独立存储。
- 为 UI 快速读取与恢复，把当前快照镜像到 `session.json.todos`。
- **与分支一致**：todo 状态**派生自活动会话路径**，故 fork / 切分支 / 压缩回退后，todo 自动回到该路径对应的状态（切换时重算快照）。压缩摘要应保留「未完成待办」要点，避免压缩后丢失计划。

**UI**：Session 主区/侧栏显示计划清单（勾选式），随 `todo-update` 实时刷新；进度（n/m 完成）显示在 Session 标题旁。

### 3.8 执行模式（Ask / Plan / Auto）

§3.3 的三态审批是**逐项人工审批**——它本身就是默认的 **Ask 模式**。在其之上叠一层**执行模式**，决定高危调用「由谁裁决」，同时**不改变**「什么是高危」「能否越界」：

| 模式 | 一句话 | 高危调用裁决者 |
| --- | --- | --- |
| **Ask**（默认） | 逐项人工审批（= §3.3） | 用户（三态 `once`/`session`/`reject`） |
| **Plan** | 先只读探索 → 产出方案 → 用户审方案 → 再执行 | 探索期禁写/禁执行；批准后转 Ask/Auto |
| **Auto** | 分类器驱动的自主执行，少打扰 | 分类器 `allow`/`deny`/`ask`（存疑降级回用户） |

**定位**：模式是「人的方向盘」，与始终生效的强制层**正交、叠加、不替代**——任何模式都越不过 role 硬门（§3.4）、硬 deny / 文件边界（§4）、OS 沙箱（§4.1）。Auto 也不例外：它只把「问用户」换成「问分类器」，越不过内核与硬策略。

#### 3.8.1 ExecutionMode 与生命周期

```ts
export const EXECUTION_MODE = { ASK: 'ask', PLAN: 'plan', AUTO: 'auto' } as const;
export type ExecutionMode = (typeof EXECUTION_MODE)[keyof typeof EXECUTION_MODE];
```

模式落在 `SessionServices` 的**可变引用** `executionMode: { value }`（与 `RunContext.needsCompaction` 同款），整个 Session（含子 Agent）共享一份。默认值解析：`启动入参(--mode / startSession.mode) → Session 配置(config.executionMode) → 全局(settings.executionMode) → 'ask'`（同 §2.5 就近覆盖）。

**实时可变（刻意例外）**：§2.5/§4.1 的 model/sandbox/MCP 是启动快照、改配置只对下次 run 生效；执行模式**例外——实时可变**，因为它是用户对话中途的操控手段（Shift+Tab 切换、看方案后批准转执行）。切换**立即对下一次裁决生效**，已在飞的那次调用保留其裁决（不回溯）；Plan→执行是显式事件（§3.8.4 `exitPlanMode` 审批），不是隐式热切换；工具**集合**仍按 run 启动装配，Plan 的「只读」强制点在 gate（运行期）而非装配期，故中途双向切换都正确。

#### 3.8.2 统一裁决流水线（enforceMode）

今天的裁决散落在 `exec.ts` 快路 + `gated()`（§3.3）两处。收敛为**单一前置闸**：每个有副作用的工具（write/exec/network，`RiskTier ≠ readonly`）在 `execute` 最前调 `enforceMode(ctx, call)`；只读工具（readFile/listDir/search/getCurrentTime/useSkill/searchSkills）**不进闸**，任何模式都直接执行。`enforceMode` 按**固定顺序**裁决，前者短路后者：

| # | 关卡 | 命中结果 | 模式相关? |
| --- | --- | --- | --- |
| 1 | **role 硬门**（§3.4，装配期已挡） | 工具根本不存在 | 否（始终） |
| 2 | **硬 deny**：`denyCommands` / 文件越界（§4） | `reject`（结构化 error 回灌） | 否（始终） |
| 3 | **Plan 只读门**：mode=plan 且 `riskTier ≠ readonly` | `blocked-plan`（提示去调 `exitPlanMode`） | **Plan** |
| 4 | **会话 grant 命中**（§3.3 放行表） | `session-auto`（Auto 下危险 grant 已剥离，§3.8.5） | 部分 |
| 5 | **策略白名单**：`allowCommands` / `allowPaths` | `auto`（仍审计） | 部分 |
| 6 | **模式裁决** | ask→发审批等用户 / auto→分类器(allow/deny/ask，ask 降级 6-ask) / plan→只读工具不会到此 | **是** |

关卡 1–2 是硬约束、连同沙箱（§4.1，包在工具子进程外层，与本闸正交）先于模式生效；**换模式 = 只换第 6 步**，1–5 原样不动。`riskTier` 来源：现有 `RiskTier`（domain.ts，已用于 MCP）+ 本地工具静态表 `TOOL_RISK`（`readFile→readonly`、`writeFile→write`、`runCommand→exec`、`httpFetch→network`），单一来源，供第 3/6 关与分类器复用。返回并入现有 `GateResult`，新增 `auto-allow` / `blocked-plan` 两态；`gated()` / `exec.ts` 快路重构为调用它。

#### 3.8.3 Ask（基线）

即 §3.3，本机制对它**零行为改动**：三态审批、会话级放行表、`agentScoped`、子 Agent 继承（§3.4）全不变。退出 Plan/Auto 默认回最保守的 Ask；无人值守 `ea run` 下 Ask 待审批默认按 reject 处理（cli §6.2）。

#### 3.8.4 Plan 模式

**探索期**允许只读 + 规划/元工具：readFile/listDir/search、useSkill/searchSkills/getCurrentTime、`updateTodos`（无副作用，落方案为待办）、`askUserQuestion`（澄清）、`exitPlanMode`（见下）、`httpFetch`/网络型 MCP（**可配置** `plan.allowNetwork`，默认 `true` 便于联网调研，保守部署可关）。写/执行类工具经 gate 第 3 关返回 `{error:'plan_mode', message:'…explore read-only; call exitPlanMode when the plan is ready'}`。**强制点在 gate（运行期）而非装配期**——因模式可中途双向切换（§3.8.1）。

**每轮显式提示（关键）**：plan 模式必须在**每个 turn** 的 system prompt 注入显式指引（`modeGuidance('plan')`，§3.8.5）「你在 plan 模式，只读探索后**必须以 `exitPlanMode` 收尾**、勿用散文陈述计划；用户拒绝并要你改时，纳入反馈后**再次** `exitPlanMode`」。否则模型只能靠**撞** `plan_mode` 工具错误才发现自己在规划——一个「改一下计划」却只在散文里改、不试写的 turn 就永远不会调 `exitPlanMode`，审批面板第二次便不再弹出（实测 bug，根因即缺此每轮提示）。

**产出方案**：新增内置 `exitPlanMode` 工具，复用 §3.7 `askUserQuestion` 同一条挂起-恢复桥（`QuestionController` 模式）。入参 `{ plan: markdown, allowedActions?: [{tool, grantKey, reason}] }`——`allowedActions` 预声明执行期高危动作（对应 prompt-based permissions）。调用 → 发 `plan-proposed`、挂起本 run、等 host `approvePlan(planId, decision, {editedPlan?, targetMode?})`，四态 **approve / edit / keep / reject**（cli-ui §4 PlanOverlay）。

**批准转执行**（原子）：① 切模式（plan→ask 默认，或 plan→auto）；② 把（可能编辑过的）plan 作为 entry 注入会话路径（§5.3），执行从它继续；③ `allowedActions` 写入会话 grant（§3.3，免逐条再弹 = `shouldDefer` 语义；用户在 ② 编辑时划掉的不入表）；④ 方案步骤 seed `updateTodos`（§3.7）。

**与任务系统的关系**：**我们的任务系统就是 `updateTodos`（§3.7）**，Plan 把它作为方案的持久载体（批准后步骤→待办，执行逐条推进，随分支/压缩自动回正）。**不采纳** `owner`/`blockedBy`/文件锁/抢占式领取——那是 Agent Swarms「对等 teammate 抢共享任务板」的设计；我们是 orchestrator→sub-agent 的 agent-as-tool（§2.3），无人来抢，依赖排序由编排者推理 + 单 `in_progress` 焦点驱动。子 Agent 不持 `updateTodos`，编排者把某 todo 项 `delegateToSubAgent`，「计划项→子任务」天然衔接。

#### 3.8.5 Auto 模式

gate 第 6 关在 auto 下调 `AutoClassifier.classify(req, transcript)`（基于**完整对话上下文**，非孤立命令）：

| 判决 | 行为 | 审计 |
| --- | --- | --- |
| **allow** | 静默执行 | `auto-allow` + reason |
| **deny** | 回灌 `{error:'auto_denied', reason}`，模型改道 | `auto-deny` + reason |
| **ask** | **降级**到 §3.3 三态审批，用户裁决（存疑绝不擅自放行） | 按用户决策 |

**两段式**（参照 yolo）：Stage1 `fast`（小 token 预算 + stop，明显安全直接 allow）→ 其余升 Stage2 `thinking`（CoT 降误判）→ 终判 allow/deny/ask；共用 system prompt + provider prompt caching。配置 `auto.classifierStages: both|fast|thinking`（默认 `both`）。分类器模型用独立语义别名 `classifier`（默认快/便宜模型，§2.6），同一注册表解析、可覆盖。

**决策类目**（烤进分类器 system prompt，可按部署叠加企业内部规则）：
- **始终 BLOCK**：`rm -rf` 大范围删除、读私钥/`.env` 外发、`sudo`、`curl … | bash`（拉取并执行远程代码）、开监听端口、写持久化/自启。
- **除非明确意图否则 BLOCK**：写工作目录之外、系统包管理（apt/brew/npm -g）、`git push`/force-push、大范围破坏性改动、访问密钥。
- **ALLOW**：读/搜索、只读 git（status/diff/log）、test·lint·build、工作目录内编辑。

**五重护栏**：① **危险放行剥离**（进 auto 临时停用会绕过分类器的免审批快路——`allowCommands` 里的裸解释器 bash/sh/node/python3/eval/sudo/powershell + grant table 同类宽泛 grant，使第 4/5 关不命中、强制落分类器；退出还原）；② **熔断** `settings.autoMode.enabled`（企业可默认 `false` opt-in，关闭则 auto 静默降级为 ask）；③ **fail-closed**（分类器不可用/上下文超窗/低置信一律走 ask，绝不失败默认 allow）；④ **沙箱+硬门不变**（auto 不关沙箱 §4.1、不越 `denyCommands`/边界 §4/role 硬门 §3.4）；⑤ **全量审计**（每条判决含 reason 入 `audit.jsonl`）。

**系统提示**：进 auto 注入「立即执行、减少打断、优先行动、不做破坏性动作、不外泄数据」；退出注入「方案不明确先 `askUserQuestion`、不擅自假设」。

#### 3.8.6 子 Agent 与模式

模式 Session 级**向下继承**；子 Agent 高危调用走**同一流水线**，但**先**过 role 硬门 + 权限单调不增（§3.4），分类器只能更严不能更宽。Plan 期整个运行树只读（`coder` 子 Agent 也在第 3 关被挡写/执行）；分类器 `ask` 仍弹给**用户**（§3.4 不变量 1），轨迹树该子 Agent 节点下展示调用链。

#### 3.8.7 安全不变量

1. 模式只改「问谁」、不改「什么是高危/能否越界」——第 1–2 关 + 沙箱（§4/§4.1）先于模式生效，任何模式都越不过。
2. **fail-closed**：Plan 默认只读、Auto 存疑/失败/熔断均降级，**无失败路径默认放行**。
3. **子 ≤ 父**：§3.4 三不变量不变，分类器只会更严。
4. auto 下危险快路被剥离，预批的裸解释器/宽泛 grant 不能绕过分类器。
5. 模式切换、方案批准、每条分类器判决全程审计、可回溯。

> 命令/事件契约见 §6.1/§6.2；落地阶段与分类器 prompt 细节见实现计划 [execution-modes.md](execution-modes.md)。




---

## 4. 安全模型

> 完整安全模型如下表。其中**「渲染进程 / 桥接面」两行属于宿主壳层**（由桌面端 Electron 实现，见 [desktop-architecture.md §1](desktop-architecture.md)），列此以呈现端到端全貌；其余各行（密钥、工具门控、文件边界、沙箱、审批、审计）是 **Agent 核心模块自身强制**的，与宿主无关。

| 面 | 措施 |
| --- | --- |
| 渲染进程（宿主壳） | `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、严格 CSP |
| 桥接面（宿主壳） | preload 只暴露白名单函数，不暴露 `ipcRenderer`/`require` |
| 密钥管理 | API key 存 OS keychain（`safeStorage` / keytar），**绝不**进 renderer，仅在 utilityProcess 读取 |
| 工具门控 | main 维护权限策略（路径白名单、命令白名单/黑名单、需审批清单），按 **Session 维度**收敛（global → Session）；运行时调用工具前请求授权 |
| 文件访问 | 工具的文件操作限制在 **Session 工作目录**内：指定了 `workingDir` → 该目录；否则 → 默认工作目录（私有 **scratch**，§1.1）。路径需规范化校验防穿越；不能访问其它 Session 的工作目录或他人项目 |
| 只读根（`readRoots`） | 额外挂载一组**只读 + 可运行、绝不可写**的目录（§4.2），与技能根同一条边界通道：子进程可读、可作 exec `cwd`，但落盘只能回工作区，且 agent 的文件工具（`readFile`/`listDir`/`writeFile`）够不着。用于暴露配置目录（如 `~/.enterprise-agent`）而不放宽可写边界 |
| Session 隔离 | 不同 Session 的文件边界、MCP 连接、密钥引用互不重叠；切换 Session 不泄露上一会话的可访问路径 |
| **OS 级沙箱** | 在应用层门控之上，再用内核级沙箱强制文件/网络边界（§4.1）；可随时开关 |
| 命令执行 | 默认需审批；审批三态（单次 / 本会话 / 拒绝，§3.3）；「本会话批准」在当前 Session 内（跨多轮/多 run）放行、不跨重启；全程记审计日志 |
| 执行模式 | Ask（逐项审批）/ Plan（只读探索→审方案→执行）/ Auto（分类器 allow/deny/ask，存疑降级回用户）；模式只改「谁裁决」，越不过硬 deny / 文件边界 / 沙箱 / role 硬门（§3.8）|
| 子 Agent | 按 role 收敛工具权限；限制嵌套深度与并发；级联中断 |
| 网络 | 出站请求可配置域名白名单；MCP server 连接需用户显式授权 |
| 审计 | 所有工具调用与审批决策写入 `audit.jsonl`（append-only），可回溯 |

### 4.1 OS 级沙箱（Sandbox）

应用层门控（JS 路径校验 + 审批）能防住「Agent 直接调文件工具」，但挡不住「`runCommand` 起的子进程在 JS 校验之外乱跑」。为此叠加一层**内核级强制沙箱**作为纵深防御。

**抽象优先：`Sandbox` 接口，后端可替换**

不直接耦合任何具体沙箱实现，而是定义统一接口；[landstrip](https://github.com/landstrip/landstrip) 作为首个实现。

```ts
interface Sandbox {
  // 由 Session 上下文生成沙箱策略（Anthropic Sandbox Runtime JSON 子集）
  buildPolicy(ctx: SessionContext): SandboxPolicy;
  // 用沙箱包裹要执行的命令/进程（如 landstrip -p policy <cmd>）
  wrapCommand(cmd: string, args: string[], policy: SandboxPolicy): SpawnSpec;
  // 解析沙箱的拒绝事件（trap），含 suggested_grant，驱动审批闭环
  parseTrap(line: string): SandboxDenial | null;
}
```

- **首个实现 `LandstripSandbox`**：macOS Seatbelt / Linux Landlock+seccomp / Windows AppContainer。**锁定版本**（如 `@landstrip/landstrip@0.15.5`），不浮动跟最新，避免 pre-1.0 频繁变更打穿核心安全路径。
- **策略来源**：`allowWrite =` Session 工作目录（指定 `workingDir` → 该目录；否则 → 私有 `scratch/`，§1.1）；`allowRead =` `allowWrite` ∪ **技能根**（§3.6）∪ **只读根 `readRoots`**（§4.2）—— 后两者可读可执行、不可写；`network` 取生效网络白名单 —— 把 §1/§4 的边界从「JS 校验」下沉到内核强制。
- **审批闭环**：沙箱拒绝时输出的 `suggested_grant`（如 `{"allowWrite":"/repo/out"}`）直接喂给 §3.3 三态审批 —— 用户点「本会话批准」即把该 grant 并入当前 Session 的沙箱策略并重试。

**沙箱开关（可随时开 / 关）**

| 维度 | 说明 |
| --- | --- |
| 作用域 | 全局默认开关（`settings.sandbox.enabled`）+ **Session 级覆盖**（`session.json.config.sandbox`）。某个 Session 可单独关沙箱（如调试需要不受限的工具环境）。|
| 默认 | **默认开启**（安全优先）。关闭是显式、知情的降级操作。|
| 生效时机 | 沙箱在进程启动时套上，无法对已启动的进程树追加/摘除。故开关**对「下一个启动的 run」生效**；正在运行的 Session 保持其启动时快照（与 §2.5「快照不被热切换打断」一致）。UI 需提示「将于下次运行生效」。|
| 关闭时行为 | 回退到**纯应用层门控**（JS 路径校验 + 三态审批仍在）；并在该 Session 顶部显著标注 **「⚠ 沙箱已关闭」** 风险提示，审计记录该状态。|
| 平台差异 | Windows 网络策略粒度粗（allow-all / deny-all，按 host/port 过滤需提权，不支持）；跨平台策略需接受此差异，UI 在 Windows 上标注网络为粗粒度。|

> 设计取舍：沙箱是**纵深防御的第二层**，不是唯一防线。即使关闭，应用层门控与审批依然生效，只是少了内核强制。开关存在的意义是：某些工具链/JIT/GUI helper 可能与沙箱限制冲突，需要临时无沙箱环境排查 —— 但这应是显式、可见、可审计的选择。

### 4.2 只读根（`readRoots`）

会话默认只有**一个可写根** `rootPath`（§2.5）。要让会话「看得到」工作区以外的目录（典型：读自身配置 `~/.enterprise-agent`），若塞进 `workingDir` 会让该目录**变成可写** —— 配置、`providers.json` 的密钥引用、其它会话的 transcript 都可能被改写。技能根（§3.6）早已用一条**只读 + 可运行、绝不可写**的通道解决了脚本执行；`readRoots` 把这条通道开放成**可配置**项。

**边界语义**（对 `readRoots` 中的每个目录）

| 能力 | 是否允许 | 机制 |
| --- | --- | --- |
| 子进程读取（`runCommand`/`runScript` 起的进程读文件） | ✅ | 沙箱 `allowRead` = `rootPath` ∪ 技能根 ∪ `readRoots`（§4.1） |
| 作为 `runCommand`/`runScript` 的 `cwd` | ✅ | `resolveCwd` 白名单含 `readRoots` |
| 写入（任何工具或子进程落盘） | ❌ | 沙箱 `allowWrite` **只有** `rootPath` |
| agent 的 `readFile`/`listDir`/`writeFile` | ❌ | 文件工具的 `guardPath` 只认 `rootPath`（§2.5 要点 2） |

> 关键：`readRoots` **不是**给 agent 的通用文件工具用的 —— 和技能一样，受益方是 **exec 启动的子进程**。agent 自己不 `readFile` 这些目录；要读靠 `cat`/脚本等命令，写则永远落回工作区。若需让通用 `readFile`/`listDir` 也能浏览某目录，那是另一套改动（文件工具拆读/写双 root 集），不在本特性范围。`full` 执行模式（§3.8）整体关闭工作区边界，此时 `readRoots` 不再起约束作用。

**配置与合并**：`readRoots` 是 `ScopedConfig` 字段，按 **global → scope 去重并集**合并 —— 会话/通道只能**追加**根目录，无法移除全局已配的根（与 §2.5「就近覆盖」一致，但语义是**并集而非覆盖**，避免低权限 scope 偷偷收窄全局策略）。路径**按原样使用**（不展开 `~`/`$ENV`，填绝对路径）；**不存在的目录在会话构建时被静默丢弃**，不下发给沙箱或 cwd 守卫。

**多租户提醒**：`readRoots` 的目录对该会话子进程**全部可读**。不要把含跨会话数据或密钥的目录（如整个 `~/.enterprise-agent/`）暴露给共享/匿名会话；需要时单建一个只放可共享内容的窄目录。Gateway 因此支持**按通道**配置（gateway §7），而非只能全局开。

详见 [docs/read-roots.md](../docs/read-roots.md)（操作手册）。CLI 命令见 cli §9.5；Gateway 通道配置见 gateway §7。




---

## 5. 数据模型与持久化

> v0.4 重构：**放弃 SQLite，改为纯文件存储**（local-first、人类可读、可备份可 diff），延续 pi agent 的「JSONL 会话 + 目录式配置」。文件存储天然容纳 **Skills**（目录 + `SKILL.md`，§3.6）与 **MCP**（JSON 配置，§3.5）。会话树/分支/压缩语义同 v0.3，仅落盘形式由表改为 append-only 日志。

### 5.0 两棵正交的树

本应用有两棵**互相独立**的树，勿混淆：

| 树 | 链接字段 | 维度 | 作用 |
| --- | --- | --- | --- |
| **会话树** | `entry.parentId` | 时间（历史/分支） | 一个 Session 内消息/轮次的树，支持 fork 与压缩 checkpoint；用户可见可导航 |
| **运行树** | `run.parentRunId` | 空间（委派） | 主 Agent → 子 Agent 的委派层级；驱动轨迹树观测（§2.3/desktop §2） |

二者通过 `entry.runId` / `entry.agentId` 关联：每条 entry 记录「由哪个 run / agent 产生」。**一个 Session = 一棵会话树**。

### 5.1 存储位置

所有数据由 app 统一管理于 **`~/.enterprise-agent/`**（App 数据根）—— Session、会话、全局配置、用户安装的 skills / MCP / providers 都在此。配置作用域两级：**全局 → Session**（缺省回退全局，与 §2.5 一致）。

> Session 指定的 `workingDir` 仅是 Agent 操作的**代码库目录**（文件访问边界，§4），Enterprise Agent 不在其中写入任何状态/配置文件 —— 不污染用户仓库。所有 Session 状态都落在 `~/.enterprise-agent/sessions/<id>/`。

### 5.2 目录布局

```
~/.enterprise-agent/                           # App 数据根（唯一存储位置）
├─ settings.json                      # 全局默认：model 默认、sandbox.enabled、权限策略、compactRatio(默认 0.9)、defaultWorkingDir、readRoots[](只读根 §4.2)...
├─ providers.json                     # model_provider[]（含 keyRef 引用，不含明文密钥，§2.6/§4）
├─ aliases.json                       # 全局 model_alias[]
├─ skills/<skill>/SKILL.md            # 全局 skills（Agent Skills 标准，§3.6）
├─ mcp/<server>.json                  # 全局 MCP server 配置（§3.5）
└─ sessions/<session-id>/             # 唯一会话实体（§1），扁平、各自独立配置
   ├─ session.json                    # { name, workingDir?, config:{model,sandbox,permission,aliases,readRoots 覆盖}, headEntryId, todos, usage }
   │                                  #   workingDir 缺省 → 用 scratch/（默认工作目录）；todos/usage 为快照镜像（§3.7/§2.7）
   ├─ session.jsonl                   # 会话树：append-only 事件日志（§5.3）
   ├─ runs.jsonl                      # 运行树：每行一个 run（含 parentRunId、rootEntryId、status）
   ├─ audit.jsonl                     # tool_call 审计（tool/input/output/approval/grantKey/agentScoped）
   ├─ aliases.json / mcp/ / skills/   # 可选：该 Session 的别名/MCP/skills 覆盖
   └─ scratch/                        # 未指定 workingDir 时的默认工作目录（私有，文件/执行边界 = 沙箱 allowWrite）
```

> 配置作用域由「全局 → Session」两级合并实现（Session 缺省回退全局）；Provider 接入（含密钥引用）是全局的。原 `workspaces/`+`works/` 与 `chats/` 两套目录**收敛为单一 `sessions/`**：指定 `workingDir` 即原 Work（围绕项目目录），缺省即原 Chat（私有 scratch）。
> **跨会话记忆**（可选，补充能力）独立于上述会话存储，由后端无关的 `MemoryPort` 契约 + turn-loop 钩子提供（`memory.*` 配置），见 [memory-architecture.md](memory-architecture.md)；未启用则零影响。

### 5.3 会话文件（append-only 会话树）

`session.jsonl` 是**追加式事件日志**：不就地改写、崩溃安全、append 近似原子。每行一条记录：

```jsonc
{"type":"entry","id":"e12","parentId":"e11","runId":"r3","agentId":"orch","kind":"assistant","content":[/* v6 parts */],"usage":{...},"ts":1718...}
{"type":"label","entryId":"e12","label":"works-baseline"}   // 命名 checkpoint（pi appendLabelChange）
{"type":"head","entryId":"e12"}                              // 活动叶子移动（fork / 切分支 / 压缩后）
{"type":"entry","id":"e13","parentId":"e12","kind":"summary","summary":{"reason":"threshold","firstKeptEntryId":"e09","tokensBefore":150000,"tokensAfter":4000},"ts":1718...}
```

- `kind`: `user` | `assistant` | `tool_result` | `summary`（压缩 checkpoint）。`content` = v6 UIMessage/ModelMessage parts。
- **加载**：顺序折叠日志 → 重建 `entry` 树 + 当前 `head` + labels。`head` 同时镜像到 `session.json.headEntryId` 便于快速定位。
- **Fork / 压缩 / 改名** 全是**追加事件**，旧状态永不丢失，天然支持分支与回溯。
- **单写者**：每 Session 一个 utilityProcess 独占该 Session 目录的写权（与 desktop §1 进程模型一致），避免并发写冲突；读侧（UI 列表）只读快照。

### 5.4 会话树与分支（参考 pi agent）

- **活动路径**：`headEntryId` 沿 `parentId` 回溯到根（或最近 summary，§5.5），即当前喂给 Agent 的上下文。
- **Fork（分支）**：选树上任一历史 entry `E`，追加 `parentId = E` 的新 entry → 旁出新分支，再追加 `head` 事件指向新叶。旧分支保留、可随时切回。用于「换个问法 / 换条路」而不丢历史。
- **Checkpoint**：追加 `label` 事件标记命名锚点（pi `appendLabelChange`）。
- **Clone**：把某叶→根的路径抽取为新 Session 目录（pi `createBranchedSession` 等价物）。
- **导航 API**：`getPath(head)` 取活动上下文；`getTree(sessionId)` 取全树供 UI 树形导航；`getChildren(id)` 取分叉。

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
    appendSummaryEntry(ctx.sessionId, summaryEntry, { reason: 'threshold', tokensBefore });
    return { messages: [messages[0], summaryMsg, ...recentTail(messages)] };  // 系统 + 摘要 + 近段
  }
  ```
  同一次压缩**既改写在途 messages、又追加 `summary` entry**（§5.3），二者保持一致。

- **`overflow`（兜底，事后）—— 捕获 provider 超限错误后重试**：threshold 滞后一步，若那一步内又注入超大 tool 结果就可能真的爆窗。包裹模型调用，捕获 provider 的「上下文超长」错误（按各 provider 错误码识别；注意区别于 `finishReason==='length'` 那是输出截断、另行续写），触发**紧急压缩**（立即置标志并在重试前的 `prepareStep` 生效，或直接压一次）后重试该步；若单条消息本身超限则降级（截断该 tool 结果 / 上报错误）。

> 注意：压缩与子 Agent 解耦 —— 主 Agent 会话路径压缩，不影响已结束的子 Agent 转写（它们是工具调用的执行细节）。threshold 判定**只信 provider 回报的真实 `inputTokens`**，无本地估算；滞后一步的窗口由 `overflow` 兜住。

### 5.6 可恢复性

- **消息历史**：v6 `ModelMessage`/UIMessage parts 持久化于 `entry.content`。
- **恢复 Session**：折叠 `session.jsonl` → 取 `head` 活动路径（遵循最近 summary）→ 回放给主 Agent，在已有上下文继续。
- **运行树还原**：`runs.jsonl` 的 `parentRunId` + `entry.agentId` 重建主/子 Agent 关系，驱动轨迹树。
- **子 Agent 转写**：子 Agent 的 entry 同写在该 Session 的 `session.jsonl`（`agentId` 区分，`parentId` 挂在其 `delegateToSubAgent` 工具 entry 之下），仅用于轨迹树回放；**分支/压缩只作用于主 Agent 的会话路径**，子 Agent 转写视为该工具调用的执行细节，不独立可分支。

### 5.7 为什么文件而非 SQLite

| 取舍 | 说明 |
| --- | --- |
| 选文件的理由 | local-first 可读可 diff、可备份；**天然容纳 skills（目录）/ MCP（JSON）**；与 pi 生态互通；零迁移成本 |
| 代价 | 无事务 / 索引 / 复杂查询 |
| 缓解 | 会话/运行/审计用 **append-only JSONL**（崩溃安全、写入即追加）；小配置用 JSON；**加载时建内存索引**；每 Session 单写者消除并发写；跨 Session 搜索靠启动扫描 + 内存索引（本地个人量级，可接受）|

### 5.8 迁移

文件存储为首版落地形态，无历史库迁移负担。若已有 v0.1–v0.3 的 SQLite 原型：按表导出为对应文件 —— `work`/`chat` 各→ 一个 `sessions/<id>/session.json`（`work` 把所属 `workspace.root_path` 写入 `workingDir`、`workspace.config` 并入 `config`；`chat` 留空 `workingDir`），`entry` → `session.jsonl`（补 `head` 事件指向末条），`run` → `runs.jsonl`，`tool_call` → `audit.jsonl`，`setting/provider/alias/mcp_server` → 对应 JSON。



---

## 6. 模块接口契约（命令 + 事件 + 中断）

本节定义 Agent 核心模块的**对外接口**：宿主（桌面端 / CLI）通过它驱动模块、接收流式输出。接口是**传输无关**的 —— 桌面端用 Electron IPC 承载（`contextBridge` invoke + `MessagePort`，见 [desktop-architecture.md §1.2](desktop-architecture.md)），CLI 可用 stdio/JSON-RPC 承载，契约本身不变。

### 6.1 命令（宿主 → 模块，请求式）

- Session 管理：`listSessions`、`createSession({ name, workingDir?, config? })`、`updateSessionConfig`、`deleteSession`、`switchSession`（设当前活动 Session）。`workingDir` 缺省 → 默认工作目录（私有 scratch，§1.1）。
- 会话驱动：`startSession`、`sendMessage`、`approveTool(toolCallId, decision)`（三态 `once` / `session` / `reject`，§3.3）、`abortRun`。
- 执行模式（§3.8）：`setExecutionMode(sessionId, mode)`（实时切 `ask`/`plan`/`auto`）、`getExecutionMode(sessionId)`（读当前 live 模式，未开则配置默认）、`approvePlan(planId, decision, { editedPlan?, targetMode? })`（Plan 方案四态裁决 approve/edit/keep/reject）；`startSession`/`sendMessage` 可选携带初始 `mode`。
- 会话树操作：`forkFrom(entryId)`、`labelEntry(entryId, label)`、`compact(reason?)`、`getSessionTree(sessionId)`、`cloneToSession(leafId)`。
- 配置/模型：`listProviderModels(providerId)` 动态拉取某 provider 的可用模型 id（§2.6 模型发现，含静态兜底与 24h 缓存）。技能（`SkillRegistry`）与 MCP（`ConfigStore.listMcpServers`）按 **Session 的生效作用域**枚举（global + 该 Session 的覆盖），由宿主复用导出工具直接读。
- 所有会话类操作以统一的 `sessionId` 寻址（不再区分 Work / Chat）。

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
  | { kind: 'todo-update'; sessionId: string; todos: Todo[] }
  | { kind: 'sub-agent-start'; runId: string; parentAgentId: string; agentId: string; role: string }
  | { kind: 'sub-agent-finish'; runId: string; agentId: string; summary: string }
  | { kind: 'compaction-start'; runId: string; reason: 'manual' | 'threshold' | 'overflow' }
  | { kind: 'compaction-end'; runId: string; summaryEntryId: string; firstKeptEntryId: string; tokensBefore: number; tokensAfter: number }
  | { kind: 'mode-changed'; sessionId: string; mode: ExecutionMode }                      // §3.8
  | { kind: 'plan-proposed'; runId: string; agentId: string; parentAgentId?: string;       // §3.8.4
      planId: string; plan: string;
      allowedActions?: { tool: string; grantKey: string; reason: string }[] }
  | { kind: 'auto-classified'; runId: string; agentId: string; toolCallId: string;          // §3.8.5（观测）
      verdict: 'allow' | 'deny'; reason: string }
  | { kind: 'run-finish'; runId: string; finishReason: string }
  | { kind: 'schedule-fired'; name: string; sessionId: string; runId: string }                 // §7
  | { kind: 'schedule-finished'; name: string; sessionId: string; runId: string;                // §7
      status: 'done' | 'error'; summary: string; deliverTo?: string }
  | { kind: 'error'; runId: string; message: string };
```

UI 依据 `agentId` / `parentAgentId` 把事件归并到轨迹树的对应节点，子 Agent 显示为可折叠的嵌套块。`mode-changed` 驱动模式指示器、`plan-proposed` 唤起 PlanOverlay（与审批同「待决时禁用输入」不变量，cli-ui §4）。

### 6.3 中断

`abortRun(runId)` 命令触发模块内对应 `AbortController.abort()`，AI SDK v6 的 `stream`/`generate` 接收 `abortSignal` 后停止，级联到所有子 Agent。（桌面端经 main 转发到 utilityProcess，见 [desktop-architecture.md §1.2](desktop-architecture.md)。）

## 7. 定时编排（Schedules，已实现）

按 cron / `every` 在**无人值守**下触发一次 Session（日报 / 周报 / 巡检）。设计与改动清单见 [`declarative-agents-and-schedules.md`](declarative-agents-and-schedules.md) B 节；实现见 [schedules/](../packages/agent/src/schedules/)。要点：

- **定义即目录**：`~/.enterprise-agent/schedules/<name>/SCHEDULE.md`（frontmatter：`cron`/`every` + `mode`/`agent`/`session`/`deliver-to`/`grants`/`enabled`；正文 = 触发时发给 Session 的 goal）。`ScheduleRegistry` 发现解析（mode 缺省/非法 → `auto`）。
- **durable 不靠外部引擎**：运行状态（`lastRunAt`/`lastRunId`/`lastStatus`/`nextRunAt`）落 append-only `schedules-state.jsonl`（`ScheduleStore`），重启后由 cron 重算下次触发，契合 §5.7「文件而非 SQLite」。
- **cron**：自带零依赖 5 段解析（`*`、`*/n`、`a-b`、`a,b`；dom/dow 经典 OR 语义）+ `every: <n><s|m|h|d>`；按分钟向后扫描求 next（[schedules/cron.ts](../packages/agent/src/schedules/cron.ts)）。本地时区，`timezone` 暂为 best-effort。
- **调度器**：`Scheduler.tick()` 评估每个启用的 schedule——首次见到只「武装」`nextRunAt` 不触发；到期则 fire 并跳到下一未来槽；重入保护。**错过窗口**（宕机超过预定时刻 > 一个 tick + 余量才被判为「missed」，与稍迟的正常 tick 区分）按 `on-missed` 处理：`run-once`（默认）补跑一次再重排（不风暴），`skip` 不补、只重排到未来槽——给「过期即失效」的任务（如早报）用。宿主驱动墙钟 timer（gateway 常驻 → boot 时 `startScheduler()`；CLI 短生命周期不承诺常驻）。
- **无人值守安全（§3.3/§3.8 的延伸）**：触发时强制 `mode=auto` 且置 `unattended` 标志——任何会走到交互审批门的调用一律 **deny（ask→deny，fail-closed）**，绝不挂起等一个不会来的审批。例外：schedule 的 `grants`（细粒度 `exec:<cmd>` / `write:<dir>` / `http:<host>`）在 fire 前注入会话授权表，**仅这些 scope** 被放行，其余高危仍 deny。默认无 grants ⇒ 只读/汇报型，零额外授权即可跑。
- **投递交回宿主（Channel 抽象）**：core 跑完发 `schedule-finished{ summary, deliverTo }`（summary = 末条 assistant 文本）；gateway dispatcher 按 `deliver-to: <channel>:<conversationId>` 路由到对应 channel adapter（套用其 Markdown→text transform）。core 不知道怎么发微信/TG。
- **接口**：`AgentHost` 增 `startScheduler`/`stopScheduler`/`runScheduleNow`（§6.1）；事件 `schedule-fired`/`schedule-finished`（§6.2）。CLI/gateway 各自像 skills 一样在自己宿主里发现管理（gateway Web「定时」面板：增删改 + 启停 + 立即运行）。



---

## 附录 A：版本与 API 注意事项

- 本设计基于 `ai@6.0.0-beta`，核心类为 **`ToolLoopAgent`**（v6 引入），方法为 `.generate()` / `.stream()`。
- v6 工具入参字段为 `inputSchema`（非 v4 的 `parameters`）；停止条件用 `stopWhen` + `stepCountIs(n)` 或自定义 `async ({ steps }) => boolean`。
- 结构化输出用 `Output.object({ schema })`，会额外占用一个 step。
- 模型层 API 已对照 `ai@6.0.0-beta.128` 核实（2026-06-18）：`createProviderRegistry(providers, { separator })`、`customProvider({ languageModels, fallbackProvider })`、`wrapLanguageModel` + `defaultSettingsMiddleware({ settings })`，`registry.languageModel('providerId:modelId')`。Provider 包：`@ai-sdk/anthropic`(`createAnthropic`)、`@ai-sdk/openai`(`createOpenAI`)、`@ai-sdk/openai-compatible`(`createOpenAICompatible`)。
- Token 统计与压缩 API 已对照 `ai@6.0.0-beta.128` 核实（2026-06-18）：`onStepFinish({ usage, totalUsage, finishReason })`，`LanguageModelUsage = { inputTokens, outputTokens, totalTokens, reasoningTokens?, cachedInputTokens? }`；`ToolLoopAgent` 的 **`prepareStep({ stepNumber, steps, messages }) => { messages? }`** 可在每步前改写消息（官方示例即「压缩历史 / 摘要超长 tool 结果」），用于 §5.5 主动压缩。
- 升级 beta 版本前请用 Context7 复核 `ToolLoopAgent` / `streamText` / `Output` / `createProviderRegistry` / `prepareStep` / `onStepFinish` 的签名是否有变化。
