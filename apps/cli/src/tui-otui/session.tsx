/**
 * OpenTUI + Solid session screen (cli-ui §2–§7). The conversation lives in a
 * native `<scrollbox>` (scroll / follow / mouse handled by the framework) with
 * folding reasoning/tool rows (§3.2), the input is a `<textarea>` plus a model
 * line, and modals (picker / model / config / exit) float over it — all things
 * Ink lacked. Reuses the host wiring + `reduceTrace` from the existing core.
 */
import { createEffect, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid"
import { SyntaxStyle, defaultTextareaKeyBindings } from "@opentui/core"
import type { AgentStreamEvent, DiscoveredModel, ExecutionMode, Session as Sess } from "@enterprise-agent/agent-contract"
import { EXECUTION_MODE } from "@enterprise-agent/agent-contract"
import type { CliContext } from "../host/bootstrap.js"
import {
  flattenTrace,
  flattenSubAgentLog,
  initialTrace,
  reduceTrace,
  fmtTok,
  type TraceState,
  type TraceRow,
  type TextItem,
  type ToolItem,
  type AgentItem,
  type CompactionItem,
  type ShellItem,
  type PendingApproval,
  type PendingQuestion,
} from "../core/trace.js"
import type { ApprovalDecision, PlanDecision } from "@enterprise-agent/agent-contract"

/** The `plan-proposed` stream event (agent §3.8.4) — drives the PlanOverlay. */
type PlanProposed = Extract<AgentStreamEvent, { kind: "plan-proposed" }>
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

const SHELL_OUTPUT_CAP = 16_000

/** Run a shell-escape command via `sh -c` (so args/pipes/globs work), capturing
 *  combined stdout+stderr (capped) and the exit code. Never rejects. */
function execShell(command: string, cwd: string): Promise<{ text: string; code: number }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env })
    } catch (e) {
      resolve({ text: String(e), code: -1 })
      return
    }
    let buf = ""
    const cap = (d: Buffer) => {
      if (buf.length < SHELL_OUTPUT_CAP) buf += d.toString()
    }
    child.stdout?.on("data", cap)
    child.stderr?.on("data", cap)
    child.on("error", (err) => resolve({ text: String(err), code: -1 }))
    child.on("close", (code) => resolve({ text: buf.slice(0, SHELL_OUTPUT_CAP), code: code ?? 0 }))
  })
}

const SLASH: { name: string; desc: string }[] = [
  { name: "/sessions", desc: "切换会话" },
  { name: "/new", desc: "新建会话(可指定工作目录)" },
  { name: "/clear", desc: "清屏(不删历史)" },
  { name: "/compact", desc: "压缩当前上下文" },
  { name: "/model", desc: "切换当前模型(同 provider 内)" },
  { name: "/fork", desc: "会话树导航 / 分叉(§8)" },
  { name: "/config", desc: "Provider/模型/MCP/技能/配置(§9)" },
  { name: "/exit", desc: "退出" },
]

/** Which pane fills the body: the conversation, or a full-pane view (§1.1). */
type View = "session" | "branch" | "config"

type Overlay =
  | null
  | { kind: "picker" }
  | { kind: "new"; error?: string }
  // Model switcher (§6.3 /model): pick another model under the current provider.
  | { kind: "model"; alias: string; providerId: string; models: DiscoveredModel[]; filter: string; sel: number; current?: string }
const UNTITLED = "新会话"
/** Visible rows of a contained sub-agent log viewport (§3.1) — its content
 *  scrolls within this height so the main transcript stays put. The height
 *  adapts to the terminal (~40%, clamped): tall terminals show more of the log,
 *  short ones stay usable. Recomputed on resize via `useTerminalDimensions`. */
const SUBAGENT_LOG_MIN_ROWS = 6
const SUBAGENT_LOG_MAX_ROWS = 22
export const subAgentLogRows = (termHeight: number): number =>
  Math.max(SUBAGENT_LOG_MIN_ROWS, Math.min(SUBAGENT_LOG_MAX_ROWS, Math.floor(termHeight * 0.4)))
import { statusGlyph, summarizeInput, summarizeOutput, toolGlyph } from "../core/glyphs.js"
import { theme } from "../core/theme.js"
import { BranchView, ConfigView } from "./views.js"

/** Minimal markdown syntax style (headings/code accents); code fences in known
 * languages stay unhighlighted without the optional tree-sitter parsers. */
const MARKDOWN_SYNTAX = SyntaxStyle.fromStyles({
  default: { fg: "#cdcdd6" },
  heading: { fg: theme.accent, bold: true },
  emphasis: { italic: true },
  strong: { bold: true },
  code: { fg: theme.warning },
  link: { fg: theme.accent, underline: true },
})

/** Chat-style Enter handling: bare Enter submits, Shift+Enter inserts a newline
 * (OpenTUI's default binds bare Enter → newline). Bare ↑/↓ are also unbound from
 * cursor movement so they can drive the slash-completion menu / session picker
 * (§6.2). Built from the defaults so it works whether the textarea merges or
 * replaces `keyBindings`. */
const INPUT_KEYBINDINGS = [
  ...defaultTextareaKeyBindings.filter((b) => {
    const bare = !b.ctrl && !b.shift && !b.meta && !(b as { super?: boolean }).super
    return !(bare && (b.name === "return" || b.name === "up" || b.name === "down"))
  }),
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
] as typeof defaultTextareaKeyBindings

/** The printable text a key produces, or undefined for control / named keys —
 * used to filter the session picker while its textarea is blurred (§7.2). */
function typedChar(key: { ctrl?: boolean; meta?: boolean; name?: string; sequence?: string }): string | undefined {
  if (key.ctrl || key.meta) return undefined
  const s = key.sequence ?? ""
  if (!s) return undefined
  const c0 = s.charCodeAt(0)
  if (c0 < 0x20 || c0 === 0x7f) return undefined // ESC / control / DEL / arrows
  return s
}

/** Copy text to the system clipboard via OSC 52 (works locally + over SSH/tmux),
 * so selecting transcript text copies it without a native pbcopy/xclip. */
function writeClipboard(text: string): boolean {
  if (!process.stdout.isTTY || !text) return false
  const seq = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  // tmux/screen need the sequence wrapped in a DCS passthrough.
  process.stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq)
  return true
}

/** A left-only "quote bar" border (matches opencode's SplitBorder). */
const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

