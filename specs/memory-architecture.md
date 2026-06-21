# Enterprise Agent — Memory 记忆能力（语义契约与钩子）

> 本文档定义一个**后端无关的跨会话记忆能力**,作为 Agent 核心（`@enterprise-agent/agent`）的**补充**。它只规定两件事:① 一个薄语义契约 `MemoryPort`（§2）;② 三个挂在 session turn loop（agent §2.6）上的生命周期钩子（§3）。**具体记忆引擎、整理调度、运维形态均不在本文档范围**——它们是 port 后面的实现细节,留待后续阶段(§6 仅含奠基的 Phase 0/1)。
> **核心取向:记忆 = core 的能力,不是某个 host 或某个库的特性。** 检索-注入与捕获只能发生在 turn loop,那在 core;所有 host（CLI、Gateway、桌面端）共享同一机制,host 只负责把「这是谁」（作用域 key,§4）喂下来。契约定在三个语义原语的最小公约数上,**不为任何单一库定制**。
> **与上下文压缩的区别**:压缩（agent §2.6 / compactor）解决**会话内**上下文窗口溢出,临时、反应式;记忆解决**跨会话**知识沉淀,持久。二者正交,互不替代。
> 编号:**本文件章节独立顺序编号**（§1–§6）。本文件内引用用裸 `§x`;跨文件引用用 `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `gateway §x`（[gateway-architecture.md](gateway-architecture.md)）限定。

---

## 1. 定位:core 的一个可选补充能力

记忆是 core 内一个**可装可卸**的能力。core 持有一个可选的 `MemoryPort`;未配置时三个钩子全部 no-op,行为与今天完全一致(**零记忆 = 零行为变化**)。

```
 host 提供作用域                ┌──────────── core (@enterprise-agent/agent) ───────────┐
 (gateway §4 / cli)            │  Session turn loop (agent §2.6 drive())                │
   conversationId              │   ┌─turn 开始──────────────────────────────────────┐  │
   userId / scope ────────────────▶│ ① retrieve-inject  MemoryPort.retrieve(scope,q) │  │
                               │   │      命中片段注入 system/context                 │  │
                               │   ├─orchestrator 多步循环（工具/MCP/审批/压缩）──────┤  │
                               │   │ ② capture          MemoryPort.capture(scope,turn)│  │
                               │   └─turn 结束────────────────────────────────────────┘  │
                               │   ③ maintain（仅 no-op 接入点,触发机制属后续阶段）       │
                               │            │                                            │
                               │            ▼  MemoryPort（§2,后端无关,实现可换）          │
                               └─────────────────────────────────────────────────────────┘
```

| 维度 | 设计 |
| --- | --- |
| 归属 core | 检索-注入只能发生在 session turn loop（agent §2.6）,那在 core;放 host 会让其它 host 用不到且重复实现。 |
| host 无感 | host 只通过 §4 把作用域 key 随 `startSession` / `sendMessage` 带入,不感知后端实现。 |
| 后端无关 | core 只依赖 `MemoryPort`（§2）。换实现 = 换一个 port 实现 + 改配置,**core 与 host 零改动**。 |
| 可选即默认关 | 未配置 `MemoryPort` 时三钩子 no-op;记忆是增量补充,不是必选依赖。 |
| 与压缩正交 | 压缩改写**当前会话**的 message 窗口;记忆读写**跨会话**的外部存储。两条路径不交叉。 |

---

## 2. 契约:`MemoryPort`（语义）

### 2.1 核心三方法

切在最小公约数上——这是契约保持后端无关的关键。

```ts
// @enterprise-agent/agent-contract — 仅类型签名,无实现
interface MemoryPort {
  /** turn 结束后喂入原始对话/事实;由后端决定如何抽取(同步抽取 / 仅收料待后续构建)。 */
  capture(scope: MemoryScope, payload: CapturePayload): Promise<void>;

  /** turn 开始前按作用域检索;返回「纯文本片段 + 相关度分」。 */
  retrieve(scope: MemoryScope, query: string, opts?: RetrieveOpts): Promise<MemoryHit[]>;

  /** 后台维护/整理的统一入口;Phase 1 仅留 no-op 接入点,触发机制不在本文档范围。 */
  maintain(scope?: MemoryScope): Promise<void>;
}

