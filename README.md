# enterprise-agent

Host-agnostic **Agent core module** built on **Vercel AI SDK v6** (`ToolLoopAgent`).
See [`specs/agent-architecture.md`](specs/agent-architecture.md) for the full design
(domain model, runtime, tools, security/sandbox, persistence, and the §6 module contract).

## Monorepo layout

```
packages/
  agent-contract/   # @enterprise-agent/agent-contract — pure types: §6 commands/events + domain models (zero runtime deps)
  agent/            # @enterprise-agent/agent — the Agent core module (runtime, tools, approval, MCP, skills, sandbox, file storage)
```

## Develop

```bash
pnpm install
pnpm build       # build packages (agent-contract → agent)
pnpm typecheck
pnpm test
```

## Notes

- Packages use the `@enterprise-agent/*` scope (renamed from the original monorepo's `@ztagent/*`).
- The desktop (Electron) and CLI hosts are **not** part of this repo; they drive the module
  through the transport-agnostic §6 contract in `@enterprise-agent/agent-contract`.
