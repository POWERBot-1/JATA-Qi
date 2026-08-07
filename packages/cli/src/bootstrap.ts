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
import { TracingModule } from '@jataqi/tracing';
import { RealtimeModule } from '@jataqi/realtime';
import { PaymentsModule } from '@jataqi/payments';
import { MessagingModule } from '@jataqi/messaging';
import { AiSafetyModule } from '@jataqi/ai-safety';
import { MultimodalModule } from '@jataqi/multimodal';
import { SovereignModule } from '@jataqi/sovereign';
import { LLMGatewayModule, openaiProvider, mockProvider } from '@jataqi/llm-gateway';
import { AccreditationModule, type OperationMode } from '@jataqi/accreditation';
import { DnsModule } from '@jataqi/dns';
import { RegistryModule } from '@jataqi/registry';
import { RegistrarModule } from '@jataqi/registrar';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '@jataqi/learning';
import { AiLearningModule } from '@jataqi/ai-learning';
import { DesignSystemModule } from '@jataqi/design-system';
import { BrandingModule } from '@jataqi/branding';
import { UniversalWalletModule } from '@jataqi/universal-wallet';
import { CryptoModule } from '@jataqi/crypto';
import { DashboardModule } from '@jataqi/dashboard';
import { LinkIntelligenceModule } from '@jataqi/link-intelligence';
import { MultimodalIntelligenceModule } from '@jataqi/multimodal-intelligence';
import { SearchModule } from '@jataqi/search';
import { AutomationModule } from '@jataqi/automation';
import { FxModule } from '@jataqi/fx';
import { PkiModule } from '@jataqi/pki';
import { MobilityModule } from '@jataqi/mobility';
import { LogisticsModule } from '@jataqi/logistics';
import { AgricultureModule } from '@jataqi/agriculture';
import { CircularModule } from '@jataqi/circular';
import { EnergyModule } from '@jataqi/energy';
import { BorderModule } from '@jataqi/border';
import { RestaurantsModule } from '@jataqi/restaurants';
import { MarketplaceModule } from '@jataqi/marketplace';
import { CloudModule } from '@jataqi/cloud';
import { CdnModule } from '@jataqi/cdn';
import { EmailModule } from '@jataqi/email';
import { IpamModule } from '@jataqi/ipam';
import { TanyaModule } from '@jataqi/tanya';
import { MobileModule } from '@jataqi/mobile';
import { ActiveDefenseModule } from '@jataqi/active-defense';
import { SocModule } from '@jataqi/soc';
import { SupplyChainSecurityModule } from '@jataqi/supply-chain-security';
import { InfrastructureGovernanceModule } from '@jataqi/infra-governance';
import { ResilienceEngineeringModule } from '@jataqi/resilience-engineering';
import { SecurityReviewModule } from '@jataqi/security-review';
import { SecurityAutomationModule } from '@jataqi/security-automation';
import { DlpModule } from '@jataqi/dlp';
import { PqcModule } from '@jataqi/pqc';
import { ProductMarketplaceModule } from '@jataqi/product-marketplace';
import { OnboardingModule } from '@jataqi/onboarding';
import { OperationsModule } from '@jataqi/operations';
import { ConversationsModule } from '@jataqi/conversations';
import { readConfig } from './config.js';
import { createEmailChannel, createSmsChannel, createStripePaymentProvider } from './provider-bridges.js';

function readConfigEnv(key: string): string | undefined {
  return process.env[key];
}

