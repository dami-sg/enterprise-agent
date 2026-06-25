# Enterprise Agent — 跨渠道记忆（账号维度）改造 spec

> **状态：设计提案（draft）**。本 spec 只负责**记忆**:让同一个人在不同渠道（Web / Telegram / 未来渠道）**各自独立 session**,但共享一套按 `accountId` 隔离的记忆——任意渠道在 turn 后写入、turn 前取出,实现「换个渠道,agent 仍记得我」。
>
> **配套 spec**:账号体系、OAuth 登录、渠道身份绑定、Web 聊天端见 [`web-app.md`](web-app.md)。本 spec 把「`accountId` 从哪来、`{channel,userId}` 如何映射到账号」视为**外部依赖**,只消费其提供的 `resolveAccount()`(见 §3)。
>
> 设计第一原则（沿用 [`declarative-agents-and-schedules.md`](declarative-agents-and-schedules.md)）：**不破坏安全不变量**——记忆是 `MemoryPort` 既有契约（memory §1–5）的**落地**,不新增绕过审批/沙箱的路径；隔离键**只对已绑定账号存在**,永不把不同人的记忆汇入同一命名空间。
>
> 关联架构：[`agent-architecture.md`](agent-architecture.md) memory §1–5。

---

## 0. 决策摘要（已拍板）

| 决策 | 取定 |
|---|---|
| Web / Telegram session | **各自独立**（不共享 transcript、不合并时间线） |
| 跨渠道连续性来自 | **记忆系统**（事实/偏好/摘要），非逐字记录镜像 |
| 记忆后端 | **可插拔**(`MemoryPort` 为稳定缝);**默认实现**=自托管 mem0(`mem0ai/oss`,进程内;见 §4)。可经配置整体替换,核心零改动 |
| 默认实现的抽取 LLM | **Claude Haiku 4.5**（复用既有 Anthropic 凭证） |
| 默认实现的 Embedder | **Ollama + bge-m3**（自托管，多语含中文） |
| 默认实现的向量库 | **Qdrant**（docker），按 `userId=accountId` 隔离 |
| 隔离粒度 | **到 `accountId` 一层**；`tenant`/`tags` 留空,预留扩展 |
| 未绑定/匿名用户 | **不记录任何记忆**（`namespace=undefined`,记忆不挂载） |
| Telegram 群消息 | **暂不进记忆**,留扩展口（§5.3） |
| 记忆可感知/可撤回 | **需要**，默认开（§5.4） |

---

## 1. 现状盘点：契约完整,后端为空

记忆子系统是「Phase-1 契约 + hook 已接好,但没有任何具体引擎」的状态。

| 关注点 | 现状 | 位置 |
|---|---|---|
| 端口契约 | `MemoryPort { capture / retrieve / maintain }` | [memory.ts](../packages/agent-contract/src/memory.ts) |
| 隔离键 | `MemoryScope { namespace, tenant?, tags? }`,注释明确 namespace 可为 **user id** | [memory.ts](../packages/agent-contract/src/memory.ts) |
| 默认作用域模式 | `MemoryScopeMode` 默认 **`'per-user'`** | [memory.ts](../packages/agent-contract/src/memory.ts) |
| 作用域解析 | `resolveMemoryScope()`,**host 提供的 namespace 优先** | [store.ts:130](../packages/agent/src/config/store.ts) |
| 注入点 | `buildSession` 用 `s.config?.memoryNamespace` 解析 scope | [index.ts:495](../packages/agent/src/index.ts) |
| turn 前注入 / turn 后捕获 hook | `retrieveMemoryBlock` / `captureMemory`（fire-and-forget、fail-open） | [session.ts:404](../packages/agent/src/runtime/session.ts) |
| 后端注入位 | `this.memory = opts.memory`;`memory: p.memoryScope ? this.memory : undefined` | [index.ts:117](../packages/agent/src/index.ts) / [index.ts:717](../packages/agent/src/index.ts) |

**关键缺口**:`opts.memory` 在全仓库**无任何地方传入** → `this.memory === undefined` → 三个 hook 当前全是 no-op。**本 spec 的实现主体 = ① 立一个可插拔的后端工厂(§4.0,保留替换记忆库的能力)+ 默认 mem0 适配器并在 bootstrap 注入;② 把 `accountId` 喂给 `memoryNamespace`。**

---

## 2. 设计总览

