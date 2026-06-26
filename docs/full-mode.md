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
| **`full`** | **无分类器、无工作区边界：仅 提权 与 高危删除 仍走人工审批，其余一切（含解释器/脚本/磁盘工具/监听）直接放行** |

> `full`：**只拦两类——提权(sudo/doas/su/pkexec) 与 高危破坏性删除；其余全部跳过分类器、直接放行，且工作区边界关闭。**

### 与 `auto` 的差异

| | `auto` 模式 | `full` 模式 |
|---|---|---|
| 普通命令（读、搜、`git status`、构建、测试、编辑/删除） | 跑分类器逐条裁决 | **直接放行，不跑分类器** |
| 解释器 / 脚本（`bash -c`、`python`、`node -e`、`runScript`、`curl\|bash`） | 跑分类器（通常 deny/ask） | **直接放行** |
| 磁盘工具 / 开监听（`dd`、`mkfs`、`nc -l`、`socat`） | 跑分类器 | **直接放行** |
| 提权（`sudo`/`doas`/`su`/`pkexec`） | 跑分类器 | **走人工审批门** |
| 高危删除（`rm -rf` 指向 `/`、`~`、`$HOME`、系统目录、广域 `*`） | 跑分类器 | **走人工审批门** |
| 工作区边界（`guardPath`） | 强制（文件/exec 不能越界） | **关闭**（文件/exec 可读写/执行工作区之外） |
| 每次裁决成本 | 1~2 次模型调用 | 0（确定性规则） |
| 已有 session grant | honored（危险解释器除外） | honored（同左） |
| 分类器不可用 | fail-closed → ask | 不涉及（不跑分类器） |

一句话：`full` 把审批面收到**最窄两类（提权 + 高危删除）**并**关闭工作区边界**——其余一切无提示运行。

### 安全定位 ⚠️（重大放松）
`full` 是一次**重大**的、由操作者主动选择的安全放松，请仅在受控环境使用：
- ✅ 仅拦截：提权（sudo/doas/su/pkexec）、以及指向根/家目录/系统目录/广域通配的**破坏性删除**。
- ⚠️ **直接放行（高残余风险）：** 任意解释器与内联代码（`bash -c`、`python -c`、`node -e`、`curl|bash`）、`runScript`、磁盘工具（`dd`/`mkfs`/`shred`）、开网络监听（`nc -l`/`socat`）、以及**工作区之外**的文件读写与命令执行（`guardPath` 边界已关闭）。`httpFetch` 同样放行。
- **缓解**：仅在隔离/一次性环境用 `full`；需要硬边界时**开启 OS 沙箱（landstrip，`ea config sandbox on`）**——沙箱的 `allowWrite: rootPaths` 在 OS 层独立强制，不受 `full` 关闭应用层 `guardPath` 影响（见 §3 尾注）。用 `permission.allowHosts` 收紧出网。

### 可用性门控
`full` 与 `auto` 同受 auto 圈断器（`auto.enabled`）门控：当组织把 `auto.enabled` 置为 `false`（合规层），Shift+Tab 轮转收窄为 `[ask, plan]`——`auto` 与更宽松的 `full` 都不可选。

---

## 2. 运行时（`gate.ts`）

`gated()`（`packages/agent/src/tools/gate.ts`）按模式分派：

```ts
if (mode === 'full') {
  const dangerous = isDangerousInAuto(call);                 // 危险解释器 grant 不自动放行
  const granted = !dangerous && approval.isGranted(...);
  if (!granted && !requiresApprovalInFull(call)) {
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

`full` 模式**不跑模型分类器**，仅用一条**极窄的确定性规则**拦两类。`requiresApprovalInFull(call)` 返回 `true`（→ 人工审批）**仅**在：
1. **提权**：`runCommand` 且 `argv[0]` ∈ `{sudo, doas, su, pkexec, runas}`。
2. **高危破坏性删除**：`rm`/`rmdir`/`unlink`/`srm`/`find -delete`/`git clean -f`，**且**某个目标参数是灾难性目标——根/家目录符号（`/`、`~`、`~/…`、`$HOME`）、广域通配（`*`、`.*`、`/*`），或位于系统目录（`/etc`、`/usr`、`/bin`、`/var`、`/root`、`/System`、`/Library`、…）。

返回 `false`（→ 直接放行）的一切，**包括**：任意解释器与内联代码（`bash -c`/`python`/`node -e`）、`runScript`、磁盘工具（`dd`/`mkfs`/`shred`）、开监听（`nc -l`/`socat`）、删除**具体**路径（无论是否在工作区内，只要不是上面的灾难性目标，如 `rm -rf /tmp/scratch`、`rm -rf node_modules`）、以及所有只读/构建/VCS 命令与 `writeFile`/`httpFetch`。

> 注意：删除判定**不再看工作区边界**——只看目标是否灾难性。`rm -rf /work/repo/build`、`rm -rf /tmp/x` 都直接放行。

### 工作区边界（`guardPath`）在 full 模式关闭
应用层边界检查在 full 模式被跳过：
- 文件工具（`file.ts` 的 `guard()`）：`executionMode === 'full'` 时解析路径但**不**做 within-roots 校验 → `readFile`/`writeFile`/`applyPatch` 等可读写工作区之外，不再返回 `out_of_boundary`。
- exec（`exec.ts` 的 `resolveCwd()`）：`full` 时 `cwd` 不再被 `guardPath` 约束 → 命令可在工作区外的目录执行。

**尾注（OS 沙箱仍独立强制）**：landstrip OS 沙箱的 `allowWrite: rootPaths` 在**装配期**静态构建、由 OS 层强制，**不受** full 模式关闭应用层 `guardPath` 影响。即：沙箱关闭（默认）时，`full` 可自由越界；沙箱开启时，越界**写**仍被 OS 拦下。需要硬边界就 `ea config sandbox on`。

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
| 高危门单测 | `test/full-mode-policy.test.ts` | 审批=true：**仅** 提权(sudo/doas/su/pkexec) 与 高危删除(rm -rf /、~、$HOME、系统目录、`*`)；放行=false：解释器/`bash -c`/`node -e`/runScript、磁盘工具(dd/mkfs)、监听(nc -l/socat)、删除具体路径(含工作区外 /tmp/x)、只读/构建 |
| gate 行为 | `test/gate-full.test.ts` | `full`+放行项(含 `bash -c`) → **不调用** `classify`、直接 run、审计 `reason:'full'`；`full`+提权(sudo) → 落到 `approval.gate`；`auto` 模式 → 仍走分类器（回归） |
| 边界关闭 | `test/gate-full.test.ts` | `full` 模式 `writeFile` 到工作区外 → 成功落盘、无 `out_of_boundary`；`ask` 模式同路径 → `out_of_boundary` 拦下 |

---

## 6. 与旧 `bypass` / 早期 `full` 的差异（迁移要点）
- 旧 `settings.json` 的 `auto.bypass` / `ea config bypass` / TUI `b` 键 / gateway bypass 列 **全部移除**。
- 旧的"全局单向锁"（org 设 `bypass:false` 锁死全局）**移除**——`full` 是普通执行模式；要禁止 `full`，把通道/会话执行模式设为 `auto`/`ask`，或用 `auto.enabled:false` 同时关掉 `auto` 与 `full`。
- **审批面进一步收窄**：早期 `full`（= 旧 auto+bypass）仍拦解释器/脚本/磁盘/监听；现版 `full` **只拦 提权 + 高危删除**，并**关闭工作区边界**。这是一次更激进的放松，请仅在受控环境使用。
