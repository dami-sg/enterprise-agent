/**
 * Addressing conventions (cli §3.2). Sessions are addressed uniformly by their
 * `sessionId` (agent §1). A directory-bound session takes its working directory
 * from the current directory unless told otherwise; a session with no working
 * directory falls back to its private scratch (default working dir, agent §1.1).
 */
import { resolve } from 'node:path';

/** Absolute working directory for a directory-bound session (cli §3.2). */
export function resolveWorkingDir(cwd = process.cwd()): string {
  return resolve(cwd);
}