```
   Web 浏览器(登录建立 accountId) ┐
   Telegram 私聊(已绑定 from.id) ├─► 各自独立 session（沿用 channel:conversationId → sessionId）
   WeChat / 未来渠道 …          ┘                    │
                                                     ▼  build session 时注入
                                  memoryNamespace = resolveNamespace(channel, userId, isPrivate)
                                                     │（绑定→accountId；未绑定/群→undefined不记忆）
                                     ┌───────────────┴────────────────┐
                                     │   MemoryPort（稳定缝 / 账号维度隔离）│
                                     │   capture(turn 后) / retrieve(turn 前) │
                                     │   + 可选 list / forget（治理）  │
                                     └───────────────┬────────────────┘
                                          createMemory(backend) 工厂选实现 ▼
                                  ┌────────────────────────────────────────┐
                                  │ 默认: Mem0Memory（mem0ai/oss,进程内）   │
                                  │  ├─ LLM 抽取:Claude Haiku 4.5           │
                                  │  ├─ Embedder:Ollama bge-m3（本地）       │
                                  │  └─ Vector:Qdrant（userId=accountId 隔离）│
                                  │ 可替换: local / cognee / none / …        │
                                  └────────────────────────────────────────┘
```

**核心思想**:记忆是各渠道的**收敛点**。session 各自独立(各渠道单驱动 → 无并发写同一条 session、无群聊并线、无跨端实时扇出这三个难题),连续性全部经由 `namespace=accountId` 的共享记忆实现。新增渠道只需让账号层提供「`{channel,userId}` → `accountId`」映射,记忆侧零改动。

---

## 3. 命名空间策略（消费账号层）

账号层（[`web-app.md`](web-app.md) §账号与身份）对外暴露一个纯函数:

```ts
// 由账号层提供;查 identities 表，未绑定返回 undefined
resolveAccount(channel: string, channelUserId: string): string | undefined
```

记忆侧据此决定 session 的命名空间(在 dispatcher [handleInbound](../apps/gateway/src/runtime/dispatcher.ts) 建/复用 session 前):

```ts
function resolveNamespace(channel: string, userId: string, isPrivate: boolean): string | undefined {
  if (!isPrivate) return undefined;                  // 群聊:不进记忆(§5.3)
  return resolveAccount(channel, userId) ?? undefined; // 绑定→账号维度共享;未绑定→不记忆
}
```

- 命中 → `startSession({ config: { memoryNamespace: accountId } })`,核心侧 [index.ts:495](../packages/agent/src/index.ts) 既有逻辑直接生效,**路由与存储层一行不改**。
- 返回 `undefined` → **不要**调用 `resolveMemoryScope`(避免落到 `'default'` 把不同人汇入同一池),且令该 session `memoryEnabled=false`,记忆不挂载。

> ⚠️ **隔离不变量**:记忆**只对已绑定 `accountId` 存在**。未绑定/匿名/群聊一律 `undefined` → 不写、不读、不挂载。

Web 端因为登录后请求即带 `accountId`,可直接用该 `accountId` 作 namespace,无需经 `resolveAccount`(它本就是账号本身)。

---

## 4. 记忆后端:可插拔,mem0 为默认实现

### 4.0 可替换性是第一约束（不写死任何引擎）

记忆库**必须可整体替换**。架构上这道缝已经存在——`MemoryPort`(memory §1)是核心唯一依赖,契约注释明确「concrete engines mem0 / cognee / local files … are implementations behind it」。本期落地遵守三条:

1. **核心零引擎依赖**:`packages/agent`、`agent-contract` **绝不** import `mem0ai` 或任何具体引擎;只认 `MemoryPort`。具体适配器全部落在边缘(`apps/gateway` 或独立包 `packages/memory-*`)。
2. **配置选后端**:gateway 配置加一个 backend 选择器,bootstrap 经**工厂**构造适配器再注入 `opts.memory`——换引擎只改配置 + 加一个适配器包,核心与上层逻辑一行不动:

   ```ts
   // 已落地:apps/gateway/src/memory/index.ts
   type MemoryBackend = 'none' | 'mock' | 'mem0';  // 未来再加 'local' | 'cognee' | …

   function createMemory(opts: { backend?: MemoryBackend } = {}): MemoryPort | undefined {
     switch (opts.backend ?? 'none') {
       case 'none': return undefined;            // 关闭记忆(hook 退化 no-op)——当前默认
       case 'mock': return new InMemoryMemory(); // 有状态 mock,跑通接入(§4.1.0)
       case 'mem0': throw new Error('mem0 not wired yet (deferred)'); // 真库待选(§4.1)
       default: throw new Error(`unknown memory backend: ${opts.backend}`);
     }
   }
   new AgentHost({ memory: createMemory({ backend }), ... });
   ```
