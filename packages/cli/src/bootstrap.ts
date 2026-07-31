// One-shot bootstrap for the full JATA Qi stack. Useful for embedders and the CLI.

import { Kernel, type KernelOptions, Logger } from '@jataqi/core-kernel';
import { StorageModule, type StorageModuleConfig } from '@jataqi/storage';
import { VectorSearchModule, type VectorModuleConfig } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule, type KnowledgeGraphConfig } from '@jataqi/knowledge-graph';
import {
  AgentRuntimeModule,
  EchoLLM,
  OpenAILLM,
  type AgentModuleConfig,
  type ILLM,
} from '@jataqi/agent-runtime';
import { QiLModule } from '@jataqi/qil';
import { SecurityModule, type SecurityModuleConfig } from '@jataqi/security';
import { OrchestratorModule } from '@jataqi/orchestrator';
import { ApiGatewayModule, type GatewayOptions } from '@jataqi/api-gateway';
import { MetricsModule } from '@jataqi/metrics';
import { SimulationModule } from '@jataqi/simulation';
import { TeamCoordinatorModule } from '@jataqi/teams';
import { PluginManagerModule } from '@jataqi/plugins';
import { ModelRegistryModule } from '@jataqi/model-registry';
import { SchedulerModule } from '@jataqi/scheduler';
import { ComputeModule, computeTools } from '@jataqi/compute';
import { RoboticsModule } from '@jataqi/robotics';
import { DigitalTwinModule } from '@jataqi/digital-twin';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { ReadinessModule } from '@jataqi/readiness';
import { ProvenanceModule } from '@jataqi/provenance';
import { CommerceModule } from '@jataqi/commerce';
import { OrganizationsModule } from '@jataqi/organizations';
import { NotificationsModule } from '@jataqi/notifications';
import { PoliciesModule } from '@jataqi/policies';
import { FeatureFlagsModule } from '@jataqi/feature-flags';
import { PrivacyModule } from '@jataqi/privacy';
import { PolicyGovernanceModule } from '@jataqi/policy-governance';
import { MultimediaModule } from '@jataqi/multimedia';
import { EvalsModule } from '@jataqi/evals';
import { FinanceModule } from '@jataqi/finance';
import { CommunicationModule } from '@jataqi/communication';
import { ResearchModule } from '@jataqi/research';
import { EducationModule } from '@jataqi/education';
import { HealthModule } from '@jataqi/health';
import { SelfEvolutionModule } from '@jataqi/self-evolution';
import { SupplyChainModule } from '@jataqi/supply-chain';
import { EnvironmentModule } from '@jataqi/environment';
import { CyberdefenseModule } from '@jataqi/cyberdefense';
import { IoTModule } from '@jataqi/iot';
import { SmartCitiesModule } from '@jataqi/smart-cities';
import { CloudDevopsModule } from '@jataqi/cloud-devops';
import { LocalizationModule } from '@jataqi/localization';
import { EnterpriseModule } from '@jataqi/enterprise';
import { MFAModule } from '@jataqi/mfa';
import { DisasterRecoveryModule } from '@jataqi/disaster-recovery';
import { OptimizationModule } from '@jataqi/optimization';
import { SyntheticDataModule } from '@jataqi/synthetic-data';
import { BusinessIntelligenceModule } from '@jataqi/business-intelligence';
import { WebUIModule } from '@jataqi/web-ui';
import { MultimodalModule } from '@jataqi/multimodal';
import { SovereignModule } from '@jataqi/sovereign';
import { LLMGatewayModule, openaiProvider, mockProvider } from '@jataqi/llm-gateway';
import { readConfig } from './config.js';

function readConfigEnv(key: string): string | undefined {
  return process.env[key];
}

