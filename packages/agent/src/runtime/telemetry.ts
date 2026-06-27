/**
 * OpenTelemetry opt-in (observability §8). The AI SDK natively emits spans when
 * a call is given `experimental_telemetry: { isEnabled: true }`. We expose that
 * as a zero-default-cost passthrough: only when `EA_OTEL` is set do we attach
 * the option, so the operator can `--require` an OTel NodeSDK in the host and
 * collect model-call spans (token usage, latency, tool calls) without this repo
 * bundling any `@opentelemetry/*` dependency.
 *
 * `functionId` groups spans (e.g. 'orchestrator', 'sub-agent'); `metadata`
 * carries correlation ids (runId / agentId) so spans line up with the run tree
 * (agent §5.0) and the error log (§2).
 */

function enabled(): boolean {
  const v = (process.env.EA_OTEL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface TelemetryMeta {
  runId?: string;
  agentId?: string;
}

/**
 * Returns `{ experimental_telemetry }` to spread into a `stream()`/`generate()`
 * call, or `{}` when telemetry is off. Typed loosely so it can be spread into
 * the AI SDK call options without coupling to the SDK's exact option type.
 */
export function telemetryOption(
  functionId: string,
  metadata: TelemetryMeta = {},
): Record<string, unknown> {
  if (!enabled()) return {};
  const meta: Record<string, string> = {};
  if (metadata.runId) meta.runId = metadata.runId;
  if (metadata.agentId) meta.agentId = metadata.agentId;
  return { experimental_telemetry: { isEnabled: true, functionId, metadata: meta } };
}
