# Enterprise Agent — CLI UI 设计（OpenTUI）

> 本文档逐一设计 **CLI 的每个 UI 界面**——OpenTUI（+ SolidJS，跑在 Bun 上）下的屏幕、面板、组件、状态与交互。它是 [cli-architecture.md](cli-architecture.md)（下称 `cli`）§4 的细化：cli §4 给架构骨架（事件→reducer→组件、按键→命令），本文给**每一块的视觉、状态机、键位与契约绑定**。
> **绑定原则**：每个 UI 都说明它**消费哪些 `AgentStreamEvent`（agent §6.2）/ 调用哪些 `AgentHost` 方法（agent §6.1）**。UI 不持有业务状态——它只是 `reduceTrace`（cli §5.3）产出的 state 的一次渲染。
> 覆盖：设计语言（§1）、应用框架（§2）、会话视图/轨迹树（§3）、审批（§4）、Todo（§5）、输入区与斜杠命令（§6）、侧栏与切换器（§7）、会话树导航（§8）、Provider/模型/MCP/配置 视图（§9）、Provider 配置与鉴权（§10）、Headless 输出（§11）、首启/空态/帮助/退出（§12）、键位与通知总表（§13）。
> 编号：**本文件独立顺序编号**（§1–§13 + 附录 A）。自引用裸 `§x`；跨文件 `cli §x`（[cli-architecture.md](cli-architecture.md)）/ `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `desktop §x`（[desktop-architecture.md](desktop-architecture.md)）。

---

## 1. 设计语言与全局约定

终端 UI 的「设计系统」收敛为四件事：布局栅格、角色色板、状态字形、焦点模型。所有界面共用，保证一致。

### 1.1 布局栅格

整屏是一个垂直 Flexbox（OpenTUI/Yoga），固定四带：

```
┌─ TopBar ────────────────────────────────┐  height: 1   全局上下文（workspace + usage）
├─ Sidebar ─┬─ MainPane ──────────────────┤  flex: 1     主内容区（左栏可折叠）
│           │                             │
├───────────┴─────────────────────────────┤
│  Input / Overlay                         │  height: auto 输入区，或被 Overlay 覆盖
├─ HintBar ────────────────────────────────┤  height: 1   随焦点变化的键位提示
└──────────────────────────────────────────┘
```

- **Overlay 层**：审批条（§4）、切换器（§7）、帮助（§12.3）、确认框等以**浮层**盖在 Input 之上，不重排主区。
- **主区可被替换**：MainPane 在不同模式下渲染不同界面（会话视图 §3 / 会话树 §8 / 配置 §9），切换不动框架。

### 1.2 角色色板（语义而非具体色，随终端主题）

| 角色 | 用途 | 典型渲染 |
| --- | --- | --- |
| `accent` | 焦点/激活/可操作 | 高亮边框、当前选中行 |
| `success` | 完成、已批准、`run-finish` | ✓、completed todo |
| `warning` | 需审批、压缩、降级 | ⏸、⚠ 沙箱已关闭 |
| `danger` | 错误、拒绝、`isError` | ✗、红字 |
| `muted` | 次要信息 | 时间戳、token 数、提示文案 |
| `agent` | Agent 节点主色 | orchestrator vs 子 Agent 用字形+缩进区分，不靠颜色区分层级 |

> 取舍：**不依赖颜色传达关键语义**（色盲/单色终端兼容）——颜色是冗余强化，主信息走**字形 + 文字 + 缩进**。`NO_COLOR` 环境变量下全部降级为纯字形，不丢信息。

### 1.3 状态字形（贯穿所有界面）

| 字形 | 含义 | 来源事件/状态 |
| --- | --- | --- |
| `●` / `◐` | Agent 运行中 / 思考中 | `text-delta` 流入中 |
| `✓` | 步骤/run 完成 | `tool-result`(ok) / `run-finish` |
| `✗` | 错误 / 拒绝 | `error` / `tool-result`(isError) / reject |
| `⏸` | 等待审批 | `tool-approval-required` |
| `?` | 等待用户作答 | `user-question-required`（`askUserQuestion`，§4.1）|
| `✎` | 写文件 | `writeFile` / `applyPatch`（agent §3.1）|
| `⚙` | 执行命令 | `runCommand` |
| `↗` | 网络 | `httpFetch` / `webSearch` |
| `🔍` | 只读/检索 | `readFile` / `listDir` / `search` |
| `🔌` | MCP 工具 | `mcp__<server>__<tool>`（agent §3.5）|
| `▸` / `▾` | 折叠 / 展开 | 子 Agent、长结果 |
| `☐` `▶` `☑` | 待办 pending / in_progress / completed | `todo-update`（agent §3.7）|
| `⟲` | 压缩节点 | `compaction-start/-end`（agent §5.5）|

### 1.4 焦点模型

- 默认**输入框（`<textarea>`）持键盘**。没有常驻侧栏；任务面板是只读浮层（§5）。
- Overlay / 弹窗 / 全屏视图出现时**抢占键盘**：审批栏、`/sessions` 弹窗、配置弹窗（§9）、退出确认（§12.4）都会 blur 输入框、由全局 handler 接管（并 `preventDefault` 防止漏键）；会话树（§8）作为整屏视图挂载时其 `useKeyboard` 独占键盘。`Esc` 关闭浮层 / 退出视图、键盘归还输入框。
- `Tab` 用于斜杠命令补全（§6.2），不切面板。视图 / 弹窗内用方向键 / `j`/`k` 移动选中项。

### 1.5 响应式（按终端宽度降级）

主区是单栏全宽对话（无侧栏），随宽度自然回流。浮层（任务面板 §5、切换器 §7.2、配置 §9、确认 §12.4）绝对定位浮于其上。

> OpenTUI 经 `useTerminalDimensions()` 暴露终端尺寸，宽度变化即重渲（Solid 响应式重排），无需手工重绘。

---

## 2. 应用框架（App Shell）

主框架是常驻 chrome，包住所有界面。对应组件 `<App>`，cli §4.4 给了骨架，这里定义每块。

```
┌ ◆ acme/web ─────────────────────────────── ◷ 12.4k  $0.031  ⚙ sonnet-4.5 ┐  ← TopBar (§2.1)
│┌ WORKSPACES ─┐┌ Trace ───────────────────────────────────────────────┐│
││◆ acme/web   ││ ● Orchestrator                                        ││
││  payments   ││ │  我先看下现有鉴权实现…                                ││  ← MainPane (§3)
││ CHATS       ││ ├─ 🔍 readFile  src/auth.ts                    ✓      ││
││  查 API     ││ ├─ ✎ writeFile  src/auth.ts                    ✓      ││
││             ││ └─ ⚙ runCommand  pnpm test                     ⏸      ││
│├ TODO 1/3 ───┤│                                                       ││
││ ☑ 拆分模块   ││                                                       ││
││ ▶ 写迁移脚本  ││                                                       ││  ← Sidebar (§7)
││ ☐ 补测试    ││                                                       ││
│└─────────────┘└────────────────────────────────────────────────────┘│
│┌ Input ──────────────────────────────────────────────────────────────┐│
││ › 让它把测试也补上_                                                    ││  ← Input (§6)
│└──────────────────────────────────────────────────────────────────────┘│
│ ↵ 发送  / 命令  a/s/r 审批  ^C 中断/退出                                   │  ← HintBar (§2.2)
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 TopBar（全局上下文）

左侧会话名 + 右侧**工作目录全路径**。usage/ctx/cost 与模型名**不在 TopBar**——分别移到输入框下方的模型行右侧（§6.1）与左侧。

| 元素 | 内容 | 数据源 |
| --- | --- | --- |
| `◆ <title>`（左）| 当前活动 Session 名 | `listSessions()` 中 `isActive`（agent §1.1）|
| `<workingDir>`（右，muted）| 活动 workspace 的**完整工作目录路径**（无则 `scratch`）| `listSessions()` 的 `workingDir` |
| `⟲` (闪烁) | 压缩进行中 | `compaction-start` → `-end` 之间显示 |
| `● REMOTE` | 仅 daemon 模式（cli §8）连远端时 | `--server` 生效 |

