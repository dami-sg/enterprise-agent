/**
 * Schedules filesystem store (§7): list / read / save single-file / enable-disable
 * / delete, under a temp schedules dir. Mirrors agents-store.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesStore } from '../src/web/schedules-store.js';

const SCHEDULE_MD = '---\nname: daily-digest\ndescription: daily ops report\ncron: 0 9 * * *\nmode: auto\n---\nSummarize yesterday.\n';

let dir: string;
let store: SchedulesStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-sched-'));
  store = new SchedulesStore(join(dir, 'schedules'));
  return () => rmSync(dir, { recursive: true, force: true });
});

it('saves a SCHEDULE.md (folder from name), lists with cron, reads it', () => {
  const summary = store.saveFile(SCHEDULE_MD);
  expect(summary).toMatchObject({ dir: 'daily-digest', name: 'daily-digest', cron: '0 9 * * *', enabled: true });
  expect(store.list()).toEqual([
    { dir: 'daily-digest', name: 'daily-digest', description: 'daily ops report', cron: '0 9 * * *', enabled: true },
  ]);
  expect(store.read('daily-digest')).toContain('Summarize yesterday.');
});

it('shows `every` when there is no cron', () => {
  store.saveFile('---\nname: hourly\ndescription: d\nevery: 1h\n---\ndo it');
  expect(store.list()[0]!.cron).toBe('every 1h');
});

it('disables (renames SCHEDULE.md so the loader skips it) and re-enables', () => {
  store.saveFile(SCHEDULE_MD);
  store.setEnabled('daily-digest', false);
  expect(existsSync(join(dir, 'schedules', 'daily-digest', 'SCHEDULE.md'))).toBe(false);
  expect(existsSync(join(dir, 'schedules', 'daily-digest', 'SCHEDULE.md.disabled'))).toBe(true);
  expect(store.list()[0]).toMatchObject({ enabled: false });
  store.setEnabled('daily-digest', true);
  expect(store.list()[0]).toMatchObject({ enabled: true });
});

it('rejects a SCHEDULE.md without name/description, and deletes', () => {
  expect(() => store.saveFile('# no frontmatter')).toThrow(/frontmatter name/);
  store.saveFile(SCHEDULE_MD);
  expect(store.remove('daily-digest')).toBe(true);
  expect(store.list()).toEqual([]);
});
