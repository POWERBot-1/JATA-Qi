// One-shot bootstrap for the full JATA Qi stack. Useful for embedders and the CLI.

import { Kernel, type KernelOptions, Logger } from '@jataqi/core-kernel';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { VectorSearchModule, type VectorModuleConfig } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule, type KnowledgeGraphConfig } from '@jataqi/knowledge-graph';
import { CommercialControlPlaneModule, type CommercialControlPlaneConfig } from '@jataqi/commercial-control-plane';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import { GitHubExecutionModule } from '@jataqi/github-execution';
import { CopilotExecutionAdapterModule } from '@jataqi/copilot-execution-adapter';
import { AutonomousTestRepairModule } from '@jataqi/autonomous-test-repair';
import { AutonomousDeploymentModule } from '@jataqi/autonomous-deployment';
import { InfrastructureStateRegistryModule } from '@jataqi/infrastructure-state-registry';
import { PaymentsModule } from '@jataqi/payments';
import { BillingModule } from '@jataqi/billing';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import { UniversalVisibilityFabricModule } from '@jataqi/universal-visibility-fabric';
import { UniversalDistributionNervousSystemModule } from '@jataqi/universal-distribution-nervous-system';
import { ReconciliationModule } from '@jataqi/reconciliation';
import { CommercialAnalyticsModule } from '@jataqi/commercial-analytics';
import { CommercialIntelligenceModule } from '@jataqi/commercial-intelligence';
import { PortfolioGovernorModule } from '@jataqi/portfolio-governor';
import { CommercialMemoryModule } from '@jataqi/commercial-memory';
import { CommercialHealthModule } from '@jataqi/commercial-health';
import { CommercialObservabilityModule } from '@jataqi/commercial-observability';
import { CommercialEventStreamModule } from '@jataqi/commercial-event-stream';
import { CommercialCommandCenterModule } from '@jataqi/commercial-command-center';
import { AutonomousVentureFactoryModule } from '@jataqi/autonomous-venture-factory';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import { MultiAgentCognitionModule } from '@jataqi/multi-agent-cognition';
import { MetaReasoningModule } from '@jataqi/meta-reasoning';
import { ProbabilisticEngineModule } from '@jataqi/probabilistic-engine';
import { HypothesisEngineModule } from '@jataqi/hypothesis-engine';
import { WorldModelModule } from '@jataqi/world-model';
import { CausalEngineModule } from '@jataqi/causal-engine';
import { TemporalEngineModule } from '@jataqi/temporal-engine';
import { OrbitalIntelligenceModule } from '@jataqi/orbital-intelligence';
import { ReproducibilityModule } from '@jataqi/reproducibility';
import { ResearchEvidenceModule } from '@jataqi/research-evidence';
import { HumanApprovalModule } from '@jataqi/human-approval';
import { RegulatoryGateModule } from '@jataqi/regulatory-gates';
import { PermanenceFabricModule } from '@jataqi/permanence-fabric';
import { CapabilityFabricModule } from '@jataqi/capability-fabric';
import { UnifiedLoopModule } from '@jataqi/unified-loop';
import { LoopHostModule } from '@jataqi/loop-host';
import {
  AgentRuntimeModule,
  EchoLLM,
  OpenAILLM,
  type AgentModuleConfig,
  type ILLM,
} from '@jataqi/agent-runtime';
import { readConfig } from './config.js';

export interface JataQiConfig {
  /** Kernel-level overrides. */
  kernel?: KernelOptions;
  /** Storage driver: 'memory' (default) or development-only single-process 'filesystem'. */
  storage?: StorageModuleConfig & { fsRoot?: string };
  /** Embedding + vector search config. */
  vector?: VectorModuleConfig;
  /** Knowledge graph config. */
  graph?: KnowledgeGraphConfig;
  /** Governed commercial decision/action control plane config. */
  commercialControlPlane?: CommercialControlPlaneConfig;
  /** Agent runtime config. */
  agent?: AgentModuleConfig;
  /**
   * O-01 continuous-operation host. Disabled by default: the module is only
   * registered when `enabled` is explicitly true, and even then the host
   * starts IDLE — an operator must call `start()` and `tick()`/`recover()`.
   * There is no automatic production start.
   */
  loopHost?: { enabled?: boolean; leaseTtlMs?: number; maxBatch?: number; sleepDelayMs?: number; autoTickMs?: number };
}

export interface JataQiInstance {
  kernel: Kernel;
  /** Shut down JATA Qi cleanly. */
  shutdown: () => Promise<void>;
}