> usage 读数 `◷ <tok>  ⛶ <ctx>/<win> <pct>%  $<cost>`（context % 按压力着色）渲染在**输入框第二行右侧**（与左侧的 `⚙ <model>` 同一行，§6.1）。
> **持久化**：累计 token/成本随每步写回 `session.usage`，上下文占用写回 `session.lastInputTokens`（agent host `persistUsage`）；重新进入会话时 `loadHistory` 用 `@set-usage` 从 session 恢复(context window 从模型 meta 取)，所以读数不再归零。

### 2.1.1 选中复制（copy-on-select）

整个窗口的文字默认 `selectable`（OpenTUI `<text>` 默认可选）。**鼠标拖拽选中即自动复制**到系统剪贴板——`useSelectionHandler` 防抖(150ms，只在松开后写一次)后用 **OSC 52** 转义序列(`\x1b]52;c;<base64>\x07`，tmux 下加 DCS passthrough)写剪贴板，本地与 SSH 均可，无需 pbcopy/xclip，并弹 toast「已复制选中文本」。

### 2.2 HintBar（上下文键位提示）

随**当前焦点面板 + 是否有待审批**变化，只显示此刻可用的键。审批待定时优先显示 `a/t/r`。这是 TUI 的「自文档化」——用户不必背键位（完整表见 §13）。

### 2.3 状态行 / Toast

run 级别的瞬时反馈（非阻塞）以**单行 toast** 从 HintBar 上方滑入、3s 自动消失：

- `✓ run 完成 · 4 步 · 1.2k tok` ← `run-finish`
- `✗ 错误：provider rate limited` ← `error`（持久，需 `Esc` 关，因为是故障）
- `⟲ 已压缩 150k → 4k tok` ← `compaction-end`（agent §5.5）

---

## 3. 会话视图（Trace Tree）—— 核心界面

MainPane 的默认内容，是整个 CLI 的心脏。它把 `AgentStreamEvent` 流（agent §6.2）渲染成**可导航、可折叠的运行轨迹树**，按 `agentId` / `parentAgentId` 归并（与桌面端 desktop §2 同一归并算法）。

### 3.1 节点类型与渲染

```
● Orchestrator                                    ← agent 根节点（agent §2.2）
│  把 callback 改成 async/await，并补测试。          ← assistant 流式文本（text-delta）
│
├─ 📋 updateTodos  3 项                      ✓     ← 规划工具（agent §3.7），结果折叠
│
├─ 🔍 readFile  src/auth.ts                  ✓     ← tool-call + tool-result
│     └ 142 行                                      ← 结果摘要（▸ 展开看全文）
│
├─ ✎ applyPatch  src/auth.ts                 ✓
│     └ +38 −12                                     ← diff 统计
│
├─ ▸ ⟳ delegateToSubAgent researcher「查 OAuth…」 ⏳ ⤷子代理日志（展开）← 默认折叠
│      ┄┄ 点击表头展开 ↓ ┄┄
│   ╭─────────────────────────────────────────────╮
│   │ ◐ 子代理 · researcher            运行中 · 24 行 │  ← 限高(随终端自适应)、带边框+底色的容器
│   │ ↗ httpFetch  api.github.com             ✓     │  ← 子代理日志在框内滚动，
│   │ 正在比较三种 OAuth 流程…                        │     不顶动主对话（§3.1）
│   ╰─────────────────────────────────────────────╯
│
├─ ⚙ runCommand  pnpm test                   ⏸     ← 等待审批（§4），节点高亮
│     授权范围 `pnpm *`                              ← grantScope 预览
│
└─ ⟲ 压缩  150k → 4k tok                            ← compaction 标记节点（agent §5.5）
```

| 节点 | 事件 | 折叠默认 |
| --- | --- | --- |
| Agent（orchestrator / sub） | `sub-agent-start` / `-finish` | 子 Agent 日志**默认折叠**为单行摘要；点击表头展开到**限高容器**（§3.2） |
| 流式文本 | `text-delta` 累积 | 始终展开 |
| 工具调用 | `tool-call` → `tool-result` | **结果默认折叠为摘要**，`▸` 展开全文 |
| 审批中 | `tool-approval-required` | 展开 + 高亮（§4）|
| 问答中 | `user-question-required` | 展开 + 高亮（§4.1）|
| 压缩 | `compaction-start/-end` | 单行标记 |
| 错误 | `error` / `tool-result.isError` | 展开、`danger` 标红 |

### 3.2 流式与增量渲染

- `text-delta` 追加到「当前 assistant 节点」的文本缓冲。assistant 正文用 OpenTUI 原生 `<markdown>`（标题/粗体/列表/代码块/表格）渲染：
  - **`streaming`**：run 进行中（`trace.status === "running"`）时置 `true`（尾块随 chunk 追加保持稳定），run 结束置 `false` 以**最终化尾块**（否则末尾代码块可能渲染不全）。
  - **`internalBlockMode="top-level"`**：每个顶层块（含代码围栏）作为独立、尺寸正确的 renderable。
  - 每行外层 `<box flexShrink={0}>`：防止 `<scrollbox>` 挤压/裁剪高内容（代码块），是「markdown 渲染不全」的根因修复。
  - 代码块语法高亮需 tree-sitter parser（markdown/js/ts 为 opentui 内置；其它语言要按需加载 wasm parser）；未加载时代码块仍正常渲染，只是无高亮。
- **推理（thinking）默认折叠**：`reasoning-delta` 累积进 `reasoning` 文本块，但**不直接展示真实内容**——只显示一行表头 `✻ thinking` + `▸ 展开`/`▾ 收起`。当它是**正在流式输出的尾块**（`run 进行中 && 是末行`）时表头跳动为 `thinking…`（`frame` 计数器由 `setInterval(350ms)` 驱动，仅 run 进行中运行）。点击表头（`onMouseUp`）展开真实推理文本。
- **工具调用默认折叠**：单行摘要即表头（`▸`/`▾` 前缀 + `toolGlyph 名称 入参摘要 状态 输出摘要`）；点击展开完整 `入参`/`↳ 输出`（`JSON.stringify` 美化，截断 2000 字符）。`tool-call` 先 `⏳`，`tool-result` 翻 `✓`/`✗`。
- **子代理日志装进固定高度容器（关键）**：`delegateToSubAgent` 生成的子代理轨迹挂在该工具节点的 `children` 上，但**不**被 `flattenTrace` 摊平进主轨迹的顶层行——`flattenTrace(state, { containSubAgent: true })` 遇到带 `children` 的委派工具即停止下钻，由工具行用 `SubAgentViewport` 把这段日志渲进一个**带边框（`rounded`）+ 底色（`theme.subAgent`）的限高 `<scrollbox>`**（`stickyScroll`/`stickyStart="bottom"` 跟随最新）。框高**随终端自适应**：`subAgentLogRows(termHeight) = clamp(⌊termHeight × 0.4⌋, 6, 22)`，由 `useTerminalDimensions()`（响应式）驱动，**resize 即时重算**——矮终端（如 18 行）约 7 行、高终端（如 50 行）约 20 行、再高封顶 22。子代理再吵，也只在这个框内滚动，**不会把主对话顶上去**。框内内容由 `flattenSubAgentLog(tool)` 单独摊平（深度从 1 起，嵌套子代理仍各自成框、不再摊平）。**默认折叠（关键）**：`showLog = hasLog() && open()`——**运行中也保持折叠**，只在表头显示一行摘要 + `⤷ 子代理日志（展开）` 提示，避免子代理日志默认占屏；点击表头（`tool:<id>`）才展开限高容器（运行中边框 accent 色 + `运行中 · N 行`，完成后转 muted 色）。展开后保持展开、不随完成自动收起。Headless（`ea run`，§11）不传 `containSubAgent`，仍按缩进摊平内联输出。
- **归位对事件顺序鲁棒（关键）**：**并行委派**下，编排者的委派 `tool-call(dX)`、子代理的 `sub-agent-start(subX, toolCallId=dX)`、子代理的流式内容（`text-delta`/`tool-call`…）来自**两条独立 emit 流**（编排者自己的流 vs. 各 `execute()`），三者到达顺序不定。若子代理的 start/内容先于其委派 `tool-call` 到达，节点会被挂到编排者下、整段日志摊平进主对话、而该委派工具行**无 children → 无展开按钮**（这正是「多子代理时只有最后一个有展开按钮、其余刷屏」的根因）。reducer 用 `AgentItem.spawnedByToolCallId` 记录归属，并在三处保证最终归位到委派工具下（连同已流式的子树）：① `sub-agent-start` 时工具已在 → `ensureAgent` 直接挂到工具；② `sub-agent-start` 时工具未到 → 暂挂编排者并记下 `spawnedByToolCallId`；③ 委派 `tool-call` 落地 → `rehomeSubAgentsForTool` 把认领该工具的子代理（用 `detachItem` 从原父摘除后）移入工具 `children`。④ 内容先于 start → `ensureAgent` 命中已存在节点时，若带 `attachTo` 且尚未在其下，同样 `detachItem` 后改挂。四条路径幂等（`children.includes` 守卫），任何到达顺序最终都「每个子代理各归其委派工具」。
- 折叠状态 = 一个 `expanded` Set 信号，id 用 `think:<行key>`（按位置，切会话清空）/ `tool:<toolCallId>`（全局唯一）；点击 `toggle(id)`。
- Solid 的细粒度响应式只更新变化的节点；轨迹用 `<Index>`（按位置 key）而非 `<For>`（按引用 key），避免每个 `text-delta` 重建整列（闪烁/抖动），长会话也不闪屏。

