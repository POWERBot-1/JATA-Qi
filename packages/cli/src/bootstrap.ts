// One-shot bootstrap for the full JATA Qi stack. Useful for embedders and the CLI.

import { Kernel, type KernelOptions, Logger } from '@jataqi/core-kernel';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { VectorSearchModule, type VectorModuleConfig } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule, type KnowledgeGraphConfig } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM, type AgentModuleConfig } from '@jataqi/agent-runtime';

export interface JataQiConfig {
  /** Kernel-level overrides. */
  kernel?: KernelOptions;
  /** Storage driver: 'memory' (default) or 'filesystem'. */
  storage?: StorageModuleConfig & { fsRoot?: string };
  /** Embedding + vector search config. */
  vector?: VectorModuleConfig;
  /** Knowledge graph config. */
  graph?: KnowledgeGraphConfig;
  /** Agent runtime config. */
  agent?: AgentModuleConfig;
}

export interface JataQiInstance {
  kernel: Kernel;
  /** Shut down JATA Qi cleanly. */
  shutdown: () => Promise<void>;
}

/** Build and boot a fully-wired JATA Qi kernel. */
export async function createJataQi(cfg: JataQiConfig = {}): Promise<JataQiInstance> {
  const kernel = new Kernel(cfg.kernel);

  const storageCfg: StorageModuleConfig = {
    driver: cfg.storage?.driver ?? 'memory',
    fsRoot: cfg.storage?.fsRoot,
    driverInstance: cfg.storage?.driverInstance,
  };
  kernel.register(new StorageModule(storageCfg));
  kernel.register(new VectorSearchModule(cfg.vector ?? { model: 'hash', hashDim: 128 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule(cfg.graph));
  kernel.register(
    new AgentRuntimeModule({
      llm: cfg.agent?.llm ?? new EchoLLM(),
      ...cfg.agent,
    }),
  );

  await kernel.boot();
  return {
    kernel,
    shutdown: () => kernel.shutdown(),
  };
}

export { Logger };
