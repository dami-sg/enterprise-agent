/**
 * Dispatcher (gateway §2.2 / §6). The multi-session headless main loop: it owns
 * one global `host.onEvent` subscription and fans events out to the right
 * conversation by run tree, and it turns inbound platform messages into
 * `AgentHost` commands (appendix A). It is the gateway's analogue of
 * headless/run.ts — generalized from one run to many concurrent conversations.
 *
 * The `turnRuns` invariant is inherited verbatim from headless (gateway §2.2):
 * a sub-agent's events carry the SUB's runId (agent §2.3), so approvals raised
 * inside a delegation must be matched against the conversation's whole run tree,
 * not just the orchestrator run — otherwise they hang until wall-clock timeout.
 */
import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  ScopedConfig,
  Session,
  Todo,
  UserQuestion,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';
import { ORCHESTRATOR_AGENT_ID } from '@enterprise-agent/agent-contract';
import { decide, parseApprovePolicy, type ApprovePolicy } from '@enterprise-agent/cli';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelAdapter, InboundMessage, MessageRef, Prompt, SendTarget } from '../channels/adapter.js';
import type { ChannelConfig } from '../config/gateway-config.js';
import { ConversationRenderer } from '../render/chat-render.js';
import { Router, shouldReset } from './router.js';
import { commandAllowed } from './auth.js';
import { parseSlash, isBuiltin } from '../commands/slash.js';
import { approvalView, approvalTextPrompt, approvalAutoNotice } from './approval.js';
import {
  questionPrompt,
  parseAnswer,
  renderTodoList,
  renderSubAgentCard,
  type SubAgentProgress,
} from './interactive.js';

/** A pending interactive action a button token resolves to (gateway §6.1). */
type PendingAction =
  | { kind: 'approve'; toolCallId: string; decision: ApprovalDecision }
  | { kind: 'answer'; questionId: string; answers: UserQuestionAnswer[] }
  | { kind: 'plan'; planId: string; approve: boolean };

/** A sent inline-button message and its text, so a tap can edit it in place
 *  (drop the keyboard + append the outcome) instead of leaving it stacked (§6.1). */
interface Card {
  ref: MessageRef;
  text: string;
  /** All tokens belonging to this card, cleared together once one is tapped. */
  tokens: string[];
}

interface Conv {
  readonly key: string;
  readonly channel: string;
  readonly conversationId: string;
  sessionId?: string;
  target: SendTarget;
  /** This turn's run tree: orchestrator run + admitted sub-runs (gateway §2.2). */
  turnRuns: Set<string>;
  orchRunId?: string;
  renderer?: ConversationRenderer;
  /** Button token → action, for inline-button platforms (§6.1). */
  tokens: Map<string, PendingAction>;
  /** Button token → the card it lives on, for in-place finalization (§6.1). */
  cards: Map<string, Card>;
  tokenSeq: number;
  /** toolCallIds awaiting a `/approve` text reply (no-button platforms, §6.1). */
  pendingApprovals: string[];
  pendingQuestion?: { questionId: string; questions: UserQuestion[] };
  pendingPlan?: { planId: string };
  /** The edited-in-place todo checklist message for this turn (edit-capable channels). */
  todoRef?: MessageRef;
  /** Live sub-agent progress (agentId → role/status/summary, gateway §2.3). */
  subAgents: Map<string, SubAgentProgress>;
  /** The edited-in-place sub-agent progress card for this turn. */
  subAgentRef?: MessageRef;
}

interface ChannelCtx {
  adapter: ChannelAdapter;
  config: ChannelConfig;
  policy: ApprovePolicy;
}

/** Gateway-local platform control surface (`/platform`, gateway §2.3 / §6.2). */
export interface PlatformControl {
  list(): Array<{ name: string; state: string }>;
  pause(name: string): void;
  resume(name: string): Promise<void>;
}

export interface DispatcherOptions {
  host: AgentHost;
  router: Router;
  verbose?: boolean;
  platform?: PlatformControl;
  /** Injectable clock for reset decisions (gateway §4.3). Default Date.now. */
  now?: () => number;
  onError?: (err: unknown) => void;
}

export class Dispatcher {
  private readonly host: AgentHost;
  private readonly router: Router;
  private readonly verbose: boolean;
  private readonly platform?: PlatformControl;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  private readonly channels = new Map<string, ChannelCtx>();
  private readonly convs = new Map<string, Conv>();
  private readonly runToConv = new Map<string, string>();
  private unsubscribe?: () => void;