### 3.3 导航与折叠

| 操作 | 键 | 行为 |
| --- | --- | --- |
| 上/下移动选中节点 | `↑`/`↓` 或 `k`/`j` | 选中态高亮 |
| 展开/折叠 | `→`/`←` 或 `Enter` | 子 Agent 子树、工具长结果 |
| 跳到底部（跟随流） | `G` / `End` | 取消手动滚动，重新跟随最新 |
| 全部折叠/展开子 Agent | `z` | 长任务降噪 |
| 在选中节点分叉 | `f` | → 会话树导航（§8），`forkFrom` |
| 复制选中节点内容 | `y` | 工具结果/文本到剪贴板 |

> **跟随 vs 浏览**：默认「跟随」最新事件自动滚到底；用户一旦上滚即进入「浏览」态、停止自动滚（避免新事件把视线拽走），`G` 回到跟随。右下角小标 `↑浏览中` 提示。

### 3.4 空态

新建会话未发消息时，MainPane 显示**目标 + 引导**：

```
        ● Work: 重构鉴权
        目标：把 src/legacy 的 callback 改成 async/await

        ↓ 在下方输入第一条消息开始，或 /plan 让它先规划
```

---

## 4. 审批（Approval Overlay）

agent §3.3 三态审批的终端落地。收到 `tool-approval-required` → 该工具节点进入 `⏸` 态（§3.1），同时底部弹 **ApprovalBar 浮层**（盖在 Input 上，抢焦点）。

```
┌ ⏸ 需要审批 ─────────────────────────────────────────────┐
│  ⚙ runCommand                                           │
│     pnpm test --runInBand                               │  ← 完整入参（input）
│                                                         │
│  授权范围   本会话内自动批准  pnpm *                       │  ← grantScope（agent §3.3 授权键）
│  调用链     Orchestrator › Sub#researcher                │  ← 子 Agent 才显示（agent §3.4）
│  沙箱       ✓ landstrip（写边界 /repo）                   │  ← 当前沙箱状态（agent §4.1）
│                                                         │
│  [a] 单次批准   [s] 本会话批准   [r] 拒绝   [d] 查看详情     │
└─────────────────────────────────────────────────────────┘
```

| 状态 | 说明 |
| --- | --- |
| 唤起 | `tool-approval-required` 到达；Input 置灰（§6.3），HintBar 切到 `a/t/r` |
| 决策 | `a`/`t`/`r` → `host.approveTool(toolCallId, 'once'\|'session'\|'reject')`（直接调用，cli §4.4）|
| `t` 反馈 | 浮层关闭，节点旁标 `session✓`，后续同 `grantScope` 调用自动放行（toast：`已放行 pnpm * · 本会话`）|
| 详情 | `d` 展开 `input` 全文 / 沙箱策略（长命令、大 patch）|
| 多个待批 | 队列化：一次只显一个，右上角 `1/3` 计数；批完自动弹下一个 |
| 子 Agent | 调用链行点明「是谁在请求」，审批主体仍是用户（agent §3.4 不变量 1）|

> 取舍：审批做**浮层而非整屏**——用户能同时看到上方轨迹（工具节点在哪、上下文是什么），决策不脱离语境。整屏会切断「这是哪一步」的感知。

### 4.1 问答（Question Overlay）

审批的**孪生体**:审批是内核**拦截**高危调用,问答是模型**主动**发问。编排 Agent 调内置 `askUserQuestion` 工具(agent §3.7,Work 作用域,子 Agent 不持有)即可在任务执行中途暂停,弹一组单/多选题让用户拍板。底层走与审批**同一条往返桥**:工具体 `await questions.ask()` 挂起 → 收到 `user-question-required` → 用户选 → `host.answerQuestion()` → 选项作为 `tool-result` 喂回模型继续(agent §6 命令/事件)。

收到 `user-question-required` → 该工具节点进入 `?` 态(§3.1,accent 色),底部弹 **QuestionBar 浮层**(盖在 Input 上、抢焦点,与 ApprovalBar 同位)。

```
┌ ? 请选择 (1/2)  数据库 ──────────────────────────────────┐  ← header;多问时显 n/m
│  迁移用哪种存储?                                          │  ← question 全文
│  ▸ PostgreSQL — 强一致,适合关系型                         │  ← 单选:▸ 高亮当前项
│    SQLite — 零依赖,适合本地                               │
│                                                          │
│  ↑↓ 选择 · ↵ 确认 · Esc 跳过                              │
└──────────────────────────────────────────────────────────┘

多选题(multiSelect)时每项前加复选框:
│  ▸ [x] 单元测试    [ ] 集成测试    ↑↓ 移动 · 空格 勾选 · ↵ 确认 · Esc 跳过
```

| 状态 | 说明 |
| --- | --- |
| 唤起 | `user-question-required` 到达;Input 置灰(§6.3),节点转 `?`;选择游标 `qState` 重置为首题首项 |
| 移动 | `↑/↓` 在当前题的选项间移动高亮(`oi`) |
| 勾选 | 多选题 `空格` 切换当前项的选中态(`picked[qi]`);单选题靠高亮即选中 |
| 确认 | `↵` 提交当前题:多题则翻到下一题(`qi+1`),末题则 `host.answerQuestion(questionId, answers)`,answers 与 questions 同序对齐 |
| 跳过 | `Esc` → `host.answerQuestion(questionId, null)`(忽略);工具回报「未作答」,模型自行决断 |
| 范围 | 1–4 题、每题 2–4 选项;问答互斥于审批(同一时刻至多一个浮层) |

> 与审批一致的不变量:存在待答问题时 **blur 输入框**、所有按键吞掉不漏进 textarea、abort 时 `questions.cancelAll()` 兜底解挂(agent §3.3 / cli §6.3)。无人值守的 `ea run` 对问题默认回 `null`(跳过),防止挂死(cli §6.2,同审批 reject 精神)。

---

## 5. 任务面板（浮动 Todo）

**没有常驻右侧栏**（早期设计有 Sidebar 放 任务/产出物/引用；已移除以让对话占满主区）。任务面板是一个**从右上角浮出的弹层**（`position="absolute" top={1} right={0}`，盖在对话之上），渲染当前会话计划（agent §3.7）。数据来自 `todo-update` 事件（全量替换）。

```
                                   ┌ 任务 1/3 ──────┐
                                   │ ☑ 拆分鉴权模块   │   ← completed（success）
                                   │ ▶ 写迁移脚本     │   ← in_progress（accent，高亮）
                                   │ ☐ 补单元测试     │   ← pending（muted）
                                   └────────────────┘  （浮于对话右上角）
```

