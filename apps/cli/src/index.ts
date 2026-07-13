/**
 * @dami-sg/cli — the CLI shell (cli-architecture.md). The default
 * binary is `ea` (see bin.ts); this barrel exports the reusable pieces a host
 * or test can drive: the render-agnostic trace core (cli §5.3), the bootstrap,
 * and the Commander program.
 */
export * from './core/trace.js';
export * from './core/glyphs.js';
export { bootstrap, type CliContext, type BootstrapOptions } from './host/bootstrap.js';
export { createKeychain, type KeychainInfo } from './host/keychain.js';
export { resolveWorkingDir } from './host/resolve.js';
export { buildProgram } from './commands/program.js';
export { runHeadless, EXIT, type RunOptions } from './headless/run.js';
export { LineRenderer, JsonRenderer, type Renderer } from './headless/render.js';
export { parseApprovePolicy, decide, type ApprovePolicy } from './headless/policy.js';
