# Gateway 测试指南

从「跑单元测试」到「真机 Telegram / 微信对话」的完整路径。分四层，按需推进：

| 层 | 需要什么 | 验证什么 |
| --- | --- | --- |
| L0 单元测试 | 无 | 路由/重置、审批桥、问答、计划、命令、分权、切分、iLink 协议、AES、渲染、熔断 |
| L1 配置核心 | 一个 LLM provider | agent 核心本身能回复（gateway 的前提） |
| L2 本地终端 e2e | 同上 | 在终端和真实 agent 走完整网关链路（**无需任何 IM 账号**） |
| L3 Telegram 真机 | Telegram bot token | 全能力通道：流式编辑 + 按钮审批 + 群 |
| L4 微信 iLink | 微信扫码 | 最弱通道：整条发 + `/approve` 文本审批 |

---

## 0. 准备

```bash
# 环境：Node ≥ 22.13，pnpm 11.5.1，Bun ≥ 1.3（跑 CLI 需要）
cd /Users/yuzhao/git/dami/enterprise-agent
pnpm install
pnpm -r build          # agent-contract → agent → cli → gateway
```

便捷别名（**关键：CLI 必须用 Bun 跑；gateway 用 Node 跑 dist 即可**）：

```bash
# 隔离测试数据，不污染真实配置（可选但推荐）
export ENTERPRISE_AGENT_HOME=~/.ea-gateway-test

alias ea='bun /Users/yuzhao/git/dami/enterprise-agent/apps/cli/src/bin.ts'
alias ea-gateway='node /Users/yuzhao/git/dami/enterprise-agent/apps/gateway/dist/bin.js'
```

> ⚠️ macOS 上密钥存进**系统 keychain**（service=`enterprise-agent`），与 `ENTERPRISE_AGENT_HOME` 无关。隔离 HOME 只隔离配置/会话，不隔离 keychain——用唯一的 keyRef 即可。

---

## L0. 单元测试（无需任何外部账号）

```bash
pnpm --filter @enterprise-agent/gateway test          # 58 个用例
pnpm --filter @enterprise-agent/gateway test -- --watch
pnpm -r test                                          # 全仓：agent 173 + cli 48 + gateway 58
```

重点用例：

- `dispatcher.test.ts` — 会话路由、**子代理审批的 turnRuns 不变量**、按钮/文本/auto 三条审批路径、问答、计划、`/new` `/mode` `/stop`、并发保护。
- `router.test.ts` — `routes.json` 持久化 + idle/daily/command 重置。
- `weixin.test.ts` — iLink 鉴权头、`getupdates` body、图片 hex vs 文件 base64 的 AES key 坑。
- `chat-render.test.ts` — 流式编辑 vs 整条发、长文切分。
- `gateway-runtime.test.ts` — 适配器构建、`/platform` 管控、缺 token 时不崩。

---

## L1. 配置 agent 核心（provider + 模型）

> 🖥 **可视化捷径**：`ea-gateway ui` 打开本地 Web 面板（http://127.0.0.1:7317），
> L1（接 Provider + 绑模型）和 L3（加通道 + 写 token）的全部配置都能在浏览器里点完，
> 无需手敲下面的命令或手写 `gateway.json`。下面是等价的命令行方式。

gateway 复用同一份 `~/.enterprise-agent`，所以先用 CLI 把核心配通。三选一：

```bash
# A) 本地 Ollama（免费，推荐）：ollama serve && ollama pull qwen2.5
ea provider add --kind openai-compatible --id ollama --base-url http://localhost:11434/v1   # 本地端点免 key
ea models set orchestrator ollama:qwen2.5

# B) Anthropic
ea provider add --kind anthropic --id anthropic          # 交互输入 API key（掩码）
ea models set orchestrator anthropic:claude-sonnet-4-5

# C) OpenAI
ea provider add --kind openai --id openai
ea auth login openai
ea models set orchestrator openai:gpt-4.1
```

**冒烟验证（必做）**——核心能回复，gateway 才能工作：

```bash
ea run -p "用一句话介绍你自己"
```

---

## L2. 本地终端端到端（无需 IM 账号，最快）

用示例「stdin 通道」直接驱动真实网关链路（Router → Dispatcher → host → ChatRenderer）。
它模拟最弱通道（无编辑、无按钮），审批走 `/approve` 文本：

```bash
cd apps/gateway
bun examples/stdin-channel.ts
```

然后在终端里直接对话：

```
> 你好，你能做什么？
🤖 …（流式/整条回复）

> 在当前目录创建文件 hello.txt，内容写 hi
🤖 ⏸ 需要审批：`writeFile` · …
   回复 /approve 批准（本会话），或 /deny 拒绝。
> /approve
🤖 ✅ 已批准（本会话）。…
```

改 `examples/stdin-channel.ts` 里的 `approval: 'reject'` 为 `'auto:session'` 可演示「完全无人值守自动放行」（看到 `⚡ 已自动批准`）。

---

## L3. Telegram 真机（最简单的真实通道，无需公网）