- **出现时机**：`todo-update` 带来非空 todos 时弹出（任务创建即现）。
- **消失时机**：任务跑完后面板**留在原处**显示完成态；用户发出**下一条消息**时隐藏（send 置 `todoDismissed`），直到下一轮再产生 todos 重新弹出。
- 标题 `任务 n/m` = 完成数/总数；**单焦点**：至多一个 `▶ in_progress`（agent §3.7 约定）。
- 只读：用户不直接编辑 todo（它是 Agent 的规划产物）。

---

## 6. 输入区（Prompt）与斜杠命令

MainPane 下方常驻输入框，是 OpenTUI 原生 `<textarea>`（IME 安全、原生多行），cli §4.4 给了 `onSubmit`。回车键位：OpenTUI 默认把裸 `Enter` 绑成换行，这里改绑 `Enter`→提交、`Shift+Enter`→换行；裸 `↑/↓` 也从光标移动解绑，让它们驱动斜杠菜单 / 切换器（§6.2 / §7.2）。

### 6.1 多行输入

输入容器为 **2 行**：第一行是 `<textarea minHeight={1} maxHeight={8}>`（多行时向上长），**同一容器内第二行**是**当前模型**（`⚙ <providerId>:<modelId>   /model 切换`，§6.4）。二者共享同一左侧 `┃` 边框条与面板底色。容器有**上下 padding**（`paddingTop/Bottom=1`）作呼吸感，两行之间留**一行间隔**（`marginTop=1`，终端无法渲染字面「半行」，取最小可见间隔）。

```
┃                                                            ← 上 padding
┃ 把测试也补上，并且确保覆盖 OAuth 回调分支_                  ← 输入（Shift+↵ 换行，↵ 发送）
┃                                                            ← 行间隔（≈半行）
┃ ⚙ claude-opus-4  /model 切换        ◷ 69.9k ⛶ 28.5k/512k 6% $0.027   ← 模型（左）+ usage（右，§2.1）
┃                                                            ← 下 padding
```

第二行用 `justifyContent: space-between`：左侧当前模型（§6.4），右侧 usage/ctx/cost 读数（从 TopBar 移来，§2.1）。

| 键 | 行为 |
| --- | --- |
| `Enter` | 发送 → `host.sendMessage(ref, text)`（返回 `runId`，开始流）|
| `Shift+Enter` | 插入换行（多行）|
| `↑`/`↓` | 斜杠菜单 / 切换器打开时移动高亮（§6.2 / §7.2）；否则无操作 |
| `Ctrl-U` | 清空 |
| `/` (行首) | 唤起斜杠命令菜单（§6.2）|
| `!` (行首) | 进入 **Shell 转义命令模式**（§6.2.1）|

### 6.2.1 Shell 转义（`!cmd`）

行首 `!` 且**单行**时进入命令模式：输入框左侧边框从**绿变蓝**（`theme.info`），第二行提示 `! 命令模式 · ↵ 直接执行 shell（不经模型）`。`↵` 把 `!` 之后的整行交给 `sh -c` 在**当前会话工作目录**（无则 `process.cwd()`）直接执行——**绕过模型与 agent 审批/沙箱**，捕获 stdout+stderr（截断 16KB）+ 退出码，作为 `shell` 轨迹项内联回显：

```
! ls -la
total 24
drwxr-xr-x  ...                  ← 退出码 0：灰色输出
! false
 (exit 1)                        ← 非 0：红色 (exit N) + 红色输出
```

- 仅**行首 `!` 且无换行**才算（多行 `!…` 当普通消息走模型）；`!ls -la` 中空格后为命令参数，管道/通配符因走 `sh -c` 自然可用。
- 这是面向 power-user 的逃生舱，等价 REPL 的 `!`：执行用户自己敲的命令、用户自身权限、不弹审批。命令与输出是**本地 UI 项，不入 `session.jsonl`**，不参与模型上下文、刷新历史后不重现。

### 6.2 斜杠命令（行内命令面板）

行首打 `/` 在输入框上方弹自动补全菜单，覆盖那些「不值得占一个按键」的会话级操作：

```
┌────────────────────────────────┐
│ ▸ /sessions  切换会话            │  → 切换器弹窗（§7.2）   ← ▸ 当前高亮
│   /new       新建会话            │  → host.createSession(...)
│   /clear     清屏（不删历史）     │
│   /compact   压缩当前上下文        │  → host.compact(id)（agent §5.5）
│   /model     切换当前模型          │  → 模型弹窗（§6.4）
│   /fork      会话树 / 分叉         │  → 进会话树（§8）
│   /config    Provider/模型/MCP/配置│  → 配置弹窗（§9）
│   /exit      退出 TUI             │  → host.dispose() 后退出（§12.4）
│ ↑↓ 选择 · Tab 补全 · ↵ 执行       │
└────────────────────────────────┘
```

- 输入即模糊过滤（按命令名）；高亮项随过滤重置到首项。
- `↑↓` 移动高亮；`Tab` 把高亮命令补全进输入框（`/sessions `，便于追加参数）；`↵` 执行——精确首词匹配优先，否则执行当前高亮项。
- 菜单只在输入框聚焦、草稿以 `/` 起时出现；`↑↓/Tab` 在全局键盘 handler 里处理（裸 `↑↓` 已从 `<textarea>` 解绑，见 §6.1），输入框保持聚焦以便继续过滤。

### 6.4 切换模型（`/model`）

`/model` 弹出一个**居中模态**，列出**当前 orchestrator 模型所属 provider 下的全部模型**（`listProviderModels(providerId)`，`providerId` = 当前 ref `<providerId>:<modelId>` 的前缀），当前模型用 `◆` 标记。输入过滤 · `↑↓` 选 · `↵` 切换 · `Esc` 取消（弹窗打开时输入框 blur，键走全局 handler）。

- **作用域**：有活动 Session 时写**会话级覆盖**（`updateSessionConfig` 把 `{alias: orchestratorAlias, ref}` 加进 session 的 `ScopedConfig.aliases`，该会话下次 run 生效）；无活动 Session 时写全局别名（`saveGlobalAliases`，新会话生效）。切换后输入框下的模型行立即更新。
- **只换模型、不换 provider**：模型列表全部来自当前 provider，所以新 ref 仍是同一 provider。跨 provider 改绑走 `/config`（§9.2）。

### 6.5 禁用态

审批待定（§4）时输入框 blur、键盘交给审批栏（a/s/r）；`/sessions`/`/model`/`/config`/退出确认 等弹窗打开时输入框同样 blur，由全局 handler 接管（并 `preventDefault` 防漏键，见 §1.4）。

---

## 7. 单 Session 聊天模式与切换器

**TUI 默认是单 Session 聊天模式**：MainPane 全宽渲染**当前一个 Session** 的对话（无常驻 Session 侧栏），让聊天为唯一焦点。切换/新建 Session 走**浮层切换器**，不占主区。

### 7.1 当前 Session（全宽聊天）

- 主区只显示活动 Session 的轨迹树（§3）+ 输入框（§6）；计划（todo）以**贴近输入框上方的窄条** `TodoPanel` 显示（§5），无 todo 时隐藏。
- TopBar 显当前 Session 名 + usage + 模型（§2.1）。

### 7.2 Session 切换器（`/sessions`）

`/sessions` 唤起一个**居中弹窗**（`position="absolute"` 全屏覆盖 + `alignItems/justifyContent: center` + 高 `zIndex`），抢键盘、不动主区。打开时输入框 **blur**，弹窗自管全部输入（打字过滤、`↑↓` 选、`↵` 切、`Esc` 取消）：

```
        ┌ 切换会话 （输入过滤 · ↑↓ 选择 · ↵ 切换 · d 删除 · Esc 取消）┐
        │  › auth_                                                  │
        │  ▸ ◆ 重构鉴权     · /repo                                  │  ← ▸ 高亮；◆ 当前会话
        │      修复鉴权回调  · /repo                                  │
        │      鉴权方案调研  · scratch                                │  ← 无工作目录 → scratch
        │  删除「鉴权方案调研」？ y 确认 · 其他键取消                   │  ← 按 d 后的确认行（红框）
        └───────────────────────────────────────────────────────────┘
                       （屏幕居中浮于会话视图之上）
```

