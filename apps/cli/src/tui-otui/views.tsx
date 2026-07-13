/**
 * OpenTUI + Solid full-pane views (cli-ui §1.1 "主区可被替换") — Phase 4 of the
 * Ink→OpenTUI migration. Ports `tui/views.tsx`: the Branch Navigator (§8) and the
 * read-only config tabs (§9). Each view is mounted only while active (the parent
 * swaps it into the body via `<Show>`), so its `useKeyboard` handler is added on
 * mount and torn down on unmount — it owns the keyboard while visible and routes
 * `Esc` back to the session view (§3).
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import type {
  DiscoveredModel,
  Entry,
  McpKeyRef,
  McpServerConfig,
  McpTransport,
  ProviderConfig,
  RiskTier,
  ScopedConfig,
  SessionTree,
} from "@dami-sg/agent-contract"
import { BUILTIN_PROVIDERS, type ProviderPreset } from "@dami-sg/agent"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { CliContext } from "../host/bootstrap.js"
import { theme } from "../core/theme.js"
import { fmtTok } from "../core/trace.js"
import { isLocalBase, keyRefFor } from "../core/provider.js"
import { displayWidth, padEnd, truncateW } from "../core/width.js"

/** A keypress as delivered by OpenTUI's `useKeyboard` (subset we read). */
interface Key {
  name?: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
  sequence?: string
}

/** The printable text a key produces, or undefined for control / named keys —
 * the OpenTUI analogue of Ink's `ch && !key.ctrl && !key.meta` guard. */
function typed(key: Key): string | undefined {
  if (key.ctrl || key.meta || key.option) return undefined
  const s = key.sequence ?? ""
  if (!s) return undefined
  const c0 = s.charCodeAt(0)
  if (c0 < 0x20 || c0 === 0x7f) return undefined // ESC / control / DEL / arrows
  return s
}

// Bracketed-paste markers + any ANSI escape (built without a literal ESC byte).
const PASTE_ANSI = new RegExp("\\x1b\\[[0-9;]*[A-Za-z~]", "g")
/** The plain text of an OpenTUI `paste` event for a single-line field: decode
 * the bytes, drop ANSI / bracketed-paste markers, strip control chars (incl.
 * newlines/tabs). Pasting is otherwise dropped — paste arrives as a `paste`
 * event, NOT keypresses, so the key/filter fields never saw it (§9.1). */
function pasteText(event: { bytes?: unknown }): string {
  const b = event.bytes
  const raw = typeof b === "string" ? b : b ? new TextDecoder().decode(b as Uint8Array) : ""
  // eslint-disable-next-line no-control-regex
  return raw.replace(PASTE_ANSI, "").replace(/[\x00-\x1f\x7f]/g, "")
}

// ---------------------------------------------------------------------------
// Generic data table (used by every config tab, §9)
// ---------------------------------------------------------------------------

interface Cell {
  text: string
  color?: string
}

function DataTable(props: { headers: string[]; rows: Cell[][]; selected?: number }) {
  // Memoized: `props.rows` is a reactive getter (callers pass `rows={cells()}`),
  // and `widths` is read once per header + once per cell in the nested `<For>`s —
  // without memoization every read re-invokes `cells()` (which for ProvidersTab
  // reads + parses the on-disk key store), turning one render into hundreds of
  // blocking calls and freezing the whole TUI for seconds.
  const widths = createMemo(() =>
    props.headers.map((h, i) => Math.max(displayWidth(h), ...props.rows.map((r) => displayWidth(r[i]?.text ?? "")))),
  )
  return (
    <box flexDirection="column">
      <text fg={theme.muted}>{"  " + props.headers.map((h, i) => padEnd(h, widths()[i]!)).join("  ")}</text>
      <For each={props.rows}>
        {(r, ri) => (
          <text bg={ri() === props.selected ? theme.panel : undefined}>
            <span>{ri() === props.selected ? "▸ " : "  "}</span>
            <For each={r}>
              {(c, ci) => (
                <span style={{ fg: c.color }}>
                  {padEnd(c.text, widths()[ci()]!)}
                  {ci() < r.length - 1 ? "  " : ""}
                </span>
              )}
            </For>
          </text>
        )}
      </For>
      <Show when={props.rows.length === 0}>
        <text fg={theme.muted}>（空）</text>
      </Show>
    </box>
  )
}

// ===========================================================================
// §8 Branch Navigator
// ===========================================================================

export function BranchView(props: {
  ctx: CliContext
  sessionId: string
  onExit: () => void
  onToast: (text: string) => void
}) {
  const { ctx } = props
  const [tree, setTree] = createSignal<SessionTree | undefined>(undefined)
  const [sel, setSel] = createSignal(0)
  const [labeling, setLabeling] = createSignal<string | null>(null)

  const reload = () => {
    void ctx.host
      .getSessionTree(props.sessionId)
      .then(setTree)
      .catch(() => setTree({ nodes: {}, labels: {} }))
  }
  onMount(reload)

  const rows = createMemo(() => (tree() ? flattenSessionTree(tree()!) : []))
  const current = () => rows()[Math.min(sel(), rows().length - 1)]?.entry

  useKeyboard((key: Key) => {
    const name = key.name
    const ch = typed(key)

    const lab = labeling()
    if (lab !== null) {
      if (name === "return") {
        const label = lab.trim()
        const cur = current()
        if (cur && label) {
          void ctx.host
            .labelEntry(props.sessionId, cur.id, label)
            .then(() => {
              props.onToast(`🏷 ${label}`)
              reload()
            })
            .catch((e) => props.onToast(`命名失败：${(e as Error).message}`))
        }
        return setLabeling(null)
      }
      if (name === "escape") return setLabeling(null)
      if (name === "backspace" || name === "delete") return setLabeling((v) => (v ?? "").slice(0, -1))
      if (ch) return setLabeling((v) => (v ?? "") + ch)
      return
    }

    if (name === "escape") return props.onExit()
    if (name === "up" || ch === "k") return setSel((i) => Math.max(0, i - 1))
    if (name === "down" || ch === "j") return setSel((i) => Math.min(rows().length - 1, i + 1))
    const cur = current()
    if (!cur) return
    if (ch === "f" || name === "return") {
      void ctx.host
        .forkFrom(props.sessionId, cur.id)
        .then(() => {
          props.onToast(`已从 ${cur.id.slice(0, 6)} 分叉`)
          props.onExit()
        })
        .catch((e) => props.onToast(`分叉失败：${(e as Error).message}`))
    } else if (ch === "l") {
      setLabeling("")
    } else if (ch === "c") {
      void ctx.host
        .cloneToSession(props.sessionId, cur.id)
        .then(({ sessionId }) => {
          props.onToast(`已克隆为新 Session ${sessionId}`)
        })
        .catch((e) => props.onToast(`克隆失败：${(e as Error).message}`))
    }
  }, {})

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.accent}>会话树 · {props.sessionId.slice(0, 8)}</text>
      <box flexDirection="column" paddingTop={1}>
        <For
          each={rows()}
          fallback={<text fg={theme.muted}>（空会话树）</text>}
        >
          {(row, i) => <BranchRow tree={tree()!} entry={row.entry} depth={row.depth} selected={i() === sel()} />}
        </For>
      </box>
      <Show when={labeling() !== null}>
        <box paddingTop={1}>
          <text>
            命名 checkpoint: <span style={{ fg: theme.accent }}>{labeling()}▌</span>
          </text>
        </box>
      </Show>
      <box paddingTop={1}>
        <text fg={theme.muted}>↑↓/jk 选 · f/↵ 从此分叉 · l 命名 · c 克隆为新 Work · Esc 返回</text>
      </box>
    </box>
  )
}