### 3.1 建 bot
Telegram 里找 **@BotFather** → `/newbot` → 起名 → 拿到 token（形如 `8123456:AAH...`）。

### 3.2 写 token 进 keychain
```bash
echo "8123456:AAH..." | ea-gateway secret set telegram-bot-token
ea-gateway secret check telegram-bot-token        # ✓ 存在
```

### 3.3 写 `gateway.json`（在 `$ENTERPRISE_AGENT_HOME/gateway.json`）
```jsonc
{
  "verbose": true,
  "channels": [
    {
      "name": "telegram",
      "enabled": true,
      "token": { "keyRef": "telegram-bot-token" },
      "session": { "executionMode": "ask" },   // 先用 ask 测按钮审批
      "approval": "reject",
      "reset": { "mode": "idle", "idleMinutes": 60 }
    }
  ]
}
```

### 3.4 启动
```bash
ea-gateway start                 # 日志：[gateway] 通道已启动：telegram
ea-gateway status                # 另开终端，看通道 + 路由
```
在 Telegram 给 bot 发消息即可。按下面的场景矩阵逐条测。

---

## L4. 微信 iLink（可选，最弱通道）

```bash
ea-gateway weixin login          # 终端打印二维码图片路径 + 内容；用微信扫码确认
# 成功后自动：bot_token 写 keychain（keyRef=weixin-bot-token-<id>），gateway.json 追加 weixin 通道
ea-gateway start
```
微信 **私聊** 给 bot 发消息（群基本不可用，§8.6）。无流式编辑→整条发；无按钮→`/approve` 文本审批。

> iLink 是新接口，稳定性/限速未公开，可能失败——正好验证熔断兜底（§2.3）。

---

## 测试场景矩阵（逐条 + 预期）

| # | 操作 | 预期 | 对应 |
| --- | --- | --- | --- |
| 1 基本对话 | 发「用一句话介绍你自己」 | 显示「正在输入…」；Telegram 流式编辑、微信整条发；`routes.json` 出现 `telegram:<chatid>→s1` | §5 / §4.1 |
| 2 多轮复用 | 再发「我刚才问了什么」 | 复用 s1（status 路由不变），记得上下文 | §4.1 |
| 3 并发保护 | 长任务未完成时再发一条 | 回「⏳ 正在处理上一条消息…」 | dispatcher |
| 4 按钮审批 | `ask` 模式下发「创建 hello.txt 写入 hi」 | Telegram 弹 [允许一次][本会话允许][拒绝]；点「本会话允许」→ 执行；再写第二个文件不再问（session grant） | §6.1 |
| 5 文本审批 | 微信/stdin 通道发同样请求 | 弹 `/approve` `/deny` 提示；`/approve` → 执行 | §6.1 |
| 6 auto 放行 | `approval` 改 `auto:session` 重启，再发写文件 | 不弹按钮，直接「⚡ 已自动批准」并执行 | §6.1 |
| 7 问答 | 发「帮我二选一，先问我偏好」 | 弹选项按钮 / 编号文本；点或回数字 → 继续 | §6.3 |
| 8 计划 | `/mode plan` 再发「重构 X」 | 发计划 markdown + `/approve` 提示；`/approve` → 执行 | §6.3 |
| 9 命令 | `/status` `/help` `/model fast` `/mode auto` | 各自生效（看回执） | §6.2 |
| 10 重置 | `/new` | 「已重置」，下条起新会话（routes→s2） | §4.3 |
| 11 中断 | 长任务中 `/stop` | 「已请求中断」 | §6.2 |
| 12 通道管控 | `/platform ls`、`/platform pause telegram`、`/platform resume telegram` | 状态切换 running/paused | §2.3 |
| 13 idle 重置 | `idleMinutes:1`，静默 1 分钟后发消息 | 起新会话 | §4.3 |
| 14 熔断 | `secret set` 写个错 token 重启 | 连续失败 5 次 → 日志「已熔断暂停」，status=error；`/platform resume` 恢复 | §2.3 |
| 15 多会话隔离 | 第二个 Telegram 账号同 bot 对话 | 独立会话 + 独立路由 | §4 |
| 16 分权 | 配 `allowAdminFrom:["<你的id>"]`，用别的账号发 `/stop` | 「⛔ 你没有权限」 | §6.4 |
| 17 子代理审批 | 发需委派子代理且子代理写文件的任务 | 审批照常弹出（turnRuns 不变量；真机较难构造，主要靠 L0 覆盖） | §2.2 |

---

## 调试技巧

- `"verbose": true` → 聊天里看 `🔧 工具` / `▸ 子代理` 状态行。
- `ea-gateway status` / `ea-gateway route ls` / `route rm <channel> <conversationId>`。
- `ea sessions`（CLI）能回看 gateway 创建的会话树（共享同一 root）。
- 网关日志走 stderr；`ea-gateway start 2>gateway.log`。
- 全程 `export ENTERPRISE_AGENT_HOME=~/.ea-gateway-test` 隔离，删目录即清空（keychain 里的 token 用 `ea-gateway secret rm <ref>` 单独清）。
