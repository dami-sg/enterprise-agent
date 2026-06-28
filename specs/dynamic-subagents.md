# Enterprise Agent — 自生成式子 Agent（Dynamic Sub-Agents）设计稿

> 本文定义子 Agent 编排从 **声明式（v0.6，目录式 `AGENT.md`）** 演进到 **自生成式（v0.7）** 的设计：
> 取消预定义子 Agent，改由 Orchestrator 在委派那一刻**按需合成**一个临时子 Agent（能力 + 任务 prompt），
> 在管理员包络内收敛能力、沿用同一 mode、不重复审批、全量记录、执行后评估、并在**会话内**即时纠错。
> 复用 [agent-architecture.md](agent-architecture.md) 的运行时（§2）、工具系统（§3）、安全不变量（§3.4）、沙箱（§4）。
> 编号：本文 §D1–§D7；跨文件引用用 `agent §x`。实现锚点：
> [sub-agent.ts](../packages/agent/src/runtime/sub-agent.ts)、[tools/registry.ts](../packages/agent/src/tools/registry.ts)、
> [agents/registry.ts](../packages/agent/src/agents/registry.ts)、[runtime/prompts.ts](../packages/agent/src/runtime/prompts.ts)。

---

## D0. 设计目标与不变量（先划红线）

**目标**：让 Orchestrator 按子任务**实际需要的最小能力组合**自造 worker，而非从固定枚举里向上取整到某个角色；worker 用完即弃。

**安全重心迁移**：删掉「role 枚举硬门」这层**作者侧**约束后，能力天花板从「预先评审的枚举」迁移到三样**强制层**——它们一条都不能松：

1. **管理员包络（§D2）**：动态子 Agent 能请求的能力上限。删枚举后这是**唯一**的能力天花板，不可省。
2. **mode + 审批门（§D3）**：每个高危**动作**仍按当前 mode 过门（auto→分类器、ask→用户、plan→只读）。「不额外审批」= 不重复弹框 + 沿用 mode，**不是**跳过门。
3. **沙箱 + 文件边界 + 硬 deny（agent §4 / §3.4）**：任何 mode、任何子 Agent 都越不过，恒定。

**保留 agent §3.4 三不变量**：① 审批主体永远是用户；② 权限单调不增 `子 ≤ 父`；③ 两道门顺序固定（硬门→软门）。本设计只是把「硬门」从「按 role 名查表」换成「按合成 spec 收敛构造」，门本身不变。

---

## D1. 委派接口：从 role 名到 inline spec

取消 `delegateToSubAgent` 的 `role: z.enum(...)` 入参与 registry 名字目录（[sub-agent.ts:24,31](../packages/agent/src/runtime/sub-agent.ts)），改为接受一个 **AgentSpec**：

```ts
delegateToSubAgent({
  spec: {
    name: string,            // 仅用于 trace/日志标识（如 "pg-schema-reader"）；不进任何 registry
    capabilities: string[],  // ("read"|"write"|"exec"|"http") 的子集；未知 token 丢弃（fail-closed）
    mcp: false | string[],   // 显式 MCP server 白名单；禁止 `true`（不能一把拿全部）
    prompt: string,          // 任务专属 system prompt（Orchestrator 合成）
    model?: string,          // alias 或 provider:model；缺省用动态默认
    timeoutMs?: number,      // 缺省用 envelope 默认
  },
  objective: string,
  context?: string,
  inheritScopedGrants?: boolean,  // 语义不变（agent §3.4 B）：仅 agentScoped 敏感授权的 opt-in 下放
})
```

**不保留预定义子 Agent**：删除 `SUB_AGENT_ROLE_NAMES` 枚举与 5 个 `builtin` 种子作为**委派目标**（[agents/registry.ts:121](../packages/agent/src/agents/registry.ts)）。原 5 role 不再是可选项，而是改写成 Orchestrator prompt 里的 **few-shot 示例**（§D6）。

> 取舍：删 preset 失去了「零配置回归基线 / 审批可模式化 / 稳定测试面」。这三样改由**全量日志（§D4）+ 执行后评估（§D5）+ few-shot 示例（§D6）**补回。前提是日志必须是一等的结构化事件，否则审计将无锚点。

---

## D2. 能力收敛与管理员包络（唯一能力天花板）

合成 spec **不直接生效**，先过两层 ∩ 收敛，fail-closed：

```
granted.capabilities = requested.capabilities ∩ parent.capabilities ∩ envelope.capabilities
granted.mcp          = requested.mcp          ∩ parent.visibleMcp    ∩ envelope.mcp
```