function BranchRow(props: { tree: SessionTree; entry: Entry; depth: number; selected: boolean }) {
  const indent = () => "  ".repeat(props.depth)
  const isHead = () => props.tree.headId === props.entry.id
  const label = () => props.tree.labels[props.entry.id]
  const isSummary = () => props.entry.kind === "summary"
  return (
    <text bg={props.selected ? theme.panel : undefined}>
      {indent()}
      <span style={{ fg: theme.muted }}>{props.entry.id.slice(0, 6)} </span>
      <span style={{ fg: isSummary() ? theme.muted : undefined }}>
        {isSummary() ? "⟲ " : ""}
        {props.entry.kind}
      </span>{" "}
      <span style={{ fg: theme.muted }}>{truncateW(preview(props.entry), 40)}</span>
      <Show when={label()}>
        <span style={{ fg: theme.warning }}> 🏷 {label()}</span>
      </Show>
      <Show when={isHead()}>
        <span style={{ fg: theme.accent }}> ◀ HEAD</span>
      </Show>
    </text>
  )
}

function flattenSessionTree(tree: SessionTree): { entry: Entry; depth: number }[] {
  const out: { entry: Entry; depth: number }[] = []
  const walk = (id: string, depth: number): void => {
    const e = tree.nodes[id]
    if (!e) return
    out.push({ entry: e, depth })
    for (const c of Object.values(tree.nodes).filter((n) => n.parentId === id)) walk(c.id, depth + 1)
  }
  if (tree.rootId) walk(tree.rootId, 0)
  return out
}

function preview(entry: Entry): string {
  if (entry.kind === "summary" && entry.summary) {
    return `${fmtTok(entry.summary.tokensBefore)} → ${fmtTok(entry.summary.tokensAfter)} tok`
  }
  for (const p of entry.content ?? []) {
    const t = (p as { text?: unknown }).text
    if (typeof t === "string" && t.trim()) return t.replace(/\n+/g, " ").trim()
  }
  return entry.kind
}

// ===========================================================================
// §9 Config tabs — read-only views with in-place edits (§9.1 / §9.3 / §9.5)
// ===========================================================================

const TABS = ["Providers", "模型", "MCP", "Skills", "Config"] as const

/** Tabs that support row selection + edit keys (Providers, 模型, MCP). */
const SELECTABLE: Record<number, boolean> = { 0: true, 1: true, 2: true }

/** What a model binding writes to (§9.2): define what an alias resolves to (→ global aliases.json). */
type BindTarget = { kind: "alias"; alias: string }

const targetLabel = (t: BindTarget): string => t.alias

/** Model-binding picker (§9.2): pick provider → pick model → save the target. */
type Picker =
  | { stage: "provider"; target: BindTarget; providers: ProviderConfig[]; sel: number }
  | { stage: "model"; target: BindTarget; providerId: string; models: DiscoveredModel[]; filter: string; sel: number }

/** A 模型-tab row: an alias definition. */
type ModelRow = { kind: "alias"; name: string }

/** A Providers-tab row: a configured provider, or a not-yet-added preset (§9.1). */
type ProviderRow =
  | { kind: "configured"; provider: ProviderConfig }
  | { kind: "preset"; preset: ProviderPreset }

