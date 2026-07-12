/**
 * Network tools (agent §3.1, mid risk → configurable approval). Grant key is
 * the host; outbound requests honor the network allowlist (agent §4).
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../runtime/context.js';
import { gated, ToolRejectedError } from './gate.js';
import { enforceMode } from './mode.js';
import { safeFetch, SsrfError } from '../util/ssrf.js';

export function buildHttpTools(ctx: RunContext) {
  const { permission } = ctx.shared;

  // Match the allowlist by hostname only (case-insensitive), independent of port,
  // so `api.example.com` covers `api.example.com:8443` and casing variants — a
  // port-sensitive match pushed operators toward over-broad lists.
  function hostAllowed(hostname: string): boolean {
    if (!permission.allowHosts) return true; // unset = allow (gate + SSRF guard still apply)
    const h = hostname.toLowerCase();
    return permission.allowHosts.some((a) => a.toLowerCase().replace(/:\d+$/, '') === h);
  }

  const httpFetch = tool({
    description:
      'Make an HTTP request. Mid risk: requires approval unless granted for the host. Returns status + truncated body.',
    inputSchema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    }),
    execute: async ({ url, method = 'GET', headers, body }, { toolCallId }) => {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { error: 'invalid_url' };
      }
      if (!hostAllowed(host)) return { error: 'host_not_allowed', host };
      const m = enforceMode(ctx, { toolName: 'httpFetch', toolCallId, input: { url, method } });
      if (m.blocked) return m.result;
      try {
        return await gated(
          ctx,
          {
            toolName: 'httpFetch',
            toolCallId,
            input: { url, method },
            grantKey: host,
            grantScope: `request ${host} for this task`,
          },
          async () => {
            const res = await safeFetch(
              url,
              {
                method,
                headers,
                body,
                signal: ctx.abortSignal,
              },
              // Re-check the allowlist on every redirect hop, not just the initial
              // URL, so an allowlisted open-redirect can't bounce the request (and
              // its headers/body) to an unapproved host.
              { isHostAllowed: hostAllowed },
            );
            const text = await res.text();
            return {
              status: res.status,
              ok: res.ok,
              headers: Object.fromEntries(res.headers.entries()),
              body: text.slice(0, 16_000),
              truncated: text.length > 16_000,
            };
          },
        );
      } catch (e) {
        if (e instanceof ToolRejectedError) return { error: 'rejected' };
        if (e instanceof SsrfError) return { error: 'blocked_by_ssrf_guard', message: e.message };
        return { error: 'request_failed', message: String(e) };
      }
    },
  });

  return { httpFetch };
}
