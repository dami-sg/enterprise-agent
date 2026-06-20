/**
 * Headless tests for the OpenTUI session screen (Phase 5). Uses `testRender`
 * (off-TTY) + `mockInput` to drive the real Solid component, then asserts on the
 * captured char frame / recorded host calls. Run: `bun test src/tui-otui` (the
 * bunfig `[test] preload` applies the Solid transform).
 */
import { describe, it, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AgentStreamEvent } from "@enterprise-agent/agent-contract"
import { SessionApp, subAgentLogRows } from "./session.js"
import { ConfigView } from "./views.js"

interface Harness {
  ctx: any // eslint-disable-line @typescript-eslint/no-explicit-any
  sent: string[]
  created: { name: string; workingDir?: string }[]
  approved: { toolCallId: string; decision: string }[]
  renamed: { id: string; name: string }[]
  aborted: string[]
  deleted: string[]
  configUpdates: { id: string; config: any }[] // eslint-disable-line @typescript-eslint/no-explicit-any
  emit: (e: AgentStreamEvent) => void
}

function harness(sessions: any[] = []): Harness {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  const sent: string[] = []
  const created: { name: string; workingDir?: string }[] = []
  const approved: { toolCallId: string; decision: string }[] = []
  const aborted: string[] = []
  const deleted: string[] = []
  const renamed: { id: string; name: string }[] = []
  const modeChanges: { sessionId: string; mode: string }[] = []
  const planApprovals: { planId: string; decision: string }[] = []
  const configUpdates: { id: string; config: any }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  let listener: ((e: AgentStreamEvent) => void) | undefined
  const ctx = {
    host: {
      onEvent: (cb: (e: AgentStreamEvent) => void) => {
        listener = cb
        return () => {}
      },
      listSessions: async () => sessions,
      getTodos: async () => [],
      getSessionTree: async () => ({ nodes: {}, labels: {} }),
      createSession: async (input: { name: string; workingDir?: string }) => {
        created.push(input)
        return { id: "sNew", name: input.name, workingDir: input.workingDir }
      },
      sendMessage: async (_id: string, text: string) => {
        sent.push(text)
        return { runId: "r1" }
      },
      approveTool: (toolCallId: string, decision: string) => approved.push({ toolCallId, decision }),
      setExecutionMode: (sessionId: string, mode: string) => modeChanges.push({ sessionId, mode }),
      approvePlan: (planId: string, decision: string) => planApprovals.push({ planId, decision }),
      abortRun: (runId: string) => aborted.push(runId),
      deleteSession: async (id: string) => {
        deleted.push(id)
      },
      compact: async () => {},
      dispose: async () => {},
      // Auto-title after the first turn (§1.1).
      generateTitle: async () => "一二三四五六七八九十甲乙", // used verbatim (host owns brevity)
      renameSession: async (id: string, name: string) => {
        renamed.push({ id, name })
        return { id, name }
      },
      // Branch Navigator (§8) + config (§9) host calls — stubbed for the views.
      labelEntry: async () => {},
      forkFrom: async () => {},
      cloneToSession: async () => ({ sessionId: "sClone" }),
      listProviderModels: async () => ({
        models: [
          { ref: "anthropic:claude-opus", hasMeta: true },
          { ref: "anthropic:claude-haiku", hasMeta: true },
        ],
        fetchedAt: 0,
      }),
      updateSessionConfig: async (id: string, config: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        configUpdates.push({ id, config })
        return {}
      },
    },
    config: {
      loadProviders: () => [],
      listMcpServers: () => [],
      loadSessionAliases: () => [],
      loadGlobalAliases: () => [],
      saveGlobalAliases: () => {},
      saveProviders: () => {},
      saveMcpServer: () => {},
      // Honor the scope override so toggles (sandbox, delegateRoles) re-render.
      effective: (scope?: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        orchestratorAlias: "opus",
        roleAliases: {},
        aliases: [{ alias: "opus", ref: "anthropic:claude-opus" }],
        sandboxEnabled: true,
        sandboxNetwork: true,
        compactRatio: 0.8,
        maxDepth: 3,
        maxConcurrency: 4,
        maxSteps: 50,
        subAgentTimeoutMs: 300000,
        delegateRoles: scope?.delegateRoles ?? [],
        executionMode: scope?.executionMode ?? "ask",
        planAllowNetwork: scope?.plan?.allowNetwork ?? true,
      }),
    },
    meta: { get: () => ({ contextWindow: 200000, capabilities: [], price: undefined }) },
    paths: { sessionMcp: () => "/tmp/__none__", sessionSkills: () => "/tmp/__none__" },
    keychain: { get: () => undefined, set: () => {} },
    skillsForScope: () => [],
  }
  return { ctx, sent, created, approved, renamed, aborted, deleted, modeChanges, planApprovals, configUpdates, emit: (e) => listener?.(e) }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe("OpenTUI session screen", () => {
  it("renders the TopBar, empty-state and a visible input (no persistent sidebar)", async () => {
    const h = harness()
    const t = await testRender(() => <SessionApp ctx={h.ctx} />, { width: 100, height: 24 })
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("Enterprise Agent")
    expect(frame).toContain("在下方输入第一条消息")
    expect(frame).toContain("输入消息") // input placeholder is on screen
    // The right sidebar is gone; the task panel only appears once todos exist.
    expect(frame).not.toContain("产出物")
  })

  it("floats the task panel from the top-right on todo creation, hides it on the next send", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 24 })
    await t.flush()
    await t.mockInput.typeText("do tasks")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1
    await t.flush()
    await tick()
    h.emit({
      kind: "todo-update",
      sessionId: "s1",
      todos: [
        { content: "拆分模块", status: "in_progress" },
        { content: "补测试", status: "pending" },
      ],
    } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("任务 0/2")
    expect(t.captureCharFrame()).toContain("拆分模块")

    // Next user message hides the panel until the next turn's todos arrive.
    await t.mockInput.typeText("next")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).not.toContain("任务 0/2")
  })

  it("sends the typed message on Enter (not a newline)", async () => {
    const h = harness()
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 16 })
    await t.flush()
    await t.mockInput.typeText("写一个脚本")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    expect(h.sent).toEqual(["写一个脚本"])
  })

  it("shows the slash menu when the input starts with '/'", async () => {
    const h = harness()
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18 })
    await t.flush()
    await t.mockInput.typeText("/")
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("/sessions")
    expect(frame).toContain("/new")
  })

  it("surfaces a sub-agent's approval even though its events carry a different runId", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 22 })
    await t.flush()
    await t.mockInput.typeText("delegate a file write")
    await t.flush()
    t.mockInput.pressEnter() // turn runId = r1
    await t.flush()
    await tick()
    // Orchestrator (r1) spawns a coder sub-agent whose own run id is r2; its
    // writeFile then needs approval. Before the fix, r2 events were dropped, so
    // the approval never appeared and the sub-agent hung.
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "d1", toolName: "delegateToSubAgent", input: { role: "coder" } } as AgentStreamEvent)
    h.emit({
      kind: "sub-agent-start",
      runId: "r2",
      parentRunId: "r1",
      parentAgentId: "orch",
      agentId: "sub-coder-1",
      role: "coder",
      toolCallId: "d1",
    } as AgentStreamEvent)
    h.emit({
      kind: "tool-approval-required",
      runId: "r2",
      agentId: "sub-coder-1",
      toolCallId: "w1",
      toolName: "writeFile",
      input: { path: "/tmp/x.txt" },
      grantScope: "write /tmp",
    } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("需要审批")
  })

  it("keeps a running sub-agent's log collapsed by default, revealing the contained viewport on click", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 26 })
    await t.flush()
    await t.mockInput.typeText("delegate research")
    await t.flush()
    t.mockInput.pressEnter() // turn runId = r1
    await t.flush()
    await tick()
    // Orchestrator spawns a researcher sub-agent (own runId r2) that streams a
    // chatty log while the delegate tool stays 'running'.
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "d1", toolName: "delegateToSubAgent", input: { role: "researcher" } } as AgentStreamEvent)
    h.emit({ kind: "sub-agent-start", runId: "r2", parentRunId: "r1", parentAgentId: "orch", agentId: "sub-r-1", role: "researcher", toolCallId: "d1" } as AgentStreamEvent)
    h.emit({ kind: "text-delta", runId: "r2", agentId: "sub-r-1", text: "scanning the codebase" } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    // Collapsed by default: the delegate row + an 展开 hint, but NOT the log — a
    // busy sub-agent never takes over the screen unless asked (§3.1).
    const collapsed = t.captureCharFrame()
    expect(collapsed).toContain("delegateToSubAgent")
    expect(collapsed).toContain("子代理日志") // the ⤷ …（展开）hint
    expect(collapsed).not.toContain("scanning the codebase") // log stays hidden

    // Click the delegate header → the contained, bounded viewport reveals the log.
    const y = collapsed.split("\n").findIndex((l) => l.includes("delegateToSubAgent"))
    await t.mockMouse.click(5, y)
    await t.flush()
    await tick()
    await t.flush()
    const open = t.captureCharFrame()
    expect(open).toContain("子代理 · researcher") // the viewport's label
    expect(open).toContain("scanning the codebase") // log now scrolls inside the box
  })

  it("gives every parallel sub-agent its own collapsed log, even when events arrive out of order", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 28 })
    await t.flush()
    await t.mockInput.typeText("delegate to two in parallel")
    await t.flush()
    t.mockInput.pressEnter() // turn runId = r1
    await t.flush()
    await tick()
    // Racy parallel delegation: the writer's start + log land BEFORE its delegate
    // tool-call (d2); the coder's content lands BEFORE its start. Both must still
    // end up contained behind their OWN delegate row — not flat in the chat.
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "d1", toolName: "delegateToSubAgent", input: { role: "coder" } } as AgentStreamEvent)
    h.emit({ kind: "text-delta", runId: "r2", agentId: "sub-coder", text: "CODER_LOG_LINE" } as AgentStreamEvent)
    h.emit({ kind: "sub-agent-start", runId: "r2", parentRunId: "r1", parentAgentId: "orch", agentId: "sub-coder", role: "coder", toolCallId: "d1" } as AgentStreamEvent)
    h.emit({ kind: "sub-agent-start", runId: "r3", parentRunId: "r1", parentAgentId: "orch", agentId: "sub-writer", role: "writer", toolCallId: "d2" } as AgentStreamEvent)
    h.emit({ kind: "text-delta", runId: "r3", agentId: "sub-writer", text: "WRITER_LOG_LINE" } as AgentStreamEvent)
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "d2", toolName: "delegateToSubAgent", input: { role: "writer" } } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    // Both delegate rows present, each with its OWN 展开 button — and neither
    // sub-agent's log flooded the main chat (collapsed by default).
    expect((frame.match(/子代理日志/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(frame).not.toContain("CODER_LOG_LINE")
    expect(frame).not.toContain("WRITER_LOG_LINE")
  })

  it("scales the contained sub-agent viewport height with the terminal (clamped)", () => {
    // ~40% of the terminal, clamped to [6, 22]: short terminals stay usable,
    // tall ones show more of the log, and it never eats the whole pane (§3.1).
    expect(subAgentLogRows(18)).toBe(7) // floor(18 * 0.4)
    expect(subAgentLogRows(50)).toBe(20) // floor(50 * 0.4)
    expect(subAgentLogRows(10)).toBe(6) // floor(4) → clamped up to the min
    expect(subAgentLogRows(200)).toBe(22) // clamped down to the max
  })

  it("runs a `!` shell-escape directly and shows command + output (not via the model)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    // Typing `!…` enters command mode (the hint appears; border turns blue).
    await t.mockInput.typeText("!echo hello-shell")
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("命令模式")

    t.mockInput.pressEnter() // run it directly in the shell
    const waitFor = async (s: string, n = 30): Promise<boolean> => {
      for (let i = 0; i < n; i++) {
        await t.flush()
        await tick(30)
        if (t.captureCharFrame().includes(s)) return true
      }
      return false
    }
    expect(await waitFor("hello-shell")).toBe(true)
    const frame = t.captureCharFrame()
    expect(frame).toContain("! echo hello-shell") // echoed command line
    // It must NOT have gone through the model.
    expect(h.sent).toEqual([])
  })

  it("session switcher renders two-line items (title line, then workspace line)", async () => {
    const h = harness([
      { id: "s1", name: "Alpha", workingDir: "/home/me/alpha" },
      { id: "s2", name: "Beta", workingDir: "/home/me/beta" },
    ])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 24 })
    await t.flush()
    await t.mockInput.typeText("/sessions")
    await t.flush()
    t.mockInput.pressEnter() // open the switcher
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("切换会话")
    // Title and workspace both present…
    expect(frame).toContain("Alpha")
    expect(frame).toContain("/home/me/alpha")
    expect(frame).toContain("Beta")
    expect(frame).toContain("/home/me/beta")
    // …but no longer on a single ` · ` line (the old one-line format is gone).
    expect(frame).not.toContain("Alpha · /home/me/alpha")
  })

  it("opens the new-session dialog via /new and rejects a missing directory", async () => {
    const h = harness()
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18 })
    await t.flush()
    await t.mockInput.typeText("/new")
    await t.flush()
    t.mockInput.pressEnter() // run /new → open dialog
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("新建会话")

    await t.mockInput.typeText("/no/such/dir/xyz")
    await t.flush()
    t.mockInput.pressEnter() // try to create → must error, not create
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("目录不存在")
    expect(h.created).toEqual([])
  })

  it("offers existing workspace dirs as candidates in /new and Tab fills the input", async () => {
    const h = harness([
      { id: "s1", name: "S1", workingDir: "/home/me/proj-a" },
      { id: "s2", name: "S2", workingDir: "/home/me/proj-b" },
      { id: "s3", name: "S3", workingDir: "/home/me/proj-a" }, // duplicate dir, deduped
    ])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/new")
    await t.flush()
    t.mockInput.pressEnter() // open dialog
    await t.flush()
    await tick()
    await t.flush()
    // Both unique dirs are listed as candidates.
    const frame = t.captureCharFrame()
    expect(frame).toContain("已有工作目录")
    expect(frame).toContain("/home/me/proj-a")
    expect(frame).toContain("/home/me/proj-b")

    // ↓ moves the highlight to the second candidate; Tab fills the input with it.
    t.mockInput.pressArrow("down")
    await t.flush()
    t.mockInput.pressTab()
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("› /home/me/proj-b")
  })

  it("shows the approval bar and approves with 'a'", async () => {
    const h = harness()
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18 })
    await t.flush()
    await t.mockInput.typeText("run it")
    await t.flush()
    t.mockInput.pressEnter() // sets runId = r1
    await t.flush()
    await tick()
    h.emit({
      kind: "tool-approval-required",
      runId: "r1",
      agentId: "orch",
      toolCallId: "t1",
      toolName: "runCommand",
      input: { command: "pnpm test" },
      grantScope: "pnpm *",
    } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("需要审批")

    t.mockInput.pressKey("a")
    await t.flush()
    await tick()
    await t.flush()
    expect(h.approved).toEqual([{ toolCallId: "t1", decision: "once" }])
    // The approval key must NOT leak into the (re-focused) input — after the
    // decision the empty input shows its placeholder, not a stray "a".
    expect(t.captureCharFrame()).toContain("输入消息")
  })

  it("cycles execution mode with Shift+Tab and reflects mode-changed (agent §3.8)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 24 })
    await t.flush()
    await tick()
    await t.flush()
    // Default mode is ask, shown on the model line.
    expect(t.captureCharFrame()).toContain("◆ ask")

    // Shift+Tab → plan: drives the host and updates the indicator optimistically.
    t.mockInput.pressTab({ shift: true })
    await t.flush()
    await tick()
    await t.flush()
    expect(h.modeChanges).toEqual([{ sessionId: "s1", mode: "plan" }])
    expect(t.captureCharFrame()).toContain("◆ plan")

    // Shift+Tab again → auto.
    t.mockInput.pressTab({ shift: true })
    await t.flush()
    await tick()
    await t.flush()
    expect(h.modeChanges.at(-1)).toEqual({ sessionId: "s1", mode: "auto" })
    const autoFrame = t.captureCharFrame()
    expect(autoFrame).toContain("◆ auto")
    expect(autoFrame).toContain("自动执行模式") // the auto banner (§3.8.5)

    // A host-driven mode-changed (e.g. plan approval transition) is reflected too.
    h.emit({ kind: "mode-changed", sessionId: "s1", mode: "ask" } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("◆ ask")
  })

  it("shows the plan overlay on plan-proposed and approves it with 'a' (agent §3.8.4)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 26 })
    await t.flush()
    await t.mockInput.typeText("plan this")
    await t.flush()
    t.mockInput.pressEnter() // sets runId = r1
    await t.flush()
    await tick()
    h.emit({
      kind: "plan-proposed",
      runId: "r1",
      agentId: "orch",
      planId: "pm1",
      plan: "1. read files\n2. edit config",
      allowedActions: [{ tool: "runCommand", grantKey: "git", reason: "commit the change" }],
    } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("计划待审批")
    expect(frame).toContain("1. read files")
    expect(frame).toContain("runCommand(git)")

    t.mockInput.pressKey("a")
    await t.flush()
    await tick()
    await t.flush()
    expect(h.planApprovals).toEqual([{ planId: "pm1", decision: "approve" }])
    // Overlay dismissed; the input placeholder is back (key didn't leak into it).
    expect(t.captureCharFrame()).not.toContain("计划待审批")
    expect(t.captureCharFrame()).toContain("输入消息")
  })

  it("annotates an auto-classified tool call with a ⚡ badge (agent §3.8.5)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 26 })
    await t.flush()
    await t.mockInput.typeText("do it")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1
    await t.flush()
    await tick()
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "t1", toolName: "writeFile", input: { path: "a.ts" } } as AgentStreamEvent)
    h.emit({ kind: "auto-classified", runId: "r1", agentId: "orch", toolCallId: "t1", verdict: "allow", reason: "safe edit", stage: "fast" } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("⚡自动")
  })

  it("opens the config tabs via /config, switches tab, and Esc returns to the session", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 26 })
    await t.flush()
    await t.mockInput.typeText("/config")
    await t.flush()
    t.mockInput.pressEnter() // run /config → full-pane view
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("Providers")
    expect(frame).toContain("模型")
    expect(frame).toContain("Config")

    t.mockInput.pressKey("2") // → 模型 tab
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("别名")

    t.mockInput.pressEscape() // back to the conversation
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("在下方输入第一条消息")
  })

  it("auto-titles an untitled session after the first run (uses the model title verbatim)", async () => {
    const h = harness([{ id: "s1", name: "新会话", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 16 })
    await t.flush()
    await t.mockInput.typeText("写个脚本")
    await t.flush()
    t.mockInput.pressEnter() // sets runId = r1
    await t.flush()
    await tick()
    h.emit({ kind: "run-finish", runId: "r1", agentId: "orch" } as AgentStreamEvent)
    await t.flush()
    await tick()
    // The model title is used as-is (no mid-phrase clipping) — the host's
    // generateTitle/cleanTitle owns brevity; the TUI must not chop it.
    expect(h.renamed).toEqual([{ id: "s1", name: "一二三四五六七八九十甲乙" }])
  })

  it("falls back to a preview of the first message when title-gen yields nothing", async () => {
    const h = harness([{ id: "s1", name: "新会话", workingDir: "/tmp" }])
    h.ctx.host.generateTitle = async () => "" // model unavailable → empty title
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 16 })
    await t.flush()
    await t.mockInput.typeText("请帮我重构这段鉴权逻辑代码") // 13 chars, under the 24-char cap
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    h.emit({ kind: "run-finish", runId: "r1", agentId: "orch" } as AgentStreamEvent)
    await t.flush()
    await tick()
    expect(h.renamed).toEqual([{ id: "s1", name: "请帮我重构这段鉴权逻辑代码" }]) // short enough → kept whole
  })

  it("truncates a long first-message fallback with an ellipsis (not a broken clip)", async () => {
    const h = harness([{ id: "s1", name: "新会话", workingDir: "/tmp" }])
    h.ctx.host.generateTitle = async () => "" // model unavailable → empty title
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 16 })
    await t.flush()
    await t.mockInput.typeText("帮我把这个项目里所有用到旧版鉴权中间件的地方都迁移到新的统一鉴权网关上") // >24 chars
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    h.emit({ kind: "run-finish", runId: "r1", agentId: "orch" } as AgentStreamEvent)
    await t.flush()
    await tick()
    expect(h.renamed).toEqual([{ id: "s1", name: "帮我把这个项目里所有用到旧版鉴权中间件的地方都迁…" }]) // 24 cp + ellipsis
  })

  it("leaves an already-named session's title untouched on run-finish", async () => {
    const h = harness([{ id: "s1", name: "我命名的会话", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 16 })
    await t.flush()
    await t.mockInput.typeText("再来一条")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    h.emit({ kind: "run-finish", runId: "r1", agentId: "orch" } as AgentStreamEvent)
    await t.flush()
    await tick()
    expect(h.renamed).toEqual([])
  })

  it("navigates the slash menu with ↓ and runs the highlighted command on ↵", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/") // menu: /sessions, /new, …
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressArrow("down") // highlight → /new (2nd)
    await t.flush()
    t.mockInput.pressEnter() // run the highlighted command
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("新建会话") // /new dialog opened
  })

  it("Tab completes the highlighted slash command into the input", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/se") // filters to /sessions
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressTab() // complete → "/sessions "
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressEnter() // run it
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("切换会话") // session picker modal opened
  })

  it("opens a centered session picker and switches with ↓ + ↵", async () => {
    const h = harness([
      { id: "s1", name: "S1", workingDir: "/a" },
      { id: "s2", name: "S2", workingDir: "/b" },
    ])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/sessions")
    await t.flush()
    t.mockInput.pressEnter() // open the picker modal
    await t.flush()
    await tick()
    await t.flush()
    const open = t.captureCharFrame()
    expect(open).toContain("切换会话")
    expect(open).toContain("S2")

    t.mockInput.pressArrow("down") // select S2
    await t.flush()
    t.mockInput.pressEnter() // switch to it
    await t.flush()
    await tick()
    await t.flush()
    const after = t.captureCharFrame()
    expect(after).not.toContain("切换会话") // modal closed
    expect(after).toContain("S2") // active session (TopBar) is now S2
  })

  it("streams assistant text deltas into the same row in place (no churn/loss)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    // The assistant body renders via the async <markdown>; poll the frame rather
    // than relying on a fixed settle (flaky under many concurrent test renderers).
    const waitForText = async (s: string, n = 25): Promise<boolean> => {
      for (let i = 0; i < n; i++) {
        await t.flush()
        await tick(30)
        if (t.captureCharFrame().includes(s)) return true
      }
      return false
    }
    await t.mockInput.typeText("hi")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1
    await tick()
    h.emit({ kind: "text-delta", runId: "r1", agentId: "orch", text: "Hello " } as AgentStreamEvent)
    expect(await waitForText("Hello")).toBe(true)

    h.emit({ kind: "text-delta", runId: "r1", agentId: "orch", text: "world" } as AgentStreamEvent)
    expect(await waitForText("world")).toBe(true)
    // earlier delta survives the in-place update (appended, not replaced).
    expect(t.captureCharFrame()).toContain("Hello")
  })

  it("copies selected transcript text to the clipboard (OSC 52) on drag-select", async () => {
    const stdout = process.stdout as unknown as { isTTY?: boolean; write: (s: unknown) => boolean }
    const origTTY = stdout.isTTY
    const origWrite = process.stdout.write.bind(process.stdout)
    let osc = ""
    stdout.isTTY = true
    stdout.write = (s: unknown) => {
      if (typeof s === "string" && s.includes("]52;")) osc += s
      return true
    }
    try {
      const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
      const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 80, height: 18 })
      await t.flush()
      await t.mockInput.typeText("COPY ME PLEASE")
      await t.flush()
      t.mockInput.pressEnter()
      await t.flush()
      await tick()
      const y = t.captureCharFrame().split("\n").findIndex((l) => l.includes("COPY ME"))
      await t.mockMouse.drag(3, y, 25, y) // select the message
      await t.flush()
      await tick(220) // 150ms copy debounce + render
      await t.flush()
      const m = osc.match(/]52;c;([^]+)/)
      const copied = m ? Buffer.from(m[1]!, "base64").toString() : ""
      expect(copied).toContain("COPY ME")
    } finally {
      stdout.isTTY = origTTY
      process.stdout.write = origWrite
    }
  })

  it("folds reasoning into a 'thinking' header (real text hidden) and expands it on click", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 80, height: 22 })
    await t.flush()
    await t.mockInput.typeText("hi")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    h.emit({ kind: "reasoning-delta", runId: "r1", agentId: "orch", text: "我在推理一个隐藏的中间步骤" } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    const collapsed = t.captureCharFrame()
    expect(collapsed).toContain("thinking") // animated header
    expect(collapsed).not.toContain("我在推理") // real reasoning text is folded away

    // Click the "thinking" header → the real reasoning text expands.
    const y = collapsed.split("\n").findIndex((l) => l.includes("thinking"))
    await t.mockMouse.click(5, y)
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("我在推理") // now revealed
  })

  it("renders a tool call collapsed (one-line header) by default", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 80, height: 22 })
    await t.flush()
    await t.mockInput.typeText("go")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    h.emit({ kind: "tool-call", runId: "r1", agentId: "orch", toolCallId: "tc1", toolName: "runCommand", input: { command: "pnpm test" } } as AgentStreamEvent)
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("runCommand") // collapsed header
    expect(frame).toContain("▸") // collapse indicator
  })

  it("Ctrl-C interrupts a running model call (no exit confirm)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18, exitOnCtrlC: false })
    await t.flush()
    await t.mockInput.typeText("go")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1
    await t.flush()
    await tick()
    h.emit({ kind: "text-delta", runId: "r1", agentId: "orch", text: "working" } as AgentStreamEvent) // status → running
    await t.flush()
    await tick()
    t.mockInput.pressCtrlC()
    await t.flush()
    await tick()
    await t.flush()
    expect(h.aborted).toEqual(["r1"])
    expect(t.captureCharFrame()).not.toContain("退出 Enterprise Agent") // interrupt, not quit
  })

  it("Ctrl-C interrupts during the connecting window, before the first token", async () => {
    // Regression: the interrupt is gated on a run being in flight (`runId`), not
    // on the trace status — status only flips to 'running' on the first streamed
    // token, so an accidental send must still be stoppable before any token.
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18, exitOnCtrlC: false })
    await t.flush()
    await t.mockInput.typeText("oops")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1; no stream events yet (status still idle)
    await t.flush()
    await tick()
    t.mockInput.pressCtrlC()
    await t.flush()
    await tick()
    await t.flush()
    expect(h.aborted).toEqual(["r1"]) // aborted, even though nothing streamed
    expect(t.captureCharFrame()).not.toContain("退出 Enterprise Agent")
  })

  it("after an interrupt, run-finish clears the run so the next Ctrl-C quits", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18, exitOnCtrlC: false })
    await t.flush()
    await t.mockInput.typeText("go")
    await t.flush()
    t.mockInput.pressEnter() // runId = r1
    await t.flush()
    await tick()
    t.mockInput.pressCtrlC() // abort the in-flight run
    await t.flush()
    await tick()
    expect(h.aborted).toEqual(["r1"])
    // The session reports the run as aborted; this clears the tracked runId.
    h.emit({ kind: "run-finish", runId: "r1", finishReason: "aborted" } as AgentStreamEvent)
    await t.flush()
    await tick()
    t.mockInput.pressCtrlC() // now idle → exit confirm, and no second abort
    await t.flush()
    await tick()
    await t.flush()
    expect(h.aborted).toEqual(["r1"]) // not re-aborted
    expect(t.captureCharFrame()).toContain("退出 Enterprise Agent")
  })

  it("Ctrl-C while idle raises an exit-confirm modal that cancels on another key", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 18, exitOnCtrlC: false })
    await t.flush()
    await tick()
    t.mockInput.pressCtrlC() // idle → confirm
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("退出 Enterprise Agent")
    expect(h.aborted).toEqual([]) // nothing running to abort

    t.mockInput.pressKey("n") // any non-y cancels
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).not.toContain("退出 Enterprise Agent")
  })

  it("shows the current model under the input + workspace path in the TopBar", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/home/me/proj-x" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 24 })
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("anthropic:claude-opus") // model line below the input
    expect(frame).toContain("/home/me/proj-x") // full workspace path in the TopBar
  })

  it("restores the persisted token/cost/window readout on re-entering a session", async () => {
    const h = harness([
      {
        id: "s1",
        name: "S1",
        workingDir: "/tmp",
        usage: { inputTokens: 8000, outputTokens: 4300, totalTokens: 12300, reasoningTokens: 0, cachedInputTokens: 0, cost: 0.42 },
        lastInputTokens: 8000,
      },
    ])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 24 })
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame() // reconstructTrace zeroes usage; @set-usage restores it
    expect(frame).toContain("12.3k") // total tokens, not 0
    expect(frame).toContain("$0.420") // cost, not $0.000
    expect(frame).toContain("8.0k/200.0k") // context occupancy / window (from session + model meta)
  })

  it("opens the model switcher via /model (models under the current provider)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 24 })
    await t.flush()
    await t.mockInput.typeText("/model")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("切换模型")
    expect(frame).toContain("anthropic:claude-haiku")
  })

  it("deletes a selected session from the picker with d then y", async () => {
    const h = harness([
      { id: "s1", name: "S1", workingDir: "/a" },
      { id: "s2", name: "S2", workingDir: "/b" },
    ])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/sessions")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressArrow("down") // select S2
    await t.flush()
    t.mockInput.pressKey("d") // arm delete
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("删除「S2」")

    t.mockInput.pressKey("y") // confirm
    await t.flush()
    await tick()
    await t.flush()
    expect(h.deleted).toEqual(["s2"])
  })

  it("cancels a picker delete on any non-y key", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/a" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 90, height: 20 })
    await t.flush()
    await t.mockInput.typeText("/sessions")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressKey("d") // arm
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("删除「S1」")
    t.mockInput.pressKey("n") // cancel
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).not.toContain("删除「S1」")
    expect(h.deleted).toEqual([])
  })

  it("pastes into a ConfigView text field (paste event, not keypresses)", async () => {
    // Render ConfigView directly — the same `usePaste` wiring backs the provider
    // Key field; we render it standalone because the config modal clips it in a
    // tiny test terminal.
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <ConfigView ctx={h.ctx as never} sessionId="s1" onExit={() => {}} />, {
      width: 100,
      height: 26,
    })
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressKey("a") // Providers tab: open a text field (preset search)
    await t.flush()
    await tick()
    await t.flush()
    await t.mockInput.pasteBracketedText("sk-paste-xyz") // paste arrives as a paste event
    // Poll the frame rather than a fixed flush+tick: under a cold module cache the
    // paste re-render can lag a single settle (flaky), like the markdown test above.
    const waitForText = async (s: string, n = 25): Promise<boolean> => {
      for (let i = 0; i < n; i++) {
        await t.flush()
        await tick(30)
        if (t.captureCharFrame().includes(s)) return true
      }
      return false
    }
    expect(await waitForText("sk-paste-xyz")).toBe(true)
  })

  it("adds, edits and deletes an MCP server in the MCP tab (§9.3)", async () => {
    // Render ConfigView directly (the config modal clips in a tiny test terminal).
    const saved: { name: string; command?: string; transport: string }[] = []
    const removed: string[] = []
    let mcpServers: { name: string; transport: string; command?: string; enabled: boolean }[] = []
    const ctx = {
      host: { listProviderModels: async () => ({ models: [], fetchedAt: 0 }) },
      config: {
        loadProviders: () => [],
        listMcpServers: () => mcpServers,
        loadSessionAliases: () => [],
        loadGlobalAliases: () => [],
        effective: () => ({
          orchestratorAlias: "opus",
          roleAliases: {},
          aliases: [],
          sandboxEnabled: true,
          sandboxNetwork: true,
          compactRatio: 0.8,
          maxDepth: 3,
          maxConcurrency: 4,
          maxSteps: 50,
          subAgentTimeoutMs: 300000,
        }),
        saveMcpServer: (cfg: { name: string; transport: string; command?: string; enabled: boolean }) => {
          saved.push(cfg)
          mcpServers = [...mcpServers.filter((s) => s.name !== cfg.name), cfg]
        },
        removeMcpServer: (name: string) => {
          removed.push(name)
          mcpServers = mcpServers.filter((s) => s.name !== name)
          return true
        },
      },
      paths: { sessionMcp: () => "/tmp/__none__", sessionSkills: () => "/tmp/__none__" },
      keychain: { get: () => undefined, set: () => {} },
      skillsForScope: () => [],
    }
    const t = await testRender(() => <ConfigView ctx={ctx as never} onExit={() => {}} />, { width: 100, height: 30 })
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressKey("3") // MCP tab
    await t.flush()
    t.mockInput.pressKey("a") // open the add form
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("新增 MCP Server")

    await t.mockInput.typeText("srv1") // name field (idx 0)
    await t.flush()
    t.mockInput.pressArrow("down") // → transport
    t.mockInput.pressArrow("down") // → command (stdio)
    await t.flush()
    await t.mockInput.typeText("node")
    await t.flush()
    t.mockInput.pressEnter() // save
    await t.flush()
    await tick()
    await t.flush()
    expect(saved.some((s) => s.name === "srv1" && s.command === "node" && s.transport === "stdio")).toBe(true)
    expect(t.captureCharFrame()).toContain("srv1")

    t.mockInput.pressKey("e") // edit the (now selected) row
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("编辑 MCP — srv1")
    t.mockInput.pressEscape() // close without changes
    await t.flush()
    await tick()
    await t.flush()

    t.mockInput.pressKey("d") // arm delete
    await t.flush()
    await tick()
    await t.flush()
    expect(t.captureCharFrame()).toContain("删除「srv1」")
    t.mockInput.pressKey("y") // confirm
    await t.flush()
    await tick()
    await t.flush()
    expect(removed).toEqual(["srv1"])
  })

  it("toggles a sub-agent role's nested-delegation in the Config tab (§9.5 / agent §2.3)", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <ConfigView ctx={h.ctx as never} sessionId="s1" onExit={() => {}} />, {
      width: 100,
      height: 30,
    })
    await t.flush()
    await tick()
    await t.flush()
    t.mockInput.pressKey("5") // Config tab
    await t.flush()
    await tick()
    await t.flush()
    // All roles start ✗ (delegateRoles defaults to empty).
    expect(t.captureCharFrame()).toContain("✗coder")

    t.mockInput.pressKey("c") // coder's first letter → enable nesting for coder
    await t.flush()
    await tick()
    await t.flush()
    expect(h.configUpdates.at(-1)?.config.delegateRoles).toEqual(["coder"])
    expect(t.captureCharFrame()).toContain("✓coder")

    t.mockInput.pressKey("r") // researcher → now two roles enabled
    await t.flush()
    await tick()
    await t.flush()
    expect(h.configUpdates.at(-1)?.config.delegateRoles).toEqual(["coder", "researcher"])

    t.mockInput.pressKey("c") // toggle coder back off
    await t.flush()
    await tick()
    await t.flush()
    expect(h.configUpdates.at(-1)?.config.delegateRoles).toEqual(["researcher"])
  })

  it("opens the Branch Navigator via /fork", async () => {
    const h = harness([{ id: "s1", name: "S1", workingDir: "/tmp" }])
    const t = await testRender(() => <SessionApp ctx={h.ctx} initialSessionId="s1" />, { width: 100, height: 26 })
    await t.flush()
    await t.mockInput.typeText("/fork")
    await t.flush()
    t.mockInput.pressEnter()
    await t.flush()
    await tick()
    await t.flush()
    const frame = t.captureCharFrame()
    expect(frame).toContain("会话树")
    expect(frame).toContain("空会话树")
  })
})