- 数据：`listSessions()`（统一一份）；输入即模糊过滤（name + workingDir），过滤变化时高亮重置首项。
- `↑↓` 移动高亮 · `↵` 切到高亮 Session（UI 直接切渲染 + `getSessionTree` 重建历史，§4.6）· `Esc` 取消。
- **删除**：选中后按 `d` 进入删除确认（弹窗边框转红 + 确认行），再按 `y` 调 `deleteSession(id)`，其他键取消；删的是活动 Session 时清空主区。`d` 在切换器里**保留作删除键**（不参与过滤），其它字符仍过滤。
- 弹窗的输入由全局键盘 handler 驱动（输入框 blur，故打字/`↑↓`/`↵`/`d`/`y` 都落到 handler）。`Tab` 不再触发切换器——它在 §6.2 用于斜杠命令补全。

#### 7.2.1 新建会话（`/new`）

`/new` 唤起一个**居中弹窗**（与切换器同款），输入新会话的**工作目录**（留空=当前目录），`↵` 创建前 `existsSync` 校验（不存在则红字报错、不创建），`Esc` 取消。创建后自动切到新会话。同样输入框 blur、全局 handler 接管输入。

> **自动起标题（§1.1）**：新会话名默认占位 `新会话`；只要名字仍是该默认值，**第一轮交流结束（`run-finish`）后**用 `generateTitle`（host 提示「不超过 10 个字」）生成摘要、`renameSession` 替换之，TUI 再按码点**硬截到 ≤10 字**。**title-gen 失败/为空时**（模型不可用/无 key）回退到**首条用户消息的前 10 个字**，确保默认名仍被替换。用户/Agent 已改过名的会话不动（默认名是唯一门槛，自限一次）。

### 7.3 Headless 切换

`ea session switch <id>` 设活动 Session；`ea session ls` 列出全部；`ea session rm <id>` 删除。

---

## 8. 会话树导航（Branch Navigator）

按 `f`（§3.3）或 `/fork` 进入。把 agent §5.4 的**会话树**（分支/checkpoint/压缩点）摊开成可导航的树，对应 `getSessionTree(ref)`。

```
┌ 会话树  ·  acme/web › 重构鉴权 ──────────────────────────────┐
│ ● e01  user      「把 callback 改 async」                    │
│ │                                                           │
│ ├─ e02 assistant  方案 A：逐文件改写            🏷 baseline   │  ← label/checkpoint
│ │   └ e05 …（当前 HEAD ◀）                                   │  ← headEntryId（agent §5.3）
│ │                                                           │
│ └─ e03 assistant  方案 B：引入适配层  （另一分支）             │  ← fork 出的旁支
│       └ e04 ⟲ summary  150k→4k                             │  ← 压缩 checkpoint（agent §5.5）
└─────────────────────────────────────────────────────────────┘
  ↑↓ 选  ↵ 切到此节点  f 从此分叉  l 命名  c 克隆为新Work  Esc 返回
```

| 操作 | 键 | 调用 |
| --- | --- | --- |
| 切活动路径到某节点 | `Enter` | 内部移动 HEAD（追加 `head` 事件，agent §5.3）|
| 从历史节点分叉 | `f` | `forkFrom(ref, entryId)`（agent §5.4）|
| 命名 checkpoint | `l` | `labelEntry(ref, entryId, label)` |
| 克隆路径为新 Work | `c` | `cloneToSession(ref, leafId)` → 新 `workId` |
| 返回会话视图 | `Esc` | HEAD 对应路径回到 §3 |

- `◀ 当前 HEAD` 标记活动叶；切节点后 §3 的轨迹按新路径重建（todo 也随路径重算，agent §3.7）。
- summary 节点（`⟲`）即压缩基线，标注 `tokensBefore→After`。

> 取舍：fork/branch 在桌面端是可视树（desktop §2），终端用**缩进 + 分支线**表达同一结构。旁支用「另一分支」标注、HEAD 用 `◀`，让「我在哪条路径上」一眼可辨——这是树导航的关键认知。

---

## 9. Provider / 模型 / MCP / 技能 / 配置 视图

`/config` 打开一个**居中模态弹窗**（`position="absolute"` 全屏覆盖 + 居中 + 高 `zIndex`，浮于对话之上；对话仍渲染在后面，输入框 blur），`Esc` 关闭归还键盘。只读为主的检视界面（新增/编辑走 §10 向导或 `ea * config`，agent §5.2）。复用核心导出的 `ConfigStore` / `ModelMetaRegistry` / `SkillRegistry` + `listProviderModels`（cli §7 / agent §2.6）。

### 9.1 Providers（`ea provider ls`）

Provider 是模型来源的**接入配置**（全局，agent §2.6 / domain `ProviderConfig`）：一个 `kind` + 用户自定 `id` + 可选 `baseURL` + `keyRef`。**同一 kind 可有多个 provider**（如多个 `openai-compatible` 各连不同服务），模型 ref = `<id>:<modelId>`。

```
┌ Providers  （全局接入，agent §2.6） ─────────────────────────────────────┐
│ id         kind               baseURL                  key  模型  状态    │
│ anthropic  anthropic          —（官方）                ✓    3*   ● 启用   │  ← *无端点，纯内置
│ openai     openai             —（官方）                ✓    38   ● 启用   │
│ deepseek   openai-compatible  api.deepseek.com/v1      ✓    14   ● 启用   │
│ ollama     openai-compatible  localhost:11434/v1       —    9    ● 启用   │  ← 本地无需 key
│ groq       openai-compatible  api.groq.com/openai/v1   ✗    0    ○ 停用   │  ← 缺 key
└──────────────────────────────────────────────────────────────────────────┘
   n 新增   e 启用/停用   k 设置/更新 Key   r 刷新模型   ↵ 看模型   Esc 返回
```

| 列 | 含义 / 数据源 |
| --- | --- |
| `id` / `kind` | 用户自定键 / 接入类型（agent domain `ProviderKind`：anthropic·openai·google·openai-compatible·gateway）。`ConfigStore.loadProviders()` |
| `baseURL` | 官方 kind 显「—」（用内置端点）；`openai-compatible`/`gateway` 必填（含版本前缀，如 `…/v1`，agent §2.6） |
| `key` | `✓` 已配 / `✗` 缺 / `—` 不需（本地端点）。`KeyStore` 查 `keyRef` 是否存在（不显明文，agent §4） |
| `模型` | `listProviderModels(id)` 发现数（24h 缓存，agent §2.6）；`*` 表纯内置（anthropic 无端点） |
| `状态` | `ProviderConfig.enabled`，仅启用的 provider 进 `ModelRegistry`（agent §2.6） |

- `n` 新增 → 走 §10 Provider 配置向导；`k` 更新 key → §10 步骤 3；`e` 切 `enabled` 写 `providers.json`（`ConfigStore.saveProviders`）；`r` → `listProviderModels(id, {refresh:true})` 绕缓存重拉；`↵` 看该 provider 的模型清单（喂 §9.2 选择器）。
- **粘贴**：Key / 预设搜索 / 模型过滤这些单行输入支持粘贴——粘贴在终端是独立的 `paste` 事件（非按键），所以 ConfigView 用 `usePaste` 把粘贴文本(解码 + 去 ANSI/控制符)追加到当前激活的字段；否则像 keychain Key 这种只能逐字敲、无法粘贴。
- **kind 决定能力边界**：`anthropic` 无 models 端点（计数标 `*`，纯内置）；`openai-compatible`/`gateway` 缺 `baseURL` 不可用；localhost 端点（Ollama/vLLM/LM Studio）跳过 key（agent §2.6 发现表）。

### 9.2 模型（`ea models` / `/model`）

