# 实现文档：Auto 模式 `bypass` 属性

状态：**待 review（未写代码）— 决策已按推荐采纳（见 §8）**
作者：草案 v2
关联：agent §3.8.5（auto 模式安全分类器）、§3.3（三态审批门）

> v2 变更：§8 决策清单全部按推荐落定。最大影响是 **D1 采纳 (b)** —— bypass 的"仍需审批"范围从"仅系统级删除"扩大为**分类器 `ALWAYS DENY` 全集**（删除 + 提权 + 远程代码执行 + 开监听 + 磁盘毁灭），并据此把 §4 的检测器从"删除检测"重写为"确定性高危门"。

---

## 1. 目标与语义

### 需求
在 **auto 执行模式**下新增布尔配置 `bypass`。打开后,auto 模式的危险指令过滤行为变为:

> **不可豁免的高危指令仍走人工审批,其余一切跳过分类器、直接放行。**
> 不可豁免集 = 分类器原有 `ALWAYS DENY` 的确定性可检测子集(见 §4.1)。

### 与现状的差异

| | 现状(auto 模式) | bypass 打开后 |
|---|---|---|
| 普通命令(读、搜、`git status`、构建、测试、工作区内编辑/删除) | 跑分类器逐条裁决 | **直接放行,不跑分类器** |
| 高危(系统级删除、提权、`curl\|bash`、开监听、磁盘毁灭、跑任意脚本) | 跑分类器(通常 deny/ask) | **强制走人工审批门** |
| 每次裁决成本 | 1~2 次模型调用 | 0(确定性规则) |
| 已有 session grant | honored(危险解释器除外) | honored(同左) |
| 分类器不可用 | fail-closed → ask | 不涉及(不跑分类器) |

一句话:`bypass` 用一条**确定性高危黑名单**替换"模型逐条裁决"——命中→人工审批,未命中→放行。

### 安全定位(D1 已采纳 (b))
bypass 是一次**有界的**安全放松,不是关闭安全:
- ✅ 仍拦截:不可逆删除、提权(sudo/doas/su)、远程代码执行(经任意解释器/`curl|bash`)、开网络监听、磁盘级毁灭、任何无法静态核验的脚本/内联代码。
- ⚠️ **已知残余风险(接受并记录):** 纯语义类危险——"读取凭据再外发"、"禁用安全控制"——无法用确定性规则识别(需要模型上下文判断)。bypass 下这类动作若不经解释器/不触发上述模式,**会被放行**。`writeFile`/`readFile` 受工作区边界(`guardPath`)约束无法逃逸;`httpFetch` 在 bypass 下放行,是外泄残余面的主要来源。
  → 若该残余面不可接受,见 §8 "运维建议":对 bypass 通道用 `permission.allowHosts` 收紧出网,或保留 `httpFetch` 不在豁免内(可选硬化)。

---

## 2. 涉及改动总览(4 层)

| 层 | 文件 | 改动 |
|---|---|---|
| 契约/类型 | `packages/agent-contract/src/domain.ts` | `AutoModeConfig` 加 `bypass?: boolean` |
| 配置 store | `packages/agent/src/config/store.ts` | `EffectiveConfig` 加 `autoBypass`;`effective()` 合并(单向收紧) |
| 风险常量 | `packages/agent/src/tools/risk.ts` | 上移 `DANGEROUS_AUTO_COMMANDS`(避免循环依赖) |
| 运行时(核心) | 新文件 `packages/agent/src/tools/bypass-policy.ts` | `requiresApprovalUnderBypass()` 确定性高危门 |
| 运行时接入 | `packages/agent/src/tools/gate.ts` | bypass 分支 |
| 运行时接线 | `packages/agent/src/index.ts` + `context.ts` | `services.auto.bypass` |
| CLI | `apps/cli/src/commands/config.ts` + `apps/cli/src/tui-otui/views.tsx` | `ea config bypass` + TUI 开关 |
| Gateway | `apps/gateway/src/web/{admin,server}.ts` + `ui/components/channels.ts` + `i18n.ts` | 每通道开关 + REST + UI |