export function ConfigView(props: {
  ctx: CliContext
  sessionId?: string
  sessionConfig?: ScopedConfig
  onExit: () => void
}) {
  const { ctx, sessionId } = props
  const [tab, setTab] = createSignal(0)
  const [sel, setSel] = createSignal(0)
  const [providers, setProviders] = createSignal<ProviderConfig[]>(ctx.config.loadProviders())
  const [servers, setServers] = createSignal<McpServerConfig[]>(ctx.config.listMcpServers(sessionId))
  const [scopeConfig, setScopeConfig] = createSignal<ScopedConfig>(props.sessionConfig ?? {})
  const [counts, setCounts] = createSignal<Record<string, string>>({})
  const [keyEdit, setKeyEdit] = createSignal<{ id: string; buf: string } | null>(null)
  const [picker, setPicker] = createSignal<Picker | null>(null)
  const [presetPick, setPresetPick] = createSignal<{ filter: string; sel: number } | null>(null)
  const [mcpForm, setMcpForm] = createSignal<McpForm | null>(null)
  const [mcpDelete, setMcpDelete] = createSignal<{ name: string; scope: McpScope } | null>(null)
  const [aliasVersion, setAliasVersion] = createSignal(0) // bump to re-read aliases
  const [note, setNote] = createSignal("")

  // Effective alias names (orchestrator + defined aliases), stable order. Role
  // bindings are NOT folded in here — they live in their own 模型-tab section and
  // their values are concrete refs, not alias names.
  const aliasNames = createMemo(() => {
    void aliasVersion() // re-read after a binding save
    const eff = ctx.config.effective(scopeConfig(), sessionId ? ctx.config.loadSessionAliases(sessionId) : [])
    return [...new Set<string>([eff.orchestratorAlias, ...eff.aliases.map((a) => a.alias)])]
  })

  // 模型-tab rows: every sub-agent role first (bind-a-model targets), then the
  // alias definitions. Selection in this tab indexes into this combined list.
  const modelRows = createMemo<ModelRow[]>(() => [
    ...aliasNames().map((name) => ({ kind: "alias" as const, name })),
  ])

  // The Providers tab lists configured providers first, then the built-in
  // presets not yet added (dimmed, addable inline) — so every known source is
  // visible in settings, not hidden behind the `a` picker (§9.1).
  const providerRows = createMemo<ProviderRow[]>(() => {
    const configured = new Set(providers().map((p) => p.id))
    return [
      ...providers().map((p) => ({ kind: "configured" as const, provider: p })),
      ...BUILTIN_PROVIDERS.filter((pr) => !configured.has(pr.id)).map((pr) => ({ kind: "preset" as const, preset: pr })),
    ]
  })

  // Refresh provider models when the config page opens — bypass the 24h cache so
  // counts/picker reflect current keys (§9.1). The catalog still skips the network
  // for unconfigured no-key cloud providers, so this only re-fetches providers
  // that can actually discover.
  onMount(() => {
    let alive = true
    onCleanup(() => {
      alive = false
    })
    void Promise.all(
      providers().map(async (p) => {
        try {
          const res = await ctx.host.listProviderModels(p.id, { refresh: true })
          return [p.id, res.fetchedAt === 0 && p.kind === "anthropic" ? `${res.models.length}*` : String(res.models.length)] as const
        } catch {
          return [p.id, "?"] as const
        }
      }),
    ).then((pairs) => alive && setCounts(Object.fromEntries(pairs)))
  })

  const rowCount = () =>
    tab() === 0 ? providerRows().length : tab() === 1 ? modelRows().length : tab() === 2 ? servers().length : 0

  // -- model picker (§9.2) --
  const openPicker = (): void => {
    const row = modelRows()[sel()]
    if (!row) return
    const enabled = providers().filter((p) => p.enabled)
    if (!enabled.length) {
      setNote("无启用的 Provider——先在 Providers 页启用/加 Key")
      return
    }
    const target: BindTarget = { kind: "alias", alias: row.name }
    setPicker({ stage: "provider", target, providers: enabled, sel: 0 })
  }

  const pickProvider = (): void => {
    const pk = picker()
    if (pk?.stage !== "provider") return
    const p = pk.providers[pk.sel]
    if (!p) return
    setNote(`加载 ${p.id} 模型…`)
    void ctx.host
      .listProviderModels(p.id, { refresh: true })
      .then((res) => {
        setNote(res.error ? `（部分回退：${res.error}）` : "")
        setPicker({ stage: "model", target: pk.target, providerId: p.id, models: res.models, filter: "", sel: 0 })
      })
      .catch((e: Error) => setNote(`模型发现失败：${e.message}`))
  }

  const filteredModels = (p: Extract<Picker, { stage: "model" }>): DiscoveredModel[] => {
    const q = p.filter.toLowerCase()
    return q ? p.models.filter((m) => m.ref.toLowerCase().includes(q)) : p.models
  }

  const commitModel = (): void => {
    const pk = picker()
    if (pk?.stage !== "model") return
    const m = filteredModels(pk)[pk.sel]
    if (!m) return
    const alias = pk.target.alias
    const aliases = ctx.config.loadGlobalAliases().filter((a) => a.alias !== alias)
    aliases.push({ alias, ref: m.ref })
    ctx.config.saveGlobalAliases(aliases)
    setNote(`${alias} → ${m.ref}（新会话生效）`)
    setPicker(null)
    setAliasVersion((v) => v + 1)
  }

  const toggleProvider = (): void => {
    const row = providerRows()[sel()]
    if (row?.kind !== "configured") return
    const p = row.provider
    const next = providers().map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x))
    ctx.config.saveProviders(next)
    setProviders(next)
    setNote(`${p.id} → ${!p.enabled ? "启用" : "停用"}`)
  }

  // Re-run model discovery for a provider (bypassing the 24h cache) and update
  // its count — called whenever a provider is (re)configured.
  const refreshModels = (id: string): void => {
    const kind = providers().find((x) => x.id === id)?.kind
    setCounts((c) => ({ ...c, [id]: "…" }))
    void ctx.host
      .listProviderModels(id, { refresh: true })
      .then((res) =>
        setCounts((c) => ({ ...c, [id]: res.fetchedAt === 0 && kind === "anthropic" ? `${res.models.length}*` : String(res.models.length) })),
      )
      .catch(() => setCounts((c) => ({ ...c, [id]: "?" })))
  }

  // -- add a provider from a built-in preset (§9.1) --
  const presetMatches = (filter: string): ProviderPreset[] => {
    const q = filter.toLowerCase()
    return q ? BUILTIN_PROVIDERS.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(q)) : BUILTIN_PROVIDERS
  }

  const addPresetRow = (preset: ProviderPreset): void => {
    const cfg: ProviderConfig = {
      id: preset.id,
      kind: preset.kind,
      baseURL: preset.baseURL,
      keyRef: preset.requiresKey ? keyRefFor(preset.id) : undefined,
      enabled: true,
    }
    const next = providers().filter((p) => p.id !== preset.id)
    next.push(cfg)
    ctx.config.saveProviders(next)
    setProviders(next)
    setSel(next.length - 1) // the freshly-added (now configured) row
    setNote(`已添加 ${preset.name}（${preset.kind}）`)
    if (preset.requiresKey) setKeyEdit({ id: preset.id, buf: "" })
    else refreshModels(preset.id)
  }

  const addPreset = (): void => {
    const pp = presetPick()
    if (!pp) return
    const preset = presetMatches(pp.filter)[pp.sel]
    setPresetPick(null)
    if (preset) addPresetRow(preset)
  }

  const refreshCount = (): void => {
    const row = providerRows()[sel()]
    if (row?.kind === "configured") refreshModels(row.provider.id)
  }

  const commitKey = (): void => {
    const ke = keyEdit()
    if (!ke) return
    const p = providers().find((x) => x.id === ke.id)
    if (p && ke.buf) {
      const ref = p.keyRef ?? keyRefFor(p.id)
      ctx.keychain.set(ref, ke.buf)
      if (!p.keyRef) {
        const next = providers().map((x) => (x.id === p.id ? { ...x, keyRef: ref } : x))
        ctx.config.saveProviders(next)
        setProviders(next)
      }
      setNote(`已写入 ${p.id} 密钥（明文文件）· 正在刷新模型…`)
      refreshModels(p.id)
    }
    setKeyEdit(null)
  }

  // Scope of the server currently under the cursor (per-server file location).
  const serverScope = (s: McpServerConfig): McpScope =>
    sessionId && existsSync(join(ctx.paths.sessionMcp(sessionId), `${s.name}.json`)) ? "session" : "global"

  const toggleServer = (): void => {
    const s = servers()[sel()]
    if (!s) return
    const scope = serverScope(s)
    const updated: McpServerConfig = { ...s, enabled: !s.enabled }
    ctx.config.saveMcpServer(updated, scope === "session" ? sessionId : undefined)
    setServers(servers().map((x, i) => (i === sel() ? updated : x)))
    setNote(`${s.name} → ${!s.enabled ? "启用" : "停用"}（下次会话生效）`)
  }

  // -- add / edit / delete MCP servers (§9.3) --
  const openAddMcp = (): void => {
    setMcpForm(emptyMcpForm(sessionId ? "session" : "global"))
  }

  const openEditMcp = (): void => {
    const s = servers()[sel()]
    if (!s) return
    setMcpForm(mcpFormFromConfig(s, serverScope(s)))
  }

  const commitMcpForm = (): void => {
    const form = mcpForm()
    if (!form) return
    const built = buildMcpConfig(form)
    if (typeof built === "string") {
      setMcpForm({ ...form, error: built })
      return
    }
    // Renamed or moved scope: drop the old file so it isn't orphaned.
    if (form.original && (form.original !== built.name || form.originalScope !== form.scope)) {
      ctx.config.removeMcpServer(form.original, form.originalScope === "session" ? sessionId : undefined)
    }
    ctx.config.saveMcpServer(built, form.scope === "session" ? sessionId : undefined)
    const next = ctx.config.listMcpServers(sessionId)
    setServers(next)
    setSel(Math.max(0, Math.min(next.findIndex((x) => x.name === built.name), next.length - 1)))
    setMcpForm(null)
    setNote(`${form.original ? "已更新" : "已新增"} MCP ${built.name}（${form.scope}）`)
  }

  const confirmDeleteMcp = (): void => {
    const del = mcpDelete()
    if (!del) return
    ctx.config.removeMcpServer(del.name, del.scope === "session" ? sessionId : undefined)
    const next = ctx.config.listMcpServers(sessionId)
    setServers(next)
    setSel((i) => Math.max(0, Math.min(i, next.length - 1)))
    setMcpDelete(null)
    setNote(`已删除 MCP ${del.name}`)
  }

  const toggleSandbox = (): void => {
    if (!sessionId) {
      setNote("无活动 Session——沙箱覆盖按 Session 设置")
      return
    }
    const eff = ctx.config.effective(scopeConfig(), ctx.config.loadSessionAliases(sessionId))
    const next: ScopedConfig = { ...scopeConfig(), sandbox: { ...scopeConfig().sandbox, enabled: !eff.sandboxEnabled } }
    void ctx.host
      .updateSessionConfig(sessionId, next)
      .then(() => {
        setScopeConfig(next)
        setNote(`沙箱 → ${!eff.sandboxEnabled ? "启用" : "关闭"}（session 覆盖）`)
      })
      .catch((e) => setNote(`保存失败：${(e as Error).message}`))
  }

  const toggleSandboxNetwork = (): void => {
    if (!sessionId) {
      setNote("无活动 Session——网络覆盖按 Session 设置")
      return
    }
    const eff = ctx.config.effective(scopeConfig(), ctx.config.loadSessionAliases(sessionId))
    const next: ScopedConfig = { ...scopeConfig(), sandbox: { ...scopeConfig().sandbox, network: !eff.sandboxNetwork } }
    void ctx.host
      .updateSessionConfig(sessionId, next)
      .then(() => {
        setScopeConfig(next)
        setNote(`沙箱网络 → ${!eff.sandboxNetwork ? "开启" : "关闭"}（session 覆盖）`)
      })
      .catch((e) => setNote(`保存失败：${(e as Error).message}`))
  }


  useKeyboard((key: Key) => {
    const name = key.name
    const ch = typed(key)

    const ke = keyEdit()
    if (ke) {
      if (name === "return") return commitKey()
      if (name === "escape") return setKeyEdit(null)
      if (name === "backspace" || name === "delete") return setKeyEdit((k) => (k ? { ...k, buf: k.buf.slice(0, -1) } : k))
      if (ch) return setKeyEdit((k) => (k ? { ...k, buf: k.buf + ch } : k))
      return
    }
    const form = mcpForm()
    if (form) {
      const fields = mcpFields(form, !!sessionId)
      const idx = Math.min(form.fieldIdx, fields.length - 1)
      const cur = fields[idx]
      if (!cur) return
      if (name === "escape") return setMcpForm(null)
      if (name === "return") return commitMcpForm()
      if (name === "up") return setMcpForm({ ...form, fieldIdx: Math.max(0, idx - 1), error: undefined })
      if (name === "down") return setMcpForm({ ...form, fieldIdx: Math.min(fields.length - 1, idx + 1), error: undefined })
      if (cur.kind === "enum") {
        const dir = name === "left" ? -1 : name === "right" ? 1 : 0
        if (!dir) return
        if (cur.key === "transport") {
          const i = (TRANSPORTS.indexOf(form.transport) + dir + TRANSPORTS.length) % TRANSPORTS.length
          return setMcpForm({ ...form, transport: TRANSPORTS[i]!, error: undefined })
        }
        if (cur.key === "riskTier") {
          const i = (RISK_TIERS.indexOf(form.riskTier) + dir + RISK_TIERS.length) % RISK_TIERS.length
          return setMcpForm({ ...form, riskTier: RISK_TIERS[i]!, error: undefined })
        }
        return setMcpForm({ ...form, scope: form.scope === "global" ? "session" : "global", error: undefined })
      }
      if (cur.kind === "bool") {
        if (name === "left" || name === "right" || ch === " ") return setMcpForm({ ...form, enabled: !form.enabled, error: undefined })
        return
      }
      if (name === "backspace" || name === "delete") return setMcpForm({ ...form, [cur.key]: form[cur.key].slice(0, -1), error: undefined })
      if (ch) return setMcpForm({ ...form, [cur.key]: form[cur.key] + ch, error: undefined })
      return
    }
    const del = mcpDelete()
    if (del) {
      if (ch === "y") return confirmDeleteMcp()
      return setMcpDelete(null)
    }
    const pp = presetPick()
    if (pp) {
      const n = presetMatches(pp.filter).length
      if (name === "escape") return setPresetPick(null)
      if (name === "up") return setPresetPick({ ...pp, sel: Math.max(0, pp.sel - 1) })
      if (name === "down") return setPresetPick({ ...pp, sel: Math.min(Math.max(0, n - 1), pp.sel + 1) })
      if (name === "return") return addPreset()
      if (name === "backspace" || name === "delete") return setPresetPick({ ...pp, filter: pp.filter.slice(0, -1), sel: 0 })
      if (ch) return setPresetPick({ ...pp, filter: pp.filter + ch, sel: 0 })
      return
    }
    const pk = picker()
    if (pk) {
      if (name === "escape")
        return pk.stage === "model"
          ? setPicker({ stage: "provider", target: pk.target, providers: providers().filter((p) => p.enabled), sel: 0 })
          : setPicker(null)
      if (pk.stage === "provider") {
        if (name === "up") return setPicker({ ...pk, sel: Math.max(0, pk.sel - 1) })
        if (name === "down") return setPicker({ ...pk, sel: Math.min(pk.providers.length - 1, pk.sel + 1) })
        if (name === "return") return pickProvider()
      } else {
        const n = filteredModels(pk).length
        if (name === "up") return setPicker({ ...pk, sel: Math.max(0, pk.sel - 1) })
        if (name === "down") return setPicker({ ...pk, sel: Math.min(Math.max(0, n - 1), pk.sel + 1) })
        if (name === "return") return commitModel()
        if (name === "backspace" || name === "delete") return setPicker({ ...pk, filter: pk.filter.slice(0, -1), sel: 0 })
        if (ch) return setPicker({ ...pk, filter: pk.filter + ch, sel: 0 })
      }
      return
    }
    if (name === "escape") return props.onExit()
    if (name && name >= "1" && name <= "5") {
      setTab(Number(name) - 1)
      setSel(0)
      setNote("")
      return
    }
    if (name === "left") {
      setTab((t) => Math.max(0, t - 1))
      setSel(0)
      return
    }
    if (name === "right") {
      setTab((t) => Math.min(TABS.length - 1, t + 1))
      setSel(0)
      return
    }
    if (SELECTABLE[tab()]) {
      // Arrow keys only — `j`/`k` are free so `k` can mean "set Key" (§9.1).
      if (name === "up") return setSel((i) => Math.max(0, i - 1))
      if (name === "down") return setSel((i) => Math.min(Math.max(0, rowCount() - 1), i + 1))
    }
    if (tab() === 0) {
      if (ch === "a") return setPresetPick({ filter: "", sel: 0 }) // fuzzy add-by-search
      const row = providerRows()[sel()]
      if (row?.kind === "preset") {
        if (name === "return" || ch === "e") return addPresetRow(row.preset)
        return
      }
      if (ch === "e") return toggleProvider()
      if (ch === "r") return refreshCount()
      if (ch === "k" && row) return setKeyEdit({ id: row.provider.id, buf: "" })
    } else if (tab() === 1) {
      if (ch === "o") return openPicker()
    } else if (tab() === 2) {
      if (ch === "a") return openAddMcp()
      if (name === "return" || ch === "e") return openEditMcp()
      if (ch === "t") return toggleServer()
      if (ch === "d") {
        const s = servers()[sel()]
        if (s) setMcpDelete({ name: s.name, scope: serverScope(s) })
        return
      }
    } else if (tab() === 4) {
      if (ch === "s") return toggleSandbox()
      if (ch === "n") return toggleSandboxNetwork()
    }
  }, {})

  // Paste support (§9.1): pasted text arrives as a `paste` event, not keypresses,
  // so append it to whichever single-line field is active — the provider Key, the
  // preset search, or the model filter.
  usePaste((event: { bytes?: unknown }) => {
    const text = pasteText(event)
    if (!text) return
    const ke = keyEdit()
    if (ke) return setKeyEdit({ ...ke, buf: ke.buf + text })
    const form = mcpForm()
    if (form) {
      const fields = mcpFields(form, !!sessionId)
      const cur = fields[Math.min(form.fieldIdx, fields.length - 1)]
      if (cur?.kind === "text") return setMcpForm({ ...form, [cur.key]: form[cur.key] + text })
      return
    }
    const pp = presetPick()
    if (pp) return setPresetPick({ ...pp, filter: pp.filter + text, sel: 0 })
    const pk = picker()
    if (pk?.stage === "model") return setPicker({ ...pk, filter: pk.filter + text, sel: 0 })
  })

  const eff = () => ctx.config.effective(scopeConfig(), sessionId ? ctx.config.loadSessionAliases(sessionId) : [])

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <For each={TABS}>
          {(t, i) => (
            <text fg={i() === tab() ? theme.accent : theme.muted}>
              {i() === tab() ? "▸ " : "  "}
              {i() + 1} {t}
              {i() < TABS.length - 1 ? " " : ""}
            </text>
          )}
        </For>
      </box>
      <box paddingTop={1} flexDirection="column">
        <Show when={tab() === 0}>
          <ProvidersTab rows={providerRows()} counts={counts()} keychain={ctx.keychain} selected={keyEdit() || presetPick() ? -1 : sel()} />
        </Show>
        <Show when={tab() === 1}>
          <ModelsTab ctx={ctx} aliasNames={aliasNames()} version={aliasVersion()} scopeConfig={scopeConfig()} sessionId={sessionId} selected={picker() ? -1 : sel()} />
        </Show>
        <Show when={tab() === 2}>
          <McpTab ctx={ctx} sessionId={sessionId} servers={servers()} selected={sel()} />
        </Show>
        <Show when={tab() === 3}>
          <SkillsTab ctx={ctx} sessionId={sessionId} />
        </Show>
        <Show when={tab() === 4}>
          <ConfigTab eff={eff()} />
        </Show>
      </box>
      <Show when={picker()}>
        <PickerOverlay picker={picker()!} filtered={picker()!.stage === "model" ? filteredModels(picker() as Extract<Picker, { stage: "model" }>) : []} ctx={ctx} />
      </Show>
      <Show when={presetPick()}>
        <PresetOverlay matches={presetMatches(presetPick()!.filter)} filter={presetPick()!.filter} sel={presetPick()!.sel} />
      </Show>
      <Show when={mcpForm()}>
        <McpFormOverlay form={mcpForm()!} fields={mcpFields(mcpForm()!, !!sessionId)} />
      </Show>
      <Show when={mcpDelete()}>
        <box paddingTop={1}>
          <text>
            <span style={{ fg: theme.danger }}>删除「{mcpDelete()!.name}」？</span>
            <span style={{ fg: theme.muted }}> y 确认 · 其他键取消</span>
          </text>
        </box>
      </Show>
      <Show when={keyEdit()} fallback={<Show when={note()}><box paddingTop={1}><text fg={theme.success}>✓ {note()}</text></box></Show>}>
        <box paddingTop={1}>
          <text>
            {keyEdit()!.id} 的 Key: <span style={{ fg: theme.accent }}>{"•".repeat(keyEdit()!.buf.length)}▌</span>
            <span style={{ fg: theme.muted }}> (↵ 保存 · Esc 取消)</span>
          </text>
        </box>
      </Show>
      <box paddingTop={1}>
        <text fg={theme.muted}>{hintFor(tab())}</text>
      </box>
    </box>
  )
}

