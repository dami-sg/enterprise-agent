# Technical Debt Audit — enterprise-agent

_Date: 2026-07-08 · Scope: full monorepo (apps/cli, apps/gateway, packages/agent, agent-client, agent-contract, agent-server) · ~24.5k source LOC, 249 source files, 67 test files._

## Headline

This is a well-disciplined codebase: 0 TODO/FIXME markers, only 4 `any` types, 1 `@ts-ignore`, spec-anchored comments throughout. The debt is **not** sloppiness — it is (1) missing automated enforcement, (2) a few very large god-files/functions, (3) invariants held together by copy-paste, and (4) docs describing features that aren't shipped. The single most important gap is that **the test suite exists but nothing runs it.**

Priority score = (Impact + Risk) × (6 − Effort), each rated 1–5. Higher = do sooner.

## Prioritized debt register

| # | Item | Category | Impact | Risk | Effort | **Priority** | Severity |
|---|------|----------|:---:|:---:|:---:|:---:|---|
| 1 | No CI gate — tests/typecheck never run on push/PR | Infrastructure | 4 | 5 | 2 | **36** | Critical |
| 2 | Weak hand-rolled `safeEqual` in CLI (timing/length leak) | Code / Security | 2 | 4 | 1 | **30** | High |
| 3 | Cross-package duplicated invariants (`isLocalBase`, key-ref, sanitizers) | Architecture | 3 | 4 | 2 | **28** | High |
| 4 | No linter / formatter config anywhere | Infrastructure | 3 | 3 | 2 | **24** | Medium |
| 5 | ~~Docs describe memory as shipped~~ — verified accurate; see note | Documentation | 1 | 1 | 1 | **10** | Low |
| 6 | God-methods: `sub-agent.execute` (345 lines), `session.drive` (177) | Code | 4 | 3 | 3 | **21** | Medium |
| 7 | Zero tests in `agent-contract`; core storage/mcp untested | Test | 3 | 4 | 3 | **21** | Medium |
| 8 | WhatsApp advertised in admin but adapter only throws | Architecture | 2 | 2 | 1 | **20** | Medium |
| 9 | ~~Stale `specs/web-app.md`~~ — already banner-marked removed; see note | Documentation | 1 | 1 | 1 | **10** | Low |
| 10 | `dispatcher.ts` god-class (1321 lines, mixes routing + FS I/O + HTTP) | Architecture | 5 | 3 | 4 | **16** | Strategic |
| 11 | `apps/cli` weakest tested (0.25 test ratio) | Test | 2 | 3 | 3 | **15** | Low |
| 12 | Stateless admin cookie, no expiry/rotation | Security | 2 | 3 | 3 | **15** | Low |
| 13 | No `engines`/Node pin in sub-package manifests | Infrastructure | 1 | 2 | 1 | **15** | Low |

## Findings in detail

### 1. No CI gate on tests or typecheck — _Critical_

The only workflow is `.github/workflows/release-binaries.yml`, which triggers on `release: published` and only cross-builds the `ea` binary. Every package defines `test` (`vitest run`) and `typecheck` (`tsc --noEmit`) scripts, and there are 67 test files — but nothing runs them automatically on a branch or PR. Regressions and type errors can merge undetected; the 67 tests provide false confidence because they're only run when someone remembers to run them locally. **Fix:** a `ci.yml` running `pnpm -r typecheck && pnpm -r test` on push/PR. Effort: ~half a day.

### 2. Weaker hand-rolled `safeEqual` in the CLI — _High_

`apps/cli/src/commands/serve.ts:177` implements token comparison with a hand-rolled XOR loop that early-returns on length mismatch (`if (a.length !== b.length) return false`) — leaking length and short-circuiting. `apps/gateway/src/accounts/admin-auth.ts:71` does the same job correctly with `crypto.timingSafeEqual`. Two security primitives, two behaviors, and the CLI's is the weaker one. **Fix:** delete the CLI copy, import the gateway's. Effort: trivial. This is the highest-ROI item on the board.