```
┌ 模型别名  （global → session 覆盖后生效值） ──────────────────────┐
│ 别名          → ref                       ctx     能力          $/Mtok │
│ orchestrator → anthropic:claude-sonnet-4.5 200k   tools struct  3/15   │  ← 当前 ws 生效
│ fast         → anthropic:claude-haiku       200k   tools         0.8/4  │
│ reasoning    → openai:o3                    200k   tools reason  …      │
│ vision       → google:gemini-2.5-pro        1M     tools vision  …      │
│                                                                        │
│ ⚠ research 别名解析到的模型不含 `tools` 能力——子 Agent 会失败          │  ← 能力校验（agent §2.6 pt.2）
└────────────────────────────────────────────────────────────────────────┘
```

- 列：别名 → `ref`、`contextWindow`、`capabilities`、`price`（agent domain `ModelMeta` / `ModelAlias`）。
- 标注作用域来源（global vs session 覆盖）与能力校验告警。
- **可选模型选择器**：新建/改别名时按 `o` 唤起 picker——**先选 provider**（来自 §9.1 已启用列表），再从该 provider 的 `listProviderModels`（agent §2.6 模型发现）拉到的 id 里挑 ref，而非手打。

```
按 o 选模型（orchestrator 别名）→ 先选 provider「openai」，再选模型：
┌ 可选模型  openai  · 动态 36 + 内置 2 ──────────────────┐
│ › gpt_                                                │  ← 模糊过滤
│ ▸ openai:gpt-4.1          1M   tools struct    ✓meta  │
│   openai:gpt-4.1-mini     1M   tools           ✓meta  │
│   openai:gpt-5-preview    ?    ?               无定价  │  ← 动态发现但无 meta → FALLBACK
└────────────────────────────────────────────────────────┘
```

- 列表 = `union(动态拉到, 内置已知)`（agent §2.6：合并不替换）；标 `✓meta`（有 `ModelMeta`，能算成本/触发压缩）vs `无定价`（回退 `FALLBACK_META`，agent §2.7）。
- `ea models --refresh` 绕过 24h 缓存强制重拉；拉取失败静默用内置兜底，不报错阻塞。

### 9.3 MCP Servers（`ea mcp ls`）

MCP server = 外部工具来源（agent §3.5）。列表 = **当前会话生效作用域**内合并后的 server——global + 该 Session 的覆盖（同名覆盖）。`enabled` 的会在会话启动时连接、其工具进 Agent 工具集。

```
┌ MCP Servers   作用域: <session>（global + session）─────────────────────┐
│   name        transport  risk     scope       状态                       │
│ ▸ github      stdio      network  global      ● 已连 12 工具             │
│   filesystem  stdio      write    workspace   ● 已连 6 工具              │
│   jira        http       network  workspace   ✗ 连接失败                 │  ← error 事件标红
│   slack       sse        network  global      ⊘ 已停用（enabled=false）  │
└───────────────────────────────────────────────────────────────────────────┘
   ↑↓ 选   a 新增   e/↵ 编辑   t 启停   d 删除   Esc 返回

（无 session 覆盖时仅显示 global 行）
```

新增/编辑弹窗（`a` 或 `e`/`↵`）——逐字段表单，`↑↓` 选字段、`←→` 切枚举/布尔、输入即编辑、`↵` 保存、`Esc` 取消：

```
╭ 新增 MCP Server ──────────────────────────────╮
│ ▸ 名称      srv1▌                              │
│   传输      ‹ stdio ›                          │
│   命令      node                               │
│   参数      空格分隔                           │
│   环境变量  K=V,逗号分隔                       │
│   风险级别  ‹ — ›                              │
│   启用      ✓ 是                               │
│   作用域    ‹ session ›   （仅有活动会话时）   │
│ ↑↓ 选字段 · ←→ 切换 · 输入编辑 · ↵ 保存 · Esc 取消 │
╰───────────────────────────────────────────────╯
```

- 字段随 `传输` 变化：`stdio` → `命令`/`参数`/`环境变量`；`sse`/`http` → `URL`/`请求头`。`参数`空格分隔；`环境变量`/`请求头`为 `K=V` 逗号分隔，值写 `${ref}` round-trip 成 `McpKeyRef`（agent §3.5）。
- 校验失败（名称空、含 `/`、stdio 缺命令、http 缺 URL）在弹窗内标红，不关闭。
- 保存 → `ConfigStore.saveMcpServer(cfg, scope==='session'?sessionId:undefined)`（每 server 一个 JSON）；改名/换作用域时先 `removeMcpServer` 旧文件避免遗留。`作用域` 字段仅在有活动 Session 时出现（否则恒 global）。
- `t` 切 `enabled`（下次会话生效）；`d` → `删除「name」？ y 确认 · 其他键取消` → `removeMcpServer`。

| 状态 | 含义 |
| --- | --- |
| `● 已连 N 工具` | enabled + 当前会话已连接，N 个 `mcp__<server>__<tool>` 进工具集（agent §3.5）|
| `✗ 连接失败` | enabled 但连接出错（`error{runId:'mcp'}`，agent index.ts mcpHub 回调）|
| `⊘ 已停用` | `enabled=false`，列出但不连接 |

- 数据：`ConfigStore.listMcpServers(sessionId?)`（agent §3.5）——传该 Session 的 id（global + session 合并）；不传 → 只返回 global。运行时连接态由启动连接结果 + `error{runId:'mcp'}` 事件推出。
- `scope` 标 global vs session（session 同名覆盖 global）；`a` 新增、`e`/`↵` 编辑（弹窗）、`t` 切 `enabled`（下次会话生效）、`d` 删除（agent §3.5）。

### 9.4 Skills（`ea skill ls`）

技能 = 按需加载的知识/流程（agent §3.6，Agent Skills 标准：目录 + `SKILL.md`）。**渐进式披露**：启动只注入各技能 `description`，匹配 / `/skill` 时才载入完整正文。列表 = **当前会话生效作用域**内合并后的技能——global + 该 Session 的覆盖（同名覆盖）。

```
┌ Skills   作用域: <session>（global + session）──────────────────────────┐
│   name          description              tools       调用   scope     状态  │
│ ▸ pdf-extract   从 PDF 抽取文本与表格…    readFile…   自动   global    ◉ 已载入│
│   db-migrate    生成并执行迁移…           runCommand  自动   global    ○      │
│   release-notes 生成发布说明…             —           手动*  workspace ○      │  ← *disable-model-invocation
└───────────────────────────────────────────────────────────────────────────┘
   ↵ 看 SKILL.md 正文   /skill:<name> 载入   a 导入   o 打开目录   Esc 返回

（无 session 覆盖时仅显示 global 行）
```

| 列 / 状态 | 含义 / 数据源 |
| --- | --- |
| name / description | `SkillRegistry.list()`（agent §3.6）；description 即注入提示的「可用技能」清单（`catalog()`）|
| tools | `allowed-tools` 收敛的工具集（空 = 不额外限制）；被子 Agent 继承仍受 role 硬门（agent §3.4）|
| 调用 | 「自动」= 模型可自调；「手动*」= `disable-model-invocation`，仅 `/skill:<name>` 显式载入 |
| scope | global `~/.enterprise-agent/skills/` vs session（覆盖，agent §5.2）|
| `◉ 已载入` | 当前会话已注入其正文（渐进式披露，进上下文受 §5.5 压缩管理）|

- 数据：`SkillRegistry([global, sessionSkills?])`——含该 Session 的 skills 根（与运行时 buildSession 一致）。
- `↵` 看正文（`SkillRegistry.load`）；`/skill:<name>`（§6.2）把正文作为额外 instructions 注入当前会话；`a` 导入 `SKILL.md` 包（兼容 Anthropic/pi）；`o` 打开目录看 `scripts/` `references/` `assets/`。
- **安全**：技能携带的脚本走与普通命令相同的审批 + 沙箱（agent §3.6 / §4.1），不因来自技能而豁免。

#### 9.4.1 子 Agent（自生成式，v0.7）

**已无预定义子 Agent，故无 `ea agent` 命令**（v0.7 取消，dynamic-subagents §D1）。子 Agent 由 Orchestrator 在委派时**按需合成**（能力集 + 任务 prompt），跑完即弃；唯一可配的是**能力包络**——见 §9.5 的 `ea config dynamic-subagents`（默认开启 + 全能力，运营方按需收敛/熔断）。运行中的子 Agent 轨迹仍内联在 `delegateToSubAgent` 工具节点下的限高容器里（§9.4 子代理日志）。

