# Skill 动态发现与按需加载（Skill Search）实现计划

> 状态：v1 — 落地 Phase 0 + Phase 1（本地词法检索）。Phase 2/3 列为后续。
> 关联：agent §3.6（Skills / 渐进式披露）、§5.5（压缩）、§2.3 / §3.4（子 Agent 能力硬门）。

## 1. 背景与问题

技能（Skill）是「按需加载的知识 / 流程」（agent §3.6），磁盘格式为 `<name>/SKILL.md`（YAML frontmatter + 正文）。渐进式披露分两层：

1. **L1 — 描述注入**：启动时只把每个技能的 `name: description` 注入 system prompt（「可用技能」清单）。
2. **L2 — 正文按需加载**：当任务匹配某技能时，把完整 `SKILL.md` 正文加载进上下文作为额外 instructions。

落地前的实现状态（`packages/agent/src/skills/loader.ts`）：

- ✅ L1 已实现：`SkillRegistry.catalog()` 把全部描述拼成清单注入 prompt，并按子 Agent 子 Agent 工具集过滤（`carryable`）。
- ❌ **L2 未接通**：`SkillRegistry.load()` 方法存在，但全代码库无人调用；`buildLocalTools` 里**没有让模型加载技能的工具**，CLI `skill show` 只打印到 stdout，不注入会话。模型能「看到清单」，却没有任何手段把正文拉进上下文。
- ❌ **无动态发现 / 语义搜索**：清单是「无条件全量 dump」，技能一多就撑大 prompt，且模型难以判断相关性。没有相关性排序、索引、远程市场或预取。

本计划补齐 L2，并加入「按相关性检索 + 超阈值降级为搜索优先」的动态发现能力。

## 2. 目标（本期范围）

- **Phase 0**：接通 L2 —— 新增模型可调用的 `useSkill` 工具，把指定技能正文加载进上下文。
- **Phase 1**：本地词法相关性检索 —— 新增 `searchSkills` 工具 + `SkillRegistry.search()`；当可见技能数超过阈值时，清单从「全量 dump」降级为「搜索优先（含本回合预取 top-K）」。

非目标（后续）：

- **Phase 2**：基于 embedding 的真·语义检索（复用 provider 层 + 磁盘缓存，词法不足时回退）。
- **Phase 3**：远程技能市场发现未安装技能；提交前 prefetch 降首响应延迟；阈值经 `EffectiveConfig` 暴露为用户配置。

## 3. 设计

### 3.1 数据模型

`SkillMeta` 增加可选 `keywords?: string[]`，来自 frontmatter 的 `keywords:`（逗号串或 `[a, b]` 数组）。仅用于提升检索召回，不影响既有字段。

### 3.2 检索算法（词法，零依赖、确定性）

对查询与 `name + keywords + description` 做分词后打分（`scoreSkill`）：

- query 先 `tokenize`（小写、`[a-z0-9]+`）并去重；
- 命中 name token：+6；命中 name 子串（非整 token）：+3；
- 命中 keyword token：+4；
- 命中 description：+1，并按词频追加（封顶）；description 子串：+1。

`search(query, { allowedToolNames?, limit? })` 返回 `{ meta, score }[]`，过滤 `score>0`，按 `score` 降序、同分按 name 升序稳定排序。`allowedToolNames` 用既有 `carryable` 谓词过滤，且排除 `disable-model-invocation`。空 query → 空结果。

### 3.3 清单（catalog）的两种形态

`catalog(allowedToolNames?, query?)`，先得到 `visible = visibleList(allowedToolNames)`（`!disableModelInvocation` 且 `carryable`）：

- `visible.length === 0` → 空串。
- `visible.length <= SEARCH_THRESHOLD`（默认 12）→ **全量清单**（与既有行为一致，仅把引导语从 `/skill:<name>` 改为「调用 `useSkill`」）。
- 否则 → **搜索模式**：声明「有 N 个技能，过多无法全列」，指示调用 `searchSkills(query)` 检索、`useSkill(name)` 加载；若有 `query`（本回合用户消息 / 子 Agent objective），额外预取 top-K（默认 5）最相关项的 `name: description`。

阈值以下行为与改造前完全一致 → **无回归**。

### 3.4 渐进式披露 L2：`useSkill` 工具

只读、不过审批（同 `readFile`）。`execute({name})` → `ctx.shared.loadSkill(name, allowedToolNames)`：

