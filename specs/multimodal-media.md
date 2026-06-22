# Enterprise Agent — 多模态媒体接入（语音 / 图片 / 文档）

> 本文档定义聊天通道（Telegram / 微信…）接收**非文本消息**（语音、图片、PDF/Word/Excel…）并把它们**适配进 orchestrator 模型**的设计。核心矛盾：gateway→core 的消息接口当前是**纯文本**的，而不同模态对模型的适配方式根本不同（图片要多模态透传、语音必先转写、文档最划算是让 agent 自己解析）。涵盖：现状约束（§1）、三条适配路线（§2）、**模型多模态能力检测与配置暴露**（§3）、入站媒体接入（§4）、契约改动（§5）、core 多模态消息（§6）、语音 STT（§7）、文档走 C（§8）、**PDF 双路（C 默认 + A 可选）**（§9）、Dispatcher 路由（§10）、能力门控与降级（§11）、落地阶段（§12）、媒体适配表（附录 A）。
>
> **取向**：尽量不动 core——文档/语音走「网关侧处理 → 文本」即可；**只有图片、以及可选的 PDF 透传**需要打通 core 的多模态消息通道（§5/§6）。是否透传由「模型能力 × 用户配置」共同门控（§3/§11），**能力不具备时自动降级**，绝不硬塞。
>
> 编号：本文件**章节独立顺序编号**（§1–§12 + 附录 A）。本文件内引用裸 `§x`；跨文件用 `agent §x`（[agent-architecture.md](agent-architecture.md)）/ `gateway §x`（[gateway-architecture.md](gateway-architecture.md)）限定。

---

## 1. 现状约束

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| `sendMessage(sessionId, text)` / `goal: string` 是**纯文本** | [commands.ts](../packages/agent-contract/src/commands.ts)（agent §6） | gateway 没法把图片/音频/文件直接交给 core——这是瓶颈 |
| `buildMessages()` 把历史**拍平为文本**（`entryText`） | [session.ts](../packages/agent/src/runtime/session.ts) | 即便 entry 存了 parts，回放时也被压成字符串 |
| entry 已支持 `content?: MessagePart[]`（v6 parts） | [session-store.ts](../packages/agent/src/storage/session-store.ts)（agent §5.3） | **多模态存储底子已在** |
| 模型注册表已追踪 `modalities.input` | [models-dev.ts](../packages/agent/src/models/models-dev.ts) | 只把 `image` 映射成 `vision`；`pdf`/`audio` 尚未暴露 |
| `InboundMessage.attachments`（image/audio/file/video，bytes/url/mime） | [adapter.ts](../apps/gateway/src/channels/adapter.ts)（gateway §3.2） | **通道入站契约已在** |
| Telegram 适配器**不收入站媒体**（只读 `message.text`） | [telegram.ts](../apps/gateway/src/channels/telegram.ts) | 要加 `getFile`+下载 |
| Dispatcher **丢弃附件**（`composeText` 见附件即回"暂不支持"） | [dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts) | 要改成按类型路由 |
| AI SDK `ModelMessage` 的 `content` 可为 parts 数组，原生支持 `{type:'image'}` / `{type:'file', mediaType}` | `ai`（agent §2） | 模型层**已具备**多模态能力，缺的是上游透传 |

---

## 2. 三条适配路线

| 路线 | 做法 | 改 core? | 失真 | 适用 |
| --- | --- | --- | --- | --- |
| **A 多模态透传** | 媒体作为内容块（image / file 块）进模型消息 | 是（§5/§6） | 无 | 图片、PDF（模型支持时） |
| **B 网关抽取文本** | 网关侧把媒体转成文字（STT / pdftotext / docx→md）后 `sendMessage` | 否 | 中（丢版式/图/语调） | 语音（必走）、文档兜底 |
| **C 存盘让 agent 解析** | 存进会话工作目录，提示 agent 路径，由 agent 用 `readFile`/`runCommand`/技能自行读取 | 否 | 低（agent 按需读） | **文档首选**（pdf/word/excel/…） |

