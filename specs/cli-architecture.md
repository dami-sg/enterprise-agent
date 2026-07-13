# Enterprise Agent — CLI 壳层架构（OpenTUI）

> 本文档定义 **CLI 宿主壳层**——把 Agent 核心模块（[agent-architecture.md](agent-architecture.md)）搬进终端的薄壳。涵盖：架构定位与进程内嵌（§1）、进程与运行模型（§2）、命令行界面（§3）、OpenTUI TUI 渲染（§4）、Headless / 脚本模式（§5）、终端内的审批（§6）、鉴权与配置（§7）、可选的 daemon 模式（§8）、接口对照（附录 A）。
> **集成方式**：CLI **不重新实现任何 Agent 逻辑**——运行时、工具、审批、MCP、压缩、文件存储全在 **`@dami-sg/agent`** 内（agent §2–§5），CLI 只通过 **agent §6 的命令/事件契约**（`AgentHost` + `AgentStreamEvent`）驱动它,自己补「渲染 + 输入 + 进程编排」。
> **核心取向：进程内嵌（in-process）。** TUI 用 **[OpenTUI](https://github.com/sst/opentui) + [SolidJS](https://www.solidjs.com/)**（终端原生组件 + 细粒度响应式）编写，整个 `ea` 跑在 **Bun** 上——与 `@dami-sg/agent`（Node/TS，Bun 兼容运行）**同为单 JS 运行时、同一进程**，于是 host 直接 `createAgentHost()` 挂在 TUI 进程里、**直接函数调用**，无 IPC、无 HTTP、无 daemon。（早期用 Ink/React 实现，因 Ink 缺原生滚动容器/Markdown、`<Box>` 不支持背景色、对 emoji/CJK 宽度估算不准而迁到 OpenTUI；见 §4。）这与桌面端「Electron main 进程内嵌 host」（desktop §1）同philosophy——两个壳都是「同进程嵌 host + 渲染事件流」,只是渲染目标一个是 OpenTUI、一个是 Electron renderer。client/server daemon **降级为 §8 的可选项**,仅在 detach / attach / 远程 / 多客户端时启用。
> 编号：**本文件章节独立顺序编号**（§1–§8 + 附录 A）。本文件内引用用裸 `§x`；跨文件引用用 `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `desktop §x`（[desktop-architecture.md](desktop-architecture.md)）/ `总览 §x`（[architecture.md](architecture.md)）限定。

---

## 1. 架构定位：进程内嵌（OpenTUI + host 同进程）

CLI 的默认形态**不是** client/server——而是一个 **`ea`（Bun）进程把 host 嵌在自己内部**。OpenTUI/Solid 与核心包都是 JS/TS、跑在同一个 Bun 进程里，所以二者能直接调用，不需要任何传输层。

```
┌────────────────────────────────────────────────┐
│  ea 进程（Bun，单进程）                           │
│  ┌──────────────┐    直接函数调用     ┌─────────┐ │
│  │ OpenTUI TUI(§4)│ ──host.send()────▶ │AgentHost│ │
│  │  Solid 组件树   │ ◀─host.onEvent()── │(agent §6)│ │
│  └──────────────┘    AgentStreamEvent └────┬────┘ │
│        ▲ 渲染轨迹树 / 审批 / todo            │       │
│        │                  运行时/工具/审批/MCP/沙箱   │
│   终端 cell grid          文件存储 ~/.enterprise-agent/│
└────────────────────────────────────────────────┘
```

| 维度 | 设计 |
| --- | --- |
| 同一运行时 | OpenTUI/Solid 与 `@dami-sg/agent`（Node/TS，Bun 兼容）都跑在 Bun 上、同一 JS 运行时。host 用 `createAgentHost()`（[packages/agent/src/index.ts:440](../packages/agent/src/index.ts)）构造，**就是 `ea` 进程里的一个普通对象**。|
| 零传输 | TUI 调命令 = 直接 `await host.sendMessage(ref, text)`；收事件 = `host.onEvent(cb)`。**没有 IPC、没有 HTTP、没有序列化**。比桌面端还简单——桌面端 renderer≠main 才需要 IPC 桥（desktop §1.2），CLI 同进程免了这一层。|
| 持久性自带 | 「常驻命令行」本身就是持久进程：host 活得和 TUI 一样久，多轮消息不重连 MCP、不重建文件索引（agent §5.7）。冷启成本只付一次。|
| 单写者天然满足 | 一个 ea 进程独占文件存储的写（agent §5.3 单写者不变量），无需额外协调——host 内部 `sessions` Map 多路复用所有 Session（§2.1）。|
| 安全边界不变 | 密钥（keychain）、文件边界、沙箱、审批全在 host 内强制（agent §4）。同进程不削弱任何边界——TUI 组件拿到的只有 `AgentStreamEvent`，从不接触明文密钥。|
| 与桌面端对称 | 两个壳同一招式：**同进程嵌 host**。桌面端嵌在 Electron main、渲染到 renderer（经 IPC）；CLI 嵌在 `ea`（Bun）进程、渲染到终端（直接调用）。核心两边都是 `@dami-sg/agent`，零分叉。|

> 为什么不默认 client/server daemon？因为「常驻 TUI + 同进程 host」已经把持久性、零冷启都拿到了，再拆出独立 server 只会平添端口、握手、序列化和进程生命周期管理。daemon 真正解锁的是**单进程做不到的四件事**——detach（关 TUI 任务续跑）、attach（另一终端看同一会话）、远程、多客户端——这些是少数场景，放到 §8 按需启用。默认形态保持最短路径。

---

## 2. 进程与运行模型

### 2.1 单进程多路复用

`createAgentHost()` 是一个**单进程多路复用器**：内部用一个 `sessions` Map 同时持有所有打开的 Session，`onEvent` 是全局的、发所有会话的事件（[index.ts:67](../packages/agent/src/index.ts)）。`ea`（Bun）进程构造一个 host 即可覆盖整机所有会话：

```ts
import { createAgentHost } from '@dami-sg/agent';

const host = createAgentHost({
  root: process.env.ENTERPRISE_AGENT_HOME,  // 缺省 ~/.enterprise-agent（agent §5.2）
  keychain: fileKeyStore,                   // CLI 提供明文文件后端（§7）
});
```

- TUI 在多个 Session 之间切换，只是**切渲染过滤**（按 `sessionId`/`runId` 选事件），不重建 host。
- 子 Agent（agent §2.3）在同一进程内 spawn，事件带 `parentAgentId`，TUI 据此渲染嵌套轨迹（§4）。

### 2.2 host 生命周期 = 进程生命周期

| 阶段 | 行为 |
| --- | --- |
| 启动 | `ea` / `ea tui` 启动 → `createAgentHost()` → 一次性连 MCP、建文件存储内存索引、加载 providers/aliases。|
| 运行 | host 常驻于 TUI 进程，跨多轮消息复用。|
| 退出 | 用户退出 TUI（`q` / `Ctrl-C` 两次）→ `await host.dispose()` 关闭 MCP 连接、flush → 进程退出。|
| **权衡** | **进程内嵌意味着关进程即停 run**：Ctrl-C 关掉 TUI，在跑的 run 随 host 一起结束。需要「关 TUI、任务后台续跑」→ 切 §8 daemon 模式。单人单窗口跑完再关，进程内嵌完全够。|

### 2.3 Headless 也是同一招

`ea run -p "..."`（§5）**不另起架构**：同样在自己进程里 `createAgentHost()` → `startSession` → 订阅事件 → 渲染到 stdout → 跑完 `dispose()` 退出。与 TUI 的唯一区别是**渲染后端**（OpenTUI 组件 vs 行/JSON printer），host 与事件处理逻辑完全共用（§5.3）。

> 设计取舍：TUI 与 headless 共享「构造 host + 订阅 `onEvent` + 把 `AgentStreamEvent` 归并成轨迹」这一整层，只在最外面换渲染器。两个模式不分叉逻辑，agent §6.2 事件是唯一输入。

---

## 3. 命令行界面（Commands）

CLI 子命令是 agent §6.1 `AgentHost` 方法的**人体工学封装**：把「容器管理 / 会话驱动 / 会话树操作」三组能力暴露成终端动词。

### 3.1 命令总览

| 命令 | 作用 | 落到的 `AgentHost` 方法 |
| --- | --- | --- |
| `ea` / `ea tui` | 启动 OpenTUI 全屏 TUI（§4），默认入口 | 交互驱动全部方法 |
| `ea run [-p <prompt>]` | Headless 跑一次（§5），脚本/CI 用 | `startSession` / `sendMessage` + `onEvent` |
| `ea session <new\|ls\|switch\|rm\|config>` | Session 管理（agent §1）。`new --dir <path>` 绑工作目录；不带 → 默认工作目录（scratch） | `createSession` / `listSessions` / `switchSession` / `deleteSession` / `updateSessionConfig` |
| `ea session <tree\|fork\|label\|compact\|clone> <id> …` | 会话树导航（agent §5.4） | `getSessionTree` / `forkFrom` / `labelEntry` / `compact` / `cloneToSession` |
| `ea approve <toolCallId> <once\|session\|reject>` | 非交互审批（§6.2） | `approveTool`（三态，agent §3.3）|
| `ea abort <runId>` | 中断运行 | `abortRun`（agent §6.3）|
| `ea report --schema <file>` | 结构化输出（agent §2.4） | `report` |
| `ea provider <ls\|add\|enable\|disable\|rm>` | Provider 接入管理（agent §2.6，cli-ui §9.1/§10） | `ConfigStore.loadProviders/saveProviders` + `listProviderModels` |
| `ea auth <login\|logout\|ls>` | 配置/更新 Provider 密钥（§7，cli-ui §10） | `KeyStore`（写明文 `secrets.json`）|
| `ea models` / `ea mcp ls` | 列出模型别名 / MCP（生效作用域，agent §2.6 / §3.5） | `listProviderModels`、`ConfigStore.listMcpServers` 等导出工具 |
| `ea skill <ls\|add\|show>` | 技能（生效作用域，agent §3.6，cli-ui §9.4） | `SkillRegistry.list/load`（导出工具）|
| `ea config dynamic-subagents`（别名 `dyn`） | 自生成式子 Agent 能力包络（开关/能力/MCP/超时/模型/评估，dynamic-subagents §D2）| `ConfigStore` `dynamicSubAgents` 配置 |
| `ea config read-roots`（别名 `rr`）`<add\|remove\|clear>` | 只读根目录管理（读+运行、不可写、不经文件工具，agent §4.2）；写全局 `settings.readRoots` | `ConfigStore.loadSettings/saveSettings` |
| `ea serve` | **可选**：启动 daemon（§8） | —（壳层，把 host 架上传输）|

### 3.2 寻址约定

- **当前 Session** 是隐式上下文：不带 `--session` 时落到 active Session（agent §1.1）。`ea session switch <id>` 改之。
- **工作目录**：`ea run` 默认新建一个**绑定当前目录**的 Session（workingDir = cwd）——像在项目里直接跑；`ea session new` 不带 `--dir` 则用默认工作目录（私有 scratch）。
- **会话寻址**：`--session <id>` 直接给 `sessionId`（统一寻址，不再区分 work/chat）；缺省时 `ea run` 新建 Session、续会话传已有 `--session <id>`。

### 3.3 全局开关

| 开关 | 作用 |
| --- | --- |
| `--json` | 事件以 JSON Lines 打到 stdout（§5.2 机器可读）|
| `--quiet` / `-q` | 只输出最终结果，吞中间轨迹（§5.1）|
| `--model <alias>` | 临时覆盖 orchestrator 别名（agent §2.6 解析顺序的「role 显式覆盖」层）|
| `--approve <policy>` | 非交互审批策略（§6.2）|
| `--server <url>` | **切到 daemon 模式**（§8）：不在本进程嵌 host，连远端/已起的 server |

---

## 4. OpenTUI TUI（Solid 渲染事件流）

`ea` / `ea tui` 是默认入口：一个 **OpenTUI 全屏 TUI**（跑在 Bun 上）。agent §6.2 的 `AgentStreamEvent` 流与 Solid 的细粒度响应式天作之合——**事件 = action，reduce 进 signal，订阅的组件精准重渲**。

> **为何从 Ink 迁到 OpenTUI。** Ink（React-for-CLI）缺原生滚动容器（要手写「行视口 + 手算高度」）、缺原生 Markdown、`<Box>` 不能设背景色，且对 emoji/CJK 的真实终端宽度估算不准（`string-width` 偏小，紧贴边框会溢出）。OpenTUI 原生解决这些：`<scrollbox stickyScroll stickyStart="bottom" flexGrow>`（滚动/跟随/鼠标全免费）、`<markdown>`/`<code>`、`<box backgroundColor>`、按侧 `border={["left"]}` + `customBorderChars`。代价：Solid JSX 需编译期变换，必须在 **Bun** 下带 `@dami-sg` 注册的 `@opentui/solid` 变换插件运行（见附录 / cli-ui）。

### 4.1 心智模型：事件 → reducer → signal

```
host.onEvent(e)  ──▶  setTrace(t => reduceTrace(t, e))  ──▶  Solid signal（轨迹树 + 待审批 + todo + usage）
                                          │
                                          ▼  精准重渲（订阅该 signal 的节点）
                              <TraceView/> <ApprovalBar/> <Sidebar/> <TopBar/>
```

把 `AgentStreamEvent` 投影到 state 的 `reduceTrace`，与桌面端 renderer、未来 Web 客户端**共用同一份**（只依赖 contract 类型，不依赖渲染框架，§5.3）。

### 4.2 布局（Flexbox / Yoga）

OpenTUI 用 Flexbox（Yoga 引擎）布局，组件是小写内建元素 `<box>`/`<text>`/`<scrollbox>`/`<textarea>`/`<markdown>`：

```
┌ Workspace: acme/web ───────────────── ◷ 12.4k tok  $0.03 ┐  ← <Usage> 顶栏（agent §2.7）
│ ┌ Works/Chats ─┐ ┌ Trace ─────────────────────────────┐ │
│ │ ▸ Work: 重构鉴权│ │ ● Orchestrator                     │ │
│ │   Chat: 查 API │ │ ├─ ✎ writeFile  src/auth.ts        │ │  ← <TraceTree> 按 agentId/
│ │              │ │ ├─ ⚙ runCommand  pnpm test  ⏸审批  │ │     parentAgentId 归并
│ │              │ │ └─ ▸ Sub#researcher                │ │
│ ├ Todo ────────┤ │     └─ httpFetch api.github.com    │ │
│ │ ☑ 拆分模块    │ └────────────────────────────────────┘ │
│ │ ▶ 写迁移脚本   │ ┌ Input ────────────────────────────┐ │
│ │ ☐ 补测试      │ │ > _                                │ │  ← <textarea> useKeyboard
│ └──────────────┘ └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 4.3 事件 → 组件映射

reducer 把每条 `AgentStreamEvent`（agent §6.2）投影到 state：

| 事件 | 渲染 |
| --- | --- |
| `text-delta` | 追加到当前 agent 节点的流式文本 |
| `tool-call` / `tool-result` | `<ToolNode>`，带入参摘要 + 结果折叠区；`isError` 标红 |
| `tool-approval-required` | 该工具节点进入 **⏸审批** 态，渲染 `<ApprovalBar>`，展示 `grantScope`（agent §3.3）|
| `sub-agent-start` / `-finish` | 在 `parentAgentId` 节点下挂可折叠子树（agent §2.3 运行树）|
| `todo-update` | 刷新 `<TodoPanel>`（agent §3.7）|
| `usage` | 更新顶栏 token/成本 + 该 agent 节点分项（agent §2.7 子 Agent 归集）|
| `compaction-start` / `-end` | 轨迹里插「压缩」标记节点（agent §5.5）|
| `entry-appended` | 落库确认，可用于「已保存」指示 |
| `run-finish` / `error` | 结束/错误态，解禁输入框 |

### 4.4 按键 → 命令（`useKeyboard` / `<textarea>` → 直接调 host）

OpenTUI 的 `useKeyboard` 捕获全局按键、`<textarea>` 的 `onSubmit` 处理回车，二者**直接调用 host 方法**（无 IPC）：

| 操作 | 按键 | `AgentHost` 调用 |
| --- | --- | --- |
| 发消息 | `Enter`（`Shift-Enter` 换行）| `host.sendMessage(ref, text)` |
| 斜杠命令补全 | 输入 `/` 起菜单 · `↑↓` 选 · `Tab` 补全 · `Enter` 执行 | —（前端补全，见 cli-ui §6.2）|
| 切会话 | `/sessions` 起居中弹窗 · `↑↓` 选 · `Enter` 切 | `host.startSession`/切换激活（cli-ui §7.2）|
| 审批：单次 / 本会话 / 拒绝 | `a` / `s` / `r` | `host.approveTool(id, 'once'\|'session'\|'reject')`（agent §3.3）|
| 中断当前 run / 退出 | `Ctrl-C`（运行中中断；空闲连按两次退出）| `host.abortRun(runId)`（agent §6.3）|
| 会话树 / 分叉 | `/fork` 进会话树 · `f` 分叉 · `l` 命名 · `c` 克隆 | `host.forkFrom`/`labelEntry`/`cloneToSession`（agent §5.4）|
| 配置（Provider/模型/MCP/技能）| `/config` | 见 cli-ui §9 |
| 滚动轨迹 | `PageUp/PageDown` / 鼠标滚轮 | scrollbox 原生，不调 host |

```tsx
import { render, useKeyboard } from "@opentui/solid";
const host = createAgentHost({ root, keychain: fileKeyStore });

function SessionApp() {
  const [trace, setTrace] = createSignal(initialTrace(), { equals: false });
  const dispatch = (e) => setTrace((t) => reduceTrace(t, e));        // 事件→signal（agent §6.2）
  onMount(() => onCleanup(host.onEvent((e) => dispatch(e))));
  const pending = createMemo(() => trace().pending[0]);
  useKeyboard((key) => {                                              // 全局按键→命令，直接调用
    if (pending() && key.name === "a") host.approveTool(pending().toolCallId, "once");
    if (pending() && key.name === "s") host.approveTool(pending().toolCallId, "session");
    if (pending() && key.name === "r") host.approveTool(pending().toolCallId, "reject");
  }, {});
  // 审批待定时 blur 输入框，让 a/s/r 落到全局 handler（见下）。
  createEffect(() => (pending() ? textarea?.blur?.() : textarea?.focus?.()));
  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar usage={trace().usage} />
      <scrollbox flexGrow stickyScroll stickyStart="bottom">…轨迹…</scrollbox>
      <Show when={pending()}><ApprovalBar pending={pending()!} /></Show>
      <textarea ref={(r) => (textarea = r)} onSubmit={() => host.sendMessage(activeId(), draft())} />
    </box>
  );
}
await render(() => <SessionApp />, { exitOnCtrlC: false });          // SessionApp 自管 Ctrl-C
```

> **审批待定时禁用输入**：与桌面端同一不变量（agent §3.3）——存在任一未决 `tool-approval-required`（含子 Agent，agent §3.4）时，`createEffect` **blur 掉 `<textarea>`**，键盘交给全局 handler，只接受审批按键。

### 4.5 无 IPC，比桌面端更短

桌面端 renderer 与 host 分处两进程，必须经 `contextBridge` + `MessagePort` 桥接 §6 契约（desktop §1.2）。OpenTUI TUI 与 host **同进程**（同一 Bun runtime），命令是直接 `await`、事件是直接回调——**省掉整层 IPC 与序列化**。代价是失去进程隔离（§2.2 关进程即停 run），用 §8 daemon 补回隔离/远程能力。

### 4.6 状态加载与重建

- 进程内嵌下，运行中的轨迹**就在内存 state**，无需重建。
- 打开一个**已存在的会话**（历史 Work/Chat）→ 先 `host.getSessionTree(ref)`（agent §5.4）拉树快照、`host.getTodos(ref)` 拉计划，渲染历史，再 `onEvent` 接实时流。
- daemon 模式（§8）下 TUI 重连应先拉 `session/history` 再重新订阅；进程内嵌不涉及。

---

## 5. Headless / 脚本模式

`ea run` 是给**脚本、CI、管道**用的非交互入口。它与 TUI 共享 host 与事件处理（§2.3），只把渲染器从 OpenTUI 换成 printer。

### 5.1 默认（人读）模式

```bash
ea run -p "把 src/legacy 下的 callback 改写成 async/await，并跑测试"
```

- 默认新建绑定当前目录的 Session（§3.2），`startSession` 起 Session，订阅其 `runId` 的事件。
- 轨迹**线性打印**到 stderr（流式文本、工具一行一条、子 Agent 缩进），最终结果到 stdout。
- `-q` 只留最终结果（`RESULT=$(ea run -q -p "...")`）。

### 5.2 JSON 模式（机器读）

```bash
ea run --json -p "审计依赖里的 CVE" | jq -c 'select(.kind=="tool-result")'
```

`--json` 把**原始 `AgentStreamEvent`（agent §6.2）逐条作为 JSON Lines** 打到 stdout——契约即 schema，无需另设格式。结构化产物走 `ea report --schema <file>` 调 `host.report(ref, prompt)`（agent §2.4），stdout 直接是校验过的 JSON。

### 5.3 共享渲染核

```
                 host.onEvent ─▶ reduceTrace（纯函数，只依赖 contract 类型）
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   <OpenTUI 组件树>              行式 printer（§5.1）          JSON Lines（§5.2）
   交互 TUI（§4）             ea run 人读                    ea run --json
```

`reduceTrace` 是**渲染无关的纯函数**，TUI / headless / 未来 Web 共用。换前端只换最外层渲染器。

### 5.4 退出码

| 场景 | 码 | 说明 |
| --- | --- | --- |
| 正常结束 | `0` | `run-finish` 且无 `error` |
| Agent 报错 | `1` | `error` 事件 |
| 审批被拒/超时 | `4` | 非交互下高风险工具无放行（§6.2）|
| host 构造失败 | `5` | provider/keychain/MCP 初始化失败 |

---

## 6. 终端内的审批与人机协同

agent §3.3 的**三态审批**（`once` / `task` / `reject`）是核心强制的，CLI 只负责「摆到用户面前、回传决策」。

### 6.1 交互式（OpenTUI TUI）

收到 `tool-approval-required`（携 `toolName` / `input` / `grantScope` / 可能的 `parentAgentId`）→ 在该工具的轨迹节点下渲染 `<ApprovalBar>`：

```
⏸ 审批  runCommand  ›  pnpm test
   授权范围：本会话内自动批准 `pnpm *`（agent §3.3 授权键）
   调用链：Orchestrator › Sub#researcher                    ← 子 Agent 审批显示调用链（agent §3.4）
   [a] 单次   [s] 本会话   [r] 拒绝
```

`a`/`t`/`r` → `host.approveTool(toolCallId, ...)`（直接调用，§4.4）。`t` 落到 host 内的**任务级放行表**（agent §3.3），后续同 `grantScope` 调用自动放行。审批主体永远是终端前的用户（agent §3.4 不变量 1）。

### 6.2 非交互式（脚本 / CI）策略

脚本里没人按键，`ea run` 必须预声明策略，否则需审批的工具一律按拒绝（安全默认）：

| 策略（`--approve`） | 行为 |
| --- | --- |
| `reject`（默认） | 需审批的工具直接 `reject`，拒绝信息回灌 Agent（agent §3.3）。退出码 `4`。|
| `auto:once` | 每次需审批自动 `once`。仅建议沙箱/可信仓库（agent §4.1 沙箱仍兜底）。|
| `auto:session` | 自动 `session`，等价「放行 + 记放行表」，审批压到每类一次。|
| `policy:<file>` | 按 `toolName` / `grantScope` 匹配 allow/deny（复用 agent domain `PermissionPolicy` 形状），未匹配落回 `reject`。CI 最推荐。|

无论哪条策略，**沙箱（agent §4.1）与审计（`audit.jsonl`）照常生效**：`auto:*` 只免去人工点击，不绕过内核边界，每次自动放行仍记 `approval='session-auto'`。

> 安全取舍：非交互默认 **`reject` 而非 auto**。脚本作者必须**显式**为自动放行负责，与桌面端「默认弹框」对齐——便利性永远是知情、可审计的降级。

---

## 7. 鉴权与配置

CLI 与桌面端**共享同一份配置与密钥**（agent §5.2 的 `~/.enterprise-agent/`），终端登录的 provider 桌面端立即可用，反之亦然。

| 关注点 | 设计 |
| --- | --- |
| KeyStore 后端 | host 的 `AgentHostOptions.keychain` 默认是 `EnvKeyStore`（读环境变量，[index.ts:73](../packages/agent/src/index.ts)）。CLI 提供**明文文件后端**——实现 `KeyStore` 接口，`ea auth login` 收 key → `keychain.set()` 写入 `~/.enterprise-agent/secrets.json`（0600），配置只留 `keyRef`。OS keychain 后端已移除：跨平台行为一致、不依赖 `security(1)`/libsecret，代价是密钥明文落盘（`insecure: true`，`ea auth ls` 会提示）。|
| 密钥读取边界 | key 只在 host（本进程）解析。明文绝不进事件流、不打日志、不入 `providers.json`（agent §4）。同进程不削弱这条——TUI 组件只见 `AgentStreamEvent`。|
| 配置作用域 | 沿用 agent §2.5「global → Session」两级合并。`ea session config` 看生效配置，`ea config` 写全局 `settings.json`。CLI 不引入新作用域。|
| 配置读写工具 | 复用核心导出的 `ConfigStore` / `ModelMetaRegistry` / `SkillRegistry`（[index.ts:453](../packages/agent/src/index.ts)）。`ea models` / `ea mcp ls` / `ea skill ls` 是这些文件的只读视图。|
| 技能（skills） | 发现于 global `~/.enterprise-agent/skills/` + workspace（覆盖，agent §3.6 / §5.2）。`ea skill add` 导入 `SKILL.md` 包（兼容 Anthropic/pi），`SkillRegistry` 渐进式披露；脚本执行仍走审批 + 沙箱（agent §4.1）。|

> 因为配置存储是核心模块的职责（agent §5），CLI 几乎没有自由度——这正是想要的：**两个壳共享一套真相**，不会出现「CLI 配了桌面端不认」的撕裂。

---

## 8. 可选：daemon 模式（detach / attach / 远程 / 多客户端）

进程内嵌（§1）覆盖单人、单窗口、本地的绝大多数用法。当且仅当需要以下**单进程做不到的能力**时，把 host 从「嵌在 TUI 进程」改为「跑在独立 server 进程」：

| 能力 | 为什么进程内嵌做不到 |
| --- | --- |
| **detach** | 关掉 TUI、任务后台续跑——任务必须活在比 TUI 更长命的进程里 |
| **attach / 多客户端** | 另一终端看**同一个** run——状态得在共享的第三方进程 |
| **远程** | host 在开发机、TUI 在笔记本——host 在别的机器 |
| **多条快命令摊销冷启** | 一个 warm server 服务连发的 `ea models` / `ea ls`，免每条冷启 |

### 8.1 怎么切

```bash
ea serve --port 4096 --host 127.0.0.1
# stdout: {"event":"serve-ready","url":"http://127.0.0.1:4096","rpcUrl":"ws://127.0.0.1:4096/rpc","token":"...","pid":...}

ea serve --detach --port 4096       # 后台 daemon；同样打印/握手 serve-ready
ea --server ws://127.0.0.1:4096/rpc # TUI 改连 server，而非本进程嵌 host（客户端接入待完成）
ea run --server <rpcUrl> -p "..."   # headless 也连 server（客户端接入待完成）
```

- daemon = **同一个 host + app-server 传输**：`ea serve` 启动 `@dami-sg/agent-server` 的 JSON-RPC WebSocket 入口 `WS /rpc`，HTTP 只保留 `/healthz` / `/readyz`。命令、流式事件、审批/提问/计划响应都走同一条 RPC 连接（对照见附录 A）。
- **安全全在 host 侧执行**：文件边界、沙箱、审批、密钥解析都在 server 进程（agent §4），客户端只是远程 I/O——远程跑和本地跑安全模型一致。
- 鉴权：本地 daemon 默认绑定 loopback；WebSocket upgrade 用 `Authorization: Bearer <token>`，token 来自 `serve-ready`。校验通过后 server 以 trusted local account 运行。
- 远程审批：`tool-approval-required` 投影为 `item/approvalRequired` 通知，用户本地按键后通过 `approval/respond` 回 server。

### 8.2 与进程内嵌的关系

daemon **不是另一套架构**，只是把 §1 那个 host「挪到独立进程 + 加传输」。OpenTUI TUI 的渲染层、reduceTrace、按键映射**完全不变**——区别只在「`host` 是本地对象，还是一个把方法转成 JSON-RPC 调用的代理」。所以从进程内嵌升级到 daemon，TUI 代码近乎零改动。

> 取舍：默认进程内嵌、daemon 可选，让 CLI 在「最简」和「全能力」之间可滑动。单人本地享受零传输的最短路径；要协作/远程/长任务时，一个 `--server` 切过去。这与桌面端「Electron main 进程内嵌」自洽——两个壳默认都不引入独立 server，只在 CLI 显式需要时才出现。

---

## 附录 A：`AgentHost` ↔ CLI 接线对照

### A.1 进程内嵌（默认）——直接调用

| `AgentHost` 方法（agent §6.1） | TUI / headless 接线 |
| --- | --- |
| `listSessions` / `createSession` / `switchSession` / `deleteSession` / `updateSessionConfig` | `ea session *` 直接 `await host.method(...)` |
| `startSession` / `sendMessage` | `ea run` / `<Prompt onSubmit>` → 返回 `{ runId }`，订阅事件 |
| `approveTool` | `useKeyboard` 的 `a/s/r` → 直接调用（§4.4）|
| `abortRun` | `Ctrl-C` / `ea abort` |
| `forkFrom` / `labelEntry` / `compact` / `cloneToSession` / `getSessionTree` / `getTodos` | `ea session *` / 树节点按键 |
| `report` | `ea report --schema` |
| `onEvent` | `useEffect(() => host.onEvent(dispatch), [])`（§4.4）|
| `dispose` | 进程退出前 `await host.dispose()`（§2.2）|

### A.2 daemon 模式（可选）——App Server JSON-RPC

把 A.1 的直接调用换成 `WS /rpc` 上的 JSON-RPC 方法；这是桌面端 Electron IPC（desktop §1.2）的 CLI 对位物：

| `AgentHost` 能力 | JSON-RPC 方法 / 通知 |
| --- | --- |
| 连接握手 | `initialize` → `{ protocolVersion, accountId, serverInfo }` |
| Session 管理 | `session/list` / `session/create` / `session/history` |
| `startSession` / `sendMessage` | `turn/start` → `{ runId }` |
| `abortRun` | `turn/interrupt` |
| `approveTool` | `approval/respond` |
| 用户提问 / 计划确认 | `question/respond` / `plan/respond` |
| 事件订阅 | `event/subscribe` / `event/unsubscribe` |
| `onEvent` | server notifications：`turn/started`、`item/textDelta`、`item/toolCall`、`item/approvalRequired`、`turn/completed` 等 |

**注意事项**

- wire schema 由 `packages/agent-server/src/protocol.ts` 定义，客户端 SDK 在 `packages/agent-client` 中封装请求/响应、通知订阅与 WebSocket transport。
- A.1 与 A.2 共用 §5.3 的 `reduceTrace` 与组件层：进程内嵌时 `host` 是本地对象，daemon 时 `host` 是 JSON-RPC 代理，TUI 之上无感。
- 旧 HTTP+SSE daemon 模式已移除；不再提供 `/events`，也不再通过 REST endpoint 回传审批。
