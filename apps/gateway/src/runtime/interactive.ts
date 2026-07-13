/**
 * Question & plan rendering/parsing for chat (gateway §6.3). askUserQuestion
 * (agent §2.4) and plan-proposed (agent §3.8.4) both suspend the run awaiting a
 * human choice; on button platforms we render taps, on text-only platforms we
 * render numbered options and parse a numeric reply. Pure + unit-testable.
 */
import type { Todo, UserQuestion, UserQuestionAnswer } from '@dami-sg/agent-contract';

/**
 * Numbered-options prompt for `user-question-required` (gateway §6.3). The options
 * are a real ordered list so rich-message platforms (Telegram) render them as a
 * proper list; plain-text platforms (WeChat) still read cleanly as "1. …".
 */
export function questionPrompt(questions: UserQuestion[]): string {
  const multi = questions.length > 1;
  const parts: string[] = [];
  questions.forEach((q, qi) => {
    const head = multi ? `**[${qi + 1}]** ` : '';
    parts.push(`❓ ${head}**${q.question}**${q.multiSelect ? '（可多选）' : ''}`);
    parts.push(''); // blank line so the ordered list starts cleanly (GFM)
    q.options.forEach((o, oi) => {
      parts.push(`${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
    });
    parts.push('');
  });
  parts.push(
    multi
      ? '回复每个问题的选项编号，用 / 分隔不同问题（同一问题多选用逗号），例如 1/2,3'
      : '回复选项编号即可（多选用逗号，例如 1,3）',
  );
  return parts.join('\n');
}

/**
 * Parse a numeric reply into aligned answers (gateway §6.3). One segment per
 * question (split on `/` when there are several); each segment is comma/space
 * separated option numbers. Returns `undefined` when the reply doesn't cleanly
 * resolve — the caller re-prompts rather than guessing.
 */
export function parseAnswer(questions: UserQuestion[], reply: string): UserQuestionAnswer[] | undefined {
  const text = reply.trim();
  if (!text) return undefined;
  const segments = questions.length > 1 ? text.split('/') : [text];
  if (segments.length !== questions.length) return undefined;

  const answers: UserQuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const nums = segments[i]!
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s) => Number(s));
    if (nums.length === 0) return undefined;
    if (!q.multiSelect && nums.length !== 1) return undefined;
    if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > q.options.length)) return undefined;
    answers.push({ selected: nums.map((n) => q.options[n - 1]!.label) });
  }
  return answers;
}

/**
 * Render a todo list (agent §2.4 `todo-update`) as a native GFM task list
 * (gateway §5). Telegram rich messages render real checkboxes — done items are
 * checked + struck through, the active one is the emphasized open item. Only used
 * on edit-capable channels (WeChat skips it), so the task-list syntax is safe.
 * Maintained as a single edited message per turn.
 */
export function renderTodoList(todos: Todo[]): string {
  const lines = ['**📋 任务清单**', ''];
  for (const t of todos) {
    if (t.status === 'completed') lines.push(`- [x] ~~${t.content}~~`);
    else if (t.status === 'in_progress') lines.push(`- [ ] ⏳ **${t.content}**`);
    else lines.push(`- [ ] ${t.content}`);
  }
  return lines.join('\n');
}

/** One sub-agent's high-level progress (gateway §2.3). */
export interface SubAgentProgress {
  role: string;
  status: 'running' | 'done';
  /** The sub-agent's closing summary (agent §2.3), shown on completion. */
  summary?: string;
}

/**
 * Render the sub-agent progress card (gateway §5). One live, edited-in-place
 * message showing each delegated sub-agent's role + status + completion summary —
 * the high-level view, not the sub-agent's streamed body (that stays in verbose).
 */
export function renderSubAgentCard(items: SubAgentProgress[]): string {
  if (items.length === 0) return '';
  // Native GFM task list (gateway §5): a checked box per finished sub-agent.
  const lines = ['**🤖 子代理进度**', ''];
  for (const s of items) {
    if (s.status === 'done') lines.push(`- [x] **${s.role}** — ${s.summary ? firstLine(s.summary) : '已完成'}`);
    else lines.push(`- [ ] ⏳ **${s.role}** — 运行中…`);
  }
  return lines.join('\n');
}

function firstLine(s: string, max = 140): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
