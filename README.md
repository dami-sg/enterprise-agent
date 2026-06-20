# Enterprise Agent

A **host-agnostic agent core** built on the **Vercel AI SDK v6** (`ToolLoopAgent`),
with a terminal shell (CLI/TUI) that embeds it in-process. The core runs an
orchestrator that plans, calls tools, and delegates to focused sub-agents — under
a human-in-the-loop approval kernel, an OS sandbox, and an append-only session
tree — while staying decoupled from any UI through a transport-agnostic
command/event contract.

> Full design (domain model, runtime, tools, security, persistence, the §6
> contract): [`specs/agent-architecture.md`](specs/agent-architecture.md).

## Features

- **Orchestrator + sub-agents** — a `ToolLoopAgent` drives the *call tool → feed
  result → keep reasoning* loop. It can delegate bounded sub-tasks to focused
  sub-agents (Agent-as-Tool) with **role-restricted tool sets** (`researcher` /
  `coder` / `analyst` / `writer` / `generalist`), depth limits, wall-clock
  timeouts, and bounded concurrency.
- **Human-in-the-loop approval** — high-risk tools (exec / write / network / MCP)
  pass a three-state gate (`once` / `session` / `reject`) with a session grant
  table keyed by a meaningful scope (executable, dir prefix, host).
- **Execution modes** — `ask` (per-call approval), `plan` (read-only explore →
  propose a plan → approve → execute), and `auto` (a safety classifier
  adjudicates allow/deny/ask, failing closed). Modes are the *steering wheel*;
  they never override the role hard-gate, hard-deny, file boundary, or sandbox.
- **Tools** — file read/list/search/write/patch, command execution, HTTP fetch,
  todo planning, interactive multiple-choice questions, and a clock — all
  boundary-checked and policy-gated.
- **MCP** — connect external [Model Context Protocol](https://modelcontextprotocol.io)
  servers (stdio / SSE / HTTP); their tools join the set as `mcp__<server>__<tool>`,
  gated by `riskTier`, isolated per server.
- **Skills** — Agent-Skills-compatible (`SKILL.md`) progressive disclosure: only
  descriptions are injected up front; the model loads a skill's body on demand,
  with lexical search once the catalog grows.
- **OS sandbox** — commands run wrapped by a managed [landstrip](packages/agent/src/sandbox)
  binary when available; a sandbox denial surfaces a structured grant request and
  retries. Falls back to no-sandbox (still gated) with a warning.
- **Model registry** — three layers: provider access → semantic aliases (role →
  model) → a unified registry, over AI SDK `createProviderRegistry` +
  `customProvider`. Dynamic model discovery, metadata enrichment from models.dev,
  and per-step token/cost accounting.
- **Persistence & compaction** — an append-only session tree (`session.jsonl`),
  run tree, and audit log; fork / label / clone; threshold + overflow context
  compaction driven by real provider token counts.

## Requirements

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | ≥ 20.11 | runtime for the core + headless CLI |
| pnpm | 11.5.1 | workspace package manager |
| Bun | ≥ 1.3 | runs the OpenTUI/Solid TUI (`ea`) |

A provider API key (Anthropic / OpenAI / OpenAI-compatible / gateway) is needed
for the agent to actually run; keys live only in the OS keychain.

## Quick start

```bash
pnpm install
pnpm build        # agent-contract → agent → cli

# configure a provider + bind the orchestrator model (or use /config in the TUI)
cd apps/cli
bun src/bin.ts provider add --kind openai --id openai
bun src/bin.ts auth login openai            # masked key entry → OS keychain
bun src/bin.ts models set orchestrator openai:gpt-4.1

bun src/bin.ts                              # launch the TUI
bun src/bin.ts run -p "summarize ./README.md"   # headless one-shot
```

From the repo root, `pnpm dev` rebuilds the libraries and launches the TUI in one
step. See [`apps/cli/README.md`](apps/cli/README.md) for the full command surface.

## Monorepo layout

```
packages/
  agent-contract/   @enterprise-agent/agent-contract — pure types: the §6 command/event
                    contract + domain models (zero runtime deps; safe for any host)
  agent/            @enterprise-agent/agent — the agent core: runtime, tools, approval,
                    MCP, skills, sandbox, model registry, file storage
apps/
  cli/              @enterprise-agent/cli — the terminal shell: an OpenTUI/Solid TUI +
                    headless runner that embeds the core in-process (run under Bun)
specs/              architecture & design docs (the source of truth)
```

## The §6 contract (host-agnostic)

Every host — the bundled CLI today, a desktop (Electron) host tomorrow — drives
the core through the **same transport-agnostic command/event contract** in
`@enterprise-agent/agent-contract`. Commands go in (`startSession`, `sendMessage`,
`approveTool`, `setExecutionMode`, …); a stream of `AgentStreamEvent`s comes back
(`text-delta`, `tool-call`, `tool-result`, `tool-approval-required`,
`sub-agent-start`, `usage`, `run-finish`, …). The host only supplies the shell:
process model, transport, and UI.

```
host ──commands──▶  AgentHost (createAgentHost)  ──events──▶ host renders trace tree
```

## Develop

```bash
pnpm build        # build all packages (agent-contract → agent → cli)
pnpm typecheck    # tsc across the workspace (incl. the Bun/Solid TUI program)
pnpm test         # vitest (core + cli) + bun test (TUI)
pnpm dev          # build libs, then launch the TUI from source
```

Sandbox the data root so development never touches your real config:
`ENTERPRISE_AGENT_HOME=/tmp/ea-dev pnpm dev`.

## Specs

| Doc | Covers |
| --- | --- |
| [agent-architecture.md](specs/agent-architecture.md) | domain model, runtime, tools, security/sandbox, persistence, the §6 contract |
| [execution-modes.md](specs/execution-modes.md) | ask / plan / auto and the unified decision pipeline |
| [skill-search.md](specs/skill-search.md) | progressive disclosure + lexical skill search |
| [cli-architecture.md](specs/cli-architecture.md) | the in-process CLI host, headless runner, trace core |
| [cli-ui.md](specs/cli-ui.md) | the TUI screens, config tabs, and branch navigator |

## Notes

- Packages use the `@enterprise-agent/*` scope (renamed from the original
  monorepo's `@ztagent/*`).
- The core is the product; the CLI is one reference host. A separate desktop
  (Electron) host can drive the same core through the §6 contract.

## License

[MIT](LICENSE)