- 未知 / 越界 token **静默丢弃**（沿用 [agents/registry.ts:62 parsePolicy](../packages/agent/src/agents/registry.ts) 的 fail-closed 风格），任何畸形 spec 只会更窄、永不提权。
- 父（Orchestrator）是满权的，所以 `parent.capabilities` 几乎不构成约束——**真正的天花板是 envelope**。

**新增配置 `dynamicSubAgents`**（global → Session 两级合并，[config/store.ts](../packages/agent/src/config/store.ts)）：

```ts
dynamicSubAgents: {
  enabled: boolean,            // 熔断开关；false → 委派工具不挂载（或降级，企业可默认 opt-in）
  maxCapabilities: string[],   // 动态子 Agent 能拿到的能力上限，如 ["read","http"]
                               //   → write/exec 不在内则任何动态子 Agent 永远拿不到，必须人工配 preset 才行
  mcpAllow: false | string[],  // 动态子 Agent 可见的 MCP server 上限
  defaultModel?: string,       // 缺省模型 alias
  defaultTimeoutMs?: number,   // 缺省墙钟超时（沿用 agent §2.3 超时机制）
  // 注意：不提供 maxDepth 旋钮 —— 子 Agent 嵌套是无条件禁止的硬约束（见 §D3），不可配置。
}
```

收敛后构造一个**临时 `AgentDef`**（`builtin:false`、`name = spec.name`），**绝不写入 registry**，直接喂给现有 [`buildToolsForAgent(def, ctx)`](../packages/agent/src/tools/registry.ts) + MCP 过滤（`mcpAllowForPolicy`）——下游硬门逻辑零改动。函数退出，def 蒸发。这天然满足「执行完即不存在」。

---

## D3. mode 继承与审批（不额外审批的精确语义）

**沿用 agent §3.4，无新行为**，要点固化如下：

- **mode 继承**：子 Agent 沿用 Session 级 mode（auto/ask/plan，agent §3.8 / [:646](agent-architecture.md)）。Orchestrator 在哪个 mode，动态子 Agent 就在哪个 mode。
- **不重复弹框**：放行表 Session 级共享（agent §3.4），同一 grant key 已批准的调用自动放行；`agentScoped` 敏感授权默认不继承，`inheritScopedGrants:true` 时按 opt-in 下放（语义不变）。
- **门仍在动作上**：每个高危**动作**按当前 mode 过门——`auto` 过分类器（含 agent §3.8 五重护栏：危险快路剥离 / 熔断 / fail-closed / 沙箱硬门不变 / 全量审计）、`ask` 弹用户、`plan` 全树只读。**「不额外审批」≠「跳过门」**。
- **恒定层**：硬 deny（破坏性 / 不可逆 / 数据外泄）+ 沙箱（agent §4.1）+ 文件边界（agent §4）任何 mode 越不过。

**嵌套（硬约束，不可配置）**：子 Agent **永远不可再委派 / 合成孙 Agent**——`delegateToSubAgent` 工具**仅 Orchestrator 持有，从不进入任何子 Agent 的工具集**（在 [tools/registry.ts buildToolsForAgent](../packages/agent/src/tools/registry.ts) 里对子 Agent 一律不挂载 delegate 工具，等价于深度上限恒为 0）。这是装配期硬门，不提供 `maxDepth` 旋钮、管理员也无法放开。理由：自生成已扩大 prompt-injection 面，递归自生成会让 blast radius 不可控。需要多层时由 Orchestrator **平铺**多个一层 worker，委派树深度恒为 1。

> 风险声明：删枚举 + LLM 自定能力 + auto mode，三者叠加时**安全完全落在「分类器 + 硬 deny + 沙箱 + envelope」上**。这是有意识的集中化：envelope 把能力面收窄、分类器把动作面收窄、沙箱兜底不可逆。三者必须同时硬。

---

## D4. 全量配置日志（删 preset 后的唯一审计锚点）

每次合成子 Agent，在 spawn 处发一条**结构化**事件（扩展现 `sub-agent-start`，[sub-agent.ts:105](../packages/agent/src/runtime/sub-agent.ts)），并写 `audit.jsonl`：

```ts
{
  kind: 'sub-agent-spawn',
  runId, agentId, parentAgentId,
  name: spec.name,
  objective,
  requested:  { capabilities, mcp },   // LLM 请求的原始 spec
  granted:    { capabilities, mcp },   // 收敛后实际生效 —— 两者都记，才能看出被砍掉了什么
  prompt: spec.prompt,                 // 或 hash + 落盘（大 prompt 避免污染事件流）
  model, timeoutMs,
  envelopeVersion,                     // 应用了哪一版包络，便于回放
}
```