- 命中可见集 → 返回 `{ name, instructions: <SKILL.md 正文> }`，作为 tool-result 进入上下文（受 §5.5 压缩管理）。
- 存在但不可见（`disable-model-invocation` 或 子 Agent 工具集不满足 `allowed-tools`）→ `{ error: 'not_available' }`。
- 不存在 → `{ error: 'not_found' }`。

即「模型只能自动加载它本就被许可、且其 role 能执行的技能」，与 agent §3.6 / §3.4 一致；`disable-model-invocation` 技能仍仅可由用户经 CLI（`ea skill show`）强制查看。

### 3.5 可观测性

`useSkill` / `searchSkills` 是普通工具，其 `tool-call` / `tool-result` 事件已被 trace 树渲染（`apps/cli/src/core/trace.ts`），**无需新增事件类型**。

### 3.6 子 Agent

子 Agent 同样获得 `useSkill` / `searchSkills`，但 `allowedToolNames` 绑定为其 子 Agent 工具集，故检索与加载都只覆盖它能执行的技能（agent §2.3 / §3.4）。其 catalog 预取 query 取 delegated `objective`。

## 4. 文件级改动

| 文件 | 改动 |
| --- | --- |
| `packages/agent/src/skills/loader.ts` | 解析 `keywords`；新增 `visibleList`、`search`、`scoreSkill`；`catalog(allowedToolNames?, query?)` 支持阈值降级 + 预取；导出 `DEFAULT_SKILL_SEARCH_THRESHOLD`、`SkillHit`、`SkillSearchOptions`。`load()` 不变。 |
| `packages/agent/src/tools/skill.ts`（新增） | `buildSkillTools(ctx, allowedToolNames?)` → `{ useSkill, searchSkills }`。 |
| `packages/agent/src/tools/registry.ts` | `buildLocalTools` 注入 skill 工具（全可见）；`buildToolsForAgent` 末尾以子 Agent 工具名注入（受限可见）。 |
| `packages/agent/src/runtime/context.ts` | `SessionServices` 增 `loadSkill`、`searchSkills`；`subAgentSkillCatalog(toolNames, query?)` 加可选 query。 |
| `packages/agent/src/runtime/session.ts` | `SessionConfig.skillCatalog: string` → `buildSkillCatalog(query?)`；`drive()` 用本回合 userText 作 query 构建 system prompt。 |
| `packages/agent/src/runtime/sub-agent.ts` | `subAgentSkillCatalog(Object.keys(tools), objective)`。 |
| `packages/agent/src/index.ts` | 装配 `services.loadSkill` / `searchSkills` / `subAgentSkillCatalog(q)`；session `buildSkillCatalog: (q) => skills.catalog(undefined, q)`。 |
| `packages/agent/test/helpers/harness.ts` | services 增 `loadSkill` / `searchSkills` + 注入项；`subAgentSkillCatalog` 签名加 query。 |
| `apps/cli/src/commands/skill.ts` | 新增 `ea skill search <query>`；引导语对齐 `useSkill`。 |
| `apps/cli/src/host/bootstrap.ts` | `CliContext` 增 `searchForScope(query, sessionId?)`。 |
| `specs/agent-architecture.md` §3.6 | 增补 `useSkill` / `searchSkills` / 搜索模式说明。 |

## 5. 测试

- `packages/agent/test/skills.test.ts`：扩展 —— `search` 排序/过滤、`keywords` 召回、catalog 阈值降级（≤阈值全列、>阈值搜索模式 + 预取）、role 过滤下检索可见性。
- `packages/agent/test/skill-tool.test.ts`（新增）：`useSkill` 命中/`not_found`/`not_available`（`disable-model-invocation`、子 Agent 工具集不满足）；`searchSkills` 返回排序结果；经真实 `SessionServices` harness 驱动。

## 6. 兼容性

- `catalog` 新增参数均可选；阈值以下输出与既有一致，现有 `skills.test.ts` 断言（含 `secret` 不出现）继续通过。
- 既有 `subAgentSkillCatalog(toolNames)` 调用仍合法（query 可选）。
- 不新增事件类型、不改 storage / contract 的破坏性结构。

## 7. 后续（Phase 2/3）

- Embedding 语义检索（`models-dev.ts` 式磁盘缓存；不可用回退词法）。
- 远程市场发现未安装技能（提示 `ea skill add`）。
- 提交前 prefetch；阈值经 `EffectiveConfig` 暴露。