3. **契约纪律**:适配器对外**只**满足 `MemoryPort` 的必需面(`capture/retrieve/maintain`)+ 可选 `list/forget`(§4.2);`retrieve` 只回 `MemoryHit`(rule 1),绝不泄漏引擎原生对象。这样任何替换实现都即插即用,且 §5.4 治理对不支持 `list/forget` 的后端自动降级。

> 因此下文 §4.1 的 mem0 + Qdrant + Ollama 只是**默认参考实现的具体选型**,不是架构绑定。要换成自建向量库、cognee、或纯本地文件方案,只需另写一个 `implements MemoryPort` 的适配器并在工厂登记。

### 4.1.0 当前状态:mock 后端先行（真库暂缓）✅ 已落地

**决策:暂不接任何真实记忆库,先用 mock 跑通接入,真库后定。** 已实现:

- `InMemoryMemory`([apps/gateway/src/memory/mock-memory.ts](../apps/gateway/src/memory/mock-memory.ts)):有状态、按 `scope`(tenant+namespace=accountId)隔离;`capture` 真存、`retrieve` 召回(**recency-based,非语义**——只证管线)、`maintain` no-op;并实现可选 `list`/`forget`(§5.4 治理)。
- `createMemory` 工厂([apps/gateway/src/memory/index.ts](../apps/gateway/src/memory/index.ts)):`none`(默认,关)/ `mock` / `mem0`(抛 "not wired yet")。
- **已接进 bootstrap**:`bootstrapGateway` 按 `EA_MEMORY_BACKEND`(`none`|`mock`|`mem0`,默认 `none`)经工厂构造 `MemoryPort`,透传 CLI `bootstrap({ memory })` → `createAgentHost({ memory })`([gateway bootstrap](../apps/gateway/src/host/bootstrap.ts) / [cli bootstrap](../apps/cli/src/host/bootstrap.ts))。`EA_MEMORY_BACKEND=mock` 即可本地真实对话验证。
  - ⚠️ hook 仍受 `settings.memory.enabled` 闸门控制(enabled=运行 hook,backend=选引擎,两者正交)。开关:**`ea config memory on|off|default`**([config.ts](../apps/cli/src/commands/config.ts),写 global settings.json);`ea config` 概览也显示记忆状态。(Web admin 面板开关待后续。)
  - 账号层已接(M2 ✅):Telegram 私聊已绑定用户 → `namespace=accountId` 按账号隔离;未绑定/群 → 不记忆。

**本地端到端验证(Telegram 私聊,按账号记忆):**
```bash
ea config memory on                                  # ① 开 hook 闸门(CLI 包,写 settings.json)
ea-gateway account create --name Me                  # ② 建账号 → 记下 acct_xxx
ea-gateway account bind telegram <你的TGuserid> acct_xxx   # ③ 绑定 Telegram 身份
EA_MEMORY_BACKEND=mock ea-gateway start              # ④ mock 后端起网关
# 私聊 bot 说一个事实 → /reset 或隔天新 session → 它仍记得
# 换个未绑定的人私聊 / 群里 → 不写也不读记忆(隔离)
```
- 接入测试:
  - [apps/gateway/test/memory.test.ts](../apps/gateway/test/memory.test.ts):工厂选择 + mock 契约 + 命名空间隔离 + `list`/`forget` 治理(9 项)。
  - [packages/agent/test/memory.test.ts](../packages/agent/test/memory.test.ts):**真实 turn loop 跨 session 共享**——session A 写入的事实被同账号 session B 召回进 system prompt;换账号召不回(命名空间隔离)。

选真库时:新增 `Mem0Memory`(§4.1)登记进工厂 `case 'mem0'`,把 `InMemoryMemory` 的接入测试当**契约一致性测试**复用即可,上层零改动。

### 4.1 目标默认实现:自托管 mem0（暂缓接入,全程 in-Node）

> ⏸ **暂缓**:下文为真库的目标选型,**尚未接入**(工厂 `case 'mem0'` 当前抛错)。决定采用时再实现。

