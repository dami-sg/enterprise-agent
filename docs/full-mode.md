# `full` 执行模式

状态：**已实现**
关联：agent §3.8（执行模式）、§3.8.5（auto 模式安全分类器）、§3.3（三态审批门）

> 历史：`full` 模式取代了早期 auto 模式下的 `bypass` 布尔属性。语义不变（跳过分类器、仅拦确定性高危集），但它现在是一个**独立的执行模式**，与 `ask`/`plan`/`auto` 并列，用 Shift+Tab 实时切换——不再是 `settings.json` 里的 `auto.bypass` 开关，也不再有"全局单向锁"。

---

## 1. 语义

执行模式（agent §3.8）回答"谁裁决一次高危工具调用"：

| 模式 | 裁决者 |
|---|---|
| `ask`  | 每次人工审批（§3.3 基线 / 默认） |
| `plan` | 只读探索 → 提案计划 → 用户批准 → 执行 |
| `auto` | AI 分类器逐条裁决（allow/deny/ask，不确定 → ask） |
| **`full`** | **无分类器：除不可豁免高危集外，一切直接放行；高危集仍走人工审批门** |

> `full`：**不可豁免的高危指令仍走人工审批，其余一切跳过分类器、直接放行。**
> 不可豁免集 = 分类器原有 `ALWAYS DENY` 的**确定性可检测子集**（见 §3）。

### 与 `auto` 的差异

| | `auto` 模式 | `full` 模式 |
|---|---|---|
| 普通命令（读、搜、`git status`、构建、测试、工作区内编辑/删除） | 跑分类器逐条裁决 | **直接放行，不跑分类器** |
| 高危（系统级删除、提权、`curl\|bash`、开监听、磁盘毁灭、跑任意脚本） | 跑分类器（通常 deny/ask） | **强制走人工审批门** |
| 每次裁决成本 | 1~2 次模型调用 | 0（确定性规则） |
| 已有 session grant | honored（危险解释器除外） | honored（同左） |
| 分类器不可用 | fail-closed → ask | 不涉及（不跑分类器） |

一句话：`full` 用一条**确定性高危黑名单**替换"模型逐条裁决"——命中 → 人工审批，未命中 → 放行。

### 安全定位
`full` 是一次**有界的**安全放松，不是关闭安全：
- ✅ 仍拦截：不可逆删除、提权（sudo/doas/su）、远程代码执行（经任意解释器 / `curl|bash`）、开网络监听、磁盘级毁灭、任何无法静态核验的脚本/内联代码。
- ⚠️ **已知残余风险（接受并记录）：** 纯语义类危险——"读取凭据再外发"、"禁用安全控制"——无法用确定性规则识别（需要模型上下文判断）。`full` 下这类动作若不经解释器/不触发上述模式，**会被放行**。`writeFile`/`readFile` 受工作区边界（`guardPath`）约束无法逃逸；`httpFetch` 在 `full` 下放行，是外泄残余面的主要来源。
  → 若该残余面不可接受，对使用 `full` 的 session/通道用 `permission.allowHosts` 收紧出网白名单。

### 可用性门控
`full` 与 `auto` 同受 auto 圈断器（`auto.enabled`）门控：当组织把 `auto.enabled` 置为 `false`（合规层），Shift+Tab 轮转收窄为 `[ask, plan]`——`auto` 与更宽松的 `full` 都不可选。

---

## 2. 运行时（`gate.ts`）

`gated()`（`packages/agent/src/tools/gate.ts`）按模式分派：

```ts
if (mode === 'full') {
  const dangerous = isDangerousInAuto(call);                 // 危险解释器 grant 不自动放行
  const granted = !dangerous && approval.isGranted(...);
  if (!granted && !requiresApprovalInFull(call, rootPaths)) {
    emit({ kind: 'auto-classified', verdict: 'allow', reason: 'full' });
    const output = await run();
    audit.record({ approval: 'auto-allow', reason: 'full', ... });
    return output;                                            // 放行 + 审计标记 'full'
  }
  // 否则（已 grant，或命中高危集）：fall through 到 approval.gate（honor grant / 提示人工）
} else if (mode === 'auto' && auto.enabled) {
  // 既有分类器路径（allow/deny/ask），未变
}
```