**`requested` 与 `granted` 必须都记**：差集就是「模型想要但被包络/父挡掉的能力」，这是审计与调参的核心信号。无此事件则删 preset 后系统失去可复现性——故此条是**删 preset 的前置条件，非可选项**。

---

## D5. 执行后评估（LLM-judge，带防漂移维度）

子 Agent `stream` 结束后（[sub-agent.ts:197](../packages/agent/src/runtime/sub-agent.ts)），跑一次**轻量**评估，发 `sub-agent-eval` 事件并把结构化结果回灌给 Orchestrator（作为 tool result 的一部分）。Rubric 三维：

| 维度 | 含义 | 作用 |
| --- | --- | --- |
| `objectiveMet` | 是否达成 objective（0–1 或 bool + 理由） | 质量 |
| `scopeAdherence` | **是否用了不必要的能力 / 触碰 scope 外的东西** | **反漂移关键维**：让"给多了"也成为可见的负信号 |
| `efficiency` | steps / tokens / 是否超时 | 成本 |

**成本控制**（LLM-judge 有成本、延迟、噪声）：
- 评估可配置开关；默认建议**仅在失败 / `scopeAdherence` 疑似越界 / 超时时触发完整评估**，成功且省的路径跳过或只做廉价启发式。
- 评估用廉价模型（如 haiku 级别）即可。

---

## D6. Few-shot 示例（替代 preset 的"基线"功能）

把原 5 role 改写成 **3–4 个示例 + 显式决策规则**，注入 Orchestrator system prompt（替换 [prompts.ts:17 ORCHESTRATOR_GUIDANCE](../packages/agent/src/runtime/prompts.js) 里的 role 列表）：

```
你可以按子任务需要自造子 Agent。给它「完成任务所需的最小能力组合」，不要套用示例、也不要向上取整。
能力 token：read / write / exec / http；MCP 必须显式列出 server 白名单。

示例（仅示意组合方式，按真实需要裁剪）：
- 只读调研：capabilities=[read,http], mcp=[<搜索server>]，prompt="只读调查并总结，不可写/执行"
- 限定改码：capabilities=[read,write,exec]，prompt="实现这处改动，编辑最小化"
- 数据分析：capabilities=[read,exec]，prompt="读数据跑只读分析，给结论"
- 仅取某 MCP：capabilities=[read], mcp=[<jira>]，prompt="只读 jira，别的都不要"
```

两个坑及对策：
- **示例被当模板照抄** → 配显式"按最小需要裁剪、勿套用示例"的规则。
- **示例与真实 schema 漂移** → 能力 token 列表从**单一来源**（现 `RoleToolPolicy` 的键 / `CAP_TOKENS`，[agents/registry.ts:44](../packages/agent/src/agents/registry.ts)）派生注入，不手写第二份。

---

## D7. 会话内即时纠错（反馈闭环，仅 in-context）

**只做会话内、只进上下文，零持久化、不跨会话、不改 prompt 模板。**

- §D5 的评估结果作为 context 反馈给 Orchestrator，**仅本会话有效，随会话结束消失**。
- 典型纠错：
  - 上次只读 worker 因缺 `http` 失败 → 本次重试时把 `http` 加上；
  - 上次给了 `exec` 但 `scopeAdherence` 显示从未用到 → 下次别给（`scopeAdherence` 让"给多了"在同会话内也是负反馈）。
- 本质是 in-context 纠错，等价于 Orchestrator 多步推理的一部分。

**明确不做（本期）**：跨会话持久学习、自动修改创建逻辑 / prompt。理由——自修改反馈闭环的梯度天然指向"给更多能力"（缺能力的失败可见，超额授予的代价隐形），无显式 over-provisioning 惩罚必然单调侵蚀最小授权；且持久化会牺牲可复现性、需人在环。会话内即时纠错因「无持久累积」天然规避此问题。若未来要做跨会话，须满足：评估只产出**给人看的建议**（不自动 apply）+ 显式 over-provisioning 惩罚项。

---

## D8. 改动影响清单（实现指引，非代码）

