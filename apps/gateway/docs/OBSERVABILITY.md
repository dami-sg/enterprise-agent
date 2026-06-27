# Gateway 可观测性指南

> 实现见 [observability-and-diagnostics.md](../../../specs/observability-and-diagnostics.md)。本文是运维向的速查：日志在哪、怎么排障、怎么接 APM。

## 日志与错误在哪

App 数据根目录默认 `~/.enterprise-agent/`：

| 文件 | 内容 | 写入者 |
| --- | --- | --- |
| `gateway/gateway.log` | 网关运行日志（启动/通道/每轮 turn/错误），按 5 MiB 轮转、保留 3 份 | `ea-gateway start` |
| `logs/errors.jsonl` | 结构化错误（agent 运行错误、MCP 故障、进程级 fatal），已脱敏 | host（所有壳共享） |
| `sessions/<id>/runs.jsonl` | run 树（主→子 agent 委派） | host |
| `sessions/<id>/audit.jsonl` | 工具调用 + 审批决定 | host |

排障第一步：`ea-gateway doctor`（通道 token / 进程状态 / 最近错误）或 `ea doctor`（密钥 / 沙箱 / MCP / 磁盘 / 模型 + 最近错误）。

## 日志级别与格式

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `EA_LOG_FORMAT` | `text`（人读）\| `json`（ndjson 采集） | TTY→text，否则 json |
| `EA_LOG_MAX_BYTES` | 单个 `gateway.log` 轮转阈值 | 5 MiB |
| `EA_LOG_KEEP` | 轮转保留份数 | 3 |

`gateway.log` 的每行带 `runId` / `sessionId` / `channel`，可与 `runs.jsonl` 对齐排障：

```sh
grep '"runId":"r_ab12"' ~/.enterprise-agent/gateway/gateway.log
```

## 接入 OpenTelemetry（可选）

本仓默认**不**绑定任何 `@opentelemetry/*` 依赖、零额外开销。需要把模型调用的 span（token / 延迟 / 工具调用）送进企业 APM 时，按需开启：

1. 设 `EA_OTEL=1`，让 agent 给每次模型调用打开 AI SDK 的 `experimental_telemetry`。
2. 在宿主进程 `--require` 一个 OTel NodeSDK，由它采集 AI SDK 自动产生的 span。

```sh
# 安装（仅运维侧，不进本仓 deps）
npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
      @opentelemetry/exporter-trace-otlp-http

# otel.mjs —— 启动一个 NodeSDK 指向你的 collector
# import { NodeSDK } from '@opentelemetry/sdk-node';
# import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
# new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }) }).start();

EA_OTEL=1 node --import ./otel.mjs apps/gateway/dist/bin.js start
```

span 的 `functionId` 区分 `orchestrator` / `sub-agent`，`metadata` 带 `runId` / `agentId`，与 `runs.jsonl` 和 `errors.jsonl` 同源。

> 不开 `EA_OTEL` 时该参数完全不传——无任何运行时开销。本仓自带的成本核算（accountant）、`errors.jsonl`、run 树已覆盖大部分自运维需求；OTel 只服务接入企业级 APM 的场景。
