#!/usr/bin/env node
/**
 * Install vendored skills (skills/) into an agent skill root so the running
 * agent/gateway discovers them (loader merges <root>/skills, restart to pick up).
 *
 * Usage:
 *   node scripts/install-skills.mjs --list                 # list bundled skills
 *   node scripts/install-skills.mjs --all                  # install all
 *   node scripts/install-skills.mjs pdf docx xlsx          # install specific
 *   node scripts/install-skills.mjs --all --force          # overwrite existing
 *   node scripts/install-skills.mjs pdf --root /srv/agent  # into <root>/skills
 *   node scripts/install-skills.mjs pdf --dest /tmp/skills # explicit dest dir
 *
 * Destination resolution (first match wins):
 *   --dest <dir>  → <dir>
 *   --root <dir>  → <dir>/skills
 *   $ENTERPRISE_AGENT_HOME/skills
 *   ~/.enterprise-agent/skills        (default, matches createPaths())
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** Bundled skill dirs (those containing a SKILL.md). */
function available() {
  if (!existsSync(SRC)) return [];
  return readdirSync(SRC)
    .filter((n) => {
      try {
        return statSync(join(SRC, n)).isDirectory() && existsSync(join(SRC, n, 'SKILL.md'));
      } catch {
        return false;
      }
    })
    .sort();
}

function parseArgs(argv) {
  const opts = { names: [], all: false, list: false, force: false, dest: undefined, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dest') opts.dest = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('-')) fail(`unknown flag: ${a}`);
    else opts.names.push(a);
  }
  return opts;
}

function resolveDest(opts) {
  if (opts.dest) return opts.dest;
  if (opts.root) return join(opts.root, 'skills');
  const base = process.env.ENTERPRISE_AGENT_HOME ?? join(homedir(), '.enterprise-agent');
  return join(base, 'skills');
}

function fail(msg) {
  console.error(`install-skills: ${msg}`);
  process.exit(1);
}

const HELP = `Install vendored skills into an agent skill root.

  node scripts/install-skills.mjs --list
  node scripts/install-skills.mjs --all [--force]
  node scripts/install-skills.mjs <name...> [--force] [--root DIR | --dest DIR]

Flags: --all  --list/-l  --force/-f  --root DIR  --dest DIR  --help/-h`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void console.log(HELP);

  const skills = available();
  if (!skills.length) fail(`no bundled skills found under ${SRC}`);

  if (opts.list || (!opts.all && opts.names.length === 0)) {
    console.log(`Bundled skills (${skills.length}) in ${SRC}:`);
    for (const s of skills) console.log(`  - ${s}`);
    if (!opts.list) console.log(`\nInstall with: --all  or  <name...>   (see --help)`);
    return;
  }

  const wanted = opts.all ? skills : opts.names;
  const unknown = wanted.filter((n) => !skills.includes(n));
  if (unknown.length) fail(`unknown skill(s): ${unknown.join(', ')}\nAvailable: ${skills.join(', ')}`);

  const dest = resolveDest(opts);
  mkdirSync(dest, { recursive: true });

  let installed = 0;
  let skipped = 0;
  for (const name of wanted) {
    const to = join(dest, name);
    if (existsSync(to) && !opts.force) {
      console.log(`  skip   ${name} (exists; --force to overwrite)`);
      skipped++;
      continue;
    }
    cpSync(join(SRC, name), to, { recursive: true, force: true });
    console.log(`  ${opts.force && existsSync(to) ? 'update' : 'install'} ${name} → ${to}`);
    installed++;
  }
  console.log(`\nDone: ${installed} installed, ${skipped} skipped → ${dest}`);
  console.log('Restart the agent/gateway to discover newly installed skills.');
}

main();