interface MemoryScope { namespace: string; tenant?: string; tags?: string[]; }     // §4
interface CapturePayload { messages: TurnMessage[]; hints?: Record<string, unknown>; }
interface RetrieveOpts { topK?: number; hints?: Record<string, unknown>; }          // hints = 不透明袋
interface MemoryHit { text: string; score?: number; metadata?: Record<string, unknown>; }
```

### 2.2 三条语义约束(保持后端无关)

契约的通用性来自语义,而非方法名。落地时必须守住:

1. **返回值只承诺文本**:`retrieve` 返回 `MemoryHit`(纯文本 + 分 + 不透明 metadata),**绝不**把任何具体后端的原生对象作为契约返回类型——否则 port 退化为该后端的适配器。
2. **`capture` 不假定同步出结果**:它只负责「收料」;是否立即可检索由后端决定,core 不依赖其同步性。
3. **`hints` 不透明**:`capture` / `retrieve` 各带可选 `hints`,core 与 host **不解释**其内容,只透传;后端能用就用,不能用就忽略。

> 后端特有的能力(如按 id 增删改、结构化/图检索、显式整理)若需要,一律以**可选能力方法**(`xxx?`)暴露,不进必选三方法、不进热路径。具体能力清单随后端实现引入,不在本文档定义。

---

## 3. 生命周期钩子(接入点)

钩子描述**时机**而非后端,因此天生通用、换实现不改。三处接入 session turn loop（agent §2.6 `drive()`）;Phase 1 全部默认 no-op:

| 钩子 | 接入点 | 行为 | 失败策略 |
| --- | --- | --- | --- |
| ① retrieve-inject | turn 开始、构造 orchestrator system/context 之前 | `retrieve(scope, userText)` → 命中片段作为「相关记忆」块注入上下文(与 skills 目录注入同位置) | **fail-open**:检索失败/超时 → 跳过注入,本轮照常进行,记 warn |
| ② capture | turn 完成、final output 落盘后(与 usage 记账同点,agent §2.7) | `capture(scope, {messages})` 喂入本轮 | 异步、不阻塞 turn 返回;失败记 warn |
| ③ maintain | 仅定义 no-op 接入点 | 触发机制(调度/手动命令/锁)**不在本文档范围**,留待后续阶段 | — |

> Phase 1 的目标是把这三个点**接进 turn loop 并默认 no-op**:未配置 `MemoryPort` 时行为与今天逐字节一致;配置后即可挂任意后端实现而无需再动 core。

---

## 4. 作用域（scope key）—— host 的唯一职责（Phase 0 决策）

记忆按 `MemoryScope.namespace` 隔离。**「这是谁」只有 host 知道**,故 host 唯一职责是把作用域 key 随会话带入,机制全在 core。

| host | namespace 来源 | tenant(多租隔离) |
| --- | --- | --- |
| Gateway | `channel:conversationId`(或 per-user 模式下的 userId,复用 gateway §4.2) | 平台 / 群 |
| CLI | 项目工作目录 slug,或全局 `default` | OS 用户 |

- **作用域语义(global / per-project / per-user)是先决产品决策**,直接决定「跨会话学习跨的是谁」,须在 Phase 1 落地前敲定。
- 默认保守:**per-user(或 per-conversation)隔离**,避免不同用户/会话事实串味;与 gateway 已落地的 per-user 文件隔离一致。

---

## 5. 配置（最小）

并入 `settings.json`（agent §5 配置层,global → session 两级合并）。Phase 1 仅需:

```jsonc
"memory": {
  "enabled": false,          // 总开关;关 → 三钩子全 no-op(默认)
  "scope": "per-user",       // "global" | "per-project" | "per-user"（§4）
  "retrieve": { "topK": 6, "timeoutMs": 1500 }
  // backend 及其专属配置随后端实现阶段引入,不在本文档范围
}
```

- 环境变量覆盖:`ENTERPRISE_AGENT_DISABLE_MEMORY=1` 全局关闭。

---

## 6. 落地阶段（仅奠基)

> 本文档只覆盖让记忆能力「存在且后端无关」的两步;具体后端、整理调度等属后续工作,不在此定义。

| 阶段 | 内容 | 价值 / 依赖 |
| --- | --- | --- |
| **Phase 0** | 决策作用域语义（global / per-project / per-user,§4） | 决定一切,先定 |
| **Phase 1** | 在 contract 定 `MemoryPort`（§2）+ 在 session turn loop 接 ①②③ 钩子(§3,默认 no-op) | 后端无关骨架;此后挂任意后端实现皆 **core 与 host 零改动** |