| 位置 | 改动 |
| --- | --- |
| [sub-agent.ts](../packages/agent/src/runtime/sub-agent.ts) | 入参 `role:enum` → `spec`；`role` 查表 → spec 收敛构造临时 def；`sub-${role}-` id → `sub-${spec.name}-`；`modelFor(role)`/`subAgentTimeoutMs(role)` → spec 值 ?? envelope 默认；新增 `sub-agent-spawn` 事件 + spawn 后评估调用 |
| [agents/registry.ts](../packages/agent/src/agents/registry.ts) | 删 5 builtin 种子作为委派目标 & `SUB_AGENT_ROLE_NAMES` 枚举；保留 `AgentDef`/`RoleToolPolicy` 作为内部数据形（临时 def 复用）|
| [tools/registry.ts](../packages/agent/src/tools/registry.ts) | `buildToolsForAgent` 基本不改（已是 def 驱动）；MCP 过滤复用 `mcpAllowForPolicy`。**删除/废弃 delegate 分支**（[:86-93](../packages/agent/src/tools/registry.ts)）：spawn 子 Agent 时**永不传 `delegateFactory`**，`delegateToSubAgent` 对子 Agent 一律不挂载 → 嵌套硬门（§D3）|
| [config/store.ts](../packages/agent/src/config/store.ts) | 新增 `dynamicSubAgents` 包络配置 + 默认（建议 `enabled` 企业默认 opt-in、`maxCapabilities` 保守）|
| [runtime/prompts.ts](../packages/agent/src/runtime/prompts.ts) | role 列表 → few-shot 示例 + 决策规则；能力 token 从单一来源派生 |
| 契约 | 新增 `sub-agent-spawn` / `sub-agent-eval` 事件类型（[agent-contract/events.ts](../packages/agent-contract/src/events.ts)）+ `dynamicSubAgents` 配置类型（[config/store.ts](../packages/agent/src/config/store.ts)）。**具体 TS 见 §D10** |

---

## D9. 验收红线（这几条不满足则不上线）

1. **收敛强制**：构造 wronged-spec（请求 envelope 外能力）→ granted 必须为 ∩ 结果，越界 token 不出现在子 Agent 工具集。
2. **包络熔断**：`dynamicSubAgents.enabled=false` → 委派不可用 / 降级，无静默放行。
3. **门不被绕过**：auto 下子 Agent 的破坏性动作仍命中分类器 / 硬 deny；plan 下子 Agent 全只读。
4. **审计完整**：每次合成有 `sub-agent-spawn`（含 requested vs granted）入 audit.jsonl，可回放"谁、凭什么能力、被砍了什么"。
5. **零持久化反馈**：反馈仅存在于会话上下文；新会话不携带上次的纠错状态。

---

## D10. 契约类型定义（TypeScript）

> 与 [agent-contract/events.ts](../packages/agent-contract/src/events.ts) 的 `AgentStreamEvent` 判别联合、
> [config/store.ts](../packages/agent/src/config/store.ts) 的 `EffectiveConfig` / `DEFAULT_SETTINGS` 同款写法。
> 能力 token 类型 `SubAgentCapability` 应从单一来源派生（现 `CAP_TOKENS` / `RoleToolPolicy` 键，[agents/registry.ts:44](../packages/agent/src/agents/registry.ts)），此处展开仅为可读。

### D10.1 共享类型

```ts
/** 能力 token —— 唯一来源派生（勿手写第二份）。 */
export type SubAgentCapability = 'read' | 'write' | 'exec' | 'http';

/** 一个子 Agent 的能力面（能力子集 + MCP 白名单）。 */
export interface SubAgentCapabilitySet {
  capabilities: SubAgentCapability[];
  /** MCP server 白名单；`false` = 不给任何 MCP（禁止 `true`，必须显式列举，§D1/§D2）。 */
  mcp: false | string[];
}

/** `delegateToSubAgent` 的入参 spec（§D1）—— Orchestrator 运行期合成，不进 registry。 */
export interface AgentSpec {
  /** 仅 trace/日志标识（如 "pg-schema-reader"）；非全局唯一、不做注册键。 */
  name: string;
  capabilities: SubAgentCapability[];
  mcp: false | string[];
  /** 任务专属 system prompt。 */
  prompt: string;
  /** alias 或 `provider:model`；缺省用 `dynamicSubAgents.defaultModel`。 */
  model?: string;
  /** 墙钟超时 ms；缺省用 `dynamicSubAgents.defaultTimeoutMs`。 */
  timeoutMs?: number;
}
```

### D10.2 事件类型（加入 `AgentStreamEvent` 判别联合）