---

## 3. 配置层

### 3.1 契约类型 — `agent-contract/src/domain.ts`
在 `AutoModeConfig`(约 :204-216)加字段:

```ts
export interface AutoModeConfig {
  enabled?: boolean;
  classifierAlias?: string;
  classifierStages?: 'both' | 'fast' | 'thinking';
  rules?: string;
  /**
   * Bypass 模式(agent §3.8.5)。仅在 auto 模式生效。打开后跳过分类器:
   * 不可豁免的高危指令(删除/提权/远程执行/开监听/磁盘毁灭/任意脚本)仍走
   * 人工审批,其余直接放行。默认 false。这是一次有界安全放松——见
   * docs/auto-bypass-mode.md(含残余风险说明)。
   */
  bypass?: boolean;
}
```

> 选择嵌在 `auto` 块下而非 `ScopedConfig` 顶层 —— 它"仅在 auto 模式生效"。`ChannelSessionConfig = ScopedConfig & {…}`,故 gateway 通道配置**自动**获得 `session.auto.bypass`,无需在 `GatewayConfig` 另开字段(见 §6)。

### 3.2 EffectiveConfig + 合并 — `agent/src/config/store.ts`

**接口**(约 :62-101)加:
```ts
autoBypass: boolean;
```

**合并**(`effective()`,约 :233-263),紧挨 `autoEnabled`(:236):
```ts
// 【D2 采纳 (a)】bypass 是安全放松,采用与 autoEnabled 相同方向的单向收紧:
// 一旦 GLOBAL 显式 bypass:false,session/channel 无法再打开(企业策略兜底)。
autoBypass:
  g.auto?.bypass === false
    ? false
    : scope?.auto?.bypass ?? g.auto?.bypass ?? false,
```
> 与 `autoEnabled: g.auto?.enabled === false ? false : …`(:236)对称。
`DEFAULT_SETTINGS`(:45-59)**无需**改动(默认 `false` 由 `?? false` 兜底)。

---

## 4. 运行时(核心改动)

### 4.0 先处理循环依赖 — `agent/src/tools/risk.ts`
`gate.ts` 现有的 `DANGEROUS_AUTO_COMMANDS`(:31-34)需要被新模块 `bypass-policy.ts` 复用,而 `bypass-policy.ts` 又被 `gate.ts` 引用 → 会形成环。**做法:把 `DANGEROUS_AUTO_COMMANDS` 上移到叶子模块 `risk.ts`**(已是无依赖的风险常量表),`gate.ts` 与 `bypass-policy.ts` 都从 `risk.ts` 引入。`gate.ts` 的 `isDangerousInAuto` 改为从 `risk.ts` import 同一常量,行为不变。

### 4.1 新文件:确定性高危门 `packages/agent/src/tools/bypass-policy.ts`

bypass 模式**不跑模型分类器**,故"不可豁免高危集"必须用**确定性规则**识别。这是本特性**风险最高、最该 review** 的部分。原则:**fail-closed** —— 不能确定安全就判为需审批。

【D1 采纳 (b)】不可豁免集 = 分类器 `ALWAYS DENY`(auto-classifier.ts:56-58)的可静态检测子集:
不可逆删除、提权、远程代码执行、开网络监听、磁盘毁灭、任意脚本/内联代码。