export function SessionApp(props: { ctx: CliContext; initialSessionId?: string }) {
  const { ctx } = props
  const [trace, setTrace] = createSignal<TraceState>(initialTrace(), { equals: false })
  const [sessions, setSessions] = createSignal<Sess[]>([])
  const [activeId, setActiveId] = createSignal<string | undefined>(props.initialSessionId)
  // The textarea's live content (drives the slash menu / dir).
  const [draft, setDraft] = createSignal("")
  const [overlay, setOverlay] = createSignal<Overlay>(null)
  // Slash-completion menu highlight (§6.2): Tab fills it, ↑↓ move it, ↵ runs it.
  const [slashSel, setSlashSel] = createSignal(0)
  // Session picker modal (§7.2): its own filter + selection (the textarea is
  // blurred while it's open, so the global key handler owns typing/↑↓/↵).
  const [pickerFilter, setPickerFilter] = createSignal("")
  const [pickerSel, setPickerSel] = createSignal(0)
  // In the session picker, `d` arms a delete-confirm on the selected session (§7.2).
  const [pickerDelete, setPickerDelete] = createSignal(false)
  // The /new centered modal's working-directory field (textarea blurred while open).
  const [newDir, setNewDir] = createSignal("")
  // Highlighted index among the /new modal's existing-workspace candidates (§7.2).
  const [newSel, setNewSel] = createSignal(0)
  // Bumped after /model saves an alias, so the model label re-reads config.
  const [modelVersion, setModelVersion] = createSignal(0)
  // Execution mode (agent §3.8): cycled with Shift+Tab, shown on the model line.
  // Tracked locally + driven by `mode-changed`; defaults to ask (the config
  // default for nearly all sessions), reset to ask when switching sessions.
  const [mode, setMode] = createSignal<ExecutionMode>(EXECUTION_MODE.ASK)
  // Auto can be disabled by the circuit breaker (agent §3.8.5 / §8); when off it
  // is dropped from the Shift+Tab cycle (a compliance tier). Set on session load.
  const [autoAvailable, setAutoAvailable] = createSignal(true)
  const modeCycle = (): ExecutionMode[] =>
    autoAvailable()
      ? [EXECUTION_MODE.ASK, EXECUTION_MODE.PLAN, EXECUTION_MODE.AUTO]
      : [EXECUTION_MODE.ASK, EXECUTION_MODE.PLAN]
  const modeColor = (m: ExecutionMode) => (m === "plan" ? theme.info : m === "auto" ? theme.warning : theme.muted)
  const cycleMode = () => {
    const id = activeId()
    if (!id) return
    const cyc = modeCycle()
    const i = cyc.indexOf(mode())
    const next = cyc[(i + 1) % cyc.length] ?? EXECUTION_MODE.ASK // current may be off-cycle
    setMode(next) // optimistic; the host echoes a mode-changed that confirms it
    ctx.host.setExecutionMode(id, next)
  }
  // Pending plan proposal (agent §3.8.4): set on plan-proposed, owns the keyboard
  // like an approval until the user decides (a/k/r), then cleared.
  const [pendingPlan, setPendingPlan] = createSignal<PlanProposed | null>(null)
  // When set, the user is editing the proposed plan in the input box before
  // approving it (agent §3.8.4 'edit'); ↵ approves the edited text, Esc cancels.
  const [editingPlan, setEditingPlan] = createSignal<{ planId: string } | null>(null)
  const decidePlan = (decision: PlanDecision) => {
    const pp = pendingPlan()
    if (!pp) return
    ctx.host.approvePlan(pp.planId, decision)
    setPendingPlan(null)
  }
  /** `e` on the plan bar: load the plan into the input for editing. */
  const startPlanEdit = () => {
    const pp = pendingPlan()
    if (!pp) return
    setEditingPlan({ planId: pp.planId })
    textarea?.setText?.(pp.plan)
    textarea?.focus?.()
  }
  /** ↵ while editing: approve the edited plan text. */
  const submitPlanEdit = () => {
    const ep = editingPlan()
    if (!ep) return
    const editedPlan = String(textarea?.plainText ?? textarea?.value ?? "")
    ctx.host.approvePlan(ep.planId, "edit", { editedPlan })
    setEditingPlan(null)
    setPendingPlan(null)
    textarea?.clear?.()
    textarea?.setText?.("")
  }
  /** Esc while editing: drop back to the a/k/r choices without approving. */
  const cancelPlanEdit = () => {
    setEditingPlan(null)
    textarea?.clear?.()
    textarea?.setText?.("")
  }
  // The body pane (§1.1): the conversation, the Branch Navigator (full-pane), or
  // the config tabs (a centered modal floating over the conversation, §9).
  const [view, setView] = createSignal<View>("session")
  // Idle Ctrl-C raises an exit-confirm modal (§12.4); `y` quits, any other key cancels.
  const [confirmQuit, setConfirmQuit] = createSignal(false)
  // Floating task panel (§5): pops from the top-right when todos are created,
  // hides on the next user message (set on send) until new todos arrive.
  const [todoDismissed, setTodoDismissed] = createSignal(false)
  const showTodos = createMemo(() => trace().todos.length > 0 && !todoDismissed())
  // A transient toast shown above the input (e.g. "已分叉"); auto-dismisses.
  const [toast, setToast] = createSignal("")
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const showToast = (text: string) => {
    setToast(text)
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setToast(""), 3000)
  }
  let runId: string | undefined
  // Run ids belonging to the active turn: the orchestrator run plus every
  // sub-agent run spawned under it. Sub-agent events carry the sub's own runId
  // (not the turn's), so without this their trace — and their approvals — get
  // dropped, leaving the sub-agent invisible and its writeFile prompt unanswerable.
  const subRuns = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let textarea: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let scroll: any

  // Collapse state for reasoning ("thinking") + tool rows (§3.2): real output is
  // folded by default; clicking the header toggles its id in this set.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const isExpanded = (id: string) => expanded().has(id)
  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  // Animated "thinking…" label: a frame counter ticks only while a run streams.
  // ~80ms/frame over the 10-frame braille cycle reads as a smooth spin (the
  // earlier 4-frame half-circle at 350ms looked choppy).
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (trace().status !== "running") return
    const t = setInterval(() => setFrame((f) => f + 1), 80)
    onCleanup(() => clearInterval(t))
  })
  /** Rotating spinner characters for the animated thinking indicator — the
   * braille dot cycle gives many fine frames so the motion looks fluid. */
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const spinnerChar = createMemo(() => SPINNER[frame() % SPINNER.length])
  const thinkingLabel = createMemo(() => "thinking")

  const dispatch = (action: Parameters<typeof reduceTrace>[1]) => setTrace((t) => reduceTrace(t, action))
  const refresh = async () => setSessions(await ctx.host.listSessions())

  // Terminal size (reactive — re-fires on resize). Drives the contained
  // sub-agent viewport's height so it scales with the window (§3.1).
  const termDims = useTerminalDimensions()
  const subAgentLogHeight = createMemo(() => subAgentLogRows(termDims().height))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderer: any = useRenderer()
  // Clean shutdown (§12.4): tear the OpenTUI renderer down FIRST — `destroy()`
  // leaves the alternate screen, disables mouse reporting, shows the cursor and
  // stops the render thread, restoring the terminal — THEN dispose the host and
  // exit. Skipping this is what left the screen un-refreshed and the terminal
  // spewing mouse escape sequences (乱码) after exit.
  let quitting = false
  function quit(): void {
    if (quitting) return
    quitting = true
    try {
      if (renderer && !renderer.isDestroyed) renderer.destroy()
    } catch {
      // best-effort terminal restore
    }
    void ctx.dispose().finally(() => process.exit(0))
  }

  // Copy-on-select (§2): dragging to select transcript text auto-copies it to the
  // system clipboard. `<text>` is `selectable` by default, so the whole window is
  // selectable; this just wires the copy. Debounced so only the finished
  // selection (mouse-up) writes, not every drag tick.
  let selText = ""
  let selTimer: ReturnType<typeof setTimeout> | undefined
  useSelectionHandler((sel: { getSelectedText?: () => string } | null) => {
    const text = sel?.getSelectedText?.() ?? ""
    if (!text.trim()) return
    selText = text
    if (selTimer) clearTimeout(selTimer)
    selTimer = setTimeout(() => {
      if (writeClipboard(selText)) showToast("已复制选中文本")
    }, 150)
  })

  // Sessions whose auto-title call is in flight, to dedupe concurrent run-finish
  // events (§1.1). Not a "done" set: the name-is-default check is the real gate.
  const titling = new Set<string>()
  // Auto-title a session after a turn (§1.1). The sole gate is "the name is still
  // the default placeholder" — a session the user/agent already named is left
  // alone. Once renamed it's no longer the default, so this self-limits to one
  // successful titling; a failed attempt can retry on a later run-finish.
  async function maybeTitle(id?: string) {
    if (!id || titling.has(id)) return // a title call is already in flight
    titling.add(id) // claim synchronously to dedupe concurrent events
    try {
      const s = (await ctx.host.listSessions().catch(() => [])).find((x) => x.id === id)
      if (!s || s.name !== UNTITLED) return // not the default name → don't touch it
      // A concise summary replaces the default name (§1.1). Use the model title
      // as-is — it's already prompted to be short and complete, and the host's
      // `cleanTitle` caps it for safety; do NOT hard-clip by code point, which
      // chops a coherent phrase into a broken fragment ("创建一个查看当前地点…").
      // If title-gen yields nothing (no key / model unavailable), fall back to a
      // short preview of the first user message so the default still gets replaced.
      const generated = (await ctx.host.generateTitle(id).catch(() => "")).trim()
      const title = generated || firstUserSummary()
      if (title) {
        await ctx.host.renameSession(id, title)
        await refresh()
      }
    } catch {
      // keep the placeholder name; a later run-finish may retry
    } finally {
      titling.delete(id)
    }
  }

  // Short preview of the first user message — the auto-title fallback when model
  // title-gen is unavailable (§1.1). Truncates long messages with an ellipsis so
  // the result reads as a clipped preview, not a broken phrase.
  function firstUserSummary(): string {
    const row = flattenTrace(trace()).find(
      (r) => r.item.kind === "text" && (r.item as TextItem).speaker === "user",
    )
    const text = row ? (row.item as TextItem).text.trim().replace(/\s+/g, " ") : ""
    const cp = [...text]
    return cp.length > 24 ? cp.slice(0, 24).join("") + "…" : cp.join("")
  }

  async function loadHistory(id: string) {
    const tree = await ctx.host.getSessionTree(id).catch(() => undefined)
    dispatch(tree ? { kind: "@load", tree } : { kind: "@reset" })
    const todos = await ctx.host.getTodos(id).catch(() => [])
    dispatch({ kind: "todo-update", sessionId: id, todos })
    // Restore the persisted token/cost/window readout (§2.1) — reconstructTrace
    // zeroes usage; the session carries cumulative `usage` + `lastInputTokens`.
    const s = (await ctx.host.listSessions().catch(() => [])).find((x) => x.id === id)
    // Show the session's LIVE execution mode (agent §3.8): the host returns the
    // running value if the session is open, else its configured default — so a
    // prior Shift+Tab toggle is reflected when switching back, not reset to ask.
    setMode(await ctx.host.getExecutionMode(id).catch(() => EXECUTION_MODE.ASK))
    setAutoAvailable(
      ctx.config.effective(s?.config, ctx.config.loadSessionAliases(id)).autoEnabled !== false,
    ) // circuit breaker (§3.8.5)
    if (s?.usage) {
      const eff = ctx.config.effective(s.config, ctx.config.loadSessionAliases(id))
      const ref = eff.aliases.find((a) => a.alias === eff.orchestratorAlias)?.ref
      dispatch({
        kind: "@set-usage",
        usage: s.usage,
        lastInputTokens: s.lastInputTokens,
        contextWindow: ref ? ctx.meta.get(ref)?.contextWindow : undefined,
      })
    }
  }

  async function send(text: string) {
    let id = activeId()
    if (!id) {
      const s = await ctx.host.createSession({ name: UNTITLED })
      id = s.id
      setActiveId(id)
      void refresh()
    }
    dispatch({ kind: "@user-text", text })
    setTodoDismissed(true) // the next turn's task panel re-appears on its first todo-update (§5)
    const { runId: rid } = await ctx.host.sendMessage(id, text)
    runId = rid
    subRuns.clear() // fresh turn: forget the previous turn's sub-agent runs
  }

  async function switchTo(id: string) {
    setActiveId(id)
    runId = undefined
    subRuns.clear()
    setTodoDismissed(false) // show the switched-to session's existing tasks, if any
    setExpanded(new Set<string>()) // reset collapse state (row keys are positional, §3.2)
    await loadHistory(id)
  }

  function matchSessions(filter: string): Sess[] {
    const q = filter.trim().toLowerCase()
    return q
      ? sessions().filter((s) => `${s.name} ${s.workingDir ?? ""}`.toLowerCase().includes(q))
      : sessions()
  }

  // Existing workspace dirs for the /new modal: unique, most-recent first,
  // filtered by what's typed so far (↑↓ highlight, Tab fills the input, §7.2).
  const dirCandidates = createMemo(() => {
    const q = newDir().trim().toLowerCase()
    const seen = new Set<string>()
    const dirs: string[] = []
    for (const s of sessions()) {
      const d = s.workingDir
      if (!d || seen.has(d)) continue
      seen.add(d)
      if (!q || d.toLowerCase().includes(q)) dirs.push(d)
    }
    return dirs.slice(0, 6)
  })

  function clearInput() {
    textarea?.clear?.()
    textarea?.setText?.("")
    setDraft("")
  }

  function closeOverlay() {
    setOverlay(null)
    setPickerDelete(false)
    clearInput()
  }

  // Run a slash command typed in the input (exact first-token match).
  async function runSlash(cmd: string) {
    clearInput()
    if (cmd === "/exit" || cmd === "/quit") return quit()
    if (cmd === "/clear") return dispatch({ kind: "@reset", runId })
    if (cmd === "/compact") {
      const id = activeId()
      if (id) void ctx.host.compact(id)
      return
    }
    if (cmd === "/sessions") {
      await refresh()
      setPickerFilter("")
      setPickerSel(0)
      setPickerDelete(false)
      return setOverlay({ kind: "picker" })
    }
    if (cmd === "/new") {
      setNewDir("")
      setNewSel(0)
      return setOverlay({ kind: "new" })
    }
    if (cmd === "/config") return setView("config")
    if (cmd === "/model") {
      const { alias, ref } = effOrch()
      const providerId = ref && ref.includes(":") ? ref.split(":")[0] : undefined
      if (!providerId) return showToast("当前模型未绑定 provider——请用 /config 绑定")
      showToast(`加载 ${providerId} 模型…`)
      try {
        const res = await ctx.host.listProviderModels(providerId)
        return setOverlay({ kind: "model", alias, providerId, models: res.models, filter: "", sel: 0, current: ref })
      } catch (e) {
        return showToast(`模型发现失败：${(e as Error).message}`)
      }
    }
    if (cmd === "/fork") {
      if (activeId()) return setView("branch")
      return showToast("先开始一个会话再分叉")
    }
  }

  // Create a session bound to the /new modal's working dir (empty = cwd); the
  // modal validates existence and owns its own input (textarea blurred).
  function createWorkspace() {
    const dir = newDir().trim() || process.cwd()
    if (!existsSync(dir)) return setOverlay({ kind: "new", error: `目录不存在：${dir}` })
    closeOverlay()
    void ctx.host.createSession({ name: UNTITLED, workingDir: dir }).then(async (s) => {
      await refresh()
      await switchTo(s.id)
    })
  }

  // Delete a session from the picker (§7.2); if it was active, reset to empty.
  async function deleteSessionFromPicker(id: string) {
    await ctx.host.deleteSession(id).catch(() => {})
    if (id === activeId()) {
      setActiveId(undefined)
      runId = undefined
      dispatch({ kind: "@reset" })
    }
    await refresh()
    showToast("已删除会话")
  }

  // The input was submitted (↵). The picker / model / new modals own ↵ in the
  // global key handler (textarea blurred), so here we route the slash prefix only.
  function onInputSubmit() {
    const value = String(textarea?.plainText ?? textarea?.value ?? "").trim()
    if (!value) return
    // Shell escape (§6.2): a single line starting with `!` runs directly in the
    // shell, bypassing the model. `!ls -la` → `ls -la` in the session's dir.
    if (value.startsWith("!") && !value.includes("\n")) {
      const command = value.slice(1).trim()
      clearInput()
      if (command) void runShell(command)
      return
    }
    if (value.startsWith("/")) {
      // Prefer an exact first-token command; otherwise run the highlighted menu
      // item (so ↵ accepts the ↑↓/typed selection, §6.2).
      const items = slashItems()
      const head = value.split(/\s+/)[0]
      const chosen = SLASH.find((s) => s.name === head) ?? items[Math.min(slashSel(), items.length - 1)]
      clearInput()
      if (chosen) void runSlash(chosen.name)
      return
    }
    clearInput()
    void send(value)
  }

  const slashItems = createMemo(() => {
    const v = draft()
    if (overlay() || !v.startsWith("/")) return []
    const q = v.slice(1).toLowerCase()
    return SLASH.filter((s) => s.name.slice(1).toLowerCase().includes(q))
  })

  // Shell-escape command mode (§6.2): a single line beginning with `!`. The input
  // border turns blue and ↵ runs the command directly in the shell.
  const cmdMode = createMemo(() => draft().startsWith("!") && !draft().includes("\n"))

  /** Run a `!`-escaped command directly in the shell (no model, no agent gate),
   *  in the active session's working directory; echo command + output inline. */
  async function runShell(command: string) {
    const cwd = sessions().find((s) => s.id === activeId())?.workingDir ?? process.cwd()
    dispatch({ kind: "@shell-start", command })
    const { text, code } = await execShell(command, cwd)
    dispatch({ kind: "@shell-result", output: text, exitCode: code })
  }
  // Reset the highlight to the top whenever the filter text changes.
  createEffect(() => {
    void slashItems()
    setSlashSel(0)
  })

  const pickerMatches = createMemo(() => matchSessions(pickerFilter()))

  // -- current model + /model switcher (§6.3) --
  // Effective orchestrator model (ref like `<providerId>:<modelId>`) for the
  // active session, shown under the input and switched by /model.
  const effOrch = createMemo(() => {
    void modelVersion() // re-read after a /model save
    const id = activeId()
    const sc = sessions().find((s) => s.id === id)?.config
    const eff = ctx.config.effective(sc, id ? ctx.config.loadSessionAliases(id) : [])
    const ref = eff.aliases.find((a) => a.alias === eff.orchestratorAlias)?.ref
    return { alias: eff.orchestratorAlias, ref }
  })
  const modelLabel = createMemo(() => effOrch().ref ?? effOrch().alias)

  const modelMatches = createMemo(() => {
    const ov = overlay()
    if (ov?.kind !== "model") return []
    const q = ov.filter.toLowerCase()
    return q ? ov.models.filter((m) => m.ref.toLowerCase().includes(q)) : ov.models
  })

  // Persist a model switch: session-scoped override when a session is active
  // (takes effect for that session's next run), else the global alias.
  async function selectModel(alias: string, ref: string) {
    const id = activeId()
    if (id) {
      const sc = sessions().find((s) => s.id === id)?.config ?? {}
      const aliases = (sc.aliases ?? []).filter((a) => a.alias !== alias)
      aliases.push({ alias, ref })
      await ctx.host.updateSessionConfig(id, { ...sc, aliases })
      await refresh()
    } else {
      const g = ctx.config.loadGlobalAliases().filter((a) => a.alias !== alias)
      g.push({ alias, ref })
      ctx.config.saveGlobalAliases(g)
    }
    setModelVersion((v) => v + 1)
    showToast(`模型 → ${ref}`)
  }

  onMount(() => {
    const off = ctx.host.onEvent((e: AgentStreamEvent) => {
      // Mode changes carry a sessionId (not a runId), so handle them before the
      // run-scoped filtering below; reflect the active session's mode (agent §3.8).
      if (e.kind === "mode-changed") {
        if (e.sessionId === activeId()) setMode(e.mode)
        return
      }
      // A sub-agent spawned under the active turn (its parent run is the
      // orchestrator turn or an already-tracked sub-run): admit its run so all
      // of its later events — text, tool calls, approvals — flow into the trace.
      if (e.kind === "sub-agent-start" && (e.parentRunId === runId || subRuns.has(e.parentRunId))) {
        subRuns.add(e.runId)
      }
      if (!belongsToActive(e, runId, subRuns, activeId())) return
      // A plan proposal suspends the run for the user's decision (agent §3.8.4);
      // surface it as an overlay rather than a trace row.
      if (e.kind === "plan-proposed") {
        setPendingPlan(e)
        return
      }
      dispatch(e)
      // Task panel pops from the top-right the moment tasks are (re)created (§5).
      if (e.kind === "todo-update" && e.todos.length > 0) setTodoDismissed(false)
      if (e.kind === "run-finish") {
        // The active turn's run ended (completed or aborted): drop its id so a
        // later Ctrl-C raises the exit confirm instead of re-aborting a dead
        // run. Sub-agent run-finish events carry a different runId and leave it.
        if (e.runId === runId) {
          runId = undefined
          setPendingPlan(null) // a plan left pending when the run ends (e.g. abort) is moot
        }
        void refresh()
        void maybeTitle(activeId()) // auto-title if still the default name
      } else if (e.kind === "error") {
        void refresh()
      }
    })
    onCleanup(off)
    void refresh()
    if (props.initialSessionId) void loadHistory(props.initialSessionId)
  })

  useKeyboard((key: { ctrl?: boolean; name?: string; raw?: string; sequence?: string; preventDefault?: () => void }) => {
    const name = key.name
    const isCtrlC = (key.ctrl && name === "c") || key.raw === "\x03"

    // Exit-confirm modal (§12.4): `y` quits, any other key cancels. Highest
    // priority so it can't be bypassed; preventDefault so the key never leaks.
    if (confirmQuit()) {
      key.preventDefault?.()
      if (name === "y") return quit()
      return setConfirmQuit(false)
    }

    // The config modal (§9) renders over the chat but owns its own keyboard;
    // the Branch view (§8) is full-pane. Both handle their own keys — bail here.
    if (view() !== "session") return

    // Shift+Tab cycles the execution mode ask→plan→auto (agent §3.8 / cli-ui §6).
    // Backtab arrives as CSI Z (`\x1b[Z`) across terminals. Skipped while an
    // overlay / approval / question owns the keyboard.
    const isBacktab =
      key.raw === "\x1b[Z" ||
      key.sequence === "\x1b[Z" ||
      (key.name === "tab" && (key as { shift?: boolean }).shift === true)
    if (isBacktab && !overlay() && !pending() && !pendingQuestion() && !pendingPlan()) {
      key.preventDefault?.()
      return cycleMode()
    }

    // Ctrl-C: interrupt the in-flight run (the model call); when nothing is
    // running, raise the exit confirm. Gated on `runId` (a run is in flight),
    // NOT on the trace status — status only flips to 'running' on the first
    // streamed token, so an accidental send must still be stoppable during the
    // connecting window before any token arrives (cli §12.4). `runId` is left
    // set here and cleared by the turn's run-finish (below): that keeps the
    // aborted run's finish event admitted (it stops the spinner), and a later
    // Ctrl-C then falls through to the quit confirm.
    if (isCtrlC) {
      if (runId) {
        ctx.host.abortRun(runId)
        return
      }
      key.preventDefault?.()
      return setConfirmQuit(true)
    }

    // Esc while editing a plan: cancel the edit, back to the a/k/r choices (§3.8.4).
    if (name === "escape" && editingPlan()) {
      key.preventDefault?.()
      return cancelPlanEdit()
    }

    // Esc closes an open overlay (session picker / new-session dialog, §7).
    if (name === "escape" && overlay()) return closeOverlay()

    // Session picker modal (§7.2): its textarea is blurred, so the global handler
    // owns all of its input — type to filter, ↑↓ to choose, ↵ to switch, d→y delete.
    if (overlay()?.kind === "picker") {
      const matches = pickerMatches()
      // Delete-confirm sub-mode: `y` deletes the selected session, else cancel.
      if (pickerDelete()) {
        key.preventDefault?.()
        const s = matches[Math.min(pickerSel(), matches.length - 1)]
        setPickerDelete(false)
        if (name === "y" && s) void deleteSessionFromPicker(s.id)
        return
      }
      if (name === "up") return setPickerSel((i) => Math.max(0, i - 1))
      if (name === "down") return setPickerSel((i) => Math.min(Math.max(0, matches.length - 1), i + 1))
      if (name === "return") {
        key.preventDefault?.() // don't let the re-focused textarea also submit this ↵
        const s = matches[Math.min(pickerSel(), matches.length - 1)]
        closeOverlay()
        if (s) void switchTo(s.id)
        return
      }
      // `d` arms delete on the selected session (reserved — not a filter char).
      if (name === "d") {
        if (matches.length) setPickerDelete(true)
        return
      }
      if (name === "backspace" || name === "delete") {
        setPickerFilter((f) => f.slice(0, -1))
        return setPickerSel(0)
      }
      const ch = typedChar(key)
      if (ch) {
        setPickerFilter((f) => f + ch)
        return setPickerSel(0)
      }
      return
    }

    // New-session modal (§7.2 /new): centered, inputs the working directory.
    const ovN = overlay()
    if (ovN?.kind === "new") {
      const cands = dirCandidates()
      if (name === "up") return setNewSel((i) => Math.max(0, i - 1))
      if (name === "down") return setNewSel((i) => Math.min(Math.max(0, cands.length - 1), i + 1))
      if (name === "tab") {
        const pick = cands[Math.min(newSel(), cands.length - 1)]
        if (pick) {
          setNewDir(pick)
          setNewSel(0)
          if (ovN.error) setOverlay({ kind: "new" })
        }
        return
      }
      if (name === "return") {
        key.preventDefault?.()
        return createWorkspace()
      }
      if (name === "backspace" || name === "delete") {
        setNewSel(0)
        return setNewDir((d) => d.slice(0, -1))
      }
      const ch = typedChar(key)
      if (ch) {
        setNewDir((d) => d + ch)
        setNewSel(0)
        if (ovN.error) setOverlay({ kind: "new" }) // clear stale error on edit
        return
      }
      return
    }

    // Model switcher modal (§6.3 /model): same self-contained input as the picker.
    const ovM = overlay()
    if (ovM?.kind === "model") {
      const matches = modelMatches()
      if (name === "up") return setOverlay({ ...ovM, sel: Math.max(0, ovM.sel - 1) })
      if (name === "down") return setOverlay({ ...ovM, sel: Math.min(Math.max(0, matches.length - 1), ovM.sel + 1) })
      if (name === "return") {
        key.preventDefault?.()
        const m = matches[Math.min(ovM.sel, matches.length - 1)]
        closeOverlay()
        if (m) void selectModel(ovM.alias, m.ref)
        return
      }
      if (name === "backspace" || name === "delete") return setOverlay({ ...ovM, filter: ovM.filter.slice(0, -1), sel: 0 })
      const ch = typedChar(key)
      if (ch) return setOverlay({ ...ovM, filter: ovM.filter + ch, sel: 0 })
      return
    }

    // Slash-completion menu (§6.2): ↑↓ move the highlight, Tab fills the input
    // with the highlighted command (↵, handled by the textarea's onSubmit, runs
    // it). The textarea keeps focus so typing still filters the menu.
    if (slashItems().length > 0) {
      if (name === "up") return setSlashSel((i) => Math.max(0, i - 1))
      if (name === "down") return setSlashSel((i) => Math.min(slashItems().length - 1, i + 1))
      if (name === "tab") {
        const it = slashItems()[Math.min(slashSel(), slashItems().length - 1)]
        if (it) {
          textarea?.setText?.(it.name + " ")
          setDraft(it.name + " ")
        }
        return
      }
    }

    // askUserQuestion keys take priority while the model awaits a choice (§4).
    // ↑↓ move, space toggles (multi-select), ↵ confirms / advances, Esc skips.
    // Swallow every key so none leaks into the (blurred) textarea.
    const pq = pendingQuestion()
    if (pq && !key.ctrl) {
      if (name === "escape") {
        key.preventDefault?.()
        return cancelQuestion(pq)
      }
      const st = qState()
      const q = pq.questions[st?.qi ?? 0]
      if (st && q) {
        if (name === "up") {
          key.preventDefault?.()
          return setQState({ ...st, oi: Math.max(0, st.oi - 1) })
        }
        if (name === "down") {
          key.preventDefault?.()
          return setQState({ ...st, oi: Math.min(q.options.length - 1, st.oi + 1) })
        }
        if (name === "space" && q.multiSelect) {
          key.preventDefault?.()
          const label = q.options[st.oi]!.label
          const cur = st.picked[st.qi] ?? []
          const picked = st.picked.map((p, i) =>
            i === st.qi ? (cur.includes(label) ? p.filter((l) => l !== label) : [...p, label]) : p,
          )
          return setQState({ ...st, picked })
        }
        if (name === "return") {
          key.preventDefault?.()
          let picked = st.picked
          if (!q.multiSelect) {
            const label = q.options[st.oi]!.label
            picked = st.picked.map((p, i) => (i === st.qi ? [label] : p))
          }
          if (st.qi + 1 < pq.questions.length) return setQState({ qi: st.qi + 1, oi: 0, picked })
          const answers = pq.questions.map((_, i) => ({ selected: picked[i] ?? [] }))
          ctx.host.answerQuestion(pq.questionId, answers)
          return dispatch({ kind: "@answer-question", questionId: pq.questionId, cancelled: false })
        }
      }
      key.preventDefault?.()
      return
    }

    // Approval keys take priority while a tool is awaiting a decision (§4).
    // `preventDefault` so the textarea — which the focus effect re-focuses the
    // instant `decide` clears `pending`, synchronously mid-dispatch — does NOT
    // also receive a/s/r: the shared key emitter runs global listeners first and
    // skips renderable (textarea) handlers once `defaultPrevented` is set.
    const p = pending()
    if (p && !key.ctrl) {
      if (name === "a" || name === "s" || name === "r") {
        key.preventDefault?.()
        return decide(p, name === "a" ? "once" : name === "s" ? "session" : "reject")
      }
    }

    // Plan decision keys while a plan is proposed and NOT being edited (§3.8.4):
    // a approve · e edit · k keep refining · r reject. (While editing, keys go to
    // the focused input instead — only ↵/Esc are special, handled elsewhere.)
    if (pendingPlan() && !editingPlan() && !key.ctrl) {
      if (name === "e") {
        key.preventDefault?.()
        return startPlanEdit()
      }
      if (name === "a" || name === "k" || name === "r") {
        key.preventDefault?.()
        return decidePlan(name === "a" ? "approve" : name === "k" ? "keep" : "reject")
      }
    }

    // Scroll the transcript (mouse wheel is handled natively by scrollbox).
    if (name === "pageup") return scroll?.scrollBy?.(-Math.max(1, (scroll?.height ?? 10) - 2))
    if (name === "pagedown") return scroll?.scrollBy?.(Math.max(1, (scroll?.height ?? 10) - 2))
    if (key.ctrl && name === "home") return scroll?.scrollTo?.(0)
    if (key.ctrl && name === "end") return scroll?.scrollTo?.(scroll?.scrollHeight ?? 0)
  }, {})

  const pending = createMemo(() => trace().pending[0])
  const decide = (p: PendingApproval, decision: ApprovalDecision) => {
    ctx.host.approveTool(p.toolCallId, decision)
    dispatch({ kind: "@approval-decision", toolCallId: p.toolCallId, decision })
  }

  // askUserQuestion (§4): one prompt at a time, with a small selection cursor.
  // `qState` tracks which question (qi), highlighted option (oi), and the labels
  // picked per question. It resets whenever a new question becomes pending.
  const pendingQuestion = createMemo(() => trace().questions[0])
  const [qState, setQState] = createSignal<{ qi: number; oi: number; picked: string[][] } | null>(null)
  createEffect(() => {
    const pq = pendingQuestion()
    setQState(pq ? { qi: 0, oi: 0, picked: pq.questions.map(() => []) } : null)
  })
  const cancelQuestion = (pq: PendingQuestion) => {
    ctx.host.answerQuestion(pq.questionId, null)
    dispatch({ kind: "@answer-question", questionId: pq.questionId, cancelled: true })
  }
  // Blur the input whenever something else owns the keyboard — the config modal
  // (§9), an approval (§4), the session picker (§7.2), or the exit confirm
  // (§12.4) — so those keys never leak into the textarea; re-focus otherwise.
  createEffect(() => {
    const ovKind = overlay()?.kind
    const blocked =
      view() !== "session" ||
      pending() != null ||
      pendingQuestion() != null ||
      // A pending plan blurs the input — UNLESS the user is editing it, where the
      // input must stay focused so they can type the edited plan (§3.8.4).
      (pendingPlan() != null && editingPlan() == null) ||
      ovKind === "picker" ||
      ovKind === "model" ||
      ovKind === "new" ||
      confirmQuit()
    if (blocked) textarea?.blur?.()
    else textarea?.focus?.()
  })

  // A delegate tool's sub-agent log is NOT flattened into the transcript; it
  // stays on the ToolItem and renders inside the tool row's fixed-height,
  // bordered viewport (`SubAgentViewport`) so a busy sub-agent scrolls in its
  // own box instead of flooding the main conversation (§3.1).
  const rows = createMemo(() => flattenTrace(trace(), { containSubAgent: true }))
  const title = createMemo(() => sessions().find((s) => s.id === activeId())?.name ?? "Enterprise Agent")
  // Active workspace's full working-directory path for the TopBar right side (§2.1).
  const workspacePath = createMemo(() => sessions().find((s) => s.id === activeId())?.workingDir ?? "scratch")

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <TopBar title={title()} workspace={workspacePath()} />
      <Show when={view() === "branch" && activeId()}>
        <box flexGrow={1} flexDirection="column" paddingTop={1}>
          <BranchView ctx={ctx} sessionId={activeId()!} onExit={() => setView("session")} onToast={showToast} />
        </box>
      </Show>
      {/* Conversation pane — also rendered (behind) while the config modal is up. */}
      <Show when={view() === "session" || view() === "config"}>
      <box flexGrow={1} flexDirection="row" paddingTop={1} gap={1}>
        <box flexGrow={1} flexDirection="column" gap={1}>
          <scrollbox ref={(r: unknown) => (scroll = r)} flexGrow={1} stickyScroll={true} stickyStart="bottom">
            <Show
              when={rows().length > 0}
              fallback={<text fg={theme.muted}>↓ 在下方输入第一条消息开始</text>}
            >
              {/* `<Index>` keys rows by position, not by reference — the trace is
                  append-only, and `flattenTrace` makes fresh row objects on every
                  event, so `<For>` would destroy+recreate the whole transcript on
                  each streaming delta (flicker + scrollbox re-stick jitter). Index
                  keeps each row's renderable mounted and just updates it in place. */}
              <Index each={rows()}>
                {(row, i) => (
                  <Row
                    row={row()}
                    streaming={trace().status === "running"}
                    isLast={i === rows().length - 1}
                    thinkingLabel={thinkingLabel()}
                    spinnerChar={spinnerChar()}
                    subAgentLogHeight={subAgentLogHeight()}
                    isExpanded={isExpanded}
                    toggle={toggleExpanded}
                  />
                )}
              </Index>
            </Show>
          </scrollbox>
          {/* Bottom bar: fixed height (flexShrink=0) so the scrollbox can't
              squeeze the input off-screen. */}
          <box flexShrink={0} flexDirection="column">
          <Show when={toast()}>
            <text fg={theme.success}>✓ {toast()}</text>
          </Show>
          <Show when={mode() === "auto" && !pendingPlan() && !pending()}>
            <text fg={theme.warning}>⚡ 自动执行模式 · 危险或不确定的操作仍会询问</text>
          </Show>
          <Show when={pendingPlan()}>
            <PlanBar plan={pendingPlan()!} editing={editingPlan() != null} />
          </Show>
          <Show when={pending()}>
            <ApprovalBar pending={pending()!} />
          </Show>
          <Show when={pendingQuestion() && qState()}>
            <QuestionBar pending={pendingQuestion()!} qi={qState()!.qi} oi={qState()!.oi} picked={qState()!.picked} />
          </Show>
          <Show when={slashItems().length > 0}>
            <box flexDirection="column" backgroundColor={theme.panel} paddingLeft={1} paddingRight={1}>
              <For each={slashItems()}>
                {(it, i) => {
                  const on = () => i() === Math.min(slashSel(), slashItems().length - 1)
                  return (
                    <text>
                      <span style={{ fg: on() ? theme.accent : theme.muted }}>{on() ? "▸ " : "  "}</span>
                      <span style={{ fg: theme.accent }}>{it.name}</span>
                      <span style={{ fg: theme.muted }}> {it.desc}</span>
                    </text>
                  )
                }}
              </For>
              <text fg={theme.muted}>  ↑↓ 选择 · Tab 补全 · ↵ 执行</text>
            </box>
          </Show>
          <box
            flexShrink={0}
            border={["left"]}
            borderColor={
              pending()
                ? theme.warning
                : pendingQuestion()
                  ? theme.accent
                  : overlay()
                    ? theme.accent
                    : cmdMode()
                      ? theme.info
                      : theme.success
            }
            customBorderChars={SPLIT}
          >
            <box
              flexGrow={1}
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={theme.panel}
            >
              <textarea
                ref={(r: unknown) => (textarea = r)}
                width="100%"
                minHeight={1}
                maxHeight={8}
                keyBindings={INPUT_KEYBINDINGS}
                placeholder={inputPlaceholder(pending() != null, pendingQuestion() != null, overlay(), trace().status === "running")}
                placeholderColor={theme.muted}
                onContentChange={() => setDraft(String(textarea?.plainText ?? textarea?.value ?? ""))}
                onSubmit={() => {
                  if (editingPlan()) return submitPlanEdit() // ↵ approves the edited plan (§3.8.4)
                  if (pending() || pendingQuestion() || pendingPlan()) return
                  onInputSubmit()
                }}
              />
              {/* Second line, same container: current model on the left (§6.4;
                  switch with /model), usage/ctx/cost on the right (moved off the
                  TopBar). `marginTop` gives a half-ish line gap from the input
                  (terminals can't render literal half rows). */}
              <box marginTop={1} flexDirection="row" justifyContent="space-between">
                <Show
                  when={cmdMode()}
                  fallback={
                    <text>
                      <span style={{ fg: modeColor(mode()) }}>{"◆ " + mode()}</span>
                      <span style={{ fg: theme.muted }}>{"  ⇧⇥ 模式   ⚙ " + modelLabel() + "   /model"}</span>
                    </text>
                  }
                >
                  <text fg={theme.info}>{"! 命令模式 · ↵ 直接执行 shell（不经模型）"}</text>
                </Show>
                <UsageText usage={trace().usage} ctxTokens={trace().lastInputTokens} ctxWindow={trace().contextWindow} />
              </box>
            </box>
          </box>
          </box>
        </box>
      </box>
      </Show>
      {/* Task panel (§5): floats in from the top-right when tasks are created,
          hides on the next user message. Only over the conversation pane. */}
      <Show when={view() === "session" && showTodos()}>
        <box position="absolute" top={1} right={0} zIndex={60}>
          <TodoPanel todos={trace().todos} />
        </box>
      </Show>
      {/* Session switcher (§7.2): a centered modal floating over the whole pane. */}
      <Show when={overlay()?.kind === "picker"}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center" zIndex={100}>
          <SessionPickerModal
            matches={pickerMatches()}
            filter={pickerFilter()}
            selected={pickerSel()}
            activeId={activeId()}
            deleting={pickerDelete()}
          />
        </box>
      </Show>
      {/* New session (§7.2 /new): a centered modal that inputs the working dir. */}
      <Show when={overlay()?.kind === "new"}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center" zIndex={100}>
          <box
            flexDirection="column"
            width={64}
            border
            borderStyle="rounded"
            borderColor={theme.accent}
            backgroundColor={theme.panel}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
          >
            <text>
              <span style={{ fg: theme.accent }}>新建会话 · 工作目录 </span>
              <span style={{ fg: theme.muted }}>（↵ 创建 · 留空=当前目录 · Esc 取消）</span>
            </text>
            <text>
              {" › "}
              {newDir()}
              <span style={{ fg: theme.accent }}>▌</span>
            </text>
            <Show when={dirCandidates().length > 0}>
              <text fg={theme.muted}>已有工作目录（↑↓ 选择 · Tab 填入）：</text>
              <For each={dirCandidates()}>
                {(dir, i) => (
                  <text fg={i() === newSel() ? theme.accent : theme.muted}>
                    {i() === newSel() ? " ❯ " : "   "}
                    {dir}
                  </text>
                )}
              </For>
            </Show>
            <Show
              when={(overlay() as { error?: string }).error}
              fallback={<text fg={theme.muted}>当前目录：{process.cwd()}</text>}
            >
              <text fg={theme.danger}>✗ {(overlay() as { error?: string }).error}</text>
            </Show>
          </box>
        </box>
      </Show>
      {/* Model switcher (§6.3 /model): centered modal, models under the current provider. */}
      <Show when={overlay()?.kind === "model"}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center" zIndex={100}>
          <ModelPickerModal overlay={overlay() as Extract<Overlay, { kind: "model" }>} matches={modelMatches()} ctx={ctx} />
        </box>
      </Show>
      {/* Config (§9): a centered modal popup floating over the conversation. */}
      <Show when={view() === "config"}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center" zIndex={100}>
          <box width="86%" height="82%" flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} backgroundColor={theme.panel}>
            <ConfigView
              ctx={ctx}
              sessionId={activeId()}
              sessionConfig={sessions().find((s) => s.id === activeId())?.config}
              onExit={() => setView("session")}
            />
          </box>
        </box>
      </Show>
      {/* Exit confirm (§12.4): idle Ctrl-C. `y` quits, any other key cancels. */}
      <Show when={confirmQuit()}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center" zIndex={120}>
          <box flexDirection="column" border borderStyle="rounded" borderColor={theme.warning} backgroundColor={theme.panel} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <text fg={theme.warning}>退出 Enterprise Agent？</text>
            <text>
              <span style={{ fg: theme.success }}>[y]</span> 确认退出{"   "}
              <span style={{ fg: theme.muted }}>其他键取消</span>
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