```ts
/**
 * 子 Agent 合成事件（§D4）：每次委派合成时发，写 `audit.jsonl` + trace。
 * 与现有 `sub-agent-start`（events.ts:101）并存：spawn 先发（携全量配置，审计锚点），
 * 随后 sub-agent-start 仅做 trace 嵌套。`requested` 与 `granted` 都记 —— 差集即被
 * envelope/父挡掉的能力，是审计与调参核心信号（删 preset 后唯一可复现来源）。
 */
| {
    kind: 'sub-agent-spawn';
    runId: string;
    parentRunId: string;
    parentAgentId: string;
    agentId: string;
    name: string;                       // spec.name
    objective: string;
    requested: SubAgentCapabilitySet;   // LLM 请求的原始能力
    granted: SubAgentCapabilitySet;     // 收敛后实际生效（= requested ∩ 父 ∩ envelope）
    model: string;
    timeoutMs: number;
    /** 大 prompt 落盘只存 hash，避免污染事件流；二选一。 */
    prompt?: string;
    promptHash?: string;
    /** 应用的包络版本，便于回放。 */
    envelopeVersion?: string;
    /** 触发委派的 tool call，UI 据此把子 trace 嵌进该调用展开。 */
    toolCallId?: string;
  }

/**
 * 子 Agent 执行后评估（§D5）：LLM-judge 结果。同时回灌给 Orchestrator 作为会话内
 * 即时纠错的依据（§D7，仅 in-context、零持久化）。
 */
| {
    kind: 'sub-agent-eval';
    runId: string;
    agentId: string;
    evaluation: SubAgentEvaluation;
  }
```

```ts
export interface SubAgentEvaluation {
  /** 是否达成 objective。 */
  objectiveMet: boolean;
  /** 0–1 质量/置信分。 */
  score: number;
  /** 反漂移关键维：是否用了不必要能力 / 触碰 scope 外。 */
  scopeAdherence: 'ok' | 'over-provisioned' | 'out-of-scope';
  /** 实测真正用到的能力；与 spawn 的 `granted.capabilities` 之差 = 多给的。 */
  usedCapabilities?: SubAgentCapability[];
  steps: number;
  /** 理由（给人看 + 喂 §D7 会话内纠错）。 */
  reason: string;
}
```

### D10.3 配置类型（`GlobalSettings` / `ScopedConfig` 可选项 + `EffectiveConfig` 收敛）

```ts
/** 原始可选配置（global → Session 两级合并，[config/store.ts]）。 */
export interface DynamicSubAgentsSettings {
  /** 熔断开关；false → delegateToSubAgent 不挂载 / 降级。企业建议默认 opt-in。 */
  enabled?: boolean;
  /** 动态子 Agent 能拿到的能力上限 —— 删枚举后的唯一能力天花板（§D2）。 */
  maxCapabilities?: SubAgentCapability[];
  /** 动态子 Agent 可见的 MCP server 上限；false = 全不可见。 */
  mcpAllow?: false | string[];
  defaultModel?: string;
  defaultTimeoutMs?: number;
  evaluation?: {
    enabled?: boolean;
    /** 触发策略；默认 'on-failure-or-violation'（省成本，§D5）。 */
    when?: 'always' | 'on-failure-or-violation';
    /** 评估用的廉价模型 alias。 */
    model?: string;
  };
  // 注意：无 `maxDepth` —— 嵌套是无条件禁止的硬约束（§D3），不可配置。
}

/** 收敛后形（必填化 + 默认填充），并入 `EffectiveConfig`。 */
export interface EffectiveDynamicSubAgents {
  enabled: boolean;
  maxCapabilities: SubAgentCapability[];
  mcpAllow: false | string[];
  defaultModel: string;
  defaultTimeoutMs: number;
  evaluation: { enabled: boolean; when: 'always' | 'on-failure-or-violation'; model?: string };
}

/** 默认值：ON + 全能力上限 —— 运营方按需收敛/关闭（ea config dyn off / caps / mcp）。
 *  每个高危动作仍走 mode 审批门 + sandbox，所以"默认全开"不等于"无防护"。 */
export const DEFAULT_DYNAMIC_SUBAGENTS: EffectiveDynamicSubAgents = {
  enabled: true,
  maxCapabilities: ['read', 'write', 'exec', 'http'],
  mcpAllow: true,                              // true=不限服务器（worker 仍须在 spec 显式列举，§D1）
  defaultModel: '<沿用 orchestrator 模型>',
  defaultTimeoutMs: 300_000,
  evaluation: { enabled: true, when: 'on-failure-or-violation' },
};
```

> 收敛规则（`effective()` 内）：`maxCapabilities` / `mcpAllow` 为动态子 Agent 的**上限**，§D2 的 `granted = requested ∩ parent ∩ envelope` 即以此为 envelope 项。`enabled=false` 时 [sub-agent.ts](../packages/agent/src/runtime/sub-agent.ts) 不构造 `delegateToSubAgent`（与 agent §2.2 depth 门同款的"工具根本不存在"硬门）。