mem0 提供原生 **TypeScript OSS** 客户端 `mem0ai/oss`,适配器**直接在 gateway 进程内**构造 `Memory`,无需另起 Python 服务。选它作默认:开箱即有「事实抽取 + 去重/更新 + 检索」,且 TS 原生易嵌入。

| 组件 | 选型 | 理由 |
|---|---|---|
| 适配器 | `mem0ai/oss` 的 `Memory`,进程内 | 省一个服务;TS 原生 |
| 抽取 LLM | `provider: 'anthropic'`,**Claude Haiku 4.5** | 复用 keychain 既有 Anthropic 凭证;主 agent 已发往 Claude,**抽取零额外数据暴露**;Haiku 便宜快 |
| Embedder | `provider: 'ollama'`,**bge-m3**(1024 维) | 自托管,嵌入本地生成不出基础设施;**多语含中文**(用户多为中文) |
| Vector store | `provider: 'qdrant'`(docker,6333) | 专用、可扩展,metadata 按 `userId` 过滤 |
| history db | mem0 sqlite,`historyDbPath` | 引擎内部审计 |
| 图记忆 | Neo4j —— **暂缓** | v1 不需要 |

**数据驻留说法**:记忆文本 + 向量存自托管 Qdrant;嵌入由本地 Ollama 生成;仅事实抽取的 LLM 调用复用既有 Anthropic 通道——而主 agent 本就把对话发往 Claude,**无增量暴露**。这是可辩护的边界。

> 备选:向量库改 `pgvector`(若账号库选 Postgres,可合一减少组件);嵌入器改 OpenAI `text-embedding-3-small`(若接受外部 vendor)。接口不变。

mem0 OSS 配置(示意,以 `mem0ai/oss` 当前 API 为准):

```ts
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  llm:      { provider: 'anthropic', config: { model: 'claude-haiku-4-5-20251001', apiKey } },
  embedder: { provider: 'ollama',    config: { model: 'bge-m3', ollamaBaseUrl: 'http://localhost:11434' } },
  vectorStore: { provider: 'qdrant', config: { collectionName: 'ea_memory', host: 'localhost', port: 6333, embeddingModelDims: 1024 } },
  historyDbPath: '<gatewayRoot>/memory-history.db',
  customInstructions: '抽取:用户长期偏好、事实、目标、约束。排除:寒暄、临时性请求、一次性指令。',
});
```

### 4.2 `MemoryPort` 适配

```ts
class Mem0Memory implements MemoryPort {
  // —— 必需契约（memory §2.2 required surface）——
  async capture(scope, payload): Promise<void> {
    // payload.messages → memory.add(messages, { userId: scope.namespace })
    // 记录本轮写入的 {id, text} 概要供 §5.4 感知/撤回（经返回值/事件，不阻塞 turn）
  }
  async retrieve(scope, query, opts): Promise<MemoryHit[]> {
    // memory.search(query, { userId: scope.namespace, limit: opts?.topK })
    // → 映射为 MemoryHit{ text, score?, metadata? }（守契约 rule 1:绝不外泄引擎原生对象）
  }
  async maintain(scope?): Promise<void> { /* mem0 后台 consolidation;无则 no-op */ }

  // —— 可选能力（memory §2.2 note:id CRUD 属 backend-specific extras,挂可选方法,
  //    绝不污染必需契约）。仅 §5.4 记忆治理使用 ——
  async list(scope, opts?)   { /* memory.getAll({ userId: scope.namespace }) → {id,text,createdAt}[] */ }
  async forget(scope, id)    { /* memory.delete(id) —— 逐条撤回 */ }
}
```

映射要点:
- `scope.namespace`(=`accountId`)→ mem0 `userId`(逐账号物理隔离)。
- `retrieve` **只返回** `MemoryHit{text,score?,metadata?}`(memory §2.2 rule 1)。
- `capture` 不假设同步可检索(rule 2);需回传**本轮写入的 id + 文本概要**供感知/撤回。
- `list`/`forget` 是**可选能力**:核心契约不依赖;换引擎若不支持,仅治理功能降级,主链路不受影响。

### 4.3 配置与注入

