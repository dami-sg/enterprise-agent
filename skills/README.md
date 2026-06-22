# Vendored Agent Skills

A curated set of [Agent Skills](https://agentskills.io) vendored into this repo
for our agent. Each skill is a folder with a `SKILL.md` (YAML frontmatter +
instructions) plus optional `scripts/`, `references/`, and assets — the same
standard our loader (`packages/agent/src/skills/loader.ts`) discovers.

These are **source-only**: they are not auto-discovered by the agent. To use
them, place a skill folder under a skill root (see [Installing](#installing)).

## Provenance

Vendored from **[anthropics/skills](https://github.com/anthropics/skills)** at
commit `5754626` (2026-06-09). Each skill keeps its upstream `LICENSE.txt`.

| Skill | Upstream license | Notes |
| --- | --- | --- |
| `brand-guidelines` | Apache-2.0 | |
| `frontend-design` | Apache-2.0 | |
| `mcp-builder` | Apache-2.0 | scripts + reference docs |
| `skill-creator` | Apache-2.0 | some steps need the `claude` CLI (skipped here) |
| `doc-coauthoring` | unspecified upstream (no `LICENSE.txt`) | governed by the [anthropics/skills](https://github.com/anthropics/skills) repo terms |
| `docx` | **Anthropic proprietary** (© 2025 Anthropic, PBC — source-available, *not* open source) | see `docx/LICENSE.txt` |
| `pdf` | **Anthropic proprietary** | see `pdf/LICENSE.txt` |
| `pptx` | **Anthropic proprietary** | see `pptx/LICENSE.txt` |
| `xlsx` | **Anthropic proprietary** | see `xlsx/LICENSE.txt` |

> The four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are **source-available
> under Anthropic's terms, not open source** — use is governed by your agreement
> with Anthropic. Keep their `LICENSE.txt` intact and review the terms before
> redistribution.

`canvas-design` from the upstream set was intentionally **excluded** (it bundles
~5.5 MB of `.ttf` fonts).

## Adaptation for this agent

Upstream skills were written for Claude Code / claude.ai. Each `SKILL.md` here
carries a short banner mapping that runtime onto ours; the substantive changes:

- **Tool names** — Read→`readFile`, Write→`writeFile`, Edit / string-replace→`applyPatch`,
  Bash / shell→`runCommand`, Grep→`search`, Glob / LS→`listDir`, web fetch→`http`.
  Literal "Edit tool" instructions in `docx`/`pptx` were rewritten to `applyPatch`.
- **No artifacts** — outputs go to the session working directory (files), not
  claude.ai artifacts.
- **Sub-agents** — available via `delegateToSubAgent` (the "if sub-agents are
  available" branches apply).
- **`claude` CLI / Claude Code-only steps** (e.g. `skill-creator` description
  optimization, the eval viewer hand-off) — skip; they aren't available here.

Everything else (instructions, `scripts/`, references) is upstream-verbatim so
the skills stay diffable against `anthropics/skills`.

## Runtime dependencies

The document/script skills shell out to Python 3 (`runCommand`). Install the
libraries they use as needed:

- `pdf` → `pypdf`, `pdfplumber`, `reportlab`, `pytesseract` + `Pillow` (OCR)
- `docx` → `python-docx`, `markitdown`
- `pptx` → `python-pptx`, `markitdown`
- `xlsx` → `openpyxl`, `pandas`
- `mcp-builder`, `skill-creator` → see each skill's `scripts/`

## Installing

The agent discovers skills from its skill roots: the global
`~/.enterprise-agent/skills/` and per-workspace/session `skills/` dirs (see
`loader.ts`). To enable one, copy its folder into a root, e.g.:

```sh
cp -R skills/pdf ~/.enterprise-agent/skills/pdf
```

Or upload the folder as a zip from the gateway Web panel (Skills tab).