/** A small default model catalog, seeded into the registry at boot. */
const DEFAULT_MODELS = [
  { id: 'echo', provider: 'jataqi', name: 'EchoLLM', capabilities: ['chat'], quality: 1, latencyMs: 0, inputCostPer1k: 0, outputCostPer1k: 0, default: true },
  { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini', capabilities: ['chat', 'reasoning', 'tool-use', 'code'], contextWindow: 128000, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006, latencyMs: 900, quality: 72 },
  { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', capabilities: ['chat', 'reasoning', 'vision', 'tool-use', 'code'], contextWindow: 128000, inputCostPer1k: 0.0025, outputCostPer1k: 0.01, latencyMs: 1400, quality: 90 },
  { id: 'text-embedding-3-small', provider: 'openai', name: 'Text Embedding 3 Small', capabilities: ['embedding'], inputCostPer1k: 0.00002, latencyMs: 200, quality: 70 },
];

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
  /** Security / identity config (bootstrap admin, roles, session ttl). */
  security?: SecurityModuleConfig;
  /** HTTP gateway options. */
  gateway?: GatewayOptions;
}

export interface JataQiInstance {
  kernel: Kernel;
  /** Convenience handle to the API gateway module (not listening until serve()). */
  gateway?: ApiGatewayModule;
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
  kernel.register(
    new VectorSearchModule(cfg.vector ?? { model: 'hash', hashDim: 128 }),
  );
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule(cfg.graph));
  kernel.register(new ComputeModule());
  const { extraTools: userTools, ...restAgent } = cfg.agent ?? {};
  kernel.register(
    new AgentRuntimeModule({
      ...restAgent,
      llm: cfg.agent?.llm ?? new EchoLLM(),
      extraTools: [...computeTools(), ...(userTools ?? [])],
    }),
  );
  kernel.register(new QiLModule());
  kernel.register(new SecurityModule(cfg.security));
  kernel.register(new OrchestratorModule());
  kernel.register(new MetricsModule());
  kernel.register(new SimulationModule());
  kernel.register(new TeamCoordinatorModule());
  kernel.register(new PluginManagerModule());
  kernel.register(new ModelRegistryModule({ models: DEFAULT_MODELS }));
  kernel.register(new SchedulerModule({ defaultCapacity: 4 }));
  kernel.register(new RoboticsModule());
  kernel.register(new DigitalTwinModule());
  kernel.register(new ToolIntelligenceModule());
  kernel.register(new ReadinessModule());
  kernel.register(new ProvenanceModule());
  kernel.register(new CommerceModule());
  kernel.register(new OrganizationsModule());
  kernel.register(new NotificationsModule());
  kernel.register(new PoliciesModule());
  kernel.register(new FeatureFlagsModule());
  kernel.register(new PrivacyModule());
  kernel.register(new PolicyGovernanceModule());
  kernel.register(new MultimediaModule());
  kernel.register(new EvalsModule());
  kernel.register(new FinanceModule());
  kernel.register(new CommunicationModule());
  kernel.register(new ResearchModule());
  kernel.register(new EducationModule());
  kernel.register(new HealthModule());
  kernel.register(new SelfEvolutionModule());
  kernel.register(new SupplyChainModule());
  kernel.register(new EnvironmentModule());
  kernel.register(new CyberdefenseModule());
  kernel.register(new IoTModule());
  kernel.register(new SmartCitiesModule());
  kernel.register(new CloudDevopsModule());
  kernel.register(new LocalizationModule());
  kernel.register(new EnterpriseModule());
  kernel.register(new MFAModule());
  kernel.register(new DisasterRecoveryModule());
  kernel.register(new OptimizationModule());
  kernel.register(new SyntheticDataModule());
  kernel.register(new BusinessIntelligenceModule());
  kernel.register(new WebUIModule());
  kernel.register(new MultimodalModule());
  kernel.register(new SovereignModule());
  kernel.register(new LLMGatewayModule());

  // Register LLM providers based on environment configuration.
  const llmGateway = kernel.getModule<LLMGatewayModule>('llm-gateway');
  const llmChoice = (readConfigEnv('AGENT_LLM') ?? 'echo');
  if (llmChoice === 'openai' && readConfigEnv('OPENAI_API_KEY')) {
    llmGateway.registerProvider(openaiProvider({
      apiKey: readConfigEnv('OPENAI_API_KEY'),
      model: readConfigEnv('OPENAI_CHAT_MODEL') ?? 'gpt-4o-mini',
    }));
    kernel.logger.info('LLM gateway: OpenAI provider registered');
  } else if (llmChoice !== 'echo') {
    // Register the mock provider as a non-echo default for non-openai configs.
    llmGateway.registerProvider(mockProvider({ tier: 'primary', priority: 1 }));
    kernel.logger.info('LLM gateway: mock provider registered (set AGENT_LLM=openai + OPENAI_API_KEY for production)');
  }
  const gateway = new ApiGatewayModule(cfg.gateway);
  kernel.register(gateway);

  await kernel.boot();

  // Seed a default, locally-invocable tool so the Universal Tool layer is
  // demonstrably usable out of the box (echo capability, R0 read-only).
  const tools = kernel.getModule<ToolIntelligenceModule>('tool-intelligence');
  const echoTool = await tools.register({
    canonicalName: 'echo',
    displayName: 'Echo Tool',
    provider: 'jataqi',
    version: '1.0.0',
    category: 'util',
    capabilities: ['echo'],
    protocol: 'function',
    riskClass: 'R0',
    status: 'ACTIVE',
  });
  tools.registerAdapter({
    id: echoTool.id,
    capabilities: () => ['echo'],
    validateInput: (i) => (i !== undefined && i !== null ? undefined : 'input required'),
    async invoke(input) {
      return { echoed: input };
    },
  });

  return {
    kernel,
    gateway,
    shutdown: () => kernel.shutdown(),
  };
}

/**
 * Optionally start an automated backup scheduler from environment config
 * (PR4 — scheduled backups). No-op when BACKUP_NAMESPACES is unset.
 */