function hintFor(tab: number): string {
  const nav = "←→/1-5 切标签 · Esc 返回"
  if (tab === 0) return `${nav} · ↑↓ 选 · ↵ 加预设 · e 启停/加 · k 设 Key · r 刷新 · a 搜预设`
  if (tab === 1) return `${nav} · ↑↓ 选 · o 绑定模型别名`
  if (tab === 2) return `${nav} · ↑↓ 选 · a 新增 · e/↵ 编辑 · t 启停 · d 删除`
  if (tab === 4) return `${nav} · s 切沙箱 · n 切网络`
  return `${nav}`
}

/** Built-in provider preset picker overlay (§9.1): fuzzy-pick a known source. */
function PresetOverlay(props: { matches: ProviderPreset[]; filter: string; sel: number }) {
  const shown = () => props.matches.slice(0, 10)
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} paddingLeft={1} paddingRight={1} marginTop={1}>
      <text>
        <span style={{ fg: theme.accent }}>加 Provider — 选预设 </span>
        <span style={{ fg: theme.muted }}>（输入过滤 · ↑↓ · ↵ 添加 · Esc 取消）</span>
      </text>
      <text>
        › {props.filter}
        <span style={{ fg: theme.accent }}>▌</span>
      </text>
      <For each={shown()}>
        {(p, i) => (
          <text bg={i() === props.sel ? theme.panel : undefined}>
            {i() === props.sel ? "▸ " : "  "}
            {p.name}{" "}
            <span style={{ fg: theme.muted }}>
              {p.kind}
              {p.baseURL ? ` · ${p.baseURL}` : ""}
              {p.requiresKey ? "" : " · 本地"}
            </span>
            <Show when={p.note}>
              <span style={{ fg: theme.warning }}> ⚠</span>
            </Show>
          </text>
        )}
      </For>
      <Show when={props.matches.length > 10}>
        <text fg={theme.muted}>  … 共 {props.matches.length}，输入过滤</text>
      </Show>
      <Show when={props.matches.length === 0}>
        <text fg={theme.muted}>  （无匹配预设）</text>
      </Show>
    </box>
  )
}