- `MemorySettings`(memory §5)置 `enabled: true`、`scope: 'per-user'`、`retrieve.topK`(默认 6)、`retrieve.timeoutMs`(默认 1500)。
- mem0/Qdrant/Ollama endpoint 与 Anthropic key 走既有 `KeyStore`/`keychain`,不入明文 config。
- bootstrap 经 `createMemory(cfg)` 工厂(§4.0)按 `backend` 配置产出 `MemoryPort`,再 `new AgentHost({ memory, ... })` 注入([bootstrap.ts](../apps/gateway/src/host/bootstrap.ts)),填上 [index.ts:117](../packages/agent/src/index.ts) 目前为空的注入位。`backend: 'none'` 时返回 `undefined`,记忆全程 no-op。
- **部署**:`docker compose` 起 Qdrant + Ollama(拉 bge-m3);gateway 进程内连两者。

---

## 5. 隔离、失败语义、边界

### 5.1 隔离不变量

1. namespace 单调收敛:**已绑定账号 → 否则不记忆**;无 `'default'` 兜底。
2. 跨渠道共享 = 跨渠道可见,**仅限同一 `accountId`**;不同账号物理隔离(Qdrant `userId` 过滤)。
3. `tenant`/`tags` 本期留空,为后续「工作 vs 私人」「按渠道溯源/过滤检索」子隔离预留(§8)。

### 5.2 失败语义（沿用既有 hook）

- `retrieve`:超时/报错 **fail-open**(返回空,不阻塞 turn)——[session.ts:404](../packages/agent/src/runtime/session.ts) 既有行为。
- `capture`:fire-and-forget,拒绝**绝不**中断 turn。
- 后端(mem0/Qdrant/Ollama)不可用 → 整体退化为「无记忆」,对话主链路不受影响。

### 5.3 Telegram 群消息:暂不进记忆（留口）

- 群聊(`chat.type !== 'private'`)→ `resolveNamespace` 返回 `undefined` → 不挂记忆(`memory: p.memoryScope ? this.memory : undefined` 自然短路,[index.ts:717](../packages/agent/src/index.ts))。
- **扩展口**:预留配置 `memoryGroupMode: 'off' | 'shared' | 'per-group'`(默认 `'off'`)。将来需要群记忆时,只在 `resolveNamespace` 内按该配置给群一个命名空间(如 `group:{channel}:{conversationId}`),其余不动。
- 需在 Telegram 适配器 `toInbound` 暴露 `isPrivate`/`chatType`([telegram.ts:173](../apps/gateway/src/channels/telegram.ts))。

### 5.4 记忆可感知与撤回（已定:需要,默认开）

写入对用户**可见且可逐条撤回**。

1. **感知(写入后)**:`capture` 回传本轮写入概要 → turn 结束时由核心发一个 stream event `memory-captured { ids, summaries }`,交渲染层按渠道能力呈现:
   - **Telegram 私聊**(本 spec 负责):回执尾部附「🧠 已记住 N 条 · `/memories` 管理」。
   - **Web**(渲染细节见 [`web-app.md`](web-app.md)):对话流内轻量卡片 + 「撤销」。
   - 沿用既有 `ConversationRenderer` 事件机制([chat-render.ts](../apps/gateway/src/render/chat-render.ts)),新增事件类型,不改主链路。
   - 默认开;账号级偏好可关(`memoryNoticeEnabled`,默认 `true`)。
2. **治理(随时)**:账号维度「我的记忆」入口:
   - **Telegram**:`/memories` 列出(`MemoryPort.list`)、`/forget <id>` 删除(`MemoryPort.forget`)。
   - **Web**:列表 + 逐条删除(UI 见 web-app spec)。
3. **撤回语义**:`forget` 删除 mem0 中该 memory id;已被检索注入到历史 turn 的内容**不追溯重写**(与 session 不可变一致),但后续不再召回。
4. **隐私**:`list`/`forget` 必须校验调用者 == 该 `accountId`,不得跨账号操作。

> capture 仍 fire-and-forget / fail-open(§5.2):感知是**附加信号**,其失败绝不影响对话或写入本身。

---

