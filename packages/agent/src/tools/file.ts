/**
 * File tools (agent §3.1). Read-only tools run ungated; write tools go through
 * the approval gate with a directory-prefix grant key (agent §3.3). All paths
 * are boundary-checked (agent §4).
 */
import { tool } from 'ai';
import { z } from 'zod';
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname, relative, isAbsolute, normalize, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { RunContext } from '../runtime/context.js';
import { guardPath, dirPrefix, PathBoundaryError } from './path-guard.js';
import { writeFileNoFollow } from '../util/fs.js';
import { gated } from './gate.js';
import { enforceMode } from './mode.js';

const MAX_READ_BYTES = 256 * 1024;

export function buildFileTools(ctx: RunContext) {
  const roots = ctx.shared.rootPaths;

  /**
   * Resolve a path within the boundary, returning a STRUCTURED error instead of
   * throwing on an out-of-boundary path. A thrown PathBoundaryError would bubble
   * as an opaque tool failure (and could crash a sub-agent into "no output");
   * a clean `{ error: 'out_of_boundary' }` lets the agent read the boundary and
   * retry inside it (agent §4).
   */
  const guard = (p: string): { abs: string } | { error: 'out_of_boundary'; path: string; roots: string[] } => {
    // Full mode disables the workspace boundary guardrail (see docs/full-mode.md):
    // resolve the path but skip the within-roots check, so file tools may read /
    // write anywhere on disk. The OS sandbox (landstrip), if enabled, remains an
    // independent hard floor.
    if (ctx.shared.executionMode?.value === 'full') {
      return { abs: isAbsolute(p) ? normalize(p) : resolve(roots[0]!, p) };
    }
    try {
      return { abs: guardPath(p, roots) };
    } catch (e) {
      if (e instanceof PathBoundaryError) return { error: 'out_of_boundary', path: e.attempted, roots };
      throw e;
    }
  };

  const readFile = tool({
    description: 'Read a UTF-8 text file within the workspace boundary.',
    inputSchema: z.object({
      path: z.string().describe('File path, absolute or relative to the root.'),
    }),
    execute: async ({ path }) => {
      const g = guard(path);
      if ('error' in g) return g;
      const abs = g.abs;
      if (!existsSync(abs)) return { error: 'not_found', path: abs };
      const raw = readFileSync(abs);
      const truncated = raw.byteLength > MAX_READ_BYTES;
      return {
        path: abs,
        content: raw.subarray(0, MAX_READ_BYTES).toString('utf8'),
        truncated,
        bytes: raw.byteLength,
      };
    },
  });

  const listDir = tool({
    description: 'List the entries of a directory within the workspace boundary.',
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async ({ path }) => {
      const g = guard(path ?? roots[0]!);
      if ('error' in g) return g;
      const abs = g.abs;
      if (!existsSync(abs)) return { error: 'not_found', path: abs };
      const entries = readdirSync(abs, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
      return { path: abs, entries };
    },
  });

  const search = tool({
    description:
      'Search file contents for a substring (case-sensitive) under a directory.',
    inputSchema: z.object({
      query: z.string(),
      path: z.string().optional(),
      maxResults: z.number().int().positive().max(200).optional(),
    }),
    execute: async ({ query, path, maxResults = 50 }) => {
      const g = guard(path ?? roots[0]!);
      if ('error' in g) return g;
      const base = g.abs;
      const hits: { file: string; line: number; text: string }[] = [];
      walk(base, (file) => {
        if (hits.length >= maxResults) return false;
        try {
          const stat = statSync(file);
          if (stat.size > MAX_READ_BYTES) return true;
          const lines = readFileSync(file, 'utf8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(query)) {
              hits.push({ file: relative(base, file), line: i + 1, text: lines[i]!.slice(0, 200) });
              if (hits.length >= maxResults) break;
            }
          }
        } catch {
          /* skip unreadable/binary */
        }
        return true;
      });
      return { base, count: hits.length, hits };
    },
  });

  const writeFile = tool({
    description:
      'Write (create or overwrite) a UTF-8 text file. Requires approval unless granted for the task.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }, { toolCallId }) => {
      const g = guard(path);
      if ('error' in g) return g;
      const abs = g.abs;
      const m = enforceMode(ctx, { toolName: 'writeFile', toolCallId, input: { path: abs } });
      if (m.blocked) return m.result;
      return gated(
        ctx,
        {
          toolName: 'writeFile',
          toolCallId,
          // Carry a bounded content preview so a host can show WHAT is being
          // written at the approval gate (not just the path), without bloating
          // the event / classifier prompt for large files.
          input: { path: abs, bytes: content.length, content: clipForApproval(content) },
          grantKey: dirPrefix(abs),
          grantScope: `write files under ${dirPrefix(abs)}`,
        },
        async () => {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileNoFollow(abs, content);
          return { path: abs, bytes: content.length, ok: true };
        },
      );
    },
  });

  const applyPatch = tool({
    description:
      'Apply a simple search/replace edit to a file. Requires approval unless granted for the task.',
    inputSchema: z.object({
      path: z.string(),
      find: z.string().describe('Exact text to replace (must be unique).'),
      replace: z.string(),
    }),
    execute: async ({ path, find, replace }, { toolCallId }) => {
      const g = guard(path);
      if ('error' in g) return g;
      const abs = g.abs;
      const m = enforceMode(ctx, { toolName: 'applyPatch', toolCallId, input: { path: abs } });
      if (m.blocked) return m.result;
      return gated(
        ctx,
        {
          toolName: 'applyPatch',
          toolCallId,
          // Carry the find→replace so a host can render the edit as a diff at the
          // approval gate (bounded for large edits).
          input: { path: abs, find: clipForApproval(find), replace: clipForApproval(replace) },
          grantKey: dirPrefix(abs),
          grantScope: `edit files under ${dirPrefix(abs)}`,
        },
        async () => {
          if (!existsSync(abs)) return { error: 'not_found', path: abs };
          const original = readFileSync(abs, 'utf8');
          const count = original.split(find).length - 1;
          if (count === 0) return { error: 'no_match', path: abs };
          if (count > 1) return { error: 'ambiguous_match', count, path: abs };
          writeFileNoFollow(abs, original.replace(find, replace));
          return { path: abs, ok: true };
        },
      );
    },
  });

  return { readFile, listDir, search, writeFile, applyPatch };
}

/** Cap text put into an approval `input` so the event / auto-classifier prompt
 *  stays bounded for large writes/edits; hosts truncate further for display. */
const APPROVAL_PREVIEW_CHARS = 4000;
function clipForApproval(s: string): string {
  return s.length > APPROVAL_PREVIEW_CHARS ? s.slice(0, APPROVAL_PREVIEW_CHARS) + '…' : s;
}

function walk(dir: string, visit: (file: string) => boolean): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(full, visit);
    else if (e.isFile()) {
      if (!visit(full)) return;
    }
  }
}