### 3. Cross-package duplicated invariants — _High_

Several conventions are enforced by copy-paste rather than a shared export, so drift silently breaks things:

- `isLocalBase()` is byte-for-byte duplicated in `apps/cli/src/core/provider.ts:16` and `apps/gateway/src/web/admin.ts:66`.
- The provider secret key-ref convention `${id}.key` is reimplemented as `keyRefFor` (CLI) and `providerKeyRef` (gateway) — the gateway comment literally says "matches the CLI." If one changes, stored secrets orphan silently.
- Path/filename sanitizers are scattered and inconsistent: `safeFileName`/`safeConvSegment` (dispatcher), `sanitizeName` (sub-agent), `assertSafeServerName` (config store), `assertSafePath` (unzip), and an inline regex in keychain — all guarding the same injection class with no shared util.

**Fix:** hoist these into a shared `packages/agent` utils module; import from CLI + gateway. Effort: ~1 day.

### 4. No linter or formatter — _Medium_

No ESLint, Prettier, or Biome config exists. The code is clean today by author discipline, but nothing prevents the next contributor from regressing style, reintroducing `any`, or leaving an unused import. **Fix:** add Biome (fastest single-tool option) with `check` wired into the CI from item 1. Effort: ~half a day.

### 5. Memory docs — _Low (verified accurate, no change needed)_

**Correction after verification:** the original finding overstated this. The memory docs are honest about backend status: `memory/index.ts` states in its header that mem0 is DEFERRED and the default backend is `none`; `specs/cross-channel-memory.md` is banner-marked "设计提案（draft）" with §1 titled "现状盘点：契约完整，后端为空" (contract complete, backend empty); `specs/memory-architecture.md` explicitly scopes engines out ("具体记忆引擎…不在本文档范围"); and the README only references the memory spec once, in the spec index, without advertising it as a shipped capability. The only near-miss is the §0 decision table listing mem0 as the "默认实现" — but that table is labelled "决策摘要（已拍板）" (design decisions), and the surrounding draft/"backend empty" context makes it clear this is intent, not current state. **Recommendation:** no doc change; implementing a durable backend remains a feature, not debt.

### 6. God-methods — _Medium_

`packages/agent/src/runtime/sub-agent.ts:113` — the `execute` closure is ~345 lines mixing capability convergence, timeout wiring, audit emission, streaming, LLM-judge evaluation, usage accounting, persistence, and three distinct error-recovery paths. `packages/agent/src/runtime/session.ts:243` — `drive()` is ~177 lines with 5+ nested closures plus inline overflow-retry. These are the hardest functions in the repo to change safely. **Fix:** extract named helpers (timeout handling, evaluation, usage flush). Effort: ~1–2 days each, best done incrementally.

### 7. Test coverage gaps in core — _Medium_

`packages/agent-contract` has **zero** test files across 8 source files carrying runtime constants/shapes (`commands.ts`, `protocol.ts`, `events.ts`, `usage.ts`) that the whole system depends on. Core runtime/persistence primitives are also untested: `orchestrator.ts`, `mcp/client.ts`, `storage/run-store.ts`, `storage/audit-store.ts`, `storage/registry-store.ts`. **Fix:** contract shape tests + storage round-trip tests. Effort: ~2–3 days.

| package | src | test | ratio |
|---|:---:|:---:|:---:|
| packages/agent | 65 | 30 | 0.46 |
| apps/gateway | 66 | 28 | 0.42 |
| agent-client | 3 | 1 | 0.33 |
| apps/cli | 28 | 7 | 0.25 |
| agent-server | 4 | 1 | 0.25 |
| **agent-contract** | 8 | **0** | **0.00** |

### 8. WhatsApp config/runtime mismatch — _Medium_

