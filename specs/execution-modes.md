# 执行模式（Ask / Plan / Auto）实现计划

> 状态：Phase 0–3 ✅ 全部落地。设计已合入 **agent §3.8**（权威来源）；本文件只承载「怎么落地」：enforceMode 重构、分类器细节、分阶段与测试。
> 关联：agent §3.8（执行模式，设计）、§3.3（三态审批）、§3.4（子 Agent 审批/权限单调不增）、§3.7（updateTodos / askUserQuestion 挂起-恢复桥）、§4 / §4.1（安全 / 沙箱）、§6（命令/事件契约）；cli-ui §4 / §6、cli-architecture §6。
> 设计参照：Claude Code 的 plan-mode / auto-mode（yolo classifier）/ task-management，按本仓抽象重映射。设计本身见 agent §3.8，本文件不复述，避免漂移。

## 1. 现状锚点（落地前已核实）

- **所有有副作用的工具今天已统一走 `gated()`**：`writeFile`/`applyPatch`（[file.ts](../packages/agent/src/tools/file.ts)）、`httpFetch`（[http.ts](../packages/agent/src/tools/http.ts)）、`runCommand`/`runScript`（[exec.ts](../packages/agent/src/tools/exec.ts)）；只读工具不进闸。→ 收敛成单一 `enforceMode` 是**扩展 `gated()` + 并入 exec 的 `allowCommands`/`denyCommands` 快路**，非推倒重来。
- **挂起-恢复桥已存在**：`QuestionController`（[question.ts](../packages/agent/src/runtime/question.ts)）的 `ask()` 发事件并挂 Promise → `resolve()` 落定 → abort 时 `cancelAll()`。`exitPlanMode` 直接复用此模式，70 行的 [ask.ts](../packages/agent/src/tools/ask.ts) 是工具模板。
- **裁决结果类型**：`GateResult`（[approval.ts](../packages/agent/src/approval/approval.ts)）现有 `session-auto|once|session|reject`，本计划加 `auto-allow|blocked-plan`。

## 2. enforceMode 重构（Phase 0 核心）

把 [gate.ts](../packages/agent/src/tools/gate.ts) 的 `gated()` 升级为 agent §3.8.2 的固定顺序闸，新增 `RiskTier` 入参与模式分叉：

```ts
// 伪代码：每个有副作用工具 execute 最前调用；只读工具不调
async function enforceMode(ctx, call /* { toolName, riskTier, grantKey, grantScope, input, agentScoped? } */) {
  const mode = ctx.shared.executionMode.value;
  // 1 role 硬门：装配期已挡（buildToolsForRole），此处无需再查
  // 2 硬 deny：denyCommands / 文件越界 —— 由各工具在调用前自查（保持现状），命中直接 return error
  // 3 Plan 只读门
  if (mode === 'plan' && call.riskTier !== 'readonly')
    return { blocked: 'plan_mode', message: '…call exitPlanMode when the plan is ready' };
  // 4 会话 grant 命中（Auto 下危险 grant 已被 stripDangerousGrantsForAuto 剥离）
  const granted = grants.match(call.toolName, call.grantKey, ctx.agentId);
  if (granted) return run('session-auto');
  // 5 策略白名单（allowCommands / allowPaths）—— exec/file 现有快路并入此处
  if (policyAllows(call)) return run('auto');
  // 6 模式裁决
  if (mode === 'auto') {
    const v = await classifier.classify(call, transcript(ctx));   // §3
    if (v.verdict === 'allow') return run('auto-allow', v.reason);
    if (v.verdict === 'deny')  return reject('auto_denied', v.reason);
    // 'ask' / 不可用 / 超窗 / 低置信 → 落 6-ask（fail-closed）
  }
  // 6-ask（ask 模式，或 auto 降级）：发 tool-approval-required，await 用户三态
  return approvalRoundTrip(call);
}
```

