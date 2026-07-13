/**
 * Headless renderers (cli §11). Both consume the same `AgentStreamEvent`
 * stream the TUI does; they differ only in the back-end — a human-readable
 * line printer to stderr (§11.1) vs raw JSON Lines to stdout (§11.2). The final
 * assistant text / `report` payload always goes to **stdout** so `$(ea run …)`
 * captures just the result, with the trace on stderr.
 */
import type { AgentStreamEvent } from '@dami-sg/agent-contract';
import { color } from '../core/color.js';
import { fmtTok } from '../core/trace.js';
import { statusGlyph, summarizeInput, summarizeOutput, toolGlyph } from '../core/glyphs.js';
import type { ToolItem } from '../core/trace.js';

export interface Renderer {
  onEvent(e: AgentStreamEvent): void;
  /** Print the terminal summary line + the captured final text to stdout. */
  finish(): void;
  /** The captured final assistant text (for `-q`). */
  finalText(): string;
}

interface LineOptions {
  quiet: boolean;
}

/** Human-readable streaming printer (§11.1). */
export class LineRenderer implements Renderer {
  private rootAgentId: string | undefined;
  private readonly depth = new Map<string, number>();
  private readonly tools = new Map<string, ToolItem>();
  private steps = 0;
  private tokens = 0;
  private cost = 0;
  private finalBuf = '';
  private reasonBuf = '';
  private failed = false;
  private message = '';

  constructor(private readonly opts: LineOptions) {}

  onEvent(e: AgentStreamEvent): void {
    switch (e.kind) {
      case 'text-delta':
        if (!this.rootAgentId) this.rootAgentId = e.agentId;
        if (e.agentId === this.rootAgentId) this.finalBuf += e.text;
        break;

      case 'reasoning-delta':
        // Thinking (agent §2.2) → dim, line-buffered to stderr (§11.1). Kept off
        // stdout so `$(ea run …)` still captures only the final answer.
        if (!this.opts.quiet) this.streamReasoning(e.text);
        break;

      case 'tool-call':
        this.tools.set(e.toolCallId, {
          kind: 'tool',
          toolCallId: e.toolCallId,
          agentId: e.agentId,
          toolName: e.toolName,
          input: e.input,
          status: 'running',
        });
        break;

      case 'tool-result': {
        const tool = this.tools.get(e.toolCallId);
        if (tool) {
          tool.output = e.output;
          tool.isError = e.isError;
          tool.status = e.isError ? 'error' : 'ok';
          if (!this.opts.quiet) this.printTool(tool);
        }
        break;
      }

      case 'tool-approval-required':
        if (!this.opts.quiet) {
          const indent = '  '.repeat((this.depth.get(e.agentId) ?? 0) + 1);
          this.err(
            `${indent}${toolGlyph(e.toolName)} ${e.toolName} ${color.muted(summarizeInput(e.toolName, e.input))} ` +
              color.warning('⏸ 需要审批'),
          );
        }
        break;

      case 'sub-agent-start': {
        const d = (this.depth.get(e.parentAgentId) ?? 0) + 1;
        this.depth.set(e.agentId, d);
        if (!this.opts.quiet) this.err(`${'  '.repeat(d)}${color.accent('▸')} Sub#${e.role}`);
        break;
      }

      case 'sub-agent-finish':
        if (!this.opts.quiet) {
          const d = this.depth.get(e.agentId) ?? 1;
          this.err(`${'  '.repeat(d)}${color.success('✓')} ${color.muted(e.summary)}`);
        }
        break;

      case 'step-finish':
        this.steps += 1;
        break;

      case 'usage':
        this.tokens = e.totalUsage.totalTokens;
        this.cost = e.cost;
        break;

      case 'compaction-end':
        if (!this.opts.quiet) {
          this.err(color.muted(`  ⟲ 已压缩 ${fmtTok(e.tokensBefore)} → ${fmtTok(e.tokensAfter)} tok`));
        }
        break;

      case 'run-finish':
        this.message = `完成 · ${this.steps} 步 · ${fmtTok(this.tokens)} tok · $${this.cost.toFixed(3)}`;
        break;

      case 'error':
        if (e.runId === 'mcp') {
          if (!this.opts.quiet) this.err(color.warning(`  🔌 MCP: ${e.message}`));
        } else if (e.runId === 'sandbox') {
          if (!this.opts.quiet) this.err(color.warning(`  ⚠ ${e.message}`));
        } else {
          this.failed = true;
          this.message = e.message;
        }
        break;
    }
  }

  /** Buffer reasoning deltas and emit complete lines dimmed with a `✻` marker. */
  private streamReasoning(text: string): void {
    this.reasonBuf += text;
    let nl: number;
    while ((nl = this.reasonBuf.indexOf('\n')) !== -1) {
      const line = this.reasonBuf.slice(0, nl);
      this.reasonBuf = this.reasonBuf.slice(nl + 1);
      if (line.trim()) this.err(color.muted(`  ✻ ${line.trim()}`));
    }
  }

  private flushReasoning(): void {
    if (this.reasonBuf.trim()) this.err(color.muted(`  ✻ ${this.reasonBuf.trim()}`));
    this.reasonBuf = '';
  }

  private printTool(tool: ToolItem): void {
    const indent = '  '.repeat((this.depth.get(tool.agentId) ?? 0) + 1);
    const g = tool.isError ? color.danger(statusGlyph('error')) : color.success(statusGlyph('ok'));
    const input = color.muted(summarizeInput(tool.toolName, tool.input));
    const out = summarizeOutput(tool);
    this.err(`${indent}${toolGlyph(tool.toolName)} ${tool.toolName} ${input} ${g}${out ? ' ' + color.muted(out) : ''}`);
  }

  finish(): void {
    this.flushReasoning();
    if (this.failed) this.err(color.danger(`✗ ${this.message}`));
    else if (this.message) this.err(color.success(`✓ ${this.message}`));
    const text = this.finalBuf.trim();
    if (text) process.stdout.write(text + '\n');
  }

  finalText(): string {
    return this.finalBuf.trim();
  }

  private err(line: string): void {
    process.stderr.write(line + '\n');
  }
}

/** Raw JSON Lines printer (§11.2) — the contract is the schema. */
export class JsonRenderer implements Renderer {
  private finalBuf = '';
  private rootAgentId: string | undefined;

  onEvent(e: AgentStreamEvent): void {
    if (e.kind === 'text-delta') {
      if (!this.rootAgentId) this.rootAgentId = e.agentId;
      if (e.agentId === this.rootAgentId) this.finalBuf += e.text;
    }
    process.stdout.write(JSON.stringify(e) + '\n');
  }

  finish(): void {
    /* events already streamed */
  }

  finalText(): string {
    return this.finalBuf.trim();
  }
}