`apps/gateway/src/web/admin.ts:45` lists `'whatsapp'` in `CHANNEL_NAMES`, so the admin panel accepts and persists a WhatsApp channel — but the adapter is a throw-only placeholder that fails at `start()`. Config surface and runtime capability disagree. **Fix:** remove from `CHANNEL_NAMES` (or gate it behind a feature flag) until implemented. Effort: trivial.

### 9. web-app spec — _Low (mostly already handled)_

**Correction after verification:** `specs/web-app.md` already carries a prominent deprecation banner ("已废弃/已移除 2026-07 … 以下内容仅作历史设计存档"), so the original "stale doc" finding was overstated. The residual issue is coherence, not staleness: several *active* specs (`cross-channel-memory.md`, `app-server.md`) still link to the deprecated doc as the authoritative home of the account/identity layer — which is now shipped in `apps/gateway/src/accounts/*`. Deleting or relocating the file would break 8 cross-references across 4 specs. **Recommendation:** leave the file in place; when convenient, lift the account/identity design section into a live spec (e.g. `gateway-architecture.md`) and repoint the links. Not a quick win — deferred.

### 10. `dispatcher.ts` god-class — _Strategic (high impact, high effort)_

`apps/gateway/src/runtime/dispatcher.ts` is 1321 lines and owns inbound routing, the IM bind/auth gate, slash-command handling, approval/question/plan UI orchestration, attachment ingestion **with direct filesystem writes** (`writeFileSync`/`mkdirSync`, 4 sites), STT invocation, memory-governance commands, and schedule delivery. Business logic, filesystem I/O, and channel presentation live in one class — the single highest-risk file to modify. It scores lower on the raw formula only because the effort is large; treat it as a **strategic** multi-sprint decomposition (extract `AttachmentIngestor`, `ImAccessGate`, `CommandRouter`), not a quick win.

### 11–13. Lower-priority items

`apps/cli` is the weakest-tested area (interactive/render code, partly justified, but `commands/config.ts` and `commands/provider.ts` logic are untested). The admin cookie (`admin-auth.ts`, `sha256(secret + '|ea-admin')`) is stateless with no expiry/rotation — a captured cookie is valid until the secret changes. Sub-package manifests lack `engines` pins (only the root pins Node ≥22.13), so a contributor on an older Node gets no guardrail.

## Phased remediation plan

Designed to run **alongside feature work** — Phase 1 is pure infra with no product risk and unblocks everything else.

**Phase 1 — Safety net (½ sprint, do first).** Items 1, 2, 4, 8, 9. Add a CI workflow running typecheck + tests on every PR; add Biome; delete the weak CLI `safeEqual` and the WhatsApp channel entry; archive the stale web-app spec. These are almost all trivial-to-small and immediately stop new debt from landing. _Outcome: every subsequent change is now verified automatically._

**Phase 2 — Kill the copy-paste + doc truth (½ sprint).** Items 3, 5, 13. Hoist shared utils (`isLocalBase`, provider key-ref, path sanitizers) into `packages/agent` and import everywhere; reconcile memory docs to reflect mock-only reality; add `engines` pins. _Outcome: security/config invariants enforced by the compiler, not by convention._

**Phase 3 — Test the core (1 sprint).** Item 7. Add contract shape tests and storage round-trip tests, then backfill `mcp/client.ts` and `orchestrator.ts`. Best done now that CI (Phase 1) will actually enforce them. _Outcome: the runtime primitives everything depends on are regression-guarded._

**Phase 4 — Decompose god-code (ongoing, opportunistic).** Items 6, 10. Break up `sub-agent.execute` and `session.drive` into named helpers as you touch them; scope the `dispatcher.ts` decomposition as its own tracked effort with tests written first. Do this incrementally, never as a big-bang rewrite. _Outcome: the two riskiest change-surfaces become safe to modify._

**Deferred / accept-for-now.** Admin cookie hardening (item 12) — revisit if the admin panel is exposed beyond localhost. WeChat AES-128-ECB and Telegram token-in-URL are protocol-mandated, not debt.