/** Build and boot a fully-wired JATA Qi kernel using explicit config. */
export async function createJataQi(cfg: JataQiConfig = {}): Promise<JataQiInstance> {
  const kernel = new Kernel(cfg.kernel);

  const storageCfg: StorageModuleConfig = {
    driver: cfg.storage?.driver ?? 'memory',
    fsRoot: cfg.storage?.fsRoot,
    driverInstance: cfg.storage?.driverInstance,
  };
  kernel.register(new StorageModule(storageCfg));
  kernel.register(new CommercialControlPlaneModule(cfg.commercialControlPlane));
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new ExternalConnectorModule());
  kernel.register(new UniversalVisibilityFabricModule());
  kernel.register(new UniversalDistributionNervousSystemModule());
  kernel.register(new GitHubExecutionModule());
  kernel.register(new CopilotExecutionAdapterModule());
  kernel.register(new AutonomousTestRepairModule());
  kernel.register(new AutonomousDeploymentModule());
  kernel.register(new InfrastructureStateRegistryModule());
  kernel.register(new PaymentsModule());
  kernel.register(new BillingModule());
  kernel.register(new RevenueLedgerModule());
  kernel.register(new ReconciliationModule());
  kernel.register(new CommercialAnalyticsModule());
  kernel.register(new CommercialIntelligenceModule());
  kernel.register(new AutonomousVentureFactoryModule());
  kernel.register(new PortfolioGovernorModule());
  kernel.register(new CommercialMemoryModule());
  kernel.register(new CommercialHealthModule());
  kernel.register(new CommercialObservabilityModule());
  kernel.register(new CommercialEventStreamModule());
  kernel.register(new CommercialCommandCenterModule());
  kernel.register(new CognitiveKernelModule());
  kernel.register(new MultiAgentCognitionModule());
  kernel.register(new MetaReasoningModule());
  kernel.register(new ProbabilisticEngineModule());
  kernel.register(new HypothesisEngineModule());
  kernel.register(new WorldModelModule());
  kernel.register(new CausalEngineModule());
  kernel.register(new TemporalEngineModule());
  kernel.register(new OrbitalIntelligenceModule());
  kernel.register(new ReproducibilityModule());
  kernel.register(new ResearchEvidenceModule());
  kernel.register(new HumanApprovalModule());
  kernel.register(new RegulatoryGateModule());
  kernel.register(new PermanenceFabricModule());
  kernel.register(new CapabilityFabricModule());
  kernel.register(
    new VectorSearchModule(cfg.vector ?? { model: 'hash', hashDim: 128 }),
  );
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule(cfg.graph));
  kernel.register(
    new AgentRuntimeModule({
      llm: cfg.agent?.llm ?? new EchoLLM(),
      ...cfg.agent,
    }),
  );
  // W22 (C-1): native in-repo unified cognitive/execution loop driver. It owns
  // orchestration over the existing fabric; it adds no engine and performs no
  // external action unless explicitly governed and authorized.
  kernel.register(new UnifiedLoopModule());
  // O-01: durable continuous-operation host driver. Opt-in only (disabled by
  // default); registers IDLE and never auto-starts background work.
  if (cfg.loopHost?.enabled === true) {
    kernel.register(
      new LoopHostModule({
        leaseTtlMs: cfg.loopHost.leaseTtlMs,
        maxBatch: cfg.loopHost.maxBatch,
        sleepDelayMs: cfg.loopHost.sleepDelayMs,
        autoTickMs: cfg.loopHost.autoTickMs,
      }),
    );
  }

  await kernel.boot();
  return {
    kernel,
    shutdown: () => kernel.shutdown(),
  };
}

/** Build JATA Qi using environment variables / .env (see .env.example). */
export async function createJataQiFromEnv(overrides: JataQiConfig = {}): Promise<JataQiInstance> {
  const env = readConfig();
  const llm: ILLM =
    overrides.agent?.llm ??
    (env.AGENT_LLM === 'openai' && env.OPENAI_API_KEY
      ? new OpenAILLM({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL })
      : new EchoLLM());
  return createJataQi({
    storage: {
      driver: env.STORAGE_DRIVER as any ?? 'memory',
      fsRoot: env.STORAGE_FS_ROOT,
      ...(overrides.storage ?? {}),
    },
    vector: {
      model: (env.VECTOR_MODEL as any) ?? 'hash',
      hashDim: env.VECTOR_HASH_DIM ?? 128,
      metric: (env.VECTOR_METRIC as any) ?? 'cosine',
      openai: env.OPENAI_API_KEY
        ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_EMBEDDING_MODEL }
        : undefined,
      ...(overrides.vector ?? {}),
    },
    agent: { llm, ...(overrides.agent ?? {}) },
    graph: overrides.graph,
    commercialControlPlane: overrides.commercialControlPlane,
    kernel: overrides.kernel,
  });
}

export { Logger };
