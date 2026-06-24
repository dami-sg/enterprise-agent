import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardPath, PathBoundaryError, dirPrefix } from '../src/tools/path-guard.js';
import { parseFrontmatter } from '../src/skills/loader.js';
import { crossesThreshold } from '../src/runtime/compactor.js';
import { costOf } from '../src/models/meta.js';
import { Accountant } from '../src/runtime/accountant.js';
import { ModelMetaRegistry } from '../src/models/meta.js';
import { isContextOverflowError } from '../src/runtime/stream-events.js';
import { mcpAllowForPolicy, mcpAllowedForPolicy } from '../src/tools/registry.js';
import { buildSeedAgents } from '../src/agents/registry.js';
import { Semaphore } from '../src/util/semaphore.js';
import { LandstripSandbox } from '../src/sandbox/landstrip.js';

describe('LandstripSandbox.isAvailable (agent §4.1)', () => {
  it('reports false when the binary is not on PATH', () => {
    expect(LandstripSandbox.isAvailable('zzz-no-such-binary-xyz')).toBe(false);
  });
  it('reports true for a binary that exists (node)', () => {
    expect(LandstripSandbox.isAvailable('node')).toBe(true);
  });
});

describe('LandstripSandbox CLI protocol (agent §4.1, landstrip 0.15.17)', () => {
  const sbx = new LandstripSandbox({ bin: 'landstrip' });

  it('invokes `landstrip -- <tool> <args>` with the policy as JSON on stdin (network open by default)', () => {
    const policy = sbx.buildPolicy({ rootPaths: ['/repo'] });
    const spec = sbx.wrapCommand('python3', ['-c', 'print(1)'], policy);
    expect(spec.command).toBe('landstrip');
    expect(spec.args).toEqual(['--', 'python3', '-c', 'print(1)']);
    const pol = JSON.parse(spec.stdin!);
    expect(pol.filesystem.allowWrite).toEqual(['/repo']); // writes bounded to the workspace
    expect(pol.network.allowNetwork).toBe(true); // network open by default (agent §4.1)
  });

  it('denies subprocess network only when explicitly disabled', () => {
    const policy = sbx.buildPolicy({ rootPaths: ['/repo'], allowNetwork: false });
    const pol = JSON.parse(sbx.wrapCommand('curl', [], policy).stdin!);
    expect(pol.network.allowNetwork).toBe(false);
  });

  it('adds skill dirs to allowRead but keeps writes workspace-only (agent §3.6/§4)', () => {
    const policy = sbx.buildPolicy({ rootPaths: ['/repo'], readPaths: ['/skills', '/repo/.sessions/s/skills'] });
    const pol = JSON.parse(sbx.wrapCommand('python3', ['s.py'], policy).stdin!);
    expect(pol.filesystem.allowWrite).toEqual(['/repo']); // skill dirs never writable
    expect(pol.filesystem.allowRead).toEqual(['/repo', '/skills', '/repo/.sessions/s/skills']); // read + run
  });

  it('parses a filesystem trap into a grantable denial', () => {
    const trap = sbx.parseTrap(
      '{"kind":"filesystem","code":"FS_WRITE_DENIED","operation":"write","path":"/repo/out","suggested_grant":{"allowWrite":"/repo/out"}}',
    );
    expect(trap).toMatchObject({ kind: 'write', path: '/repo/out' });
    expect(trap?.suggestedGrant.allowWrite).toEqual(['/repo/out']);
  });

  it('ignores non-JSON lines (macOS EPERM) and non-grantable error kinds', () => {
    expect(sbx.parseTrap('sh: /repo/out: Operation not permitted')).toBeNull();
    expect(sbx.parseTrap('{"kind":"launch","code":"LAUNCH_FAILED","program":"git"}')).toBeNull();
    expect(sbx.parseTrap('{"kind":"internal","code":"INTERNAL_ERROR"}')).toBeNull();
  });
});

describe('Path boundary (agent §4)', () => {
  it('allows paths within a root and rejects traversal', () => {
    expect(guardPath('src/a.ts', ['/repo'])).toBe('/repo/src/a.ts');
    expect(() => guardPath('../etc/passwd', ['/repo'])).toThrow(PathBoundaryError);
    expect(() => guardPath('/etc/passwd', ['/repo'])).toThrow(PathBoundaryError);
  });
  it('derives a directory grant key', () => {
    expect(dirPrefix('/repo/src/a.ts')).toBe('/repo/src');
  });
  it('rejects an in-boundary symlink that escapes the root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zt-root-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zt-out-')));
    mkdirSync(join(root, 'sub'));
    symlinkSync(outside, join(root, 'sub', 'escape')); // root/sub/escape -> outside
    // A normalized path stays "inside", but symlink resolution lands outside.
    expect(() => guardPath('sub/escape/secret.txt', [root])).toThrow(PathBoundaryError);
    // A genuine in-root path still resolves.
    expect(guardPath('sub/ok.txt', [root])).toBe(join(root, 'sub', 'ok.txt'));
  });
});