function TodoPanel(props: { todos: TraceState["todos"] }) {
  const done = () => props.todos.filter((t) => t.status === "completed").length
  return (
    <box
      flexDirection="column"
      width={34}
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.accent}>
        <b>任务 {done()}/{props.todos.length}</b>
      </text>
      <For each={props.todos}>
        {(t) => (
          <text fg={t.status === "completed" ? theme.success : t.status === "in_progress" ? theme.accent : theme.muted}>
            {t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐"} {t.content}
          </text>
        )}
      </For>
    </box>
  )
}

function ModelPickerModal(props: {
  overlay: Extract<Overlay, { kind: "model" }>
  matches: DiscoveredModel[]
  ctx: CliContext
}) {
  const shown = () => props.matches.slice(0, 12)
  const sel = () => Math.min(props.overlay.sel, props.matches.length - 1)
  return (
    <box
      flexDirection="column"
      width={72}
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      backgroundColor={theme.panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text>
        <span style={{ fg: theme.accent }}>切换模型 · {props.overlay.providerId} </span>
        <span style={{ fg: theme.muted }}>（输入过滤 · ↑↓ 选择 · ↵ 切换 · Esc 取消）</span>
      </text>
      <text>
        {" › "}
        {props.overlay.filter}
        <span style={{ fg: theme.accent }}>▌</span>
      </text>
      <box flexDirection="column" paddingTop={1}>
        <For each={shown()} fallback={<text fg={theme.muted}>（无匹配模型）</text>}>
          {(m, i) => {
            const meta = props.ctx.meta.get(m.ref)
            return (
              <text fg={i() === sel() ? theme.accent : undefined}>
                {i() === sel() ? "▸ " : "  "}
                {m.ref === props.overlay.current ? "◆ " : ""}
                {m.ref}{" "}
                <span style={{ fg: m.hasMeta ? theme.success : theme.warning }}>
                  {m.hasMeta ? `${fmtTok(meta.contextWindow)} ✓meta` : "无定价"}
                </span>
              </text>
            )
          }}
        </For>
        <Show when={props.matches.length > 12}>
          <text fg={theme.muted}>  … 共 {props.matches.length}，输入过滤</text>
        </Show>
      </box>
    </box>
  )
}

function SessionPickerModal(props: {
  matches: Sess[]
  filter: string
  selected: number
  activeId?: string
  deleting?: boolean
}) {
  // Items are now two lines each (+ a gap), so show fewer before the "… 共 N"
  // overflow hint to keep the modal from outgrowing shorter terminals.
  const shown = () => props.matches.slice(0, 6)
  const sel = () => Math.min(props.selected, props.matches.length - 1)
  const selected = () => props.matches[sel()]
  return (
    <box
      flexDirection="column"
      width={64}
      border
      borderStyle="rounded"
      borderColor={props.deleting ? theme.danger : theme.accent}
      backgroundColor={theme.panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text>
        <span style={{ fg: theme.accent }}>切换会话 </span>
        <span style={{ fg: theme.muted }}>（输入过滤 · ↑↓ 选择 · ↵ 切换 · d 删除 · Esc 取消）</span>
      </text>
      <text>
        {" › "}
        {props.filter}
        <span style={{ fg: theme.accent }}>▌</span>
      </text>
      <box flexDirection="column" paddingTop={1}>
        <For each={shown()} fallback={<text fg={theme.muted}>（无匹配会话）</text>}>
          {(s, i) => (
            // Two-line item: title on the first line, workspace on the second.
            <box flexDirection="column" marginTop={i() === 0 ? 0 : 1}>
              <text fg={i() === sel() ? theme.accent : undefined}>
                {i() === sel() ? "▸ " : "  "}
                {s.id === props.activeId ? "◆ " : ""}
                {s.name}
              </text>
              <text fg={theme.muted}>{"    " + (s.workingDir ?? "scratch")}</text>
            </box>
          )}
        </For>
        <Show when={props.matches.length > shown().length}>
          <text fg={theme.muted}>  … 共 {props.matches.length}，输入过滤</text>
        </Show>
      </box>
      <Show when={props.deleting && selected()}>
        <text fg={theme.danger}>删除「{selected()!.name}」？ y 确认 · 其他键取消</text>
      </Show>
    </box>
  )
}

function TopBar(props: { title: string; workspace: string }) {
  return (
    <box
      flexDirection="row"
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      justifyContent="space-between"
    >
      <text>
        <span style={{ fg: theme.accent }}>◆ </span>
        {props.title}
      </text>
      {/* Right side: active workspace's full working-directory path (§2.1). */}
      <text fg={theme.muted}>{props.workspace}</text>
    </box>
  )
}

/** Usage / context / cost readout (`◷ tok  ⛶ ctx/win pct%  $cost`); right-aligned
 * on the model row under the input (§6.1), context % coloured by pressure. */
function UsageText(props: { usage: TraceState["usage"]; ctxTokens?: number; ctxWindow?: number }) {
  const pct = createMemo(() =>
    props.ctxWindow ? Math.min(100, Math.round(((props.ctxTokens ?? 0) / props.ctxWindow) * 100)) : undefined,
  )
  const ctxColor = createMemo(() => {
    const p = pct()
    return p == null ? theme.muted : p >= 90 ? theme.danger : p >= 70 ? theme.warning : theme.muted
  })
  return (
    <text fg={theme.muted}>
      ◷ {fmtTok(props.usage.totalTokens)}
      <Show when={props.ctxWindow}>
        <span style={{ fg: ctxColor() }}>
          {"  ⛶ " + fmtTok(props.ctxTokens ?? 0) + "/" + fmtTok(props.ctxWindow!) + " " + pct() + "%"}
        </span>
      </Show>
      {" $" + props.usage.cost.toFixed(3)}
    </text>
  )
}

interface RowUi {
  streaming?: boolean
  isLast?: boolean
  thinkingLabel?: string
  spinnerChar?: string
  /** Height (rows) of a contained sub-agent log viewport — terminal-adaptive (§3.1). */
  subAgentLogHeight?: number
  isExpanded: (id: string) => boolean
  toggle: (id: string) => void
}

function Row(props: { row: TraceRow } & RowUi) {
  const item = () => props.row.item
  const depth = () => props.row.depth
  // Reactive (not a one-shot IIFE): `<Index>` keeps this component mounted across
  // streaming updates, so the kind switch + child props must re-read `item()` so
  // the row updates in place (esp. the streaming assistant markdown) — §4.1.
  // Root orchestrator has no header; its children render flush left (§3.1).
  return (
    <Show when={!(item().kind === "agent" && !(item() as AgentItem).parentAgentId)}>
      <Switch>
        <Match when={item().kind === "agent"}>
          <AgentRow item={item() as AgentItem} />
        </Match>
        <Match when={item().kind === "text"}>
          <TextRow
            item={item() as TextItem}
            depth={depth()}
            id={props.row.key}
            streaming={props.streaming}
            isLast={props.isLast}
            thinkingLabel={props.thinkingLabel}
            spinnerChar={props.spinnerChar}
            isExpanded={props.isExpanded}
            toggle={props.toggle}
          />
        </Match>
        <Match when={item().kind === "tool"}>
          <ToolRow
            item={item() as ToolItem}
            depth={depth()}
            streaming={props.streaming}
            thinkingLabel={props.thinkingLabel}
            spinnerChar={props.spinnerChar}
            subAgentLogHeight={props.subAgentLogHeight}
            isExpanded={props.isExpanded}
            toggle={props.toggle}
          />
        </Match>
        <Match when={item().kind === "compaction"}>
          <CompactionRow item={item() as CompactionItem} depth={depth()} />
        </Match>
        <Match when={item().kind === "shell"}>
          <ShellRow item={item() as ShellItem} depth={depth()} />
        </Match>
      </Switch>
    </Show>
  )
}

function AgentRow(props: { item: AgentItem }) {
  const running = () => props.item.status === "running"
  return (
    <text marginTop={1}>
      <span style={{ fg: running() ? theme.accent : theme.success }}>{running() ? "● " : "✓ "}</span>
      <b>Sub#{props.item.role}</b>
      <Show when={props.item.summary}>
        <span style={{ fg: theme.muted }}> {props.item.summary}</span>
      </Show>
    </text>
  )
}

function TextRow(props: { item: TextItem; depth: number; id: string } & RowUi) {
  const pad = () => Math.max(0, props.depth - 1) * 2
  const text = () => props.item.text
  // Reasoning ("thinking") is folded by default (§3.2): the header shows an
  // animated `thinking…` while it's the actively-streaming trailing block, else a
  // static `thinking`; clicking toggles the real reasoning text below it.
  const thinkId = () => `think:${props.id}`
  const thinking = () => props.streaming && props.isLast
  // Reactive speaker switch + reactive `text()` so a persisted row (under
  // `<Index>`) updates its content in place as the assistant streams (§4.1).
  // `flexShrink={0}` keeps the scrollbox from squeezing/clipping tall content
  // (code blocks) — the cause of "markdown 渲染不全".
  return (
    <Switch>
      <Match when={props.item.speaker === "user"}>
        <box marginTop={1} marginLeft={pad()} flexShrink={0} border={["left"]} borderColor={theme.success} customBorderChars={SPLIT}>
          <box paddingLeft={1} backgroundColor={theme.panel}>
            <text fg={theme.success}>{text().trim()}</text>
          </box>
        </box>
      </Match>
      <Match when={props.item.speaker === "reasoning"}>
        <box marginTop={1} marginLeft={pad()} flexShrink={0} paddingLeft={1} flexDirection="column">
          <text fg={theme.thinking} onMouseUp={() => props.toggle(thinkId())}>
            <span style={{ fg: thinking() ? theme.success : theme.muted }}>
              {thinking() ? (props.spinnerChar ?? "◐") + " " : "○ "}
            </span>
            {thinking() ? (props.thinkingLabel ?? "thinking") : "thinking"}
            <span style={{ fg: theme.muted }}>{props.isExpanded(thinkId()) ? "  ▾ 收起" : "  ▸ 展开"}</span>
          </text>
          <Show when={props.isExpanded(thinkId())}>
            <text fg={theme.thinking}>{text().replace(/\n{2,}/g, "\n").trim()}</text>
          </Show>
        </box>
      </Match>
      <Match when={true}>
        {/* Assistant prose: native OpenTUI markdown (headings/bold/lists/code).
            `streaming` keeps the trailing block stable while chunks append and
            finalizes it once the run ends; `internalBlockMode="top-level"` keeps
            each block (incl. code fences) a separate, correctly-sized renderable. */}
        <box marginTop={1} marginLeft={pad()} flexShrink={0} paddingLeft={1}>
          <markdown
            content={text().trim()}
            syntaxStyle={MARKDOWN_SYNTAX}
            streaming={props.streaming ?? false}
            internalBlockMode="top-level"
          />
        </box>
      </Match>
    </Switch>
  )
}

/** Pretty-print a tool input/output for the expanded view; capped so a huge blob
 * can't blow up the transcript. */
function detail(v: unknown): string {
  let s: string
  try {
    s = typeof v === "string" ? v : JSON.stringify(v, null, 2)
  } catch {
    s = String(v)
  }
  s = (s ?? "").replace(/\s+$/, "")
  return s.length > 2000 ? s.slice(0, 2000) + "\n… (truncated)" : s
}

function ToolRow(props: { item: ToolItem; depth: number } & RowUi) {
  const pad = () => Math.max(0, props.depth - 1) * 2
  const id = () => `tool:${props.item.toolCallId}`
  const open = () => props.isExpanded(id())
  // A delegate tool carries the spawned sub-agent's live trace in `children`.
  const hasLog = () => !!props.item.children?.length
  // delegateToSubAgent gets a sub-agent run-state indicator in front of the row.
  // Error is detected from BOTH the tool status AND a returned `{error}` payload
  // (timeout / max_depth / no-output come back as a *returned* object, so the
  // tool status is 'ok' even though the sub-task failed).
  const isDelegate = () => props.item.toolName === "delegateToSubAgent" || !!props.item.children
  const outErr = () => {
    const o = props.item.output as { error?: unknown } | null | undefined
    return !!props.item.isError || (!!o && typeof o === "object" && o.error != null)
  }
  const subState = (): "running" | "done" | "error" | "pending" =>
    props.item.status === "running"
      ? "running"
      : props.item.status === "error" || outErr()
        ? "error"
        : props.item.status === "ok"
          ? "done"
          : "pending"
  const stateGlyph = () =>
    ({ running: props.spinnerChar ?? "◐", done: "✓", error: "✗", pending: "○" })[subState()]
  const stateColor = () =>
    ({ running: theme.accent, done: theme.success, error: theme.danger, pending: theme.muted })[subState()]
  const sColor = () =>
    props.item.status === "error"
      ? theme.danger
      : props.item.status === "approval"
        ? theme.warning
        : props.item.status === "question"
          ? theme.accent
          : theme.success
  const out = () => summarizeOutput(props.item)
  const running = () => subState() === "running"
  // The contained sub-agent viewport (§3.1) stays COLLAPSED by default — even
  // while the sub-agent runs — so its log never takes over the screen. The
  // header keeps a one-line summary + an 展开 hint; click to reveal the bounded,
  // self-scrolling log on demand (works the same running or done).
  const showLog = () => hasLog() && open()
  // Collapsed by default (§3.2): the one-line summary is the header; clicking
  // expands the full input / output below.
  return (
    <box marginLeft={pad()} paddingLeft={1} flexShrink={0} flexDirection="column">
      <text onMouseUp={() => props.toggle(id())}>
        <span style={{ fg: theme.muted }}>{open() ? "▾ " : "▸ "}</span>
        <Show when={isDelegate()}>
          <span style={{ fg: stateColor() }}>{stateGlyph()} </span>
        </Show>
        {toolGlyph(props.item.toolName)} {props.item.toolName}
        <span style={{ fg: theme.muted }}> {summarizeInput(props.item.toolName, props.item.input)}</span>{" "}
        <Show when={props.item.auto}>
          <span style={{ fg: props.item.auto!.verdict === "deny" ? theme.danger : theme.warning }}>
            {props.item.auto!.verdict === "deny" ? "⚡拒绝 " : "⚡自动 "}
          </span>
        </Show>
        <span style={{ fg: sColor() }}>{statusGlyph(props.item.status)}</span>
        <Show when={out()}>
          <span style={{ fg: theme.muted }}> {out()}</span>
        </Show>
        <Show when={hasLog() && !showLog()}>
          <span style={{ fg: theme.accent }}> ⤷ 子代理日志（展开）</span>
        </Show>
      </text>
      {/* Sub-agent log in its own fixed-height, bordered box — it scrolls inside
          the box instead of pushing the main conversation around (§3.1). */}
      <Show when={showLog()}>
        <SubAgentViewport
          item={props.item}
          running={running()}
          streaming={props.streaming}
          thinkingLabel={props.thinkingLabel}
          spinnerChar={props.spinnerChar}
          subAgentLogHeight={props.subAgentLogHeight}
          isExpanded={props.isExpanded}
          toggle={props.toggle}
        />
      </Show>
      <Show when={open()}>
        <box paddingLeft={2} flexDirection="column">
          {/* For a delegate the streamed log above is the work; show only the
              raw input/return here. For plain tools, the usual 入参/↳ detail. */}
          <Show when={!hasLog()}>
            <text fg={theme.muted}>入参 {detail(props.item.input)}</text>
          </Show>
          <Show when={props.item.output !== undefined}>
            <text fg={props.item.isError ? theme.danger : theme.muted}>↳ {detail(props.item.output)}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

/** The contained sub-agent log (§3.1): a delegate tool's nested trace rendered
 *  in a fixed-height, bordered + tinted `<scrollbox>` that sticks to the latest
 *  output. Bounding the height is what keeps a chatty sub-agent from flooding
 *  the main transcript — its rows scroll within this box, not the whole pane. */
function SubAgentViewport(props: { item: ToolItem; running: boolean } & RowUi) {
  const logRows = () => flattenSubAgentLog(props.item)
  const sub = () => props.item.children?.find((c) => c.kind === "agent") as AgentItem | undefined
  const role = () => sub()?.role ?? "sub-agent"
  return (
    <box
      marginTop={1}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.running ? theme.accent : theme.muted}
      backgroundColor={theme.subAgent}
    >
      {/* Box label: which sub-agent + live state + line count. */}
      <box paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.accent}>
          <span style={{ fg: props.running ? theme.accent : theme.success }}>{props.running ? (props.spinnerChar ?? "◐") : "✓"} </span>
          子代理 · {role()}
        </text>
        <text fg={theme.muted}>{props.running ? "运行中" : "已完成"} · {logRows().length} 行</text>
      </box>
      <scrollbox
        height={props.subAgentLogHeight ?? SUBAGENT_LOG_MIN_ROWS}
        flexShrink={0}
        stickyScroll={true}
        stickyStart="bottom"
      >
        <Index each={logRows()}>
          {(row, i) => (
            <Row
              row={row()}
              streaming={props.running}
              isLast={i === logRows().length - 1}
              thinkingLabel={props.thinkingLabel}
              spinnerChar={props.spinnerChar}
              subAgentLogHeight={props.subAgentLogHeight}
              isExpanded={props.isExpanded}
              toggle={props.toggle}
            />
          )}
        </Index>
      </scrollbox>
    </box>
  )
}

function ShellRow(props: { item: ShellItem; depth: number }) {
  const pad = () => Math.max(0, props.depth - 1) * 2
  const failed = () => props.item.exitCode != null && props.item.exitCode !== 0
  const body = () => (props.item.output ?? "").replace(/\n+$/, "")
  return (
    <box marginLeft={pad()} marginTop={1} paddingLeft={1} flexDirection="column" flexShrink={0}>
      <text>
        <span style={{ fg: theme.info }}>! </span>
        <span style={{ fg: theme.info }}>{props.item.command}</span>
        <Show when={props.item.running}>
          <span style={{ fg: theme.muted }}> …</span>
        </Show>
        <Show when={!props.item.running && failed()}>
          <span style={{ fg: theme.danger }}> (exit {props.item.exitCode})</span>
        </Show>
      </text>
      <Show when={body()}>
        <text fg={failed() ? theme.danger : theme.muted}>{body()}</text>
      </Show>
    </box>
  )
}

function CompactionRow(props: { item: CompactionItem; depth: number }) {
  const detail = () =>
    props.item.tokensBefore != null
      ? `${fmtTok(props.item.tokensBefore)} → ${fmtTok(props.item.tokensAfter ?? 0)} tok`
      : "…"
  return (
    <box marginLeft={Math.max(0, props.depth - 1) * 2}>
      <text fg={theme.muted}>⟲ 压缩 {detail()}</text>
    </box>
  )
}

function PlanBar(props: { plan: PlanProposed; editing?: boolean }) {
  // Show the plan body (capped) + any pre-declared actions, then the decision
  // keys. The plan is markdown; render it as-is, trimmed to a few lines so the
  // overlay never pushes the input off-screen (agent §3.8.4 / cli-ui §4).
  const lines = () => props.plan.plan.split("\n").slice(0, 12)
  const truncated = () => props.plan.plan.split("\n").length > 12
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={theme.info}
      customBorderChars={SPLIT}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.info}>◆ 计划待审批{props.editing ? " · 编辑中" : ""}</text>
      <Show
        when={props.editing}
        fallback={
          <>
            <For each={lines()}>{(l) => <text>{l || " "}</text>}</For>
            <Show when={truncated()}>
              <text fg={theme.muted}>…</text>
            </Show>
            <Show when={props.plan.allowedActions && props.plan.allowedActions.length > 0}>
              <text fg={theme.muted}>批准后免审批：</text>
              <For each={props.plan.allowedActions}>
                {(a) => (
                  <text fg={theme.muted}>
                    {"  • "}
                    {a.tool}({a.grantKey}) — {a.reason}
                  </text>
                )}
              </For>
            </Show>
            <text>
              <span style={{ fg: theme.success }}>[a]</span> 批准执行{"  "}
              <span style={{ fg: theme.info }}>[e]</span> 编辑{"  "}
              <span style={{ fg: theme.accent }}>[k]</span> 继续规划{"  "}
              <span style={{ fg: theme.danger }}>[r]</span> 拒绝
            </text>
          </>
        }
      >
        <text fg={theme.muted}>在下方输入框修改计划 · ↵ 批准编辑后的计划 · Esc 取消</text>
      </Show>
    </box>
  )
}

