/**
 * OpenTUI TUI entry (run under Bun): `bun --preload @opentui/solid/preload
 * src/tui-otui/main.tsx`. Bootstraps the in-process agent host and mounts the
 * Solid session screen. Phase 2 standalone entry; Phase 5 wires this into the
 * `ea` command in place of the Ink `launchTui`.
 */
import { render } from "@opentui/solid"
import { bootstrap } from "../host/bootstrap.js"
import { SessionApp } from "./session.js"

async function main() {
  const ctx = bootstrap({ root: process.env.ENTERPRISE_AGENT_HOME })
  if (ctx.config.loadProviders().length === 0) {
    process.stderr.write("提示：尚未配置 Provider（cli §9/§10）。\n")
  }
  const sessions = await ctx.host.listSessions()
  const initialSessionId = sessions.find((s) => s.isActive)?.id ?? sessions[0]?.id
  await render(() => <SessionApp ctx={ctx} initialSessionId={initialSessionId} />)
}

void main()