```ts
import { basename, isAbsolute, resolve } from 'node:path';
import type { GatedToolCall } from './gate.js';
import { DANGEROUS_AUTO_COMMANDS } from './risk.js'; // 上移后的解释器+提权集

/** runCommand 的 input 形状(见 exec.ts:94-96)。 */
interface RunCommandInput { command: string; args?: string[] }

/** 磁盘/文件系统毁灭级工具:与路径无关,永远审批。 */
const FS_DESTROYERS = /^(mkfs(\.\w+)?|dd|fdisk|parted|shred|wipefs|blkdiscard)$/;
/** 开网络监听:常见反弹/监听工具 + 监听标志。 */
const LISTENERS = new Set(['nc', 'ncat', 'netcat', 'socat']);
/** 删除类可执行名。 */
const DELETE_EXES = new Set(['rm', 'rmdir', 'unlink', 'srm']);

/**
 * bypass 模式下该调用是否仍需人工审批(= 命中不可豁免高危集)。
 * fail-closed:不确定即返回 true。其余调用(返回 false)由 bypass 直接放行。
 *
 * @param roots 工作区根(ctx.shared.rootPaths)
 */
export function requiresApprovalUnderBypass(call: GatedToolCall, roots: string[]): boolean {
  // 【D6 采纳】runScript 跑任意脚本体,无法静态核验 → 一律审批。
  if (call.toolName === 'runScript') return true;
  // 文件工具受 guardPath 边界约束,无法逃逸工作区;httpFetch 见 §1 残余风险说明。
  if (call.toolName !== 'runCommand') return false;

  const { command, args = [] } = (call.input ?? {}) as RunCommandInput;
  if (typeof command !== 'string') return true; // 形状异常 → 审批
  const exe = basename(command).toLowerCase();

  // 1) 任意解释器 / 提权(sudo·doas·su·bash·sh·python·node·…):
  //    内联代码(bash -c / python -c / node -e)与提权均无法静态核验 → 审批。
  //    复用 DANGEROUS_AUTO_COMMANDS(已含解释器与提权命令)。
  if (DANGEROUS_AUTO_COMMANDS.has(exe)) return true;

  // 2) 磁盘毁灭器:永远审批。
  if (FS_DESTROYERS.test(exe)) return true;

  // 3) 开网络监听(nc -l / ncat -l / socat 监听端):
  if (LISTENERS.has(exe) && /(^|[\s])-[a-z]*l/.test(args.join(' '))) return true;
  if (exe === 'socat') return true; // socat 语义太灵活 → 一律审批

  // 4) 远程拉取并执行:curl/wget 取回后管道进解释器。runCommand 的 {command,args}
  //    形态下,管道通常以 `bash -c "curl … | sh"` 出现 → 已被(1)拦截。这里兜住
  //    直接以 curl/wget 为 argv[0] 且带 -o/管道写本地可执行的少数形态:保守放行
  //    (纯下载不危险),真正的"下载即执行"必经解释器,已在(1)。

  // 5) 系统级破坏性删除:删除语义 + 目标越出工作区/广域通配。
  const isDelete =
    DELETE_EXES.has(exe) ||
    (exe === 'find' && args.includes('-delete')) ||
    (exe === 'git' && args[0] === 'clean' && /-[a-z]*f/.test(args.join(' ')));
  if (isDelete && !isStrictlyInsideWorkspace(args, roots)) return true;

  return false; // 其余 → bypass 放行
}

/**
 * 删除目标是否全部严格落在工作区根内。任一以下情形 → false(触发审批):
 *  - 危险通配/根符号:`/`、`~`、`$HOME`、裸 `*`、`.*`
 *  - 绝对路径不在任何 root 之下;相对路径 `..` 逃逸出 root
 * fail-closed:无可识别的路径参数也算不安全。
 */
function isStrictlyInsideWorkspace(args: string[], roots: string[]): boolean {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) return false; // 只有 flags(如 rm -rf 后被 shell 展开)→ 审批
  const norm = roots.map((r) => resolve(r));
  for (const t of targets) {
    if (/^[~/]|\$HOME|^\*|^\.\*|\/\*$/.test(t)) return false;
    const abs = isAbsolute(t) ? resolve(t) : resolve(norm[0]!, t);
    if (!norm.some((r) => abs === r || abs.startsWith(r + '/'))) return false;
  }
  return true;
}
```

**判为高危(→ 人工审批):**
任何 `bash/sh/zsh/python/node/…` 调用、`sudo …`、`rm -rf /`·`~`·`$HOME`·`/etc/x`·裸 `rm -rf *`·`rm ../../x`、`find / -delete`、`git clean -fdx`、`mkfs.*`/`dd of=/dev/sda`/`shred …`、`nc -l …`/`socat …`、以及任何 `runScript`。