### 9.5 配置概览（`ea config` / `/config`）

只读展示生效配置链：`global settings.json` → `session.config` 合并结果（agent §2.5），逐项标来源。沙箱开关、`compactRatio`、`maxConcurrency`、权限策略、**只读根 `readRoots`** 一览，并对「⚠ 沙箱已关闭」显著标注（agent §4.1）。

```
 orchestrator    opus
 sandbox         ✓ 启用
 maxConcurrency  4
 maxSteps        50
 readRoots       /Users/me/.enterprise-agent             ← 只读根（agent §4.2）；缺失目录标「（缺失）」
 动态子Agent     ✓ 启用 caps=[read,write,exec,http] mcp=all   ← 自生成式子 Agent 能力包络（dynamic-subagents §D2）
```

可原地切的开关（写**会话级覆盖** `updateSessionConfig`，与沙箱一致；无活动 Session 时提示按 Session 设置）：

| 键 | 作用 |
| --- | --- |
| `s` / `n` | 切沙箱 / 切沙箱网络（agent §4.1） |

- **动态子 Agent 能力包络** = `ScopedConfig.dynamicSubAgents`（dynamic-subagents §D2），默认**开启 + 全能力**。headless 读写：`ea config dynamic-subagents`（别名 `dyn`）+ 子命令 `on|off|default`（熔断）、`caps <read|write|exec|http…>`（能力天花板）、`mcp all|none|<servers…>`（MCP 上限）、`timeout <ms|off>`、`model <alias>`、`eval on|off|always|on-failure|model <alias>`。global `off` 单向生效（session 不能反开）。每个高危动作仍走当前 mode 的审批门 + 沙箱。

- **只读根 `readRoots`** = `ScopedConfig.readRoots`（agent §4.2），默认**空**。一组**只读 + 可运行、绝不可写、且 agent 文件工具够不着**的目录，与技能根同一条边界通道；典型用途是把配置目录（如 `~/.enterprise-agent`）暴露给会话内的子进程而不放宽可写边界。按 **global ∪ scope 去重并集**合并（scope 只能追加，不能移除全局根）。headless 读写（写**全局** `settings.readRoots`）：
  - `ea config read-roots`（别名 `rr`）——列出当前根，缺失目录标 `⚠ 缺失`，并打印子命令用法
  - `ea config read-roots add <dir…>`——新增；相对路径按当前目录解析为绝对路径，去重；目录不存在会提示「构建会话时将被跳过」
  - `ea config read-roots remove <dir…>`（别名 `rm`）——按解析后的绝对路径移除；清空后该键从 `settings.json` 删除
  - `ea config read-roots clear`——清空
  路径按原样使用（不展开 `~`/`$ENV`，填绝对路径）；不存在的目录在会话构建时静默丢弃。子进程可读、可作 exec `cwd`，但写仍只能回工作区；`readFile`/`listDir` 仍够不着。Gateway 可按通道单独配（gateway §7）。详见 [docs/read-roots.md](../docs/read-roots.md)。

---

## 10. Provider 配置与鉴权（`ea provider add` / `ea auth`）

新增/配置一个 Provider = **选 `kind` → 定 `id`/`baseURL` → 写 Key → 拉模型**。产出一条 `ProviderConfig`（agent §2.6，存 `providers.json`，**只含 `keyRef` 不含明文**）+ keychain 里的密钥。可在 TUI 内 `/provider` 或独立 `ea provider add` / `ea auth login` 跑。

```
步骤 1/4  选择 kind                       （决定端点形态与能力，agent §2.6）
  ▸ anthropic   ◯ openai   ◯ google   ◯ openai-compatible   ◯ gateway

步骤 2/4  Provider id 与端点
  id      › deepseek                      ← providers.json 的键 + 模型 ref 前缀
  Base URL› https://api.deepseek.com/v1   ← 仅 openai-compatible/gateway 需要；
                                            官方 kind（anthropic/openai/google）免填

步骤 3/4  输入 API Key
  › sk-•••••••••••••••••••••••••          ← 输入即掩码，不回显明文、不入历史
  （本地端点 localhost 可留空 → agent §2.6：本地无需 key）

步骤 4/4  ✓ 写入 keychain（keyRef = deepseek.key）；providers.json 只存引用 + enabled
          ↓ 自动 listProviderModels（agent §2.6 模型发现）…
          ✓ 发现 14 个模型 · 已缓存 24h
            （anthropic 无端点 → 用内置列表；拉取失败静默回退兜底）
```

| 关注点 | 设计 |
| --- | --- |
| kind vs id | `kind` 决定端点/解析/能力（agent §2.6 发现表）；`id` 是用户自定键——多个 `openai-compatible` 各一 `id`。模型 ref = `<id>:<modelId>` |
| baseURL | `openai-compatible`/`gateway` 必填（含版本前缀，如 `…/v1`、`…/compatible-mode/v1`）；官方 kind 用内置端点 |
| 掩码 | key 全程 `•`，不回显、不进输入历史、不打日志（agent §4）|
| 落盘 | `KeyStore.set(keyRef, plaintext)` + `ConfigStore.saveProviders(...)`；`providers.json` 只存 `keyRef`（cli §7）|
| 校验 | 写入后可选「测试连接」：发一个最小请求验 key，失败给红字、不阻塞保存 |
| 模型发现 | 保存 provider 后自动 `listProviderModels(id)`（agent §2.6）：拉到的 id 喂别名选择器（§9.2），与内置合并、24h 缓存；失败静默回退。Anthropic 无端点 → 纯内置 |
| 本地无需 key | localhost/127.0.0.1 端点（Ollama/vLLM/LM Studio）跳过 key 步骤，仍能发现模型（agent §2.6）|
| 列出/登出 | `ea provider ls`（§9.1）；`ea auth ls` 只显 keyRef、绝不显明文；`ea provider rm` / `logout` 删 provider + keychain 项 |

> 安全：这是唯一直接碰明文密钥的界面，三条铁律——**掩码输入、只存 keyRef、明文只进 keychain**——与桌面端设置页同构（agent §4）。`ea auth login [id]` 是只更新已存在 provider key 的捷径（跳到步骤 3）；`ea provider add` 走完整四步。

---

## 11. Headless 输出（非交互渲染）

`ea run`（cli §5）没有全屏 UI，但「输出格式」也是 UI。它与 TUI 共享 `reduceTrace`（cli §5.3），只换渲染器。

### 11.1 人读（默认，流式到 stderr）

```
● 重构鉴权
  读取 src/auth.ts … ✓
  ✎ 写入 src/auth.ts (+38 −12) ✓
  ⚙ pnpm test … ⏸ 需要审批（--approve 未授权）→ 拒绝
  ▸ Sub#researcher: 查 OAuth 最佳实践 … ✓
✓ 完成 · 6 步 · 12.4k tok · $0.031
```

- 轨迹线性打印（缩进表子 Agent），字形复用 §1.3。
- 最终 assistant 文本 / `report` 结果打到 **stdout**（轨迹在 stderr，便于 `$(...)` 只取结果）。
- `-q` 只留最后一行结果。

### 11.2 机器读（`--json`）

```jsonl
{"kind":"tool-call","runId":"r3","agentId":"orch","toolName":"writeFile","input":{...}}
{"kind":"tool-result","runId":"r3","toolCallId":"t1","output":{...}}
{"kind":"usage","runId":"r3","usage":{...},"cost":0.031}
{"kind":"run-finish","runId":"r3","finishReason":"stop"}
```

原始 `AgentStreamEvent`（agent §6.2）逐条 JSON Lines——契约即 schema，下游 `jq` 自取。

### 11.3 非交互审批提示

`--approve reject`（默认）下遇到需审批工具，stderr 打一行 `⏸ runCommand 被拒（--approve reject）`，退出码 `4`（cli §5.4），不阻塞挂起。

