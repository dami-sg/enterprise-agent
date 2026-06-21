/**
 * Test fakes: a scripted `AgentHost` that records the commands the Dispatcher
 * issues, and a configurable `ChannelAdapter` that records outbound payloads and
 * can present (or withhold) the optional capabilities — letting one test drive
 * the full-capability (Telegram-like) path and another the weakest (WeChat-like).
 */
import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  ExecutionMode,
  PlanDecision,
  ScopedConfig,
  Session,
  StartSessionInput,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';
import type {
  ChannelAdapter,
  InboundMessage,
  MessageRef,
  OutboundPayload,
  Prompt,
  SendTarget,
} from '../src/channels/adapter.js';

export interface HostCalls {
  startSession: StartSessionInput[];
  sendMessage: Array<{ sessionId: string; text: string }>;
  approveTool: Array<{ toolCallId: string; decision: ApprovalDecision }>;
  answerQuestion: Array<{ questionId: string; answers: UserQuestionAnswer[] | null }>;
  approvePlan: Array<{ planId: string; decision: PlanDecision }>;
  abortRun: string[];
  setExecutionMode: Array<{ sessionId: string; mode: ExecutionMode }>;
  updateSessionConfig: Array<{ sessionId: string; config: ScopedConfig }>;
}

export class FakeHost {
  readonly calls: HostCalls = {
    startSession: [],
    sendMessage: [],
    approveTool: [],
    answerQuestion: [],
    approvePlan: [],
    abortRun: [],
    setExecutionMode: [],
    updateSessionConfig: [],
  };
  readonly sessions: Session[] = [];
  private sid = 0;
  private rid = 0;
  private listener?: (e: AgentStreamEvent) => void;

  async startSession(input: StartSessionInput): Promise<{ sessionId: string; runId: string }> {
    this.calls.startSession.push(input);
    const sessionId = `s${++this.sid}`;
    const runId = `orch-${++this.rid}`;
    this.sessions.push({ id: sessionId, config: input.config ?? {} } as Session);
    return { sessionId, runId };
  }

  async sendMessage(sessionId: string, text: string): Promise<{ runId: string }> {
    this.calls.sendMessage.push({ sessionId, text });
    return { runId: `orch-${++this.rid}` };
  }

  approveTool(toolCallId: string, decision: ApprovalDecision): void {
    this.calls.approveTool.push({ toolCallId, decision });
  }

  answerQuestion(questionId: string, answers: UserQuestionAnswer[] | null): void {
    this.calls.answerQuestion.push({ questionId, answers });
  }

  approvePlan(planId: string, decision: PlanDecision): void {
    this.calls.approvePlan.push({ planId, decision });
  }

  abortRun(runId: string): void {
    this.calls.abortRun.push(runId);
  }

  setExecutionMode(sessionId: string, mode: ExecutionMode): void {
    this.calls.setExecutionMode.push({ sessionId, mode });
  }

  async updateSessionConfig(sessionId: string, config: ScopedConfig): Promise<Session> {
    this.calls.updateSessionConfig.push({ sessionId, config });
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.config = config;
    return s ?? ({ id: sessionId, config } as Session);
  }

  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }

  onEvent(listener: (e: AgentStreamEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(e: AgentStreamEvent): void {
    this.listener?.(e);
  }

  asHost(): AgentHost {
    return this as unknown as AgentHost;
  }
}

export interface FakeAdapterOptions {
  name?: string;
  maxChars?: number;
  buttons?: boolean; // implements `prompt` (inline-button platform)
  edit?: boolean; // implements edit (streaming)
  typing?: boolean; // implements typing
  resolvePrompt?: boolean; // implements resolvePrompt (else dispatcher edits/replies)
}

export class FakeAdapter implements ChannelAdapter {
  readonly name: string;
  readonly maxChars: number;
  readonly sends: Array<{ target: SendTarget; payload: OutboundPayload }> = [];
  readonly edits: Array<{ ref: MessageRef; payload: OutboundPayload }> = [];
  readonly typings: Array<{ target: SendTarget; on: boolean }> = [];
  readonly prompts: Array<{ target: SendTarget; prompt: Prompt }> = [];
  readonly resolves: Array<{ ref: MessageRef; finalText: string }> = [];
  edit?: (ref: MessageRef, payload: OutboundPayload) => Promise<void>;
  typing?: (target: SendTarget, on: boolean) => Promise<void>;
  prompt?: (target: SendTarget, p: Prompt) => Promise<MessageRef>;
  resolvePrompt?: (ref: MessageRef, finalText: string) => Promise<void>;
  private mid = 0;

  constructor(opts: FakeAdapterOptions = {}) {
    this.name = opts.name ?? 'telegram';
    this.maxChars = opts.maxChars ?? 4096;
    if (opts.edit) {
      this.edit = async (ref, payload) => {
        this.edits.push({ ref, payload });
      };
    }
    if (opts.typing) {
      this.typing = async (target, on) => {
        this.typings.push({ target, on });
      };
    }
    if (opts.buttons) {
      // A button channel renders a prompt's choices as a buttons payload; reuse
      // `send` so existing assertions on kind:'buttons' keep working.
      this.prompt = async (target, p) => {
        this.prompts.push({ target, prompt: p });
        return this.send(target, { kind: 'buttons', text: p.text, buttons: p.choices });
      };
    }
    if (opts.resolvePrompt) {
      this.resolvePrompt = async (ref, finalText) => {
        this.resolves.push({ ref, finalText });
      };
    }
  }

  async start(): Promise<void> {
    /* the runtime starts adapters; tests drive handleInbound directly */
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef> {
    this.sends.push({ target, payload });
    return { conversationId: target.conversationId, messageId: `m${++this.mid}` };
  }

  async stop(): Promise<void> {}

  /** Last text payload sent (convenience for assertions). */
  lastText(): string | undefined {
    for (let i = this.sends.length - 1; i >= 0; i--) {
      const p = this.sends[i]!.payload;
      if (p.kind === 'text') return p.text;
      if (p.kind === 'buttons') return p.text;
    }
    return undefined;
  }
}

/** Let queued microtasks (the renderer/handlers' async chains) settle. */
export function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export function inbound(partial: Partial<InboundMessage> & { conversationId: string }): InboundMessage {
  return {
    channel: 'telegram',
    userId: 'u1',
    text: '',
    ...partial,
  };
}