  constructor(opts: DispatcherOptions) {
    this.host = opts.host;
    this.router = opts.router;
    this.verbose = opts.verbose ?? false;
    this.platform = opts.platform;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
  }

  /** Register a channel and precompute its approval policy. The adapter owns its
   *  own Markdown→text transform via `ChannelAdapter.format` (gateway §5). */
  registerChannel(adapter: ChannelAdapter, config: ChannelConfig): void {
    this.channels.set(adapter.name, {
      adapter,
      config,
      policy: parseApprovePolicy(config.approval),
    });
  }

  /** Subscribe to the host event stream (gateway §2.2). Idempotent. */
  subscribe(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.host.onEvent((e) => this.handleEvent(e));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // -- inbound --------------------------------------------------------------

  /** Entry point for a normalized inbound message (gateway §2.2). */
  async handleInbound(channelName: string, msg: InboundMessage): Promise<void> {
    const ctx = this.channels.get(channelName);
    if (!ctx) return;
    const conv = this.getConv(channelName, msg.conversationId);
    // Refresh per-conversation routing state (e.g. WeChat context_token, §8.5).
    conv.target = { conversationId: msg.conversationId, raw: msg.raw ?? conv.target.raw };

    try {
      // 1. Inline-button click (gateway §6.1).
      if (msg.callbackData) {
        await this.resolveToken(ctx, conv, msg.callbackData);
        return;
      }
      // 2. A pending question wants a numeric answer before anything else (§6.3).
      if (conv.pendingQuestion) {
        const answers = parseAnswer(conv.pendingQuestion.questions, msg.text);
        if (answers) {
          this.host.answerQuestion(conv.pendingQuestion.questionId, answers);
          conv.pendingQuestion = undefined;
          conv.tokens.clear();
          await this.reply(ctx, conv, '✅ 已记录你的选择。');
          return;
        }
      }
      // 3. Slash command (builtin verbs only; `/<skill>` falls through as a message).
      const cmd = parseSlash(msg.text);
      if (cmd && isBuiltin(cmd.name)) {
        await this.handleCommand(ctx, conv, msg, cmd.name, cmd.arg);
        return;
      }
      // 4. Don't push a plain message into a run suspended on a gate (§6.1/§6.3).
      if (this.hasPending(conv)) {
        await this.reply(ctx, conv, this.pendingHint(conv));
        return;
      }
      // 5. A turn is already in flight: don't start a concurrent run on the same
      //    session — tell the user to wait or /stop (one turn per conversation).
      if (conv.orchRunId) {
        await this.reply(ctx, conv, '⏳ 正在处理上一条消息，请稍候，或回复 /stop 中断当前运行。');
        return;
      }
      // 6. Ordinary message → route to a session.
      await this.routeMessage(ctx, conv, msg);
    } catch (err) {
      this.onError(err);
      await this.reply(ctx, conv, `⚠ 处理消息出错：${(err as Error).message}`);
    }
  }

  private async routeMessage(ctx: ChannelCtx, conv: Conv, msg: InboundMessage): Promise<void> {
    const now = this.now();
    const existing = this.router.lookup(conv.channel, conv.conversationId);
    const text = this.composeText(msg);

    if (existing && !shouldReset(existing, ctx.config.reset, now)) {
      this.router.touch(conv.channel, conv.conversationId, now);
      const { runId } = await this.host.sendMessage(existing.sessionId, text);
      this.beginTurn(ctx, conv, existing.sessionId, runId);
      return;
    }

    const config = this.sessionConfigFor(ctx.config);
    const started = await this.host.startSession({
      name: deriveName(msg.text),
      workingDir: this.workspaceFor(ctx.config, conv.conversationId),
      goal: text,
      config,
    });
    this.router.bind(conv.channel, conv.conversationId, started.sessionId, now);
    this.beginTurn(ctx, conv, started.sessionId, started.runId);
  }

  private beginTurn(ctx: ChannelCtx, conv: Conv, sessionId: string, runId: string): void {
    conv.sessionId = sessionId;
    conv.orchRunId = runId;
    conv.turnRuns = new Set([runId]);
    conv.tokens.clear();
    conv.cards.clear();
    conv.pendingApprovals = [];
    conv.pendingQuestion = undefined;
    conv.pendingPlan = undefined;
    this.runToConv.set(runId, conv.key);

    conv.renderer = new ConversationRenderer(ctx.adapter, conv.target, {
      verbose: this.verbose,
      onError: this.onError,
    });
    conv.renderer.start();
    conv.renderer.setStatus('🤔 Thinking…'); // baseline phase until an event refines it
  }

  // -- commands (gateway §6.2) ---------------------------------------------

  private async handleCommand(
    ctx: ChannelCtx,
    conv: Conv,
    msg: InboundMessage,
    name: string,
    arg: string,
  ): Promise<void> {
    if (!commandAllowed(ctx.config, msg.userId, name)) {
      await this.reply(ctx, conv, '⛔ 你没有权限执行该命令。');
      return;
    }
    switch (name) {
      case 'new':
      case 'reset': {
        if (conv.orchRunId) this.host.abortRun(conv.orchRunId);
        this.router.unbind(conv.channel, conv.conversationId);
        this.endTurn(conv);
        conv.sessionId = undefined;
        await this.reply(ctx, conv, '🆕 已重置会话，下一条消息将开启新会话。');
        return;
      }
      case 'approve':
      case 'deny': {
        await this.resolveTextApproval(ctx, conv, name === 'approve');
        return;
      }
      case 'stop': {
        if (conv.orchRunId) {
          this.host.abortRun(conv.orchRunId);
          await this.reply(ctx, conv, '⏹ 已请求中断当前运行。');
        } else {
          await this.reply(ctx, conv, '当前没有进行中的运行。');
        }
        return;
      }
      case 'model': {
        await this.handleModel(ctx, conv, arg);
        return;
      }
      case 'mode': {
        await this.handleMode(ctx, conv, arg);
        return;
      }
      case 'platform': {
        await this.handlePlatform(ctx, conv, arg);
        return;
      }
      case 'status': {
        await this.reply(ctx, conv, this.statusText(conv));
        return;
      }
      case 'help':
      default: {
        await this.reply(ctx, conv, HELP_TEXT);
        return;
      }
    }
  }

  private async handleModel(ctx: ChannelCtx, conv: Conv, arg: string): Promise<void> {
    if (!conv.sessionId) {
      await this.reply(ctx, conv, '尚无会话，先发送一条消息再切换模型。');
      return;
    }
    if (!arg) {
      await this.reply(ctx, conv, '用法：/model <alias>（如 fast / reasoning，需已在 CLI 配置）');
      return;
    }
    const current = await this.sessionConfig(conv.sessionId);
    const next: ScopedConfig = { ...current, model: { ...current.model, orchestratorAlias: arg } };
    await this.host.updateSessionConfig(conv.sessionId, next);
    await this.reply(ctx, conv, `🤖 已切换模型别名为 \`${arg}\`（下一轮生效）。`);
  }

  private async handleMode(ctx: ChannelCtx, conv: Conv, arg: string): Promise<void> {
    if (!conv.sessionId) {
      await this.reply(ctx, conv, '尚无会话，先发送一条消息再切换模式。');
      return;
    }
    const mode = arg.trim();
    if (mode !== 'ask' && mode !== 'auto' && mode !== 'plan') {
      await this.reply(ctx, conv, '用法：/mode ask|auto|plan');
      return;
    }
    this.host.setExecutionMode(conv.sessionId, mode);
    await this.reply(ctx, conv, `⚙ 执行模式已切换为 \`${mode}\`。`);
  }

  private async handlePlatform(ctx: ChannelCtx, conv: Conv, arg: string): Promise<void> {
    if (!this.platform) {
      await this.reply(ctx, conv, '本网关未启用平台管控。');
      return;
    }
    const [sub, target] = arg.split(/\s+/, 2);
    if (sub === 'ls' || !sub) {
      const lines = this.platform.list().map((p) => `· ${p.name}: ${p.state}`);
      await this.reply(ctx, conv, lines.length ? lines.join('\n') : '无已注册通道。');
      return;
    }
    if (!target) {
      await this.reply(ctx, conv, '用法：/platform <ls|pause|resume> [通道名]');
      return;
    }
    if (sub === 'pause') {
      this.platform.pause(target);
      await this.reply(ctx, conv, `⏸ 已暂停通道 ${target}。`);
      return;
    }
    if (sub === 'resume') {
      await this.platform.resume(target);
      await this.reply(ctx, conv, `▶ 已恢复通道 ${target}。`);
      return;
    }
    await this.reply(ctx, conv, '用法：/platform <ls|pause|resume> [通道名]');
  }

  private async resolveTextApproval(ctx: ChannelCtx, conv: Conv, approve: boolean): Promise<void> {
    if (conv.pendingApprovals.length) {
      const id = conv.pendingApprovals.shift()!;
      this.host.approveTool(id, approve ? 'session' : 'reject');
      await this.reply(ctx, conv, approve ? '✅ 已批准（本会话）。' : '🚫 已拒绝。');
      return;
    }
    if (conv.pendingPlan) {
      this.host.approvePlan(conv.pendingPlan.planId, approve ? 'approve' : 'reject');
      conv.pendingPlan = undefined;
      await this.reply(ctx, conv, approve ? '✅ 计划已批准，开始执行。' : '🚫 已放弃该计划。');
      return;
    }
    await this.reply(ctx, conv, '当前没有待审批的请求。');
  }

  // -- events (gateway §2.2 / §6) ------------------------------------------

  handleEvent(e: AgentStreamEvent): void {
    // Admit a sub-agent run into its parent conversation's run tree (gateway §2.2).
    if (e.kind === 'sub-agent-start') {
      const convKey = this.runToConv.get(e.parentRunId);
      if (!convKey) return;
      const conv = this.convs.get(convKey);
      if (!conv) return;
      conv.turnRuns.add(e.runId);
      this.runToConv.set(e.runId, convKey);
      conv.subAgents.set(e.agentId, { role: e.role, status: 'running' });
      conv.renderer?.setStatus('🤖 Sub Agent running');
      void this.updateSubAgents(conv, 'start', e.agentId);
      return;
    }

    // Todo updates key by sessionId (not runId) — route to the owning conversation.
    if (e.kind === 'todo-update') {
      const conv = [...this.convs.values()].find((c) => c.sessionId === e.sessionId);
      if (conv) void this.renderTodos(conv, e.todos);
      return;
    }

    const convKey = this.runToConv.get((e as { runId?: string }).runId ?? '');
    if (!convKey) return; // not ours (mcp / sandbox / unrelated run)
    const conv = this.convs.get(convKey);
    if (!conv) return;

    switch (e.kind) {
      case 'text-delta':
        if (e.agentId === ORCHESTRATOR_AGENT_ID) conv.renderer?.appendText(e.text);
        break;
      case 'reasoning-delta':
        // Agent is thinking (§2.2): surface a phase indicator, not a silent gap.
        if (e.agentId === ORCHESTRATOR_AGENT_ID) conv.renderer?.setStatus('🤔 Thinking…');
        break;
      case 'tool-call':
        if (e.agentId === ORCHESTRATOR_AGENT_ID) conv.renderer?.setStatus('🔧 Tool calling');
        if (this.verbose) conv.renderer?.noteStatus(`🔧 ${e.toolName}`);
        break;
      case 'tool-approval-required':
        if (conv.turnRuns.has(e.runId)) void this.handleApproval(conv, e);
        break;
      case 'user-question-required':
        if (conv.turnRuns.has(e.runId)) void this.handleQuestion(conv, e);
        break;
      case 'plan-proposed':
        if (conv.turnRuns.has(e.runId)) void this.handlePlan(conv, e);
        break;
      case 'sub-agent-finish': {
        const sa = conv.subAgents.get(e.agentId);
        if (sa) {
          sa.status = 'done';
          sa.summary = e.summary;
          // Back to "thinking" once the last sub-agent finishes; otherwise others
          // are still running, so keep the sub-agent phase.
          const running = [...conv.subAgents.values()].some((x) => x.status === 'running');
          conv.renderer?.setStatus(running ? '🤖 Sub Agent running' : '🤔 Thinking…');
          void this.updateSubAgents(conv, 'finish', e.agentId);
        }
        break;
      }
      case 'auto-classified':
        if (this.verbose) conv.renderer?.noteStatus(`⚡ 自动裁决：${e.verdict}（${e.reason}）`);
        break;
      case 'run-finish':
        if (e.runId === conv.orchRunId) void this.finishTurn(conv);
        break;
      case 'error':
        if (e.runId === conv.orchRunId) void this.failTurn(conv, e.message);
        break;
    }
  }

  private async handleApproval(
    conv: Conv,
    e: Extract<AgentStreamEvent, { kind: 'tool-approval-required' }>,
  ): Promise<void> {
    const ctx = this.channels.get(conv.channel)!;
    const view = approvalView(e.toolName, e.grantScope, e.input);
    if (ctx.adapter.prompt) {
      const choices = view.choices.map((c) => ({
        id: this.allocToken(conv, { kind: 'approve', toolCallId: e.toolCallId, decision: c.decision }),
        label: c.label,
      }));
      await this.sendPrompt(conv, { kind: 'approval', text: view.text, choices });
      return;
    }
    // No interactive prompt: try the channel's auto policy, else fall to a /approve prompt.
    const decision = decide(ctx.policy, { toolName: e.toolName, grantScope: e.grantScope, input: e.input });
    if (decision !== 'reject') {
      this.host.approveTool(e.toolCallId, decision);
      await this.reply(ctx, conv, approvalAutoNotice(e.toolName, decision, e.grantScope));
    } else {
      conv.pendingApprovals.push(e.toolCallId);
      await this.reply(ctx, conv, approvalTextPrompt(view));
    }
  }

  private async handleQuestion(
    conv: Conv,
    e: Extract<AgentStreamEvent, { kind: 'user-question-required' }>,
  ): Promise<void> {
    const ctx = this.channels.get(conv.channel)!;
    conv.pendingQuestion = { questionId: e.questionId, questions: e.questions };
    const first = e.questions[0];
    const singleSelect = e.questions.length === 1 && first !== undefined && !first.multiSelect;
    if (ctx.adapter.prompt && singleSelect && first) {
      const choices = first.options.map((o) => ({
        id: this.allocToken(conv, {
          kind: 'answer',
          questionId: e.questionId,
          answers: [{ selected: [o.label] }],
        }),
        label: o.label,
      }));
      await this.sendPrompt(conv, { kind: 'question', text: `❓ **${first.question}**`, choices });
      return;
    }
    await this.reply(ctx, conv, questionPrompt(e.questions));
  }

  private async handlePlan(
    conv: Conv,
    e: Extract<AgentStreamEvent, { kind: 'plan-proposed' }>,
  ): Promise<void> {
    const ctx = this.channels.get(conv.channel)!;
    conv.pendingPlan = { planId: e.planId };
    if (ctx.adapter.prompt) {
      const choices = [
        { id: this.allocToken(conv, { kind: 'plan', planId: e.planId, approve: true }), label: '✅ 执行' },
        { id: this.allocToken(conv, { kind: 'plan', planId: e.planId, approve: false }), label: '🚫 放弃' },
      ];
      await this.sendPrompt(conv, { kind: 'plan', text: `📋 **计划**\n${e.plan}`, choices });
      return;
    }
    await this.reply(ctx, conv, `📋 **计划**\n${e.plan}\n\n回复 /approve 执行，或 /deny 放弃。`);
  }

  private async resolveToken(ctx: ChannelCtx, conv: Conv, token: string): Promise<void> {
    const action = conv.tokens.get(token);
    if (!action) return; // stale / already resolved
    let ack = '';
    switch (action.kind) {
      case 'approve':
        this.host.approveTool(action.toolCallId, action.decision);
        conv.pendingApprovals = conv.pendingApprovals.filter((id) => id !== action.toolCallId);
        ack = approveAck(action.decision);
        break;
      case 'answer':
        this.host.answerQuestion(action.questionId, action.answers);
        conv.pendingQuestion = undefined;
        ack = `✅ 已选择：${action.answers.flatMap((a) => a.selected).join('、')}`;
        break;
      case 'plan':
        this.host.approvePlan(action.planId, action.approve ? 'approve' : 'reject');
        conv.pendingPlan = undefined;
        ack = action.approve ? '✅ 计划已批准，开始执行。' : '🚫 已放弃该计划。';
        break;
    }
    await this.finalizeCard(ctx, conv, token, ack);
  }

  /**
   * Render an interactive prompt via the channel's native affordance (gateway §6.1)
   * and remember its message + tokens so a tap can finalize it in place. Only
   * called when the adapter implements `prompt` (every caller gates on it).
   */
  private async sendPrompt(conv: Conv, p: Prompt): Promise<void> {
    const ctx = this.channels.get(conv.channel)!;
    try {
      const ref = await ctx.adapter.prompt!(conv.target, p);
      const card: Card = { ref, text: p.text, tokens: p.choices.map((c) => c.id) };
      for (const c of p.choices) conv.cards.set(c.id, card);
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * After a choice arrives, finalize the prompt in place — retract the affordance
   * and append the outcome (gateway §6.1) — so it leaves a trace instead of
   * stacking unanswered cards. The channel's `resolvePrompt` owns this if present;
   * otherwise we edit the message (when `edit`) or fall back to a plain reply.
   */
  private async finalizeCard(ctx: ChannelCtx, conv: Conv, token: string, ack: string): Promise<void> {
    const card = conv.cards.get(token);
    if (card) {
      const finalText = `${card.text}\n\n${ack}`;
      try {
        if (ctx.adapter.resolvePrompt) await ctx.adapter.resolvePrompt(card.ref, finalText);
        else if (ctx.adapter.edit) await ctx.adapter.edit(card.ref, { kind: 'text', text: finalText });
        else await this.reply(ctx, conv, ack);
      } catch (err) {
        this.onError(err);
      }
      for (const tk of card.tokens) {
        conv.tokens.delete(tk);
        conv.cards.delete(tk);
      }
      return;
    }
    await this.reply(ctx, conv, ack);
    conv.tokens.delete(token);
    conv.cards.delete(token);
  }

  /**
   * Maintain a live todo checklist (gateway §5). On edit-capable channels
   * (Telegram) it edits one rich message in place; no-edit channels (WeChat) skip
   * it to avoid spamming a new list on every todo change.
   */
  private async renderTodos(conv: Conv, todos: Todo[]): Promise<void> {
    const ctx = this.channels.get(conv.channel);
    if (!ctx || todos.length === 0 || !ctx.adapter.edit) return;
    const text = renderTodoList(todos);
    try {
      if (conv.todoRef) await ctx.adapter.edit(conv.todoRef, { kind: 'text', text });
      else conv.todoRef = await ctx.adapter.send(conv.target, { kind: 'text', text });
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * Maintain the sub-agent progress card (gateway §2.3 / §5). Edit-capable
   * channels (Telegram) keep one live rich card; no-edit channels (WeChat) get a
   * short notice only on start / finish (not per tool call) to avoid spam.
   */
  private async updateSubAgents(conv: Conv, event: 'start' | 'finish', agentId: string): Promise<void> {
    const ctx = this.channels.get(conv.channel);
    if (!ctx) return;
    if (ctx.adapter.edit) {
      const text = renderSubAgentCard([...conv.subAgents.values()]);
      if (!text) return;
      try {
        if (conv.subAgentRef) await ctx.adapter.edit(conv.subAgentRef, { kind: 'text', text });
        else conv.subAgentRef = await ctx.adapter.send(conv.target, { kind: 'text', text });
      } catch (err) {
        this.onError(err);
      }
      return;
    }
    const sa = conv.subAgents.get(agentId);
    if (!sa) return;
    const line =
      event === 'start'
        ? `🤖 子代理 ${sa.role} 启动…`
        : `✅ 子代理 ${sa.role} 完成：${sa.summary ?? ''}`;
    await this.reply(ctx, conv, line);
  }

  private async finishTurn(conv: Conv): Promise<void> {
    const renderer = conv.renderer;
    this.endTurn(conv);
    await renderer?.finish();
  }

  private async failTurn(conv: Conv, message: string): Promise<void> {
    const renderer = conv.renderer;
    this.endTurn(conv);
    await renderer?.fail(message);
  }

  /** Tear down the active turn's run mappings + interactive state. */
  private endTurn(conv: Conv): void {
    for (const rid of conv.turnRuns) this.runToConv.delete(rid);
    conv.turnRuns = new Set();
    conv.orchRunId = undefined;
    conv.renderer = undefined;
    conv.tokens.clear();
    conv.pendingApprovals = [];
    conv.pendingQuestion = undefined;
    conv.pendingPlan = undefined;
    conv.todoRef = undefined;
    conv.subAgents.clear();
    conv.subAgentRef = undefined;
    conv.cards.clear();
  }

  // -- helpers --------------------------------------------------------------

  private getConv(channel: string, conversationId: string): Conv {
    const key = `${channel}:${conversationId}`;
    let conv = this.convs.get(key);
    if (!conv) {
      const existing = this.router.lookup(channel, conversationId);
      conv = {
        key,
        channel,
        conversationId,
        sessionId: existing?.sessionId,
        target: { conversationId },
        turnRuns: new Set(),
        tokens: new Map(),
        cards: new Map(),
        tokenSeq: 0,
        pendingApprovals: [],
        subAgents: new Map(),
      };
      this.convs.set(key, conv);
    }
    return conv;
  }

  private allocToken(conv: Conv, action: PendingAction): string {
    const token = `t${conv.tokenSeq++}`;
    conv.tokens.set(token, action);
    return token;
  }

  private hasPending(conv: Conv): boolean {
    return (
      conv.pendingApprovals.length > 0 || conv.pendingQuestion !== undefined || conv.pendingPlan !== undefined
    );
  }

  private pendingHint(conv: Conv): string {
    if (conv.pendingQuestion) return questionPrompt(conv.pendingQuestion.questions);
    if (conv.pendingPlan) return '有一个待决定的计划：回复 /approve 执行，或 /deny 放弃。';
    return '有一个待审批的高风险调用：回复 /approve 批准，或 /deny 拒绝。';
  }

  private composeText(msg: InboundMessage): string {
    if (msg.text.trim()) return msg.text;
    if (msg.attachments?.length) return '（用户发送了附件，但当前通道暂不支持附件处理）';
    return msg.text;
  }

  private sessionConfigFor(cc: ChannelConfig): ScopedConfig | undefined {
    if (!cc.session) return undefined;
    const { workingDir: _omit, ...rest } = cc.session;
    void _omit;
    return rest;
  }

  /**
   * Resolve a conversation's file-boundary working directory (gateway §4.2). With
   * a base `workingDir`, `per-user` (default) isolates each conversation into its
   * own subdirectory — so different accounts can't see each other's files — while
   * `shared` uses the base dir for everyone. With no base, core's per-session
   * scratch already isolates by session.
   */
  private workspaceFor(cc: ChannelConfig, conversationId: string): string | undefined {
    const base = cc.session?.workingDir;
    if (!base || cc.workspace === 'shared') return base;
    const dir = join(base, conversationId.replace(/[^A-Za-z0-9_-]/g, '_'));
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.onError(err);
    }
    return dir;
  }

  private async sessionConfig(sessionId: string): Promise<ScopedConfig> {
    const sessions = await this.host.listSessions();
    const s: Session | undefined = sessions.find((x) => x.id === sessionId);
    return s?.config ?? {};
  }

  private statusText(conv: Conv): string {
    const lines = [
      `通道：${conv.channel}`,
      `会话：${conv.sessionId ?? '（未创建）'}`,
      `运行中：${conv.orchRunId ? '是' : '否'}`,
    ];
    if (this.platform) {
      lines.push('平台：');
      for (const p of this.platform.list()) lines.push(`  · ${p.name}: ${p.state}`);
    }
    return lines.join('\n');
  }

  private async reply(ctx: ChannelCtx, conv: Conv, text: string): Promise<void> {
    try {
      await ctx.adapter.send(conv.target, { kind: 'text', text });
    } catch (err) {
      this.onError(err);
    }
  }
}

function approveAck(decision: ApprovalDecision): string {
  if (decision === 'reject') return '🚫 已拒绝。';
  if (decision === 'once') return '✅ 允许一次。';
  return '✅ 本会话允许。';
}

function deriveName(text: string): string {
  const first = text.split('\n', 1)[0]!.trim();
  return first.length > 48 ? first.slice(0, 47) + '…' : first || 'Chat';
}

const HELP_TEXT = [
  '可用命令：',
  '/new /reset — 重置会话',
  '/approve /deny — 批准 / 拒绝高风险调用或计划',
  '/stop — 中断当前运行',
  '/model <alias> — 临时切换模型别名',
  '/mode ask|auto|plan — 切换执行模式',
  '/platform ls|pause|resume [通道] — 通道管控',
  '/status — 查看状态',
  '/<skill> … — 触发技能（直接作为消息发送）',
].join('\n');