/** Provider → model picker overlay (§9.2): pick provider, then fuzzy-pick a model. */
function PickerOverlay(props: { picker: Picker; filtered: DiscoveredModel[]; ctx: CliContext }) {
  return (
    <Show
      when={props.picker.stage === "model"}
      fallback={
        <box flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} paddingLeft={1} paddingRight={1} marginTop={1}>
          <text fg={theme.accent}>绑定 {targetLabel(props.picker.target)} — 选 Provider（↑↓ · ↵ · Esc 取消）</text>
          <For each={(props.picker as Extract<Picker, { stage: "provider" }>).providers}>
            {(pr, i) => (
              <text bg={i() === props.picker.sel ? theme.panel : undefined}>
                {i() === props.picker.sel ? "▸ " : "  "}
                {pr.id} <span style={{ fg: theme.muted }}>{pr.kind}</span>
              </text>
            )}
          </For>
        </box>
      }
    >
      {(() => {
        const p = props.picker as Extract<Picker, { stage: "model" }>
        const shown = () => props.filtered.slice(0, 8)
        return (
          <box flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} paddingLeft={1} paddingRight={1} marginTop={1}>
            <text>
              <span style={{ fg: theme.accent }}>绑定 {targetLabel(p.target)} — {p.providerId} 的模型 </span>
              <span style={{ fg: theme.muted }}>（输入过滤 · ↑↓ · ↵ · Esc 回退）</span>
            </text>
            <text>
              › {p.filter}
              <span style={{ fg: theme.accent }}>▌</span>
            </text>
            <For each={shown()}>
              {(m, i) => {
                // Context window comes off the discovery result directly (§2.6).
                return (
                  <text bg={i() === p.sel ? theme.panel : undefined}>
                    {i() === p.sel ? "▸ " : "  "}
                    {m.ref}{" "}
                    <span style={{ fg: m.hasMeta ? theme.success : theme.warning }}>{m.contextWindow != null ? `${fmtTok(m.contextWindow)} ✓meta` : "无定价"}</span>
                  </text>
                )
              }}
            </For>
            <Show when={props.filtered.length > 8}>
              <text fg={theme.muted}>  … 共 {props.filtered.length}，输入过滤</text>
            </Show>
            <Show when={props.filtered.length === 0}>
              <text fg={theme.muted}>  （无匹配模型）</text>
            </Show>
          </box>
        )
      })()}
    </Show>
  )
}