- `gated()` 保留为薄封装（调 `enforceMode` + 审计），既有调用点不动签名；exec 的 allow/deny 快路从 `runCommand.execute` 移进 `enforceMode` 第 2/5 关。
- **审计**：`approval` 字段扩 `auto-allow`/`auto-deny`/`plan-approved`，auto 判决补记 `reason`（[gate.ts](../packages/agent/src/tools/gate.ts) 现有审计同结构）。
- **`TOOL_RISK` 静态表**：新增单一来源映射本地工具→`RiskTier`，gate 第 3/6 关与分类器共用。
- **回归保证**：mode 默认 `ask` 时，第 3/6-auto 关短路，行为与今天逐字节等价 —— 现有 `approval`/`sub-agent` 测试须全绿。

## 3. AutoClassifier（Phase 2/3）

设计见 agent §3.8.5；实现要点：

- **接口**：`classify(call, transcript): Promise<AutoClassifierResult>`（`verdict: allow|deny|ask`、`reason`、`thinking?`、`stage`、`unavailable?`、`transcriptTooLong?`）。
- **模型**：语义别名 `classifier`（agent §2.6），默认绑快/便宜模型；经同一 `ModelRegistry` 解析，可 Session/全局覆盖。
- **两段式**：Stage1 `fast`（小 token 预算 + stop 序列，明显安全直接 `allow`）→ Stage2 `thinking`（CoT）；共用 system prompt + provider prompt caching。配置 `auto.classifierStages: both|fast|thinking`（默认 both）。Phase 2 先只做 thinking 单段求正确，Phase 3 加 fast + caching。
- **system prompt**：分「基础规则模板 + 企业内部规则模板」两层（决策类目见 §3.8.5），放 `packages/agent/src/auto/prompts/`，单一来源、可审。
- **transcript 输入**：喂活动路径近段（复用 `buildMessages` 的裁剪），超窗 → `transcriptTooLong` → fail-closed 走 ask。
- **危险放行剥离**：`stripDangerousGrantsForAuto` / `restoreDangerousGrants` 作用于 `permission.allowCommands` + grant table（裸解释器 bash/sh/node/python3/eval/sudo/powershell + 同类宽泛 grant），进/出 auto 时调用。
- **熔断**：`settings.autoMode.enabled`（合并时全局禁用则 Session 不可 opt-in 覆盖，单向收紧）。

## 4. 契约与配置变更

落到代码的契约（agent §6.1/§6.2 已记其形）：

- `agent-contract`：`ExecutionMode` 类型 + `EXECUTION_MODE` 常量；`AgentHost` 加 `setExecutionMode` / `approvePlan`；`AgentStreamEvent` 加 `mode-changed` / `plan-proposed` / `auto-classified`；`ScopedConfig` 加 `executionMode` / `plan.allowNetwork` / `auto:{enabled,classifierAlias,classifierStages}`；audit `approval` 枚举扩展。
- `SessionServices` 加可变 `executionMode: { value }`；`Session` 加 `setExecutionMode()` / `approvePlan()`。
- 新增工具 `exitPlanMode`（[tools/](../packages/agent/src/tools/)），装配进 orchestrator 本地工具集（Plan 期可见）。

## 5. 分阶段