## 6. 分阶段实现

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 后端抽象 + mock 后端** ✅ | `createMemory` 工厂 + `backend` 选择器(§4.0);`InMemoryMemory` mock(含可选 `list`/`forget`);接入测试(工厂 + mock 契约 + 跨 session 共享/隔离 + 治理)。**核心/contract 不得 import 任何引擎**。**真库暂缓** | ✅ 已完成:capture→retrieve 回 `MemoryHit`;`backend:'none'` 全 no-op;真实 turn loop 跨 session 共享、跨账号隔离;`mem0` 抛 not-wired |
| **M1.5 接真库(待选型后)** | 选定引擎(默认 mem0,§4.1)→ 写 `Mem0Memory` 登记进工厂;`docker compose` 起依赖(如 Qdrant+Ollama);bootstrap 经工厂注入;密钥走 keychain;复用 M1 接入测试作契约一致性 | 真库通过 M1 同套测试;切 backend 仅改配置;后端宕机 fail-open |
| **M2 命名空间策略 + dispatcher 接入** ✅ | `resolveNamespace`([namespace.ts](../apps/gateway/src/memory/namespace.ts));`InboundMessage.isPrivate`(Telegram `chat.type` 暴露);dispatcher 在建 session 时算 namespace 注入 `config.memoryNamespace`([dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts));gateway 用 `IdentityStore.resolveAccount` 接线(每次现读,跨进程绑定即时生效);`ea-gateway account create/bind/unbind/ls` CLI | ✅ 已完成:dispatcher 注入测试 4 项(绑定私聊→accountId、群→无、未绑定→无、未接 resolveAccount→无);CLI 端到端;全套 196+ 测试通过 |
| **M3 感知与撤回** ✅ | core `memory-captured` 事件([events.ts](../packages/agent-contract/src/events.ts) + [session.ts](../packages/agent/src/runtime/session.ts) 发);gateway 每会话一次提示([dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts));`/memories`/`/forget` 账号自限治理(私聊+绑定才可,群/未绑定拒);`asGovernable` 可选能力降级;gateway 持有 MemoryPort 实例 | ✅ 已完成:感知提示一次/会话(1 测试);`/memories` 列、`/forget` 删(后续不召回)、群聊不泄漏、未绑定拒(4 测试);全套 205+243 测试通过。**待做**:`memoryNoticeEnabled` 账号级偏好(当前默认开、每会话一次,已不刷屏) |
| **M4 调优(可选)** | `customInstructions` 抽取调参;`topK`/`timeoutMs` 压测;`maintain` consolidation 调度 | 中文事实抽取质量达标;检索延迟在预算内 |

> 依赖:M2 需账号层 `resolveAccount`([`web-app.md`](web-app.md) 账号阶段)就绪;M3 的 Web 渲染随 web-app spec 推进。Telegram 侧(M1/M2/M3 私聊路径)可独立于 Web 先行。

---

## 7. 非目标 / 未来扩展（留口）

- **非目标**:Web 不镜像 Telegram 逐字 transcript;不合并 session;不跨 `accountId` 共享。
- **群聊记忆**:`memoryGroupMode` 预留(§5.3)。
- **子隔离**:`tenant`/`tags` 预留——工作 vs 私人隔离、按来源渠道溯源/过滤检索。
- **图记忆**:mem0 graph(Neo4j)后续可开,关系型回忆。
- **记忆编辑**:§5.4 已含查看/删除;「编辑」一条为后续扩展。
- **向量库/嵌入替换**:Qdrant→pgvector、Ollama bge-m3→OpenAI,接口不变。

---

## 8. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| 0 | 记忆库是否写死 | **否,必须可替换**:`MemoryPort` 为稳定缝,`createMemory` 工厂按配置选 backend,核心/contract 零引擎依赖(§4.0) |
| 0.5 | 现在是否接真库 | **否,暂缓**:先用有状态 `mock` 后端跑通接入与测试(§4.1.0,✅已落地),真库待后续选型 |
| 1 | 真库目标选型(待定采用) | **倾向自托管 mem0**(`mem0ai/oss` 进程内 + Qdrant + Ollama;数据驻留可控);可整体替换 |
| 2 | 抽取 LLM | **Claude Haiku 4.5**,复用 Anthropic 凭证,无增量暴露 |
| 3 | Embedder | **Ollama + bge-m3**(多语含中文,本地) |
| 4 | 隔离粒度 | **到 `accountId`**;未绑定/匿名/群一律不记忆 |
| 5 | 可感知/可撤回 | **需要,默认开**(`memoryNoticeEnabled`) |

### 仍待定（实现期细化）

1. Qdrant / Ollama 的部署形态(单机 docker-compose vs 编排)与资源规格。
2. mem0 `customInstructions` 的中文抽取 prompt 细调。
3. 记忆条目是否带 `metadata.sourceChannel`(为将来按渠道过滤/溯源铺垫,即便本期不用)。