export function startScheduledBackupsFromEnv(
  kernel: Kernel,
  env: ReturnType<typeof readConfig> = readConfig(),
): { stop?: () => void } {
  if (!env.BACKUP_NAMESPACES) return {};
  const namespaces = String(env.BACKUP_NAMESPACES).split(',').map((s) => s.trim()).filter(Boolean);
  if (namespaces.length === 0) return {};
  const intervalMs = env.BACKUP_INTERVAL_MS && Number(env.BACKUP_INTERVAL_MS) > 0 ? Number(env.BACKUP_INTERVAL_MS) : 6 * 3600_000;
  try {
    const dr = kernel.getModule<DisasterRecoveryModule>('disaster-recovery');
    const handle = dr.startScheduler({
      namespaces,
      intervalMs,
      ...(env.BACKUP_RETENTION ? { retention: Number(env.BACKUP_RETENTION) } : {}),
      createdBy: 'system',
    });
    kernel.logger.info(`scheduled backups enabled: every ${intervalMs}ms for [${namespaces.join(', ')}]`);
    return { stop: () => handle.then((h) => h.stop()) };
  } catch (err) {
    kernel.logger.warn(`scheduled backups not started: ${(err as Error).message}`);
    return {};
  }
}

/** Build JATA Qi using environment variables / .env (see .env.example). */
export async function createJataQiFromEnv(overrides: JataQiConfig = {}): Promise<JataQiInstance> {
  const env = readConfig();
  const llm: ILLM =
    overrides.agent?.llm ??
    (env.AGENT_LLM === 'openai' && env.OPENAI_API_KEY
      ? new OpenAILLM({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_CHAT_MODEL })
      : new EchoLLM());

  const bootstrapAdmin =
    overrides.security?.bootstrapAdmin ??
    (env.JATAQI_ADMIN_USERNAME && env.JATAQI_ADMIN_PASSWORD
      ? { username: env.JATAQI_ADMIN_USERNAME, password: env.JATAQI_ADMIN_PASSWORD }
      : undefined);

  return createJataQi({
    storage: {
      driver: env.STORAGE_DRIVER as any ?? 'memory',
      fsRoot: env.STORAGE_FS_ROOT,
      ...(env.STORAGE_ENCRYPTION_KEY ? { encryptionKey: env.STORAGE_ENCRYPTION_KEY } : {}),
      ...(env.STORAGE_DEFAULT_QUOTA_BYTES ? { defaultQuotaBytes: env.STORAGE_DEFAULT_QUOTA_BYTES } : {}),
      ...(env.STORAGE_QUOTAS ? { quotas: safeParseQuotas(env.STORAGE_QUOTAS) } : {}),
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
    security: {
      ...(env.SECURITY_PERSIST_SESSIONS !== undefined ? { persistSessions: env.SECURITY_PERSIST_SESSIONS } : {}),
      ...(overrides.security ?? {}),
      ...(bootstrapAdmin ? { bootstrapAdmin } : {}),
    },
    gateway: { ...buildGatewayOptionsFromEnv(env), ...(overrides.gateway ?? {}) },
    kernel: overrides.kernel,
  });
}

/**
 * Parse a JSON map of name->bytes quotas from the STORAGE_QUOTAS env var.
 * Returns undefined on malformed input so a bad config never crashes boot.
 */
function safeParseQuotas(raw: string): Record<string, number> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && v > 0) out[k] = v;
      }
      return out;
    }
  } catch { /* fall through */ }
  return undefined;
}

/**
 * Build gateway security-hardening options (TLS, CORS, API versioning) from
 * environment config (PR4).
 */
function buildGatewayOptionsFromEnv(env: ReturnType<typeof readConfig>): GatewayOptions {
  const opts: GatewayOptions = {};
  // API versioning (default 'v1').
  if (env.API_VERSION !== undefined) {
    opts.apiVersion = env.API_VERSION === 'false' ? false : env.API_VERSION;
  }
  // TLS / HTTPS.
  if ((env.TLS_CERT_PATH && env.TLS_KEY_PATH)) {
    opts.tls = {
      certPath: env.TLS_CERT_PATH,
      keyPath: env.TLS_KEY_PATH,
      ...(env.TLS_CA_PATH ? { caPath: env.TLS_CA_PATH } : {}),
      ...(env.TLS_MIN_VERSION ? { minVersion: env.TLS_MIN_VERSION } : {}),
    };
  }
  // CORS.
  if (env.CORS_ORIGINS !== undefined) {
    const origins = env.CORS_ORIGINS.trim();
    if (origins === '*' || origins === '') {
      opts.cors = origins === '*' ? { origins: '*' } : false;
    } else {
      opts.cors = {
        origins: origins.split(',').map((o) => o.trim()).filter(Boolean),
        ...(env.CORS_CREDENTIALS ? { credentials: true } : {}),
      };
    }
  }
  return opts;
}

export { Logger };