function ProvidersTab(props: { rows: ProviderRow[]; counts: Record<string, string>; keychain: CliContext["keychain"]; selected: number }) {
  const base = (url?: string): string => (url ? truncateW(url, 34) : "—（官方）")
  // Memoized: `keychain.get` reads + JSON-parses the on-disk key store, so it
  // must not run on every reactive read of the rows. The memo recomputes
  // only when the provider list or model counts change (a handful of times),
  // never per-cell-per-render.
  const cells = createMemo((): Cell[][] =>
    props.rows.map((row) => {
      if (row.kind === "preset") {
        const p = row.preset
        return [
          { text: p.id, color: theme.muted },
          { text: p.kind, color: theme.muted },
          { text: base(p.baseURL), color: theme.muted },
          { text: p.requiresKey ? "key" : "本地", color: theme.muted },
          { text: "—", color: theme.muted },
          { text: "＋ 添加", color: theme.muted },
        ]
      }
      const p = row.provider
      const ref = p.keyRef ?? keyRefFor(p.id)
      const has = props.keychain.get(ref) !== undefined
      return [
        { text: p.id },
        { text: p.kind },
        { text: base(p.baseURL), color: p.baseURL ? undefined : theme.muted },
        { text: has ? "✓" : isLocalBase(p.baseURL) ? "—" : "✗", color: has ? theme.success : isLocalBase(p.baseURL) ? theme.muted : theme.danger },
        { text: props.counts[p.id] ?? "…", color: theme.muted },
        { text: p.enabled ? "● 启用" : "○ 停用", color: p.enabled ? theme.success : theme.muted },
      ]
    }),
  )
  return (
    <box flexDirection="column">
      <DataTable headers={["id", "kind", "baseURL", "key", "模型", "状态"]} rows={cells()} selected={props.selected} />
      <text fg={theme.muted}>（灰色为内置预设，↵/e 添加 · a 搜索预设）</text>
    </box>
  )
}