- **Phase 0 ✅｜模式骨架 + enforceMode 重构**：`ExecutionMode` + `SessionServices.executionMode` + `setExecutionMode`/`mode-changed` + 闸前置 `enforceMode`（[mode.ts](../packages/agent/src/tools/mode.ts)）+ `TOOL_RISK`（[risk.ts](../packages/agent/src/tools/risk.ts)）+ TUI Shift+Tab/指示器。ask 零回归（全测试绿）。
- **Phase 1 ✅｜Plan**：gate 第 3 关只读门 + `exitPlanMode` 工具（[plan.ts](../packages/agent/src/tools/plan.ts)）+ `PlanController`（[runtime/plan.ts](../packages/agent/src/runtime/plan.ts)）+ `plan-proposed`/`approvePlan` 往返 + TUI PlanBar（a/k/r）+ 批准转执行：切模式 + `allowedActions` 预授权为会话 grant（plan-approved 审计）。
  - 已落：批准/继续规划/拒绝、grant 预授权、mode-changed、prompt 引导（plan_mode error → 调 exitPlanMode）。
  - **Phase 1.1 ✅**：TUI 内联**编辑计划**（`e` 键载入计划到输入框 → ↵ 以 `edit`/`editedPlan` 批准 / Esc 取消）、**批准·自动**（`Shift+A` → `approvePlan(..., {targetMode:'auto'})`，批准后直接进 auto 自主执行，auto 可用时才显示该入口）、live-mode getter（`getExecutionMode` 命令，切会话回显真实模式、消除指示器滞后）。`seed todos` 由模型在 plan 期自调 `updateTodos` 满足。
- **Phase 2 ✅｜Auto（单段）**：`AutoClassifier`（单段 thinking，[runtime/auto-classifier.ts](../packages/agent/src/runtime/auto-classifier.ts)）+ `gated()` auto 关（allow 静默执行 / deny 回灌 `auto_denied` / ask 降级人审）+ 危险解释器读时剥离（`DANGEROUS_AUTO_COMMANDS`，grant + allowCommands 双路）+ 熔断 `autoEnabled`（全局 false 不可被 Session 覆盖）+ fail-closed（异常/不可解析→ask）+ `auto-allow`/`auto-deny` 审计含 reason + 系统提示 `modeGuidance` + TUI auto 横幅。
  - **Phase 2.1 ✅**：子 Agent auto 路径专门测试（子 Agent 高危调用走同一分类器、role 硬门独立于模式）。`transcriptTooLong` 检测留作后续——当前 8KB 近段截断已避免分类器 prompt 溢出，强行对长会话回 ask 反而损可用性，故不做启发式。
- **Phase 3 ✅｜Auto 优化**：两段式 fast→thinking（明显 allow 短路省一次调用，[auto-classifier.ts](../packages/agent/src/runtime/auto-classifier.ts)）+ 两段共用同一 system prompt（可被 provider 缓存）+ 企业内部规则 `auto.rules` 追加进 system prompt + `classifierStages` 配置 + 逐模式可用性（熔断关→TUI Shift+Tab 跳过 auto）+ `auto-classified` 观测事件 → 轨迹树工具节点 ⚡ 标注。
  - **prompt cache ✅**：分类器改用 `messages` 形态，system 消息带 `providerOptions.anthropic.cacheControl:{type:'ephemeral'}` 断点（两段 + 跨次调用共享同一 system 前缀 → anthropic 命中缓存；其它 provider 忽略，无害）。配 `allowSystemInMessages:true` 抑制「system-in-messages」注入告警（我方 system 可信）。

非目标（后续）：模型自主申请进入 Plan（带审批）、分类器判决的本地学习/记忆、跨 Session 的 auto 信任画像、为 todo 加 `dependsOn` 的调度式并行。

## 6. 测试计划

- **Phase 0**：`enforceMode` 单测覆盖 6 关 × 3 模式矩阵；既有 `approval.test` / `sub-agent*.test` 回归全绿；新增「mode=ask 时与旧 `gated` 路径等价」断言。
- **Phase 1**：`exitPlanMode` 挂起-恢复（仿 `ask` 测试）、Plan 只读门挡写/执行、批准转执行的 grant 预授权 + todos seed。
- **Phase 2**：分类器 allow/deny/ask 三路 + fail-closed（mock 不可用/超窗）+ 危险 grant 剥离 + 熔断降级 + 子 Agent 走同一分类器仍「子 ≤ 父」。

## 7. 安全不变量（落地须守，权威表述见 agent §3.8.7）

模式只改「问谁」越不过硬 deny/边界/沙箱/role 硬门 · fail-closed（无失败路径默认放行）· 子 ≤ 父 · auto 下危险快路被剥离 · 全程审计可回溯。