/** Build tracing (OpenTelemetry) config from environment (PR9). */
function readTracingConfigFromEnv(): import('@jataqi/tracing').TracingModuleConfig {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const exporter = (process.env.OTEL_TRACES_EXPORTER ?? (endpoint ? 'otlp' : 'none')) as 'none' | 'memory' | 'console' | 'otlp';
  const sampler = (process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on') as 'always_on' | 'always_off' | 'traceidratio' | 'parentbased_always_on';
  return {
    serviceName: process.env.OTEL_SERVICE_NAME,
    exporter,
    ...(endpoint ? { otlpEndpoint: endpoint } : {}),
    sampler,
    ...(process.env.OTEL_TRACES_SAMPLER_ARG ? { ratio: Number(process.env.OTEL_TRACES_SAMPLER_ARG) } : {}),
  };
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
  // PRX Part L: Legal Operation Mode + accreditation governance.
  kernel.register(new AccreditationModule({
    mode: (process.env.JATAQI_OPERATION_MODE as OperationMode | undefined) ?? 'DEVELOPMENT',
    governancePrivateKey: process.env.JATAQI_GOVERNANCE_KEY,
  }));
  // PRX Part D: Global DNS platform.
  kernel.register(new DnsModule({
    serve: process.env.JATAQI_DNS_SERVE === '1',
    port: process.env.JATAQI_DNS_PORT ? Number(process.env.JATAQI_DNS_PORT) : 8053,
    host: process.env.JATAQI_DNS_HOST ?? '127.0.0.1',
    recursive: process.env.JATAQI_DNS_RECURSIVE === '1',
  }));
  // PRX Part A: TLD Registry platform.
  kernel.register(new RegistryModule({
    serve: process.env.JATAQI_EPP_SERVE === '1',
    eppPort: process.env.JATAQI_EPP_PORT ? Number(process.env.JATAQI_EPP_PORT) : 17000,
    svID: process.env.JATAQI_EPP_SVID ?? 'registry.jataqi.local',
  }));
  // PRX Part B: Registrar platform.
  kernel.register(new RegistrarModule());
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

  kernel.register(new TracingModule(readTracingConfigFromEnv()));
  kernel.register(new RealtimeModule());
  kernel.register(new AiSafetyModule());
  // Continuous Learning Platform (CLP Phases 1–7): governed memory, learning
  // + personalization, and the AI learning platform (prompt registry, quality,
  // drift). Soft dependencies — each degrades gracefully if the others are
  // absent, so registration order is safe either way.
  kernel.register(new DigitalMemoryModule());
  kernel.register(new ContinuousLearningModule());
  kernel.register(new AiLearningModule());
  // Brand & product experience layer: shared design language, brand identity
  // for the 15 products, and the adaptive dashboard engine.
  kernel.register(new DesignSystemModule());
  kernel.register(new BrandingModule());
  kernel.register(new DashboardModule());
  // Finance stack (Phase 2/4): universal double-entry wallet + KRT digital
  // asset platform (token/NFT engine, staking, exchange, custody).
  kernel.register(new UniversalWalletModule());
  kernel.register(new CryptoModule());
  // Intelligence acquisition: universal link intelligence + multimodal
  // intelligence (both feed the knowledge graph + memory when available).
  kernel.register(new LinkIntelligenceModule());
  kernel.register(new MultimodalIntelligenceModule());
  // Phase 6 — Universal Search & Discovery (federates knowledge, memory,
  // graph, conversations, and tools with personalized ranking).
  kernel.register(new SearchModule());
  // Phase 6 — SOMA AI Intelligent Automation Engine (schedule/event/manual
  // automations with chained platform actions).
  kernel.register(new AutomationModule({
    tickIntervalMs: Number(process.env.JATAQI_AUTOMATION_TICK_MS ?? 1000),
  }));
  // PRX Part C — PKI: CA + Registration Authority + Identity Provider.
  kernel.register(new PkiModule({
    issuer: process.env.JATAQI_IDP_ISSUER ?? 'https://id.jataqi.local',
    signingAlg: (process.env.JATAQI_IDP_SIGNING_ALG as 'HS256' | 'EdDSA' | undefined) ?? 'HS256',
  }));
  // Phase 6 — KARIS FX: foreign exchange intelligence.
  kernel.register(new FxModule({ anchor: process.env.JATAQI_FX_ANCHOR ?? 'USD' }));
  // Phase 7 — MOTO X mobility + PORTLINK logistics intelligence.
  kernel.register(new MobilityModule());
  kernel.register(new LogisticsModule());
  // Phase 7 — KARIS FARM agriculture + KARIS LOOP circular economy.
  kernel.register(new AgricultureModule());
  kernel.register(new CircularModule());
  // Phase 7 — KARIS ENERGY + KARIS BORDER X.
  kernel.register(new EnergyModule());
  kernel.register(new BorderModule());
  // Phase 7 — NYUMBANI KITCHEN restaurant intelligence.
  kernel.register(new RestaurantsModule());
  // Phase 7 — MAZA marketplace (storefront layer over @jataqi/commerce).
  kernel.register(new MarketplaceModule());
  // PRX Part E — Cloud Infrastructure Provider (cloud/vps/hosting).
  kernel.register(new CloudModule());
  // PRX — CDN + Email providers.
  kernel.register(new CdnModule());
  kernel.register(new EmailModule());
  // PRX — RIR Member: IP address management + ASN holdings.
  kernel.register(new IpamModule());
  // Persistent conversations (TANYA + unified chat API).
  kernel.register(new ConversationsModule());
  // TANYA AI — conversational product layer (personas + identity bridge).
  kernel.register(new TanyaModule());
  // TANYA Mobile Native — devices, push, offline outbox, home snapshot.
  kernel.register(new MobileModule());
  // Active Defense & Adaptive Resilience Layer — risk scoring, containment,
  // deception, recovery, and continuous improvement.
  kernel.register(new ActiveDefenseModule());
  // Global Security Operations — SOC, telemetry lake, threat hunting/intel,
  // insider risk, abuse detection, incident command, adversarial validation.
  kernel.register(new SocModule());
  // Software supply chain + secure infrastructure governance.
  kernel.register(new SupplyChainSecurityModule());
  kernel.register(new InfrastructureGovernanceModule());
  // Global Resilience Engineering — multi-region, failover, DR, chaos, SLOs.
  kernel.register(new ResilienceEngineeringModule());
  // Independent Security Review — design/code/infra/AI-safety/compliance audits.
  kernel.register(new SecurityReviewModule());
  // Security Automation — cross-pillar correlation, scheduled hunts, compliance reports.
  kernel.register(new SecurityAutomationModule());
  // Data Loss Prevention + Post-Quantum Readiness.
  kernel.register(new DlpModule());
  kernel.register(new PqcModule());
  // Commercial rollout: product marketplace, onboarding, production operations.
  kernel.register(new ProductMarketplaceModule('1.0.0'));
  kernel.register(new OnboardingModule());
  kernel.register(new OperationsModule());
  kernel.register(new MessagingModule({
    ...(process.env.SENDGRID_API_KEY ? { sendgrid: { apiKey: process.env.SENDGRID_API_KEY } } : {}),
    ...(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? {
      twilio: { accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN, fromNumber: process.env.TWILIO_FROM_NUMBER ?? '' },
    } : {}),
    ...(process.env.AFRICAS_TALKING_API_KEY ? {
      africasTalking: { apiKey: process.env.AFRICAS_TALKING_API_KEY, username: process.env.AFRICAS_TALKING_USERNAME ?? 'sandbox', ...(process.env.AFRICAS_TALKING_SENDER_ID ? { senderId: process.env.AFRICAS_TALKING_SENDER_ID } : {}) },
    } : {}),
  }));
  kernel.register(new PaymentsModule({
    ...(process.env.STRIPE_SECRET_KEY ? {
      stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY,
        ...(process.env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: process.env.STRIPE_WEBHOOK_SECRET } : {}),
      },
    } : {}),
    ...(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET
       && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY ? {
      mpesa: {
        consumerKey: process.env.MPESA_CONSUMER_KEY,
        consumerSecret: process.env.MPESA_CONSUMER_SECRET,
        shortCode: process.env.MPESA_SHORTCODE,
        passkey: process.env.MPESA_PASSKEY,
        ...(process.env.MPESA_ENVIRONMENT ? { environment: process.env.MPESA_ENVIRONMENT as 'sandbox' | 'production' } : {}),
        ...(process.env.MPESA_CALLBACK_URL ? { callbackUrl: process.env.MPESA_CALLBACK_URL } : {}),
        ...(process.env.MPESA_API_BASE ? { apiBase: process.env.MPESA_API_BASE } : {}),
      },
    } : {}),
  }));

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

  // Wire DR snapshots into Global Resilience Engineering: recovery-plan
  // executions measure RPO exposure from the newest disaster-recovery
  // snapshot (real backup age) unless an explicit snapshot age is supplied.
  try {
    const resilience = kernel.getModule<import('@jataqi/resilience-engineering').ResilienceEngineeringModule>('resilience-engineering');
    const snapshotAges = new Map<string, number>();
    const onSnapshot = (payload: unknown): void => {
      const p = (payload ?? {}) as { namespace?: string; createdAt?: number };
      if (p.namespace && p.createdAt) snapshotAges.set(p.namespace, Date.now() - p.createdAt);
    };
    kernel.bus.on('dr.snapshot.created', onSnapshot);
    resilience.attachDrProvider({
      latestSnapshotAgeMs: (namespace?: string) => {
        if (namespace) return snapshotAges.get(namespace);
        if (snapshotAges.size === 0) return undefined;
        return [...snapshotAges.values()][0];
      },
    });
  } catch { /* optional integration */ }

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

  // Wire real provider integrations into existing modules (PR3 provider bridges).
  try {
    const messaging = kernel.getModule('messaging') as unknown as { getEmailProvider(name?: string): unknown; getSmsProvider(name?: string): unknown } | undefined;
    const notifications = kernel.getModule('notifications') as unknown as { registerChannel(ch: unknown): void } | undefined;
    if (messaging && notifications) {
      const emailProvider = messaging.getEmailProvider() as { send(msg: unknown): Promise<unknown> } | undefined;
      const smsProvider = messaging.getSmsProvider() as { send(msg: unknown): Promise<unknown> } | undefined;
      if (emailProvider) {
        notifications.registerChannel(createEmailChannel(emailProvider as never, () => undefined));
        kernel.logger.info('wired email notification channel');
      }
      if (smsProvider) {
        notifications.registerChannel(createSmsChannel(smsProvider as never, () => undefined));
        kernel.logger.info('wired SMS notification channel');
      }
    }
  } catch { /* modules not registered */ }

  try {
    const payments = kernel.getModule('payments') as unknown as { stripe: { createPaymentIntent(req: unknown): Promise<unknown> } | undefined } | undefined;
    const commerce = kernel.getModule('commerce') as unknown as { setPaymentProvider(p: unknown): void } | undefined;
    if (payments?.stripe && commerce) {
      commerce.setPaymentProvider(createStripePaymentProvider(payments.stripe as never));
      kernel.logger.info('wired Stripe payment provider into commerce');
    }
  } catch { /* modules not registered */ }

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
      ...((env.STORAGE_DRIVER === 'postgres' || env.STORAGE_DRIVER === 'postgresql') ? {
        postgres: {
          ...(env.PGHOST ? { host: env.PGHOST } : {}),
          ...(env.PGPORT ? { port: env.PGPORT } : {}),
          ...(env.PGUSER ? { user: env.PGUSER } : {}),
          ...(env.PGPASSWORD ? { password: env.PGPASSWORD } : {}),
          ...(env.PGDATABASE ? { database: env.PGDATABASE } : {}),
          ...(env.PGSSLMODE ? { ssl: env.PGSSLMODE } : {}),
        },
      } : {}),
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