function ModelsTab(props: { ctx: CliContext; aliasNames: string[]; version: number; scopeConfig: ScopedConfig; sessionId?: string; selected: number }) {
  // Memoized: reads session aliases from disk + resolves each ref against the
  // models.dev metadata index; must not re-run on every reactive read of rows.
  // `version` is read so a binding save (which doesn't change `aliasNames`) still
  // recomputes the role rows.
  const data = createMemo((): { roles: Cell[][]; aliases: Cell[][] } => {
    void props.version
    const eff = props.ctx.config.effective(props.scopeConfig, props.sessionId ? props.ctx.config.loadSessionAliases(props.sessionId) : [])
    const byAlias = new Map(eff.aliases.map((a) => [a.alias, a]))
    // Self-generated sub-agents have no per-role model binding (dynamic-subagents
    // §D1): a worker uses its spec's model or the orchestrator's. Only aliases here.
    const roles: Cell[][] = []

    const aliases = props.aliasNames.map((name) => {
      const a = byAlias.get(name)
      const meta = a ? props.ctx.meta.get(a.ref) : undefined
      const caps = (a?.capabilities ?? meta?.capabilities ?? []).join(" ")
      const noTools = !!a && !caps.includes("tool_call")
      return [
        { text: name, color: noTools ? theme.warning : undefined },
        { text: a?.ref ?? "（未定义）", color: a ? undefined : theme.muted },
        { text: meta ? fmtTok(meta.contextWindow) : "" },
        { text: caps || "—", color: caps ? undefined : theme.muted },
        { text: meta?.price ? `${meta.price.input}/${meta.price.output}` : "—", color: theme.muted },
      ]
    })
    return { roles, aliases }
  })

  return (
    <box flexDirection="column">
      <text fg={theme.muted}>别名</text>
      <DataTable headers={["别名", "→ ref", "ctx", "能力", "$/Mtok"]} rows={data().aliases} selected={props.selected} />
    </box>
  )
}

// -- MCP add/edit form (§9.3) --------------------------------------------------

const TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"]
const RISK_TIERS: (RiskTier | "")[] = ["", "readonly", "write", "exec", "network"]
type McpScope = "global" | "session"

/** Free-text fields of the form (all `string`), keyed for type-safe edits. */
type McpTextKey = "name" | "command" | "args" | "env" | "url" | "headers"

/** In-flight add/edit state. `original` is the name being edited (null = adding). */
interface McpForm {
  original: string | null
  originalScope: McpScope
  scope: McpScope
  fieldIdx: number
  name: string
  transport: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
  riskTier: RiskTier | ""
  enabled: boolean
  error?: string
}

type McpField =
  | { key: McpTextKey; label: string; kind: "text"; hint?: string }
  | { key: "transport" | "riskTier" | "scope"; label: string; kind: "enum" }
  | { key: "enabled"; label: string; kind: "bool" }

/** The visible fields for a form, transport-dependent; scope only with a session. */
function mcpFields(form: McpForm, hasSession: boolean): McpField[] {
  const f: McpField[] = [
    { key: "name", label: "名称", kind: "text" },
    { key: "transport", label: "传输", kind: "enum" },
  ]
  if (form.transport === "stdio") {
    f.push({ key: "command", label: "命令", kind: "text" })
    f.push({ key: "args", label: "参数", kind: "text", hint: "空格分隔" })
    f.push({ key: "env", label: "环境变量", kind: "text", hint: "K=V,逗号分隔" })
  } else {
    f.push({ key: "url", label: "URL", kind: "text" })
    f.push({ key: "headers", label: "请求头", kind: "text", hint: "K=V,逗号分隔" })
  }
  f.push({ key: "riskTier", label: "风险级别", kind: "enum" })
  f.push({ key: "enabled", label: "启用", kind: "bool" })
  if (hasSession) f.push({ key: "scope", label: "作用域", kind: "enum" })
  return f
}

function emptyMcpForm(scope: McpScope): McpForm {
  return {
    original: null,
    originalScope: scope,
    scope,
    fieldIdx: 0,
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    riskTier: "",
    enabled: true,
  }
}

function mcpFormFromConfig(s: McpServerConfig, scope: McpScope): McpForm {
  return {
    original: s.name,
    originalScope: scope,
    scope,
    fieldIdx: 0,
    name: s.name,
    transport: s.transport,
    command: s.command ?? "",
    args: (s.args ?? []).join(" "),
    env: stringifyPairs(s.env),
    url: s.url ?? "",
    headers: stringifyPairs(s.headers),
    riskTier: s.riskTier ?? "",
    enabled: s.enabled,
  }
}

/** `"K=V"`-pair text ↔ record. A `${ref}` value round-trips to an `McpKeyRef`. */
function parsePairs(text: string): Record<string, string | McpKeyRef> {
  const out: Record<string, string | McpKeyRef> = {}
  for (const part of text.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (!k) continue
    const ref = v.match(/^\$\{(.+)\}$/)
    out[k] = ref ? { keyRef: ref[1] as string } : v
  }
  return out
}

