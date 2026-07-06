/**
 * Request-style command routing for `ea serve` (cli §8, 附录 A.2): each route is
 * an ergonomic wrapper over one `AgentHost` method, exactly as the in-process
 * TUI / headless shells call it directly (A.1). The wire bodies ARE the
 * `@enterprise-agent/agent-contract` types — no hand-written DTOs.
 *
 * Deviation from the A.2 sketch: `POST /sessions` creates a session (no run) and
 * `POST /sessions/start` starts one (with a `goal`), so the two host methods
 * (`createSession` vs `startSession`) map to distinct routes instead of being
 * overloaded on one verb+path.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentHost,
  ApprovalDecision,
  CreateSessionInput,
  ExecutionMode,
  PlanDecision,
  ScopedConfig,
  StartSessionInput,
  UsageQuery,
  UserPart,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';
import { sendError, sendJson, readBody } from './util.js';

type Handler = (
  ctx: { host: AgentHost; params: Record<string, string>; url: URL },
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

interface Route {
  method: string;
  /** Path template with `:name` segments, e.g. `/sessions/:id/message`. */
  pattern: string;
  handler: Handler;
}

// Typed as a tuple table so each inline handler gets `Handler` contextual typing
// (its params would otherwise infer to `any`).
const table: [string, string, Handler][] = [
  // -- session management --
  ['GET', '/sessions', async ({ host }, _req, res) => sendJson(res, 200, await host.listSessions())],
  ['POST', '/sessions', async ({ host }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.createSession(body as unknown as CreateSessionInput));
  }],
  ['POST', '/sessions/start', async ({ host }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.startSession(body as unknown as StartSessionInput));
  }],
  ['DELETE', '/sessions/:id', async ({ host, params }, _req, res) => {
    await host.deleteSession(params.id!);
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/sessions/:id/switch', async ({ host, params }, _req, res) => {
    await host.switchSession(params.id!);
    sendJson(res, 200, { ok: true });
  }],
  ['PATCH', '/sessions/:id/config', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.updateSessionConfig(params.id!, body.config as ScopedConfig));
  }],
  ['PATCH', '/sessions/:id/name', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.renameSession(params.id!, String(body.name ?? '')));
  }],
  ['POST', '/sessions/:id/title', async ({ host, params }, _req, res) => {
    sendJson(res, 200, { title: await host.generateTitle(params.id!) });
  }],

  // -- session driving --
  ['POST', '/sessions/:id/message', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    const parts = body.parts as UserPart[] | undefined;
    sendJson(res, 200, await host.sendMessage(params.id!, String(body.text ?? ''), parts));
  }],
  ['POST', '/sessions/:id/mode', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    host.setExecutionMode(params.id!, body.mode as ExecutionMode);
    sendJson(res, 200, { ok: true });
  }],
  ['GET', '/sessions/:id/mode', async ({ host, params }, _req, res) => {
    sendJson(res, 200, { mode: await host.getExecutionMode(params.id!) });
  }],

  // -- approval / control (synchronous, void-returning) --
  ['POST', '/tool-approvals/:toolCallId', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    host.approveTool(params.toolCallId!, body.decision as ApprovalDecision);
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/questions/:questionId', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    const answers = (body.answers ?? null) as UserQuestionAnswer[] | null;
    host.answerQuestion(params.questionId!, answers);
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/plans/:planId', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    host.approvePlan(params.planId!, body.decision as PlanDecision, {
      editedPlan: body.editedPlan as string | undefined,
      targetMode: body.targetMode as ExecutionMode | undefined,
    });
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/runs/:runId/abort', async ({ host, params }, _req, res) => {
    host.abortRun(params.runId!);
    sendJson(res, 200, { ok: true });
  }],

  // -- session tree ops --
  ['GET', '/sessions/:id/tree', async ({ host, params }, _req, res) => sendJson(res, 200, await host.getSessionTree(params.id!))],
  ['GET', '/sessions/:id/todos', async ({ host, params }, _req, res) => sendJson(res, 200, await host.getTodos(params.id!))],
  ['POST', '/sessions/:id/fork', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    await host.forkFrom(params.id!, String(body.entryId ?? ''));
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/sessions/:id/label', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    await host.labelEntry(params.id!, String(body.entryId ?? ''), String(body.label ?? ''));
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/sessions/:id/compact', async ({ host, params }, _req, res) => {
    await host.compact(params.id!);
    sendJson(res, 200, { ok: true });
  }],
  ['POST', '/sessions/:id/clone', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.cloneToSession(params.id!, String(body.leafId ?? '')));
  }],
  ['POST', '/sessions/:id/report', async ({ host, params }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.report(params.id!, String(body.prompt ?? '')));
  }],

  // -- discovery / schedules --
  ['GET', '/providers/:id/models', async ({ host, params, url }, _req, res) => {
    sendJson(res, 200, await host.listProviderModels(params.id!, { refresh: url.searchParams.get('refresh') === '1' }));
  }],
  ['GET', '/models/capabilities', async ({ host, url }, _req, res) => {
    sendJson(res, 200, await host.modelCapabilities(url.searchParams.get('ref') ?? undefined));
  }],
  ['POST', '/schedules/:name/run', async ({ host, params }, _req, res) => {
    sendJson(res, 200, await host.runScheduleNow(params.name!));
  }],
  ['POST', '/usage/query', async ({ host }, req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, await host.queryUsage(body as unknown as UsageQuery));
  }],
];

const routes: Route[] = table.map(([method, pattern, handler]) => ({ method, pattern, handler }));

/**
 * Dispatch an authenticated request to its `AgentHost` route. Returns once a
 * response has been sent — including 404 (no match) and 400 (handler threw a
 * caller error). Unexpected errors surface as 500.
 */
export async function handleApi(host: AgentHost, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = splitPath(url.pathname);

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(splitPath(route.pattern), segments);
    if (!params) continue;
    try {
      await route.handler({ host, params, url }, req, res);
    } catch (err) {
      // Host methods throw on bad input (unknown session, invalid decision…).
      // Treat as a 400 client error; the message is the contract's own text.
      sendError(res, 400, (err as Error).message);
    }
    return;
  }
  sendError(res, 404, `not found: ${method} ${url.pathname}`);
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Match a template against a concrete path; returns captured params or null. */
function matchPath(template: string[], actual: string[]): Record<string, string> | null {
  if (template.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < template.length; i += 1) {
    const t = template[i]!;
    const a = actual[i]!;
    if (t.startsWith(':')) {
      params[t.slice(1)] = decodeURIComponent(a);
    } else if (t !== a) {
      return null;
    }
  }
  return params;
}