**判为安全(→ bypass 放行):**
`git status`/`git diff`、`pnpm test`/`npm run build`、`ls`/`cat`/`grep`/`rg`、`mkdir tmp`、`rm -rf node_modules`、`rm dist/foo.js`(工作区内)。

> 【D3 采纳:折中 + fail-closed】静态检测对 `rm -rf $(cat f)`、变量展开、`xargs rm` 等运行期才定的路径看不到——但这些几乎都经 shell 执行(argv[0] 为解释器),已被规则(1)兜住。直接以 `rm`/`find` 为 argv[0] 的越界删除被规则(5)覆盖。残余的纯语义外泄见 §1。

### 4.2 接入审批门 — `packages/agent/src/tools/gate.ts`

在 auto 分支(:60-116)内,`if (!granted)` 之后、现有分类器调用之前,插入 bypass 短路:

```ts
if (ctx.shared.executionMode.value === 'auto' && ctx.shared.auto.enabled) {
  const dangerous = isDangerousInAuto(call);
  const granted = !dangerous && approval.isGranted(call.toolName, call.grantKey, ctx.agentId);
  if (!granted) {

    // ── 新增:bypass 短路(agent §3.8.5 guardrail) ──
    if (ctx.shared.auto.bypass) {
      if (requiresApprovalUnderBypass(call, ctx.shared.rootPaths)) {
        // 不可豁免高危:跳过分类器,fall through 到下面的人工审批门(不 return)。
      } else {
        // 其余一切:直接放行 + 审计(reason 标记 bypass,便于审计追溯)。
        ctx.shared.emit({ kind: 'auto-classified', runId: ctx.runId, agentId: ctx.agentId,
          toolCallId: call.toolCallId, verdict: 'allow', reason: 'auto-bypass', stage: undefined });
        const output = await run();
        audit.record({ runId: ctx.runId, agentId: ctx.agentId, toolCallId: call.toolCallId,
          tool: call.toolName, input: call.input, output: summarizeOutput(output),
          approval: 'auto-allow', grantKey: call.grantKey, reason: 'auto-bypass' });
        return output;
      }
    } else {
      // ── 原有分类器路径(保持不变) ──
      const verdict = await ctx.shared.auto.classify(/* … */);
      // … deny / allow / ask 三分支不动 …
    }
  }
}
// 人工审批门(approval.gate)—— bypass 下的高危调用落到这里
```

> 关键:bypass 命中高危时**不 return**,fall through 到既有 `approval.gate`(:118),复用现成人工审批 UI、reject 处理与审计,无需新审批通道。
> 【D4 采纳】复用 `auto-classified` 事件 + `reason:'auto-bypass'` 标记,审计可区分 bypass 放行与分类器放行,无需新事件类型。

### 4.3 运行时接线 — `index.ts` / `context.ts`
`SessionServices.auto` 现为 `{ enabled, classify }`。新增 `bypass: boolean`:
- `context.ts` 里 `auto` 类型补 `bypass: boolean`。
- `index.ts` 构造 `services.auto` 处(约 :542-555)加 `bypass: p.eff.autoBypass`。
- gate 读 `ctx.shared.auto.bypass`。

---

## 5. CLI 暴露

### 5.1 `ea config bypass` 子命令 — `apps/cli/src/commands/config.ts`
仿 `config sandbox`(:46-90)的 on/off/default 模式,读写 **global** `settings.json` 的 `auto.bypass`:

