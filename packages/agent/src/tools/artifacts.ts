/**
 * Artifact tools (agent §artifacts): register / list / find session deliverables.
 *
 * An artifact is a file the model already wrote INTO the working directory (via
 * write_file / code) — a document, image, video, code file, or program. These
 * tools only record & retrieve metadata; they never produce content themselves,
 * so binary deliverables (images, video) are supported by referencing the file
 * the model wrote. Available to every agent (orchestrator + sub-agents), since
 * sub-agents produce deliverables too.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, basename } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Artifact, ArtifactKind } from '@dami-sg/agent-contract';
import type { RunContext } from '../runtime/context.js';
import { newId } from '../storage/session-store.js';

const KINDS = ['document', 'image', 'video', 'code', 'program', 'other'] as const satisfies readonly ArtifactKind[];

/** Resolve `p` inside the writable boundary `root`; undefined if it escapes. */
function resolveInBoundary(root: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return abs;
}

/** Substring/subsequence relevance score for fuzzy name matching. */
function nameScore(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.includes(q)) return 60 + Math.max(0, 20 - (n.length - q.length));
  let i = 0;
  for (const ch of n) if (i < q.length && ch === q[i]) i++;
  return i === q.length ? 30 : 0;
}

export function buildArtifactTools(ctx: RunContext) {
  const root = ctx.shared.rootPaths[0] ?? '';

  const createArtifact = tool({
    description:
      "Register a file you ALREADY wrote into the working directory as a session artifact — a deliverable for the human (document, image, video, code, or program). Write the file first (write_file / a command), then call this with its path. Recorded in the session so it can be listed, found, and previewed later.",
    inputSchema: z.object({
      name: z.string().describe('Human-facing name, e.g. "Q3 report" or "logo.png".'),
      path: z.string().describe('Path to the already-written file, relative to the working directory.'),
      kind: z.enum(KINDS).describe('document | image | video | code | program | other.'),
      description: z.string().optional().describe('One-line description of what it is.'),
      mimeType: z.string().optional().describe('MIME type if known, e.g. image/png, text/markdown.'),
    }),
    execute: async ({ name, path, kind, description, mimeType }) => {
      const abs = resolveInBoundary(root, path);
      if (!abs || !existsSync(abs)) {
        return { ok: false, error: `file not found within the working directory: ${path}` };
      }
      const stat = statSync(abs);
      if (!stat.isFile()) return { ok: false, error: `not a regular file: ${path}` };
      const rel = relative(root, abs);
      const artifact: Artifact = {
        id: newId('a'),
        name: name.trim() || basename(rel),
        kind,
        mimeType: mimeType?.trim() || undefined,
        description: description?.trim() || undefined,
        path: rel,
        size: stat.size,
        createdAt: Date.now(),
        runId: ctx.runId,
      };
      ctx.shared.addArtifact(artifact);
      ctx.shared.emit({ kind: 'artifact-created', sessionId: ctx.shared.sessionId, artifact, absolutePath: abs });
      return { ok: true, id: artifact.id, name: artifact.name, kind: artifact.kind, path: artifact.path, size: artifact.size };
    },
  });

  const listArtifacts = tool({
    description: 'List every artifact (deliverable) recorded in this session, oldest first.',
    inputSchema: z.object({}),
    execute: async () => {
      const items = ctx.shared.listArtifacts();
      return {
        count: items.length,
        artifacts: items.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          description: a.description,
          path: a.path,
          size: a.size,
          createdAt: a.createdAt,
        })),
      };
    },
  });

  const findArtifact = tool({
    description: 'Fuzzy-find artifacts in this session by name; returns the best matches (up to 10).',
    inputSchema: z.object({ query: z.string().describe('Name or partial name to search for.') }),
    execute: async ({ query }) => {
      const q = query.toLowerCase().trim();
      const ranked = ctx.shared
        .listArtifacts()
        .map((a) => ({ a, s: q ? nameScore(a.name, q) : 1 }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 10)
        .map((x) => x.a);
      return {
        count: ranked.length,
        artifacts: ranked.map((a) => ({ id: a.id, name: a.name, kind: a.kind, description: a.description, path: a.path })),
      };
    },
  });

  return { createArtifact, listArtifacts, findArtifact };
}
