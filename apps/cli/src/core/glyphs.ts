/**
 * Status glyphs and tool-input summaries (§1.3). Kept render-agnostic so the
 * Ink trace tree (§3) and the headless line printer (§11.1) speak the same
 * visual language. Glyphs carry the primary meaning — colour is only a
 * redundant reinforcement, so output stays legible under `NO_COLOR` (§1.2).
 */
import type { ToolStatus, ToolItem } from './trace.js';

/** Tool-family glyph by tool name (agent §3.1 / §3.5). */
export function toolGlyph(toolName: string): string {
  if (toolName.startsWith('mcp__')) return '🔌';
  switch (toolName) {
    case 'writeFile':
    case 'applyPatch':
      return '✎';
    case 'runCommand':
      return '⚙';
    case 'httpFetch':
    case 'webSearch':
      return '↗';
    case 'readFile':
    case 'listDir':
    case 'search':
      return '🔍';
    case 'updateTodos':
      return '📋';
    default:
      return '•';
  }
}

/** Status glyph for a tool node (§1.3). */
export function statusGlyph(status: ToolStatus): string {
  switch (status) {
    case 'running':
      return '⏳';
    case 'ok':
      return '✓';
    case 'error':
      return '✗';
    case 'approval':
      return '⏸';
    case 'question':
      return '?';
  }
}

/** A one-line summary of a tool's salient input argument (§3.1). */
export function summarizeInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return input == null ? '' : String(input);
  const o = input as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  switch (toolName) {
    case 'readFile':
    case 'writeFile':
    case 'applyPatch':
    case 'listDir':
      return pick('path') ?? pick('file') ?? '';
    case 'runCommand':
      return pick('command') ?? pick('cmd') ?? joinArgs(o['args']) ?? '';
    case 'httpFetch':
      return hostOf(pick('url'));
    case 'webSearch':
    case 'search':
      return pick('query') ?? pick('q') ?? '';
    default: {
      const s = pick('path') ?? pick('query') ?? pick('command') ?? pick('url');
      return s ?? truncate(JSON.stringify(o), 48);
    }
  }
}

/** A short summary of a tool result for the collapsed row (§3.1). */
export function summarizeOutput(tool: ToolItem): string {
  const out = tool.output;
  if (out == null) return '';
  if (typeof out === 'string') return firstLine(out, 60);
  if (typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (typeof o['added'] === 'number' || typeof o['removed'] === 'number') {
      return `+${o['added'] ?? 0} −${o['removed'] ?? 0}`;
    }
    if (typeof o['lines'] === 'number') return `${o['lines']} 行`;
    if (typeof o['summary'] === 'string') return firstLine(o['summary'] as string, 60);
  }
  return truncate(JSON.stringify(out), 60);
}

function joinArgs(args: unknown): string | undefined {
  return Array.isArray(args) ? args.map(String).join(' ') : undefined;
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function firstLine(s: string, max: number): string {
  const line = s.split('\n', 1)[0] ?? '';
  return truncate(line, max);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