function ApprovalBar(props: { pending: PendingApproval }) {
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SPLIT}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.warning}>⏸ 需要审批</text>
      <text>
        {toolGlyph(props.pending.toolName)} {props.pending.toolName}
        <span style={{ fg: theme.muted }}> {summarizeInput(props.pending.toolName, props.pending.input)}</span>
      </text>
      <Show when={props.pending.grantScope}>
        <text fg={theme.muted}>授权范围 本会话内自动批准 {props.pending.grantScope}</text>
      </Show>
      <text>
        <span style={{ fg: theme.success }}>[a]</span> 单次{"  "}
        <span style={{ fg: theme.accent }}>[s]</span> 本会话{"  "}
        <span style={{ fg: theme.danger }}>[r]</span> 拒绝
      </text>
    </box>
  )
}

function QuestionBar(props: { pending: PendingQuestion; qi: number; oi: number; picked: string[][] }) {
  const q = () => props.pending.questions[props.qi]
  const multi = () => !!q()?.multiSelect
  const total = () => props.pending.questions.length
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SPLIT}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.accent}>
        ? 请选择{total() > 1 ? ` (${props.qi + 1}/${total()})` : ""}
        <span style={{ fg: theme.muted }}> {q()?.header}</span>
      </text>
      <text>{q()?.question}</text>
      <For each={q()?.options ?? []}>
        {(o, i) => {
          const on = () => i() === props.oi
          const checked = () => multi() && (props.picked[props.qi] ?? []).includes(o.label)
          return (
            <text>
              <span style={{ fg: theme.accent }}>{on() ? "▸ " : "  "}</span>
              <Show when={multi()}>
                <span style={{ fg: checked() ? theme.success : theme.muted }}>{checked() ? "[x] " : "[ ] "}</span>
              </Show>
              <span style={{ fg: on() ? theme.accent : theme.muted }}>{o.label}</span>
              <Show when={o.description}>
                <span style={{ fg: theme.muted }}> — {o.description}</span>
              </Show>
            </text>
          )
        }}
      </For>
      <text fg={theme.muted}>
        {multi() ? "↑↓ 移动 · 空格 勾选 · ↵ 确认 · Esc 跳过" : "↑↓ 选择 · ↵ 确认 · Esc 跳过"}
      </text>
    </box>
  )
}

function inputPlaceholder(pending: boolean, question: boolean, overlay: Overlay, running: boolean): string {
  if (pending) return "等待审批… a 单次 · s 本会话 · r 拒绝"
  if (question) return "请选择… ↑↓ 移动 · 空格 勾选 · ↵ 确认 · Esc 跳过"
  if (overlay?.kind === "picker") return "输入过滤 · ↵ 切换 · Esc 取消"
  if (overlay?.kind === "new") return "工作目录(留空=当前目录) · ↵ 创建 · Esc 取消"
  if (running) return "运行中… ^C 停止本次调用"
  return "输入消息，↵ 发送 · / 命令 · ^C 退出"
}

function belongsToActive(
  e: AgentStreamEvent,
  runId: string | undefined,
  subRuns: ReadonlySet<string>,
  sessionId: string | undefined,
): boolean {
  if (e.kind === "error" && (e.runId === "mcp" || e.runId === "sandbox")) return true
  if (e.kind === "todo-update") return e.sessionId === sessionId
  // Admit the active turn's run AND any sub-agent run spawned under it (their
  // events carry the sub-agent's own runId, not the turn's).
  if ("runId" in e) return (runId !== undefined && e.runId === runId) || subRuns.has(e.runId)
  return true
}
