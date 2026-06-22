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
| `doc-coauthoring` | unspecified upstream (no `LICENSE.txt`) | governed by the [anthropics/skills](https://github.com/anthropics/skills) repo terms |
| `docx` | **Anthropic proprietary** (© 2025 Anthropic, PBC — source-available, *not* open source) | see `docx/LICENSE.txt` |
| `pdf` | **Anthropic proprietary** | see `pdf/LICENSE.txt` |
| `pptx` | **Anthropic proprietary** | see `pptx/LICENSE.txt` |
| `xlsx` | **Anthropic proprietary** | see `xlsx/LICENSE.txt` |

> The four document skills (`docx`, `pdf`, `pptx`, `xlsx`) are **source-available
> under Anthropic's terms, not open source** — use is governed by your agreement
> with Anthropic. Keep their `LICENSE.txt` intact and review the terms before
> redistribution.

`canvas-design` (bundles ~5.5 MB of `.ttf` fonts), `mcp-builder`, and
`skill-creator` from the upstream set are intentionally **excluded** — the agent
ships only the document and design/authoring skills.

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
- **Python via `uv`** — the document skills' bundled `scripts/*.py` are run with
  `uv run` and declare their dependencies inline (PEP 723); `uv` provisions a
  managed, shared environment on first run, so there is no `pip install` step
  (which avoids PEP 668 errors on externally-managed Pythons). Ad-hoc snippets
  use `uv run --with <pkg>`, and `markitdown` runs via `uvx`.

Other instructions and references stay close to upstream. The document skills'
Python invocations were migrated to `uv` (PEP 723 headers on `scripts/*.py`,
`uv run`/`uvx` in the docs), so those scripts are no longer byte-identical to
`anthropics/skills`.

## Runtime dependencies

The document skills shell out to Python via [`uv`](https://docs.astral.sh/uv/)
(`runCommand`). Each bundled `scripts/*.py` carries an inline PEP 723 dependency
block, so `uv run scripts/…` resolves and caches its libraries automatically on
first run — **no `pip install`, no virtualenv to manage, and PEP 668 never bites.**
The only hard requirement is that **`uv` is on PATH**.

### Installing uv

If `uv` is missing (e.g. `uv: command not found` / `command not found: uv`),
install it once — it is a single self-contained binary, no Python required:

```sh
# macOS / Linux — standalone installer (recommended)
curl -LsSf https://astral.sh/uv/install.sh | sh

# macOS / Linux — Homebrew
brew install uv

# Windows — PowerShell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Any platform that already has pipx or pip
pipx install uv      # or:  pip install uv
```

The standalone installer drops `uv` in `~/.local/bin` (or `~/.cargo/bin`); open a
new shell or `source` your profile so it lands on `PATH`. Verify with `uv --version`,
and update later with `uv self update`. Full docs: <https://docs.astral.sh/uv/getting-started/installation/>.

Python packages pulled in on demand (listed for reference — you do **not**
install these by hand):

- `pdf` → `pypdf`, `pdfplumber`, `pdf2image`, `Pillow`; inline snippets may also
  use `reportlab`/`pandas` and OCR (`pytesseract` + `pdf2image`) via `uv run --with …`
- `docx` → `defusedxml`, `lxml`
- `pptx` → `defusedxml`, `lxml`, `Pillow`; `markitdown` via `uvx --from 'markitdown[pptx]' markitdown`
- `xlsx` → `openpyxl`, `defusedxml`, `lxml`

Non-Python system tools still need to be present where used: LibreOffice
(`soffice`), Poppler (`pdftoppm`/`pdftotext`), `pandoc`, Node/`npm` (docx-js,
pptxgenjs), and `tesseract` (OCR).

## Installing

The agent discovers skills from its skill roots: the global
`~/.enterprise-agent/skills/` (or `$ENTERPRISE_AGENT_HOME/skills`, or
`<--root>/skills` when the gateway runs with a custom `--root`) and
per-workspace/session `skills/` dirs (see `loader.ts`). **Restart the
agent/gateway** after installing so they're picked up.

Use the installer (copies a bundled skill into the active skill root):

```sh
pnpm skills:install --list           # list bundled skills
pnpm skills:install --all            # install all into ~/.enterprise-agent/skills
pnpm skills:install pdf docx xlsx    # install specific ones
pnpm skills:install --all --force    # overwrite existing
pnpm skills:install pdf --root /srv/agent   # into <root>/skills (custom gateway root)
pnpm skills:install pdf --dest /tmp/skills  # explicit destination dir
```

(equivalently `node scripts/install-skills.mjs …`). Or copy a folder by hand
(`cp -R skills/pdf ~/.enterprise-agent/skills/pdf`).

**From the gateway Web panel** (Skills tab → "Built-in skills"): these skills
ship inside the gateway package (copied to `dist/skills/` at build), so a
packaged/installed gateway can install them with one click — no source tree
needed. Or upload any skill as a zip.
