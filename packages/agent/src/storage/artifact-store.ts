/**
 * Artifact manifest (agent §artifacts): `artifacts.jsonl`, one line per
 * registered deliverable, in creation order. Append-only like `runs.jsonl` —
 * the list grows unbounded over a session, so it lives outside `session.json`.
 */
import type { Artifact } from '@dami-sg/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';

export class ArtifactStore {
  private artifacts: Artifact[];

  constructor(private readonly file: string) {
    this.artifacts = readJsonl<Artifact>(this.file);
  }

  append(artifact: Artifact): void {
    this.artifacts.push(artifact);
    appendJsonl(this.file, artifact);
  }

  list(): Artifact[] {
    return [...this.artifacts];
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.find((a) => a.id === id);
  }
}