**按类型选路**（详见附录 A）：图片→A（vision 模型）/ B 兜底；语音→B（STT，模型不吃音频）；文档→C（pdf 可选 A）。

> 为什么文档优选 C：一套吃所有格式、不碰 core、复用 agent 的 workdir+工具+技能，且 agent 能「先看目录/摘要再决定读多少」，不必把整份文件硬塞进上下文。图片走不了 C（core 无读图工具，`readFile` 只读 UTF-8）。

---

## 3. 模型多模态能力检测与配置暴露 ★

「**能透传**」= 模型支持该模态 **且** 用户开了配置。两者缺一即降级（§11）。

### 3.1 能力检测（从注册表派生）

扩展 [models-dev.ts](../packages/agent/src/models/models-dev.ts) 的能力映射，把 `modalities.input` 完整暴露为结构化能力，而不只是一个 `vision` 布尔：

```ts
// 由 modalities.input 派生（models.dev 风格：['text','image','audio','pdf','video']）
interface ModelModalities {
  image: boolean;   // input 含 'image'
  pdf: boolean;     // input 含 'pdf'（或 'application/pdf'）
  audio: boolean;   // input 含 'audio'
}
```

- orchestrator 模型解析后带上 `modalities`，供 gateway 在运行时查询（经 `host.listSessions()` 的 session.config 或一个 `host.modelCapabilities(alias)` 只读查询）。
- 主流取向：Claude 4.x / GPT-4o / Gemini 都 `image:true`；Claude / Gemini `pdf:true`；`audio` 仅 Gemini / gpt-4o-audio 等。

### 3.2 配置暴露（「有能力才显示/生效」）

新增**媒体处理配置**，挂在通道作用域（`ChannelSessionConfig`，gateway §4.2）或会话配置上：

```ts
interface MediaConfig {
  /** 图片：透传给 vision 模型 / 网关描述成文字 / 忽略。默认 auto（有 vision 走透传，否则 describe）。 */
  image?: 'passthrough' | 'describe' | 'off' | 'auto';
  /** PDF：让 agent 解析（C）/ 透传给模型（A）/ 抽取文本（B）。默认 'agent'。 */
  pdf?: 'agent' | 'passthrough' | 'extract';
  /** 其它文档：agent 解析 / 抽取文本。默认 'agent'。 */
  documents?: 'agent' | 'extract';
  /** 语音：转写 / 忽略。默认 'transcribe'（需配 STT，§7）。 */
  voice?: 'transcribe' | 'off';
}
```

**暴露规则（呼应需求「如果有的话就把配置暴露出来」）**：

- 配置面板（gateway §7）读当前 orchestrator 的 `modalities`，**只在模型支持时才展示对应透传项**：
  - `modalities.image` 为真 → 显示「图片：透传 / 描述」；否则该项灰掉，固定走 describe/off。
  - `modalities.pdf` 为真 → PDF 才显示「透传（A）」选项；否则只有 agent / extract。
- 运行时门控（§11）：用户即便配了 `passthrough`，若模型不支持该模态 → **自动降级**（图片→describe，PDF→agent），并在审计/日志记一行，不报错。

> 设计意图：**配置只是「允许」，能力才是「能否」。** 切换到不支持多模态的本地小模型也不会崩，只是悄悄降级。

---

## 4. 入站媒体接入（通道侧）

### 4.1 Telegram

`message` 可能带 `photo`（尺寸数组，取最大）/ `voice`（OGG/Opus）/ `audio` / `document`（PDF/Word/…，带 `mime_type`、`file_name`）/ `video`。统一流程：

```
update → 识别媒体字段 → getFile(file_id) → 得 file_path
       → 下载 https://api.telegram.org/file/bot<token>/<file_path>
       → Attachment{ kind, data:Buffer, filename, mimeType }
       → InboundMessage.attachments[]（gateway §3.2）
```

- **共用 download helper**（photo/voice/document/video 同一条）。
- ⚠️ **20MB 上限**：Telegram bot `getFile` 下载单文件 ≤ 20MB，超限拿不到 → 回一条友好提示。
- 文本与媒体可并存（带 caption 的图片）：`text` = caption，`attachments` = 媒体。