> **审批要覆盖子 Agent 的 run（关键）**：委派（`delegateToSubAgent`）里子 Agent 的高危调用，其 `tool-approval-required` / `user-question-required` 带的是**子 Agent 自己的 `runId`**，不是本回合编排 run 的 id（agent §2.3）。`ea run` 必须按「**本回合 run 树**」匹配——监听 `sub-agent-start`（`parentRunId ∈ 已知集`）把子 run 纳入集合，再对集合内任意 `runId` 应用 `--approve` 策略；只匹配编排 runId 会让子 Agent 的审批**永远收不到答复**，挂到墙钟超时（默认 300s）才返回，看起来就像「子 Agent 跑不起来」。回合结束仍只认编排 run 的 `run-finish`（子 Agent 只发 `sub-agent-finish`，其错误以 tool-result 回灌编排者、不终止整回合）。这与 TUI 用 `subRuns` 纳入子 run 的逻辑一致。

---

## 12. 首启 / 空态 / 帮助 / 退出

### 12.1 首次启动（onboarding）

无任何 Session 时（首启），引导三步、自动建「Default」（agent §1.1）：

```
  欢迎使用 Enterprise Agent

  尚未配置 Provider。先添加一个模型来源：
     › ea provider add   （或按 p 现在就配，走 §10 向导）

  ① 添加 Provider   ② 选个目录作为工作目录   ③ 开始第一个 Session

  [p] 添加 Provider   [d] 用当前目录建 Session   [Enter] 跳过，进 Default
```

### 12.2 空态汇总

| 场景 | 空态文案 |
| --- | --- |
| 无 Provider | 「先 `ea provider add` 添加模型来源」（§9.1 / §10）|
| 无 Work/Chat | 「`n` 新建 Work，或直接输入开始一个 Chat」|
| 会话无消息 | §3.4 的目标 + 引导 |
| MCP 全未启用 | 「无 MCP 工具；`ea mcp` 启用外部工具」|

### 12.3 帮助（`?`）

`?` 弹帮助浮层：当前界面的键位 + 全局键位 + 斜杠命令清单（§13 的可视化版本），`Esc` 关。

### 12.4 退出与中断

| 操作 | 键 | 行为 |
| --- | --- | --- |
| 中断当前 run | `Ctrl-C`（run 在跑时）| 有在途 `runId` 时：`abortRun(runId)`（agent §6.3），**只中断不退出**——**从发送那一刻**起即可中断，不必等首个 token |
| 退出确认 | `Ctrl-C`（无在途 run 时）| 弹出居中确认弹窗「退出 Enterprise Agent？ [y] 确认退出 · 其他键取消」；按 `y` 退出，任意其他键取消 |
| 退出 TUI | `/exit`（或 `/quit`）| 干净退出（见下）|
| 干净关闭 | — | `quit()`：**先 `renderer.destroy()`**（离开备用屏、关鼠标上报、显光标、关 raw 模式、停渲染线程——恢复终端），**再** `await host.dispose()`（关 MCP、flush）→ `process.exit(0)` |

> `Ctrl-C` 兼顾两义：**有在途 run 时**（存在 `runId`）是「中断运行」（终端通用语义，只停这次调用）；**空闲时**是「退出」，弹出确认弹窗，`y` 确认、其他键取消，避免误按一次就丢会话。确认弹窗打开时输入框 blur、按键走全局 handler 并 `preventDefault`（不漏进输入框）。
> **以 `runId` 而非 `trace.status` 为闸**：`status` 仅在**首个流式 token** 到达才翻成 `running`，发送到首 token 之间有「连接中」窗口（误发后最想撤回的一刻）；若按 `status` 判断，这段时间 `Ctrl-C` 会错弹退出确认而 run 仍在跑。`runId` 在发送即置、由本回合的 `run-finish` 清除（中断触发的 `aborted` finish 同样清除——它也让 spinner 停下），故中断后保留 `runId` 不同步清空，使该 finish 事件仍被 `belongsToActive` 接纳。
> **干净退出（关键）**：退出路径（`/exit` 与 Ctrl-C→`y`）共用 `quit()`——**必须先 `renderer.destroy()` 再 `process.exit`**。只 `process.exit` 不销毁 renderer 会留下备用屏未恢复 + **鼠标上报未关闭**，退出后终端持续吐转义序列（乱码）。`quit()` 幂等（`quitting` 标志）。进程内嵌（cli §1）下退出即停 run；想后台续跑要 daemon 模式（cli §8）。

---

## 13. 键位与通知总表

### 13.1 全局键位

| 键 | 作用 | 生效面板 |
| --- | --- | --- |
| `Tab` | 斜杠菜单：补全高亮命令（§6.2） | 输入框 |
| `↑` / `↓` | 斜杠菜单 / `/sessions` 弹窗：移动高亮（§6.2 / §7.2） | 输入框 / 弹窗 |
| `/sessions` | 会话切换弹窗（§7.2） | 全局 |
| `/config` | 配置弹窗（§9） | 全局 |
| `?` | 帮助浮层 | 全局 |
| `Esc` | 关浮层 / 退出子界面 | Overlay |
| `Ctrl-C` | 模型输出中：中断本次调用；空闲：弹出退出确认（`y` 退出，§12.4） | 全局 |

### 13.2 会话视图键位

| 键 | 作用 |
| --- | --- |
| `↑↓` `jk` | 选节点 · `→←` `Enter` 展开折叠 · `z` 折叠子 Agent · `G` 跟随底部 · `y` 复制 · `f` 分叉 |

### 13.3 审批键位

| 键 | 作用 |
| --- | --- |
| `a` 单次 · `s` 本会话 · `r` 拒绝 · `d` 详情（§4）|

### 13.4 通知优先级

| 级别 | 渲染 | 例 |
| --- | --- | --- |
| 阻塞 | Overlay，必须响应 | 审批（§4）、退出确认（§12.4）|
| 持久 | 状态行常驻直到处理 | `error` 事件（§2.3）|
| 瞬时 | toast 3s 自动消失 | `run-finish` / `compaction-end`（§2.3）|

---

## 附录 A：界面 ↔ 契约绑定速查

| 界面 | 消费事件（agent §6.2） | 调用方法（agent §6.1） |
| --- | --- | --- |
| TopBar / Usage（§2.1） | `usage` | `listSessions` |
| 会话视图（§3） | `text-delta` `tool-call` `tool-result` `sub-agent-*` `compaction-*` `step-finish` `error` `run-finish` | `sendMessage` `startWork` |
| 审批（§4） | `tool-approval-required` | `approveTool` |
| 问答（§4.1） | `user-question-required` | `answerQuestion` |
| Todo（§5） | `todo-update` | `getTodos` |
| 输入/斜杠（§6） | — | `sendMessage` `compact` `labelEntry` `cloneToSession` `report` |
| Sidebar / 切换器（§7） | `run-finish`（状态点） | `listSessions` `createSession` `switchSession` `deleteSession` |
| 会话树（§8） | `entry-appended` | `getSessionTree` `forkFrom` `labelEntry` `cloneToSession` |
| Providers（§9.1） | — | `listProviderModels`（发现/计数）、`ConfigStore.loadProviders/saveProviders`、`KeyStore`（查 keyRef）|
| 模型/MCP/配置（§9.2·9.3·9.5） | `error{runId:'mcp'}` | `listProviderModels`、（`ConfigStore.listMcpServers`/`ModelMetaRegistry` 导出工具）|
| Skills（§9.4） | — | `SkillRegistry.list/load`（导出工具，agent §3.6）|
| Provider 配置与鉴权（§10） | — | `ConfigStore.saveProviders`、`KeyStore.set/get`、`listProviderModels`（保存后拉取）（cli §7）|
| Headless（§11） | 全部（线性/JSON 渲染） | `startWork` `sendMessage` `report` |
| 退出（§12.4） | — | `abortRun` `dispose` |

> 所有界面共享 cli §5.3 的 `reduceTrace`：事件先归并成 state，再由各组件投影渲染。UI 层不调业务逻辑、不存权威状态——它是 `AgentStreamEvent` 的一次纯函数渲染。进程内嵌（cli §1）下 `host` 是本地对象、调用即返回；daemon 模式（cli §8）下 `host` 是 app-server JSON-RPC 代理，本文所有界面**一字不改**。
