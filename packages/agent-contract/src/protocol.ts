/**
 * 宿主↔agent 之间线路契约（AgentStreamEvent 事件流 + AgentHost 命令/回复语义）的
 * 版本号。任何对事件形状、命令签名或回复语义的破坏性改动都要 +1；纯增量的可选字段不用改。
 * 宿主在启动握手时对比这个值，不匹配则告警/拒绝，避免形状漂移导致的静默失效。
 */
export const PROTOCOL_VERSION = 1;
