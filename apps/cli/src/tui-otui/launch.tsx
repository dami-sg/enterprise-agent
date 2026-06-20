/**
 * OpenTUI TUI launch (cli §4): bootstrap the in-process host, pick the active
 * session (or none → `SessionApp` creates one on first message, §12.1), and
 * mount the Solid session screen fullscreen. Unlike the Ink launch, the OpenTUI
 * renderer owns the terminal itself (alternate screen, raw mode, mouse) and
 * restores it on exit — so there's no manual alt-screen / mouse escape writing.
 * `SessionApp` owns Ctrl-C (abort run / quit confirmation, §12.4), so the
 * renderer's own Ctrl-C exit is disabled.
 *
 * Solid JSX in this module (and `session`/`views`) is transformed at load time
 * by the `@opentui/solid` Bun plugin that `bin.ts` registers up front — which is
 * why the default command reaches this module only through a dynamic import.
 */
import { render } from "@opentui/solid"
import { bootstrap } from "../host/bootstrap.js"
import { SessionApp } from "./session.js"

export async function launchTui(global: { root?: string }): Promise<void> {
  const ctx = bootstrap({ root: global.root })
  if (ctx.config.loadProviders().length === 0) {
    process.stderr.write("提示：尚未配置 Provider。在配置页（/config）添加来源并 o 绑定模型（cli §9/§10）。\n")
  }
  const sessions = await ctx.host.listSessions()
  const initialSessionId = sessions.find((s) => s.isActive)?.id ?? sessions[0]?.id
  await render(() => <SessionApp ctx={ctx} initialSessionId={initialSessionId} />, {
    exitOnCtrlC: false,
  })
}
