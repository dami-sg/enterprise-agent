/**
 * Bootstrap (cli §2.1): construct the single in-process `AgentHost` plus the
 * config/skill stores the read-only views (§9) and provider/auth flows (§10)
 * drive. Everything shares one app-data root (`~/.enterprise-agent`, agent §5.2)
 * so the CLI and desktop see the same providers, keys, sessions and skills.
 */
import {
  createAgentHost,
  createPaths,
  ConfigStore,
  ModelMetaRegistry,
  ModelsDevStore,
  SkillRegistry,
  type AgentHost,
  type Paths,
  type KeyStore,
  type MemoryPort,
  type SkillMeta,
  type SkillHit,
} from '@enterprise-agent/agent';
import { createKeychain, type KeychainInfo } from './keychain.js';

export interface CliContext {
  host: AgentHost;
  config: ConfigStore;
  meta: ModelMetaRegistry;
  paths: Paths;
  keychain: KeyStore;
  keychainInfo: KeychainInfo;
  /** Skills in a session's effective scope: global + the session's overrides. */
  skillsForScope(sessionId?: string): SkillMeta[];
  /** Relevance-ranked skill search within a session's effective scope (§3.6). */
  searchForScope(query: string, sessionId?: string): SkillHit[];
  dispose(): Promise<void>;
}

export interface BootstrapOptions {
  /** App data root; defaults to ENTERPRISE_AGENT_HOME or ~/.enterprise-agent. */
  root?: string;
  /**
   * Cross-session memory backend (memory §1). When omitted the host runs with no
   * memory port — the turn-loop hooks degrade to no-ops. The gateway supplies a
   * concrete port (e.g. the mock) via its own backend factory.
   */
  memory?: MemoryPort;
}

export function bootstrap(opts: BootstrapOptions = {}): CliContext {
  const paths = createPaths(opts.root);
  const keychainInfo = createKeychain(paths.root);
  const host = createAgentHost({ root: opts.root, keychain: keychainInfo.store, memory: opts.memory });
  const config = new ConfigStore(paths);
  const meta = new ModelMetaRegistry();
  // Share the host's models.dev catalog so config views (§9) show real context
  // window + pricing for discovered/custom models. The host owns the refresh;
  // this store reads the same on-disk cache (agent §2.6).
  const modelsDev = new ModelsDevStore(paths.modelsDevCache);
  meta.setExternalResolver(modelsDev.resolver());
  void modelsDev.refresh();

  return {
    host,
    config,
    meta,
    paths,
    keychain: keychainInfo.store,
    keychainInfo,
    skillsForScope(sessionId?: string): SkillMeta[] {
      return new SkillRegistry(scopeRoots(paths, sessionId)).list();
    },
    searchForScope(query: string, sessionId?: string): SkillHit[] {
      return new SkillRegistry(scopeRoots(paths, sessionId)).search(query);
    },
    async dispose(): Promise<void> {
      await host.dispose();
    },
  };
}

/** Skill discovery roots for a scope: global, plus the session's overrides. */
function scopeRoots(paths: Paths, sessionId?: string): string[] {
  return sessionId ? [paths.skills, paths.sessionSkills(sessionId)] : [paths.skills];
}