```ts
config
  .command('bypass [state]')
  .description('开关 auto 模式 bypass(写 global settings.json 的 auto.bypass)')
  .action(async (state?: string) => {
    await withCtx(getGlobal(), async (ctx) => {
      const settings = ctx.config.loadSettings();
      const current = settings.auto?.bypass ?? false;
      if (!state) {
        print(`当前(global)bypass:${current ? color.success('✓ 启用') : color.muted('✗ 关闭')}`);
        printErr(color.warn('⚠ 启用后 auto 模式仅拦截高危(删除/提权/远程执行/开监听/脚本),其余不再审批'));
        printErr(color.muted('用法:ea config bypass on | off | default'));
        return;
      }
      const s = state.toLowerCase();
      const ON = new Set(['on','true','enable','1']);
      const OFF = new Set(['off','false','disable','0']);
      settings.auto = settings.auto ?? {};
      if (s === 'default') { delete settings.auto.bypass; }
      else if (ON.has(s)) { settings.auto.bypass = true; }
      else if (OFF.has(s)) { settings.auto.bypass = false; }
      else { printErr(color.danger(`✗ 无法识别:${state}`)); process.exitCode = 1; return; }
      ctx.config.saveSettings(settings);
      print(color.success(`✓ bypass → ${settings.auto.bypass ? '启用' : '关闭/默认'}`));
    });
  });
```
只读 `config` 总览(:18-44)加一行展示 `eff.autoBypass`。

### 5.2 TUI 开关 — `apps/cli/src/tui-otui/views.tsx`
- `ConfigTab`(约 :1180-1236)加展示行:`bypass  ✓启用/✗关闭`,读 `eff().autoBypass`。
- 仿 `toggleSandbox`(:517-531)加 `toggleBypass()`,写 **session 覆盖**:`{ ...scope, auto: { ...scope.auto, bypass: !eff.autoBypass } }` → `ctx.host.updateSessionConfig`。
- 键位(约 :692)加 `if (ch === 'b') return toggleBypass()`,底部帮助行注明 `b 开关 bypass`。
> 【D2】若 global 已 `auto.bypass:false`,session 切换不生效——TUI 按 `eff` 回读真实值,必要时提示"已被 global 策略禁用"。

---

## 6. Gateway Admin 暴露(D5 采纳:每通道)

`ChannelSessionConfig = ScopedConfig & {…}`(gateway-config.ts:33),通道的 `session.auto.bypass` **天然被运行时识别**,无需新 `GatewayConfig` 字段。接进既有"每通道策略"编辑器(已管 executionMode / approval)。

### 6.1 后端 — `apps/gateway/src/web/admin.ts`
扩展 `updateChannelPolicy`(:263-287)的 patch:
```ts
patch: { executionMode?: string; approval?: string; bypass?: boolean },
// …
if (patch.bypass !== undefined) {
  c.session = { ...(c.session ?? {}), auto: { ...(c.session?.auto ?? {}), bypass: patch.bypass } };
}
```
`state()`(:103-162)已在 :125 带出 `session: c.session ?? {}`,前端可直接读 `c.session.auto.bypass`。

### 6.2 路由 — `apps/gateway/src/web/server.ts`
**复用现有 `/api/channel/update`** 透传 `bypass`(少开一个端点),仿 `/api/verbose`(:131-133)的 body 解析。

### 6.3 UI — `apps/gateway/src/web/ui/components/channels.ts`
通道表每行(:44-52)在 mode/approval 旁加 checkbox:
```js
var byp=(c.session&&c.session.auto&&c.session.auto.bypass)||false;
// 列:'<td><input type="checkbox" id="byp-'+i+'" '+(byp?'checked':'')+'></td>'
```
`saveChannelPolicy(name,acct,i)` 提交带 `bypass: document.getElementById('byp-'+i).checked`。表头(:43)加 `colBypass`;新增通道表单(:69-70)同样可选。

### 6.4 i18n — `apps/gateway/src/web/ui/i18n.ts`
加 `colBypass` / `bypassHint`(zh+en),hint 明确这是有界放松:
`zh: 'Bypass(仅拦高危:删除/提权/远程执行/开监听/脚本)'` / `en: 'Bypass (only high-risk ops are gated)'`。

---

## 7. 测试计划

