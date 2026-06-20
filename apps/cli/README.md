# @enterprise-agent/cli

The CLI shell for Enterprise Agent — an **Ink TUI + headless runner** that embeds
the agent host **in-process** (no daemon, no IPC). Implements
[cli-architecture.md](../../specs/cli-architecture.md) and
[cli-ui.md](../../specs/cli-ui.md).

```
ea                 # launch the Ink TUI (default, cli §4)
ea run -p "..."    # headless one-shot (scripts/CI, cli §5)
ea provider presets               # list built-in known providers (DeepSeek, Groq, …)
ea provider add --preset deepseek # one-shot add a known source (auto base URL)
ea provider add …  # or fully custom: --kind/--id/--base-url (cli §9.1 / §10)
ea auth login [id] # set/update a provider key (masked, keychain-only)
ea session new|ls|switch|rm|config   # the unified Session entity (agent §1)
ea session tree|fork|label|compact|clone <id>   # session tree (agent §5.4)
ea models | mcp ls | skill ls | config   # read-only config views (cli §9)
ea models set orchestrator openai:gpt-4.1  # bind an alias → provider:model (§9.2)
```

> **First run:** add a provider, then bind a model so the agent has something to
> run — `ea provider add --kind openai --id openai` (or `/config` in the TUI),
> then `ea models set orchestrator <provider>:<model>` (or the TUI 模型 tab → `o`
> picker). Without an `orchestrator` binding the host falls back to the built-in
> Anthropic ref, which needs an Anthropic key.

## Development

Run the CLI straight from TypeScript source via [`tsx`](https://tsx.is) — no
build step, no `dist/`:

```bash
pnpm dev                       # from repo root: build the libs, then launch the TUI
pnpm dev -- run -p "hello"     # forward headless args after `--`
pnpm --filter @enterprise-agent/cli dev          # same, from anywhere
pnpm --filter @enterprise-agent/cli dev:watch    # restart on source change (headless)
```

`pnpm dev` rebuilds the two libraries (`agent-contract`, `agent`) so the
in-process host is fresh, then runs `apps/cli/src/bin.ts` under `tsx`. The TUI
needs a real TTY (Ink raw mode); plain `pnpm dev` in an interactive terminal is
the main debug loop.

- **Sandbox the data root** so debugging never touches your real config:
  `ENTERPRISE_AGENT_HOME=/tmp/ea-dev pnpm dev` (absolute path — `--filter` runs
  in `apps/cli`, so a relative `--root` resolves there).
- **Scripting a piped secret** (`echo $KEY | … provider add`)? Call the built
  binary or `tsx src/bin.ts` directly — the root `pnpm dev` chain's build step
  consumes piped stdin first.

## Architecture

Everything renders from one pure core — **`reduceTrace`** (`src/core/trace.ts`,
cli §5.3) folds the `AgentStreamEvent` stream (agent §6.2) into a navigable
trace-tree state. The TUI (§4) and the headless renderers (§11) share it
verbatim, swapping only the back-end:

```
host.onEvent ─▶ reduceTrace ─▶ { Ink components (§3–§7) | line printer (§11.1) | JSON Lines (§11.2) }
```

| Layer | Files | Spec |
| --- | --- | --- |
| Trace core | `core/trace.ts`, `core/glyphs.ts` | cli §5.3, §1.3 |
| Host bootstrap + OS keychain | `host/*` | cli §1, §7, §10 |
| Headless run / renderers / policy | `headless/*` | cli §5, §11, §6.2 |
| Commands (Commander) | `commands/*` | cli §3, §9, §10 |
| Ink TUI shell | `tui/App.tsx`, `tui/components.tsx` | cli §4, cli-ui §2–§7 |
| Branch navigator + config tabs | `tui/views.tsx` | cli-ui §8, §9 |

The MainPane is swappable (cli-ui §1.1): `/fork` opens the **Branch Navigator**
(§8 — navigate the session tree, fork / label / clone) and `/config` opens the
**config tabs** (§9.1–§9.5: Providers / 模型 / MCP / Skills / Config), both
routing `Esc` back to the session view. The TUI runs **fullscreen** (alternate
screen buffer). The config tabs support **in-place edits**: the Providers tab lists configured
providers **and the built-in presets** not yet added (dimmed) — `↵`/`e` adds the
selected preset (auto base URL → chains into key entry), or `a` fuzzy-searches
the catalog. Toggle a provider/MCP server (`e`), set a provider key masked
(`k`, keychain-only), refresh model discovery (`r`), toggle the sandbox (`s`),
and **bind a model** on the 模型 tab (`o` → pick provider → fuzzy-pick model →
saves the alias, §9.2).
Switching to an existing session **reconstructs its history** from the persisted
tree (§4.6) before attaching the live stream.

## Security (cli §7 / §10)

API keys land **only** in the OS keychain (macOS `security`; a 0600 file
fallback elsewhere). `providers.json` keeps just the `keyRef`; plaintext never
enters events, logs, or config. Key input is masked. Non-interactive approval
**defaults to `reject`** — `auto:*` is an explicit, audited downgrade; the
sandbox still applies.

## Deferred

- Skill import inside the TUI (skills tab stays read-only) — use `ea skill add …`.
- `daemon` mode (cli §8): `ea serve` / `--server` is stubbed; in-process covers
  the single-user local path.
