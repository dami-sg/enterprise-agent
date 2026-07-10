/**
 * Chat-side approval bridge (gateway §6.1). core enforces the three-state
 * approval (`once` / `session` / `reject`, agent §3.3); the gateway only renders
 * the gate into chat and ferries the decision back via `host.approveTool`. The
 * sandbox + audit still apply — only the "terminal keypress" is swapped for a
 * button tap / `/approve` reply / classifier verdict. Safe default: reject.
 *
 * These are the pure *view* helpers; the Dispatcher owns the token registry and
 * the host wiring (§6.1).
 */
import type { ApprovalDecision } from '@enterprise-agent/agent-contract';

export interface ApprovalChoice {
  label: string;
  decision: ApprovalDecision;
}

export interface ApprovalView {
  /** The header line shown above the buttons / prompt. */
  text: string;
  /** Button-path choices (inline-keyboard platforms). */
  choices: ApprovalChoice[];
}

/** Render a `tool-approval-required` into a chat view (gateway §6.1). Uses Markdown
 *  (**bold** / `code` / fenced command) which each adapter renders natively —
 *  Telegram as a rich message, WeChat as plain text. */
export function approvalView(toolName: string, grantScope: string | undefined, input: unknown): ApprovalView {
  const lines = ['⏸ **需要审批**', `工具：\`${toolName}\``];
  if (grantScope) lines.push(`范围：\`${grantScope}\``);
  // Always show what's actually being done — even when a grantScope is present —
  // so the user can decide from the chat without opening anything (the "做厚聊天"
  // goal). What's visible is bounded by what core surfaces in the approval input.
  const detail = summarizeInput(input);
  if (detail) lines.push(detail);
  return {
    text: lines.join('\n'),
    choices: [
      { label: '✅ 允许一次', decision: 'once' },
      { label: '✅ 本会话允许', decision: 'session' },
      { label: '🚫 拒绝', decision: 'reject' },
    ],
  };
}

/** The text prompt for no-button platforms (WeChat, §6.1 `/approve` path). */
export function approvalTextPrompt(view: ApprovalView): string {
  return `${view.text}\n回复 /approve 批准（本会话），或 /deny 拒绝。`;
}

/** A one-line notice when the auto policy adjudicated without a human (§6.1). */
export function approvalAutoNotice(toolName: string, decision: ApprovalDecision, scope?: string): string {
  const verb = decision === 'reject' ? '已自动拒绝' : '已自动批准';
  const glyph = decision === 'reject' ? '🚫' : '⚡';
  return `${glyph} ${verb}：\`${toolName}\`${scope ? ` · ${scope}` : ''}`;
}

/**
 * A labelled, chat-readable detail of what a tool call would do, from the
 * approval `input` core surfaces (gateway §6.1). Bounded by what core includes:
 * `runCommand` carries `{ command, args }` (full line); `runScript` only
 * `{ interpreter, length }` (no body); file ops only `{ path }` (no content —
 * a diff needs a core change). Unknown / MCP tools fall back to their args JSON
 * so the user always sees *something* concrete, never just a tool name.
 */
function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;

  // runCommand: executable + args → the full command line (most common gate).
  const cmd = o['command'];
  if (typeof cmd === 'string' && cmd) {
    const args = Array.isArray(o['args']) ? o['args'].map((a) => String(a)) : [];
    return fenced('命令', [cmd, ...args].join(' '), 800);
  }

  // runScript: core surfaces only interpreter + length (the body stays in core).
  const interp = o['interpreter'];
  if (typeof interp === 'string' && interp) {
    const len = typeof o['length'] === 'number' ? `（${o['length']} 字符）` : '';
    return `脚本：\`${interp}\`${len}`;
  }

  // httpFetch: method + url.
  const url = o['url'];
  if (typeof url === 'string' && url) {
    const method = typeof o['method'] === 'string' ? o['method'] : 'GET';
    return `请求：\`${method} ${truncate(url, 200)}\``;
  }

  const pathLine = typeof o['path'] === 'string' && o['path'] ? `文件：\`${truncate(o['path'] as string, 200)}\`\n` : '';

  // applyPatch: find→replace → render as a diff (Telegram colours ```diff).
  if (typeof o['find'] === 'string' && typeof o['replace'] === 'string') {
    return pathLine + diffBlock(o['find'] as string, o['replace'] as string);
  }

  // writeFile: show the content preview, not just the path.
  if (typeof o['content'] === 'string') {
    return pathLine + fenced('内容', o['content'] as string, 1200);
  }

  // Other file ops surface only a path / file label.
  for (const [k, label] of [['path', '路径'], ['file', '文件']] as const) {
    const v = o[k];
    if (typeof v === 'string' && v) return `${label}：\`${truncate(v, 200)}\``;
  }

  // Unknown / MCP tool — show its args so the decision isn't blind.
  try {
    const json = JSON.stringify(o);
    if (json && json !== '{}') return fenced('参数', json, 600);
  } catch {
    /* non-serializable — skip */
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A labelled fenced code block (reads well even when long). */
function fenced(label: string, body: string, max: number): string {
  return `${label}：\n\`\`\`\n${truncate(body, max)}\n\`\`\``;
}

/** A minimal unified diff of a find→replace edit, in a ```diff block. */
function diffBlock(find: string, replace: string): string {
  const minus = find.split('\n').map((l) => '- ' + l).join('\n');
  const plus = replace.split('\n').map((l) => '+ ' + l).join('\n');
  return 'diff：\n```diff\n' + truncate(minus + '\n' + plus, 1200) + '\n```';
}