### 4.2 其它通道

能力按通道差异（gateway §3.3「能力即方法存在」同精神）：微信 iLink 已有图片/语音解密（gateway §8），归一到同一 `Attachment`；不支持的通道不实现入站媒体即可，Dispatcher 逻辑通道无关。

---

## 5. 契约改动（多模态入向）

让 core 的入向消息能携带内容块（仅图片 / PDF 透传需要；语音/文档走文本不需要）。两种形态，二选一：

- **(a) 扩 `sendMessage`**：`sendMessage(sessionId, text, parts?: UserPart[])`，`UserPart = { kind:'image', data, mediaType } | { kind:'file', data, mediaType }`。`goal` 同样可选带 `parts`。
- **(b) 新方法**：`sendUserMessage(sessionId, content: UserContent)`，`content` 是 text + parts 的并集。

推荐 **(a)**（向后兼容：纯文本调用不变）。parts 为 gateway 已下载的 `Attachment` 子集（仅透传路径用）。

> 安全/体量：透传的图片/PDF 字节进入消息与（auto 模式下）分类器提示，需设上限（如单图 ≤ 5MB、PDF ≤ 限定页/字节），超限降级到 B/C。

---

## 6. core 多模态消息（透传落地）

- **存**：携 parts 的 user 输入写成 `entry.content: MessagePart[]`（text part + image/file part），复用既有 parts 存储（agent §5.3，[session-store.ts](../packages/agent/src/storage/session-store.ts)）。
- **回放**：[session.ts](../packages/agent/src/runtime/session.ts) 的 `buildMessages()` 对带 parts 的 user entry 输出 **`content: [{type:'text',...},{type:'image'|'file', ...}]`**，而非 `entryText` 拍平。其余 entry 仍走文本。
- **下发**：AI SDK 把 image/file 块原生传给 Anthropic / Google / OpenAI（agent §2）。core 不需要识别"这是图"——SDK + provider 负责。
- **门控**：仅当 orchestrator `modalities` 支持时才构造 parts（§3.1/§11）；否则该 entry 退回文本（如附一句"用户发了图片但当前模型不支持"）。

---

## 7. 语音：STT（路线 B，恒需）

模型不吃原始音频（Claude 无音频输入；Gemini/gpt-4o-audio 例外但非默认）→ **语音永远先转写**。

```
voice(OGG/Opus) → 下载 → STT → 文字 → sendMessage(text)
```

- **位置**：网关侧的转写步骤（保持 core 文本）。
- **STT 选型/配置**：新增一个**转写 provider**（OpenAI Whisper—OGG 直收 / Gemini 音频 / 本地 whisper.cpp），在 gateway 配置里声明（keychain 存密钥，gateway §7）。未配 STT → `voice:'off'` 行为，回提示。
- **例外优化**：若 orchestrator 是音频原生模型且 `modalities.audio` 为真，可走 A 透传音频块（与图片同机制），省一次 STT——属可选增强。

---

## 8. 文档：存盘让 agent 解析（路线 C，默认）

- **存盘**：把 `Attachment`（document）写入**该会话工作目录**（gateway §4.2，Dispatcher 的 `workspaceFor` 已按会话隔离目录）。文件名做安全化处理。
- **提示 agent**：inbound 文本拼一段前缀，如：
  `（用户上传了文件：./uploads/<safe-name>.pdf，2.1MB。需要时用工具读取。）`
- **agent 自取**：文本/CSV/代码 → `readFile`；PDF/Word/Excel → `runCommand`/`runScript`（`pdftotext` / `python-docx` / `openpyxl`）或对应**技能**（agent §3 技能系统：pdf / docx / xlsx）。
- **前提**：解析工具在 agent 环境可用——文档化为部署前提，或随网关附带最小解析脚本/技能。

---

## 9. PDF 双路：C 默认 + A 可选 ★

PDF 既能让 agent 解析（C），也能（模型支持时）整份透传给模型看版式/图（A）。由 §3.2 的 `media.pdf` 决定：

