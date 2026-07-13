# @dami-sg/gateway

A **resident IM gateway host** (`ea-gateway`) that bridges chat platforms to the
agent core. It is "just another host" (per [`specs/gateway-architecture.md`](../../specs/gateway-architecture.md)):
it embeds the core in-process via `createAgentHost()`, attaches a `ChannelAdapter`
per platform, and turns platform messages into the §6 command/event contract —
**no Agent logic is reimplemented and the core is unchanged.**

The same gateway bootstrap can also expose the app-server JSON-RPC WebSocket
endpoint (`WS /rpc`) for Web / desktop / mobile clients via
`ea-gateway app-server`.

It shares one app-data root (`~/.enterprise-agent/`) with the CLI / desktop, so
providers, keys, sessions and skills configured in either are seen by the other.

## Run

```bash
pnpm build                       # agent-contract → agent → cli → gateway
node apps/gateway/dist/bin.js    # start the gateway (default command)
# or, from source under Bun:
cd apps/gateway && bun src/bin.ts start
cd apps/gateway && bun src/bin.ts app-server --port 7320  # app-server WS /rpc
```

Commands:

| Command | Purpose |
| --- | --- |
| `ea-gateway ui` | **本地 Web 配置面板：从 0 可视化配置(模型 / 通道 / 密钥 / 微信扫码)** |
| `ea-gateway start` | Connect the host, read `gateway.json`, start each channel (default) |
| `ea-gateway app-server` | Start the shared app-server endpoint: `/rpc`, `/healthz`, `/readyz` |
| `ea-gateway status` | Show channel config + session routes |
| `ea-gateway route ls` / `route rm <channel> <conversationId>` | Inspect / drop routes |
| `ea-gateway secret set <ref>` | 把 bot token 写入 keychain(如 `telegram-bot-token`；支持 `echo $TOKEN \| …` 管道) |
| `ea-gateway weixin login` | QR-login a WeChat iLink Bot → keychain + `gateway.json` (§8.3) |

`--root <dir>` overrides the app-data root (defaults to `ENTERPRISE_AGENT_HOME`
or `~/.enterprise-agent`).

## Configure

> **最省事：`ea-gateway ui`** 打开本地 Web 面板（默认 http://127.0.0.1:7317），在浏览器里
> 从 0 完成下面全部配置——接 Provider + 绑模型、加通道、写 token、微信扫码、查看路由/状态。
> 只监听 localhost；服务器上用 SSH 端口转发访问。下面是等价的「文件 + 命令」方式。

Channels are declared in `~/.enterprise-agent/gateway.json`; **secrets are stored
only as a `keyRef` into the OS keychain**, never as plaintext. Write the token
with `ea-gateway secret set`, then reference it:

```bash
# Telegram: 把 bot token 写进 keychain，再在 gateway.json 里以 keyRef 引用
echo "123456:ABC..." | ea-gateway secret set telegram-bot-token
```

```jsonc
{
  "channels": [
    {
      "name": "telegram",
      "enabled": true,
      "token": { "keyRef": "telegram-bot-token" },
      "session": { "executionMode": "auto", "workingDir": "/srv/ws/tg" },
      "workspace": "per-user",                     // per-user (default) | shared — file isolation across accounts
      "approval": "policy:/etc/ea/approve.json",   // reject | auto:once | auto:session | policy:<file>
      "reset": { "mode": "idle", "idleMinutes": 240 }
    },
    {
      "name": "weixin",
      "enabled": true,
      "accountId": "bot-xxx",                       // from `weixin login`
      "token": { "keyRef": "weixin-bot-token-bot-xxx" },
      "baseURL": "https://ilinkai.weixin.qq.com",
      "session": { "executionMode": "auto" },
      "group": "disabled"
    }
  ]
}
```

Per-channel `session` is core's `ScopedConfig` (plus `workingDir`) — different
channels get different working directory / permission / model / execution mode,
so capabilities never leak across conversations (§4.2).

### Per-user isolation (§4.2)

Different chat accounts talking to the same bot are **isolated by account**:

- **Chat history / context / approval grants** — each account gets its own
  session, keyed by `conversationId` (a Telegram DM's `chat.id` *is* the user's
  id). They never see each other's conversation or share approval grants.
- **Files** — controlled by `workspace` (default **`per-user`**): each
  conversation gets its own subdirectory under `session.workingDir`, so accounts
  can't read or write each other's files. Set `"workspace": "shared"` to opt into
  one shared workspace (e.g. a team that should collaborate on the same files).
  With **no** `workingDir`, core's per-session scratch already isolates by session.

## Channels

| Capability | Telegram (§9) | WeChat iLink (§8) |
| --- | --- | --- |
| Inbound | long-poll `getUpdates` | long-poll `getupdates` (35s) |
| Streaming edits | ✓ (`editMessageText`) | ✗ → whole-message send + typing |
| Inline-button approval | ✓ | ✗ → `/approve` text or auto policy |
| Groups | ✓ | ✗ (DM-only; `group` defaults `disabled`) |
| Public ingress | not needed | not needed |

Weak-capability platforms degrade by **not implementing** the optional adapter
methods (`edit` / `typing`) or via `supportsButtons=false`; the runtime never
branches on platform (§3.3).

## Rich messages & interactive cards (§5 / §6)

core emits Markdown; the Telegram adapter renders it as rich HTML
(`parse_mode=HTML` — only `& < >` need escaping, with an automatic plain-text
fallback if Telegram rejects any entity):

- **Formatting** — bold / italic / strikethrough / inline code / fenced code
  blocks (with language) / links / blockquote / spoiler.
- **Tables** — Telegram Bot HTML has **no `<table>`** (sending one is a 400), so
  GFM tables render as an aligned monospace `<pre>` grid (CJK/emoji width-aware;
  cell Markdown is flattened to plain text). ASCII aligns exactly; CJK/emoji may
  drift slightly on some mobile fonts.
- **Approval cards** — inline buttons `[allow once][this session][reject]`; a tap
  **edits the card in place** (drops the keyboard, appends the outcome) instead
  of stacking unanswered cards up the screen.
- **Todo checklist** — `todo-update` becomes one live, edited-in-place
  `✅ / 🔄 / ◻️` checklist.
- **Sub-agent progress** — `sub-agent-start` / `sub-agent-finish` become one live
  card: each delegated sub-agent's role + running/done state + closing summary.

WeChat (no edit, no buttons) auto-degrades: whole-message plain text, `/approve`
text approval, and short start/finish notices instead of live cards.

## In-chat commands (§6.2)

`/new` `/reset` · `/approve` `/deny` · `/stop` · `/model <alias>` ·
`/mode ask|auto|plan` · `/platform ls|pause|resume [channel]` · `/status` ·
`/help` · `/<skill> …` (forwarded as a message). High-risk verbs are gated by the
per-channel admin allowlist (`allowAdminFrom`, §6.4).

## Develop

```bash
pnpm --filter @dami-sg/gateway build
pnpm --filter @dami-sg/gateway typecheck
pnpm --filter @dami-sg/gateway test
```
