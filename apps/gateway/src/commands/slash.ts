/**
 * Slash-command surface (gateway §6.2). One verb set registered across all
 * platforms; the Dispatcher maps each verb to an `AgentHost` method (§6.1 /
 * appendix A). Parsing is pure so it can be unit-tested in isolation.
 */

export interface SlashCommand {
  /** Verb without the leading slash, lowercased (e.g. 'approve'). */
  name: string;
  /** Everything after the verb, trimmed (e.g. the model ref for `/model`). */
  arg: string;
  /** The original text. */
  raw: string;
}

/**
 * Parse a leading slash command. Tolerates the Telegram group form `/cmd@bot`.
 * Returns `undefined` for ordinary messages (no leading slash).
 */
export function parseSlash(text: string): SlashCommand | undefined {
  const t = text.trimStart();
  if (!t.startsWith('/')) return undefined;
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim(), raw: text };
}

/** Built-in gateway verbs (gateway §6.2). Anything else is treated as `/<skill>`. */
export const BUILTIN_COMMANDS = new Set([
  'new',
  'reset',
  'approve',
  'deny',
  'stop',
  'model',
  'mode',
  'platform',
  'status',
  'memories',
  'forget',
  'help',
]);

/**
 * High-risk verbs gated behind admin authorization (gateway §6.4). The rest
 * (`status`, `help`, `model`) are low-risk and available to any allowed user.
 */
export const ADMIN_COMMANDS = new Set(['approve', 'deny', 'stop', 'mode', 'platform', 'new', 'reset']);

export function isBuiltin(name: string): boolean {
  return BUILTIN_COMMANDS.has(name);
}