| 测试 | 文件 | 断言 |
|---|---|---|
| **高危门单测(核心)** | `test/bypass-policy.test.ts`(新) | **审批=true:** 任意解释器(`bash -c`/`python x.py`/`node -e`)、`sudo …`、`rm -rf /`·`~`·`$HOME`·`/etc/x`·裸 `*`·`../` 逃逸、`find / -delete`、`git clean -fdx`、`mkfs`/`dd of=/dev`/`shred`、`nc -l`/`socat`、任意 `runScript`、input 形状异常。**放行=false:** `git status`、`pnpm test`、`ls`/`grep`、`mkdir tmp`、`rm -rf node_modules`、`rm dist/x`(root 内) |
| 合并逻辑 | `test/config.test.ts` / `execution-mode.test.ts` | `autoBypass` 默认 false;global=false 锁定(D2);scope 覆盖生效 |
| gate 行为 | 新 `test/gate-bypass.test.ts` | bypass+放行项 → **不调用** `classify`、直接 run、审计 `reason:'auto-bypass'`;bypass+高危 → 落到 `approval.gate`;bypass 关 → 仍走分类器(回归) |
| 回归 | 既有 `execution-mode.test.ts` | bypass 默认关时,所有现有 auto 行为不变 |

> gate 测试需注入 spy `classify` 验证"未被调用"。测试基建见 memory「Sub-agent test env & approval routing」。

---

## 8. 决策清单(已按推荐采纳)

| # | 决策 | 采纳 | 落地位置 |
|---|---|---|---|
| **D1** | bypass 豁免范围 | **(b) 保留分类器 `ALWAYS DENY` 全集为不可豁免** | §4.1 `requiresApprovalUnderBypass` |
| **D2** | 合并单向收紧 | **(a) global `bypass:false` 锁定全局** | §3.2 |
| **D3** | 删除检测严格度 | **折中 + fail-closed**,逃逸路径由解释器规则兜底 | §4.1 规则(1)(5) |
| **D4** | 审计标记 | **复用 `auto-classified` 事件 + `reason:'auto-bypass'`** | §4.2 |
| **D5** | Gateway 粒度 | **每通道(`session.auto.bypass`)** | §6 |
| **D6** | runScript | **一律审批(无法静态核验)** | §4.1 首行 |

### 残余风险 & 运维建议(D1 的代价)
- 静态门**无法**识别"读凭据再外发"这类纯语义外泄;`httpFetch` 在 bypass 下放行是主要外泄面。
- **建议**:对启用 bypass 的 session/通道,用 `permission.allowHosts` 收紧出网白名单;或作为**可选硬化**,把 `httpFetch` 也纳入 `requiresApprovalUnderBypass`(默认放行,配置可切)——本版未纳入,留待你决定是否需要 D7。

---

## 9. 改动文件清单(实现时核对)

- `packages/agent-contract/src/domain.ts` — `AutoModeConfig.bypass`
- `packages/agent/src/config/store.ts` — `EffectiveConfig.autoBypass` + 合并(单向收紧)
- `packages/agent/src/tools/risk.ts` — 上移 `DANGEROUS_AUTO_COMMANDS`(解循环依赖)
- `packages/agent/src/tools/bypass-policy.ts` — **新增** `requiresApprovalUnderBypass`
- `packages/agent/src/tools/gate.ts` — bypass 短路分支 + 改 import 来源
- `packages/agent/src/runtime/context.ts` — `auto.bypass` 类型
- `packages/agent/src/index.ts` — `services.auto.bypass` 接线
- `apps/cli/src/commands/config.ts` — `ea config bypass` + 总览展示
- `apps/cli/src/tui-otui/views.tsx` — ConfigTab 展示 + toggleBypass + 键位
- `apps/gateway/src/web/admin.ts` — `updateChannelPolicy` patch
- `apps/gateway/src/web/server.ts` — 复用 `/api/channel/update` 透传
- `apps/gateway/src/web/ui/components/channels.ts` — 每行 checkbox
- `apps/gateway/src/web/ui/i18n.ts` — 文案
- 测试:`test/bypass-policy.test.ts`(新)+ `test/gate-bypass.test.ts`(新)+ 合并/回归
- 若有 agent 规格文档(§3.8.5 出处),同步补 bypass guardrail 说明
