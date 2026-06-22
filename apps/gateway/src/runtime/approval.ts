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
  else {
    const detail = summarizeInput(input);
    if (detail) lines.push(detail);
  }
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

/** A compact labelled detail for a tool input, when no grantScope is given. A
 *  command renders as a fenced code block (reads well even when long); a path /
 *  url / file stays a one-line inline-code label. */
function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const cmd = o['command'];
  if (typeof cmd === 'string' && cmd) {
    const val = cmd.length > 300 ? cmd.slice(0, 299) + '…' : cmd;
    return `命令：\n\`\`\`\n${val}\n\`\`\``;
  }
  const labels: Record<string, string> = { path: '路径', url: '链接', file: '文件' };
  for (const k of ['path', 'url', 'file']) {
    const v = o[k];
    if (typeof v === 'string' && v) {
      const val = v.length > 120 ? v.slice(0, 119) + '…' : v;
      return `${labels[k]}：\`${val}\``;
    }
  }
  return '';
}
