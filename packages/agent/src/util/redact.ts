/**
 * Secret redaction for logs and the error log (observability §9). core's
 * standing invariant is "secrets never reach a log"; once §2/§5 add log sinks
 * that can serialize arbitrary fields and error messages, we keep that
 * invariant by masking on the way out — the symmetric defence to stripping
 * `ENTERPRISE_AGENT_KEY_*` from MCP subprocess env (mcp/client.ts).
 */

/**
 * Field keys whose VALUE is always masked regardless of content. `token` is
 * matched only when NOT followed by more word chars, so real secret keys
 * (`token`, `access_token`, `x-auth-token`) mask while count fields
 * (`inputTokens`, `tokensBefore`, `maxTokens`) do not.
 */
const SECRET_KEY = /token(?![a-z0-9_])|secret|api[-_]?key|authorization|password|passwd|cookie|bearer/i;

/** Substrings inside any string that look like a credential, masked in place. */
const SECRET_SUBSTR: Array<[RegExp, string]> = [
  // env-injected provider keys (ENTERPRISE_AGENT_KEY_OPENAI=sk-...) — mask the value
  [/ENTERPRISE_AGENT_KEY_[A-Z0-9_]+=\S+/g, 'ENTERPRISE_AGENT_KEY_***'],
  // OpenAI-style keys (also catches sk-ant-… Anthropic keys)
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***'],
  // Bearer tokens in headers / messages
  [/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, 'Bearer ***'],
  // Telegram bot tokens (123456:AA...)
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '***:***'],
  // Google / Gemini API keys (AIza…)
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza***'],
  // AWS access key ids (AKIA… / ASIA…)
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***'],
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_… and fine-grained github_pat_…)
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***'],
  // Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-…)
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox***'],
  // JWTs (three base64url segments joined by dots) — also covers OIDC id_tokens
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'eyJ***'],
];

/** Redact a single string value in place (substring masking). */
export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_SUBSTR) out = out.replace(re, rep);
  return out;
}

/**
 * Redact an arbitrary value for logging. Strings get substring masking; objects
 * are walked and any field whose KEY looks secret has its value fully masked.
 * Cyclic refs are broken with a sentinel. Depth-bounded to stay cheap on hot
 * paths.
 */
export function redact<T>(value: T, _seen?: WeakSet<object>, depth = 0): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  const seen = _seen ?? new WeakSet<object>();
  if (seen.has(value as object)) return '[Circular]' as unknown as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '***' : redact(v, seen, depth + 1);
  }
  return out as unknown as T;
}