function stringifyPairs(rec?: Record<string, string | McpKeyRef>): string {
  if (!rec) return ""
  return Object.entries(rec)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : `\${${v.keyRef}}`}`)
    .join(",")
}

/** Validate + assemble an `McpServerConfig`, or return an error string. */
function buildMcpConfig(form: McpForm): McpServerConfig | string {
  const name = form.name.trim()
  if (!name) return "名称不能为空"
  if (/[/\\]/.test(name)) return "名称不能含 / 或 \\"
  const cfg: McpServerConfig = { name, transport: form.transport, enabled: form.enabled }
  if (form.riskTier) cfg.riskTier = form.riskTier
  if (form.transport === "stdio") {
    const command = form.command.trim()
    if (!command) return "stdio 需要命令"
    cfg.command = command
    const args = form.args.trim().split(/\s+/).filter(Boolean)
    if (args.length) cfg.args = args
    const env = parsePairs(form.env)
    if (Object.keys(env).length) cfg.env = env
  } else {
    const url = form.url.trim()
    if (!url) return "需要 URL"
    cfg.url = url
    const headers = parsePairs(form.headers)
    if (Object.keys(headers).length) cfg.headers = headers
  }
  return cfg
}

function McpTab(props: { ctx: CliContext; sessionId?: string; servers: McpServerConfig[]; selected: number }) {
  const sid = props.sessionId
  // Memoized: does a per-server `existsSync` scope check; keep it off the
  // per-render-read path (see DataTable's `widths` note).
  const cells = createMemo((): Cell[][] =>
    props.servers.map((s) => [
      { text: s.name },
      { text: s.transport },
      { text: s.riskTier ?? "—", color: theme.muted },
      { text: sid && existsSync(join(props.ctx.paths.sessionMcp(sid), `${s.name}.json`)) ? "session" : "global" },
      { text: s.enabled ? "● 启用" : "⊘ 已停用", color: s.enabled ? theme.success : theme.muted },
    ]),
  )
  return (
    <box flexDirection="column">
      <text fg={theme.muted}>作用域: {sid ? `${sid.slice(0, 8)}（global + session）` : "global"}</text>
      <DataTable headers={["name", "transport", "risk", "scope", "状态"]} rows={cells()} selected={props.selected} />
    </box>
  )
}

/** Add/edit overlay for an MCP server (§9.3): one field per row, navigable with
 * ↑↓, text typed inline, enum/bool toggled with ←→, ↵ saves, Esc cancels. */
function McpFormOverlay(props: { form: McpForm; fields: McpField[] }) {
  const f = () => props.form
  const activeIdx = () => Math.min(f().fieldIdx, props.fields.length - 1)
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.accent} paddingLeft={1} paddingRight={1} marginTop={1}>
      <text fg={theme.accent}>{f().original ? `编辑 MCP — ${f().original}` : "新增 MCP Server"}</text>
      <For each={props.fields}>
        {(field, i) => {
          const active = () => i() === activeIdx()
          return (
            <text bg={active() ? theme.panel : undefined}>
              {active() ? "▸ " : "  "}
              {padEnd(field.label, 10)}
              <Show when={field.kind === "bool"}>
                <span style={{ fg: f().enabled ? theme.success : theme.muted }}>{f().enabled ? "✓ 是" : "✗ 否"}</span>
              </Show>
              <Show when={field.kind === "enum"}>
                <span style={{ fg: theme.accent }}>‹ {mcpEnumValue(f(), field.key as "transport" | "riskTier" | "scope") || "—"} ›</span>
              </Show>
              <Show when={field.kind === "text"}>
                <span>{f()[field.key as McpTextKey]}</span>
                <Show when={active()}>
                  <span style={{ fg: theme.accent }}>▌</span>
                </Show>
                <Show when={!f()[field.key as McpTextKey] && field.kind === "text" && field.hint}>
                  <span style={{ fg: theme.muted }}> {field.kind === "text" ? field.hint : ""}</span>
                </Show>
              </Show>
            </text>
          )
        }}
      </For>
      <Show when={f().error}>
        <text fg={theme.danger}>✗ {f().error}</text>
      </Show>
      <text fg={theme.muted}>↑↓ 选字段 · ←→ 切换 · 输入编辑 · ↵ 保存 · Esc 取消</text>
    </box>
  )
}

function mcpEnumValue(form: McpForm, key: "transport" | "riskTier" | "scope"): string {
  if (key === "transport") return form.transport
  if (key === "scope") return form.scope
  return form.riskTier
}

function SkillsTab(props: { ctx: CliContext; sessionId?: string }) {
  const sid = props.sessionId
  // Memoized: enumerates skills from disk + a per-skill `existsSync`; keep it off
  // the per-render-read path (see DataTable's `widths` note).
  const cells = createMemo((): Cell[][] =>
    props.ctx.skillsForScope(sid).map((s) => [
      { text: s.name },
      { text: truncateW(s.description, 36), color: theme.muted },
      { text: (s.allowedTools ?? []).join("·") || "—", color: theme.muted },
      { text: s.disableModelInvocation ? "手动*" : "自动", color: s.disableModelInvocation ? theme.warning : undefined },
      { text: sid && existsSync(join(props.ctx.paths.sessionSkills(sid), s.name)) ? "session" : "global" },
    ]),
  )
  return (
    <box flexDirection="column">
      <text fg={theme.muted}>作用域: {sid ? `${sid.slice(0, 8)}（global + session）` : "global"}</text>
      <DataTable headers={["name", "description", "tools", "调用", "scope"]} rows={cells()} />
    </box>
  )
}

function ConfigTab(props: { eff: ReturnType<CliContext["config"]["effective"]> }) {
  const eff = () => props.eff
  return (
    <box flexDirection="column">
      <text>
        {padEnd("orchestrator", 16)}
        {eff().orchestratorAlias}
      </text>
      <text>
        {padEnd("sandbox", 16)}
        <Show when={eff().sandboxEnabled} fallback={<span style={{ fg: theme.danger }}>✗ 已关闭</span>}>
          <span style={{ fg: theme.success }}>✓ 启用</span>
        </Show>
      </text>
      <text>
        {padEnd("sandbox 网络", 16)}
        <Show when={eff().sandboxNetwork === false} fallback={<span style={{ fg: theme.success }}>✓ 开启</span>}>
          <span style={{ fg: theme.warning }}>✗ 已关闭（子进程无网络）</span>
        </Show>
      </text>
      <text>
        {padEnd("执行模式默认", 16)}
        <Show when={eff().executionMode === "full"} fallback={<span style={{ fg: theme.muted }}>{eff().executionMode}</span>}>
          <span style={{ fg: theme.warning }}>⚡ full（边界关闭·仅提权/高危删除）</span>
        </Show>
      </text>
      <text>
        {padEnd("compactRatio", 16)}
        {String(eff().compactRatio)}
      </text>
      <text>
        {padEnd("maxDepth", 16)}
        {String(eff().maxDepth)}
      </text>
      <text>
        {padEnd("maxConcurrency", 16)}
        {String(eff().maxConcurrency)}
      </text>
      <text>
        {padEnd("maxSteps", 16)}
        {String(eff().maxSteps)}
      </text>
      <text>
        {padEnd("动态子Agent", 16)}
        {eff().dynamicSubAgents.enabled
          ? `✓ caps=[${eff().dynamicSubAgents.maxCapabilities.join(",")}]`
          : "✗ 关闭"}
      </text>
      <Show when={!eff().sandboxEnabled}>
        <text fg={theme.warning}>⚠ 沙箱已关闭——工具写/执行不受 landstrip 边界保护（agent §4.1）</text>
      </Show>
    </box>
  )
}