describe('Context overflow detection (agent §5.5)', () => {
  it('matches provider context-length errors, ignores unrelated ones', () => {
    expect(isContextOverflowError({ message: 'prompt is too long: 250000 tokens' })).toBe(true);
    expect(isContextOverflowError({ message: 'error', responseBody: '{"code":"context_length_exceeded"}' })).toBe(true);
    expect(isContextOverflowError({ message: 'maximum context length is 200000 tokens' })).toBe(true);
    expect(isContextOverflowError({ message: 'rate limit exceeded' })).toBe(false);
    expect(isContextOverflowError(new Error('network timeout'))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

describe('Sub-agent MCP role gate (agent §3.4)', () => {
  it('allows all MCP tools when the role policy is `true`', () => {
    const researcher = buildSeedAgents().find((d) => d.name === 'researcher')!;
    expect(mcpAllowedForPolicy(researcher.policy)).toBe(true);
    expect(mcpAllowForPolicy(researcher.policy)).toBeUndefined(); // undefined = no filtering
  });
});

describe('Skill frontmatter (agent §3.6)', () => {
  it('parses name, description, allowed-tools, disable flag', () => {
    const { fm, body } = parseFrontmatter(
      ['---', 'name: pdf-extract', 'description: extract pdf', 'allowed-tools: [readFile, runCommand]', 'disable-model-invocation: false', '---', 'Body here'].join('\n'),
    );
    expect(fm.name).toBe('pdf-extract');
    expect(fm['allowed-tools']).toEqual(['readFile', 'runCommand']);
    expect(fm['disable-model-invocation']).toBe(false);
    expect(body.trim()).toBe('Body here');
  });
});

describe('Compaction threshold (agent §5.5)', () => {
  it('triggers at (contextWindow − maxOutputTokens) * ratio from real input tokens', () => {
    // usable budget = 100_000 − 1_000 = 99_000; 99_000 * 0.9 = 89_100.
    const meta = { ref: 'm', contextWindow: 100_000, maxOutputTokens: 1000 };
    expect(crossesThreshold(89_000, meta, 0.9)).toBe(false);
    expect(crossesThreshold(90_000, meta, 0.9)).toBe(true);
  });

  it('reserves a large maxOutputTokens so it fires before the provider overflows', () => {
    // A 200k window reserving 64k for output overflows past 136k input. The
    // threshold must sit below that ceiling — not at 0.9 * 200k = 180k (which
    // would never fire before overflow).
    const meta = { ref: 'm', contextWindow: 200_000, maxOutputTokens: 64_000 };
    // usable budget = 136_000; 136_000 * 0.9 = 122_400.
    expect(crossesThreshold(122_000, meta, 0.9)).toBe(false);
    expect(crossesThreshold(123_000, meta, 0.9)).toBe(true);
    // The old full-window formula would have stayed false here (< 180k).
    expect(crossesThreshold(150_000, meta, 0.9)).toBe(true);
  });
});

describe('Semaphore concurrency cap (agent §2.3 pt.3)', () => {
  it('never lets more than `max` holders run at once, even under interleaving', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve(); // yield so releases/acquires interleave on the microtask queue
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 20 }, () => task()));
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it('serializes with max=1 and drains the full queue', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const run = async (i: number) => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      order.push(i);
      await Promise.resolve();
      active--;
      release();
    };
    await Promise.all([run(0), run(1), run(2), run(3)]);
    expect(peak).toBe(1);
    expect(order.sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('Cost accounting (agent §2.7)', () => {
  it('computes cost from per-Mtok price with cached discount', () => {
    const meta = { ref: 'm', contextWindow: 1000, maxOutputTokens: 100, price: { input: 3, output: 15, cachedInput: 0.3 } };
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, cachedInputTokens: 0 }, meta);
    expect(cost).toBeCloseTo(18, 5);
  });
  it('records 0 cost for unpriced models', () => {
    const meta = { ref: 'local', contextWindow: 1000, maxOutputTokens: 100 };
    expect(costOf({ inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, meta)).toBe(0);
  });
  it('accumulates work totals across agents', () => {
    const acc = new Accountant(new ModelMetaRegistry());
    acc.record('r1', 'orch', 'anthropic:claude-sonnet-4.5', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    acc.record('r1', 'sub-coder-1', 'anthropic:claude-sonnet-4.5', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const w = acc.workTotals();
    expect(w.inputTokens).toBe(110);
    expect(w.outputTokens).toBe(55);
    expect(w.cost).toBeGreaterThan(0);
  });
});