| `media.pdf` | 行为 | 前提 |
| --- | --- | --- |
| `'agent'`（默认） | 存盘 + 提示 agent（§8） | 无 |
| `'passthrough'` | 作为 `{type:'file', mediaType:'application/pdf'}` 块进模型消息（§6） | `modalities.pdf` 为真，否则降级到 `'agent'`（§11） |
| `'extract'` | 网关 `pdftotext` 抽文本 → `sendMessage` | 无 |

- **透传上限**：大 PDF 设页数/字节上限（§5 安全），超限自动转 `'agent'`，记日志。
- **取舍提示**：A 保真但费 token、单条上下文压力大；C 省、可按需读但依赖解析工具。默认 C，让用户在「模型支持时」显式选 A。

---

## 10. Dispatcher 路由

把 [dispatcher.ts](../apps/gateway/src/runtime/dispatcher.ts) 现在「见附件即丢弃」的 `composeText` 改为**按类型分发**（读 §3 能力 + §3.2 配置）：

```
for att in msg.attachments:
  image    → A 透传（vision+config）/ B 描述 / 文本注记
  voice    → STT → 并入文本（§7）
  pdf      → media.pdf：agent(§8) / passthrough(§9 A) / extract(B)
  document → agent(§8) / extract(B)
text 前缀拼「附件清单 + 路径/转写摘要」；A 路径的 parts 经 §5 入口带给 host.sendMessage
```

逻辑保持**通道无关**（gateway §3.3）：通道只产出归一化 `Attachment`，路由策略集中在 Dispatcher。

---

## 11. 能力门控与降级

**透传 = 模型能力 ∧ 用户配置**；任一不满足即降级，**fail-soft 不 fail-hard**：

| 配置 \ 模型能力 | 支持该模态 | 不支持 |
| --- | --- | --- |
| passthrough（A） | ✅ 透传 | ⬇ 降级：图片→describe(B) / PDF→agent(C)，记日志 |
| describe / extract（B） | ✅ | ✅ |
| agent（C） | ✅ | ✅ |

- 体量超限（图/PDF 过大）→ 同样降级（A→C/B）。
- STT 未配 → 语音回提示（不静默吞）。
- 任何降级都在审计/日志留一行（谁、什么文件、为何降级），便于排查。

---

## 12. 落地阶段

| 阶段 | 内容 | 改 core? |
| --- | --- | --- |
| **M1 入站 + 文档 C** | download helper（getFile）、Attachment、存 workdir、Dispatcher 路由文档、inbound 前缀 | 否 |
| **M2 语音 STT** | 转写 provider + 配置；voice→文本 | 否 |
| **M3 能力检测 + 配置** | models-dev 暴露 `modalities`（image/pdf/audio）、`MediaConfig`、面板「有能力才显示」 | 否（核心是注册表派生 + 配置） |
| **M4 图片/PDF 透传（A）** | 契约 `sendMessage(...,parts?)`（§5）、`buildMessages` 多模态（§6）、门控降级（§11） | **是** |
| **M5 增强** | 图片 describe 兜底、音频原生透传、PDF 页数上限、xlsx→md 抽取器 | 否 |

> 建议顺序：**先 M1–M3（不碰 core，立刻可用：文档能读、语音能听、能力可配）**，验证体验后再上 M4 的多模态透传。

---

## 附录 A：媒体适配表

| 输入 | 模型原生? | 默认路线 | 可选 | 门控 |
| --- | --- | --- | --- | --- |
| 图片 | vision 模型可 | A 透传 | B 描述 | `modalities.image` × `media.image` |
| 语音 | 否（除音频原生模型） | B：STT→文字 | A（音频原生） | 需配 STT；`modalities.audio` |
| **PDF** | Claude/Gemini 可 | **C 存盘 agent 解析** | **A 透传** / B 抽取 | `media.pdf` × `modalities.pdf` |
| Word/Excel/PPT | 否 | C 存盘 agent 解析 | B 抽取 | 无（恒可） |
| txt/csv/代码 | 是（即文本） | 当文本 / C | — | 无 |
| 视频 | 少数模型 | 暂存盘 + 提示（或抽帧/转写音轨） | — | 后续 |
