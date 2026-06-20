/**
 * Sidebar projection (cli-ui §7): derive the right-hand panel's three sections
 * from the trace — Tasks (the plan), Artifacts (files the session generated),
 * and References (local files read + web links / MCP tools touched). Pure
 * function over `TraceState.tools`, so it stays in sync with the trace and is
 * trivially testable.
 */
import type { TraceState } from './trace.js';
import { summarizeInput } from './glyphs.js';

export interface SidebarData {
  /** Files the session created/edited (writeFile / applyPatch). */
  artifacts: string[];
  /** Local files read or searched (readFile / listDir / search). */
  files: string[];
  /** External references touched: web fetches / searches / MCP tools. */
  links: string[];
}

function hostOrText(arg: string): string {
  try {
    return new URL(arg).host || arg;
  } catch {
    return arg;
  }
}

/** Collect artifacts + references from every tool call in the trace (chronological). */
export function collectSidebar(state: TraceState): SidebarData {
  const artifacts: string[] = [];
  const files: string[] = [];
  const links: string[] = [];
  const push = (list: string[], v: string): void => {
    if (v && !list.includes(v)) list.push(v);
  };
  for (const t of state.tools.values()) {
    const arg = summarizeInput(t.toolName, t.input).trim();
    if (t.toolName === 'writeFile' || t.toolName === 'applyPatch') push(artifacts, arg);
    else if (t.toolName === 'readFile' || t.toolName === 'listDir' || t.toolName === 'search') push(files, arg);
    else if (t.toolName === 'httpFetch') push(links, hostOrText(arg));
    else if (t.toolName === 'webSearch') push(links, arg);
    else if (t.toolName.startsWith('mcp__')) push(links, t.toolName.replace(/^mcp__/, '').replace('__', '/'));
  }
  return { artifacts, files, links };
}