- 命中高危集时**不 return**，fall through 到既有 `approval.gate`，复用人工审批 UI、reject 处理与审计。
- 审计/事件用 `reason: 'full'` 标记，可与分类器放行（`reason` 为分类器理由）区分。
- 无人值守运行（schedule，§7 B.2）：`full` 下非高危项无需人工即可放行；高危项 fall through 到无人值守 fail-closed deny。

---

## 3. 确定性高危门 — `packages/agent/src/tools/full-mode-policy.ts`

`full` 模式**不跑模型分类器**，故"不可豁免高危集"必须用**确定性规则**识别。原则：**fail-closed**——不能确定安全就判为需审批。

`requiresApprovalInFull(call, roots)` 返回 `true`（→ 人工审批）的情形：
1. 任意 `runScript`（脚本体无法静态核验）。
2. `runCommand` 且 `argv[0]` 是解释器/提权（`bash`/`sh`/`python`/`node`/`sudo`/`doas`/`su`/…，复用 `DANGEROUS_AUTO_COMMANDS`）。
3. 磁盘毁灭器：`mkfs.*`/`dd`/`fdisk`/`parted`/`shred`/`wipefs`/`blkdiscard`。
4. 开网络监听：`nc -l`/`ncat -l`/`socat`。
5. 广域破坏性删除：`rm`/`rmdir`/`unlink`/`srm`/`find -delete`/`git clean -f`，且目标越出工作区根或为根/家目录/广域通配（`/`、`~`、`$HOME`、裸 `*`）。
6. 形状异常的 input（fail-closed）。

返回 `false`（→ 直接放行）：`git status`/`git diff`、`pnpm test`/`npm run build`、`ls`/`cat`/`grep`、`mkdir tmp`、`rm -rf node_modules`、工作区内 `rm dist/x`，以及 `writeFile`/`httpFetch`（文件受边界约束；httpFetch 见 §1 残余风险）。

`DANGEROUS_AUTO_COMMANDS` 住在叶子模块 `risk.ts`，供 `gate.ts`（危险 grant 剥离）与 `full-mode-policy.ts`（高危门）共享，避免循环依赖。

---

## 4. 暴露面

| 面 | 位置 | 行为 |
|---|---|---|
| 契约 | `agent-contract/src/domain.ts` | `EXECUTION_MODE.FULL = 'full'`；`AutoModeConfig` 不再有 `bypass` |
| 配置 | `agent/src/config/store.ts` | `EffectiveConfig` 不再有 `autoBypass`；`executionMode` 合并照常接受 `'full'` |
| CLI TUI | `apps/cli/src/tui-otui/session.tsx` | Shift+Tab 轮转 `ask → plan → auto → full`；`full` 用 danger 色 + 顶部提示条 |
| CLI 总览 | `apps/cli/src/commands/config.ts` | `ea config` 展示"执行模式默认"；旧 `ea config bypass` 子命令已删 |
| Gateway | `apps/gateway/src/web/{admin,server}.ts` + `ui/components/channels.ts` + `i18n.ts` | 每通道执行模式下拉新增 `full` 选项；旧 bypass 复选列已删 |
| 调度 | `agent/src/schedules/registry.ts` | scheduled run 的 `session:` 允许 `full` |

---

## 5. 测试

| 测试 | 文件 | 断言 |
|---|---|---|
| 高危门单测 | `test/full-mode-policy.test.ts` | 审批=true：解释器/提权/磁盘毁灭/监听/广域删除/runScript/形状异常；放行=false：只读/构建/工作区内删除 |
| gate 行为 | `test/gate-full.test.ts` | `full`+放行项 → **不调用** `classify`、直接 run、审计 `reason:'full'`；`full`+高危 → 落到 `approval.gate`；`auto` 模式 → 仍走分类器（回归） |

---

## 6. 与旧 `bypass` 的差异（迁移要点）
- 旧 `settings.json` 的 `auto.bypass` / `ea config bypass` / TUI `b` 键 / gateway bypass 列 **全部移除**。
- 旧的"全局单向锁"（org 设 `bypass:false` 锁死全局）**移除**——`full` 是普通执行模式，由 per-session / per-channel 的 executionMode 决定；要禁止 `full`，把通道/会话的执行模式设为 `auto`/`ask`，或用 `auto.enabled:false` 同时关掉 `auto` 与 `full`。
- 行为等价物：旧"auto 模式 + bypass:true" ≡ 新"`full` 模式"。
