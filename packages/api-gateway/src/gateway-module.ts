// ApiGatewayModule — HTTP entrypoint for JATA Qi (Step 92 Task 4 "API Gateway",
// Step 15 "API Gateway"). Exposes auth, QiL submission, orchestration, agent
// passthrough, audit and stats over a tiny zero-dependency HTTP server.
//
// The gateway is the front of the "Alpha vertical slice" defined in Step 93:
//   authenticate -> submit request -> QiL generates a workflow -> agents run ->
//   knowledge retrieved -> structured response -> auditable execution record.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { SecurityModule } from '@jataqi/security';
import { auditCsv, auditJson } from '@jataqi/security';
import type { StorageModule, TenantScope, INamespace } from '@jataqi/storage';
import type { OrchestratorModule } from '@jataqi/orchestrator';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { MetricsModule } from '@jataqi/metrics';
import type { SimulationModule, Scenario, SimulationResult } from '@jataqi/simulation';
import { createDistribution } from '@jataqi/simulation';
import type { TeamCoordinatorModule, TeamConfig, TeamResult } from '@jataqi/teams';
import type { PluginManagerModule, InstalledPlugin } from '@jataqi/plugins';
import type { ModelRegistryModule, SelectionRequest } from '@jataqi/model-registry';
import type { SchedulerModule } from '@jataqi/scheduler';
import { summarize, linearRegression } from '@jataqi/compute';
import type { RoboticsModule } from '@jataqi/robotics';
import type { DigitalTwinModule } from '@jataqi/digital-twin';
import type { ToolIntelligenceModule, ToolStatus } from '@jataqi/tool-intelligence';
import type { ReadinessModule } from '@jataqi/readiness';
import type { ProvenanceModule } from '@jataqi/provenance';
import type { CommerceModule } from '@jataqi/commerce';
import type { OrganizationsModule } from '@jataqi/organizations';
import type { NotificationsModule } from '@jataqi/notifications';
import type { PoliciesModule } from '@jataqi/policies';
import type { FeatureFlagsModule } from '@jataqi/feature-flags';
import type { PrivacyModule } from '@jataqi/privacy';
import type { PolicyGovernanceModule } from '@jataqi/policy-governance';
import type { DisasterRecoveryModule } from '@jataqi/disaster-recovery';
import type { TracingModule } from '@jataqi/tracing';
import type { Span } from '@jataqi/tracing';
import type { RealtimeModule } from '@jataqi/realtime';
import type { ActiveDefenseModule } from '@jataqi/active-defense';
import type { SocModule } from '@jataqi/soc';
import type { SupplyChainSecurityModule } from '@jataqi/supply-chain-security';
import type { InfrastructureGovernanceModule } from '@jataqi/infra-governance';
import type { ResilienceEngineeringModule } from '@jataqi/resilience-engineering';
import type { SecurityReviewModule } from '@jataqi/security-review';
import type { SecurityAutomationModule } from '@jataqi/security-automation';
import type { DlpModule } from '@jataqi/dlp';
import type { PqcModule } from '@jataqi/pqc';
import type { ConversationsModule } from '@jataqi/conversations';
import type { AccreditationModule } from '@jataqi/accreditation';
import type { DnsModule } from '@jataqi/dns';
import type { RegistryModule } from '@jataqi/registry';
import type { RegistrarModule } from '@jataqi/registrar';
import type { ModelRuntimeModule } from '@jataqi/model-runtime';
import type { AiSafetyModule } from '@jataqi/ai-safety';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { ContinuousLearningModule } from '@jataqi/learning';
import type { AiLearningModule } from '@jataqi/ai-learning';
import type { DesignSystemModule } from '@jataqi/design-system';
import type { BrandingModule } from '@jataqi/branding';
import type { UniversalWalletModule } from '@jataqi/universal-wallet';
import type { CryptoModule } from '@jataqi/crypto';
import type { DashboardModule } from '@jataqi/dashboard';
import type { LinkIntelligenceModule } from '@jataqi/link-intelligence';
import type { MultimodalIntelligenceModule } from '@jataqi/multimodal-intelligence';
import type { SearchModule } from '@jataqi/search';
import type { AutomationModule } from '@jataqi/automation';
import type { FxModule } from '@jataqi/fx';
import type { PkiModule } from '@jataqi/pki';
import type { MobilityModule } from '@jataqi/mobility';
import type { LogisticsModule } from '@jataqi/logistics';
import type { AgricultureModule } from '@jataqi/agriculture';
import type { CircularModule } from '@jataqi/circular';
import type { EnergyModule } from '@jataqi/energy';
import type { BorderModule } from '@jataqi/border';
import type { RestaurantsModule } from '@jataqi/restaurants';
import type { MarketplaceModule } from '@jataqi/marketplace';
import type { CloudModule } from '@jataqi/cloud';
import type { CdnModule } from '@jataqi/cdn';
import type { EmailModule } from '@jataqi/email';
import type { IpamModule } from '@jataqi/ipam';
import type { TanyaModule } from '@jataqi/tanya';
import type { MobileModule } from '@jataqi/mobile';
import type { PromptExperiment } from '@jataqi/ai-learning';
import { extract as extractTraceContext } from '@jataqi/tracing';
import type { TaskProfile } from '@jataqi/scheduler';
import type { GatewayHandle, GatewayOptions, GatewayRequest, GatewayResponse, ResolvedCorsPolicy, RouteHandler, TlsConfig } from './types.js';
import { RateLimiter } from './rate-limit.js';

const BOOT_TIME = Date.now();
const DEFAULT_RATE_LIMIT = { limit: 1000, windowMs: 60_000 };
const DEFAULT_VERSION = 'v1';
const SECURE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const SECURE_HEADERS_ALLOW = ['authorization', 'content-type', 'x-request-id', 'x-api-key'];

export interface ListenOptions {
  port?: number;
  host?: string;
}

export class ApiGatewayModule implements IModule {
  readonly id = 'api-gateway';
  readonly tags = ['core', 'gateway'] as const;
  readonly dependsOn = ['security', 'orchestrator'] as const;

  private api!: KernelApi;
  private sec!: SecurityModule;
  private orch!: OrchestratorModule;
  private agents!: AgentRuntimeModule;
  private knowledge!: KnowledgeService;
  private metrics?: MetricsModule;
  private simulation?: SimulationModule;
  private teams?: TeamCoordinatorModule;
  private plugins?: PluginManagerModule;
  private modelRegistry?: ModelRegistryModule;
  private scheduler?: SchedulerModule;
  private robotics?: RoboticsModule;
  private digitalTwin?: DigitalTwinModule;
  private tools?: ToolIntelligenceModule;
  private readiness?: ReadinessModule;
  private provenance?: ProvenanceModule;
  private commerce?: CommerceModule;
  private organizations?: OrganizationsModule;
  private notifications?: NotificationsModule;
  private policies?: PoliciesModule;
  private featureFlags?: FeatureFlagsModule;
  private privacy?: PrivacyModule;
  private governance?: PolicyGovernanceModule;
  private disasterRecovery?: DisasterRecoveryModule;
  private tracing?: TracingModule;
  private realtime?: RealtimeModule;
  private conversations?: ConversationsModule;
  private modelRuntime?: ModelRuntimeModule;
  private aiSafety?: AiSafetyModule;
  private accreditation?: AccreditationModule;
  private dns?: DnsModule;
  private registry?: RegistryModule;
  private registrar?: RegistrarModule;
  private memory?: DigitalMemoryModule;
  private learning?: ContinuousLearningModule;
  private aiLearning?: AiLearningModule;
  private designSystem?: DesignSystemModule;
  private branding?: BrandingModule;
  private wallet?: UniversalWalletModule;
  private crypto?: CryptoModule;
  private dashboard?: DashboardModule;
  private linkIntel?: LinkIntelligenceModule;
  private multimodalIntel?: MultimodalIntelligenceModule;
  private search?: SearchModule;
  private automation?: AutomationModule;
  private fx?: FxModule;
  private pki?: PkiModule;
  private mobility?: MobilityModule;
  private logistics?: LogisticsModule;
  private agriculture?: AgricultureModule;
  private circular?: CircularModule;
  private energy?: EnergyModule;
  private border?: BorderModule;
  private restaurants?: RestaurantsModule;
  private marketplace?: MarketplaceModule;
  private cloud?: CloudModule;
  private cdn?: CdnModule;
  private email?: EmailModule;
  private ipam?: IpamModule;
  private tanya?: TanyaModule;
  private activeDefense?: ActiveDefenseModule;
  private soc?: SocModule;
  private supplyChain?: SupplyChainSecurityModule;
  private infraGovernance?: InfrastructureGovernanceModule;
  private resilience?: ResilienceEngineeringModule;
  private securityReview?: SecurityReviewModule;
  private securityAutomation?: SecurityAutomationModule;
  private dlp?: DlpModule;
  private pqc?: PqcModule;
  private mobile?: MobileModule;
  private server: Server | HttpsServer | undefined;
  private booted = false;
  private readonly opts: GatewayOptions;
  private readonly routes = new Map<string, RouteHandler>();
  private readonly limiter: RateLimiter | undefined;
  /** Resolved CORS policy (null = CORS disabled). */
  private cors: ResolvedCorsPolicy | null = null;
  /** True when the server is serving over TLS. */
  private secure = false;
  /** API version segment (e.g. 'v1'); null when versioning is disabled. */
  private versionSegment: string | null = DEFAULT_VERSION;
  private storage?: StorageModule;

  constructor(opts: GatewayOptions = {}) {
    this.opts = { maxBodyBytes: 1_048_576, securityHeaders: true, ...opts };
    const rl = opts.rateLimit === null ? null : (opts.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.limiter = rl ? new RateLimiter(rl) : undefined;
    this.versionSegment = opts.apiVersion === false || opts.apiVersion === null || opts.apiVersion === undefined
      ? DEFAULT_VERSION
      : String(opts.apiVersion);
    if (opts.apiVersion === false || opts.apiVersion === null) this.versionSegment = null;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('api-gateway', this);
  }

  async start(kernel: KernelApi): Promise<void> {
    this.sec = kernel.getModule<SecurityModule>('security');
    this.orch = kernel.getModule<OrchestratorModule>('orchestrator');
    this.agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
    this.knowledge = kernel.getModule<KnowledgeService>('knowledge');
    // Optional services — resolved best-effort so the gateway degrades gracefully.
    this.metrics = this.tryModule<MetricsModule>('metrics');
    this.simulation = this.tryModule<SimulationModule>('simulation');
    this.teams = this.tryModule<TeamCoordinatorModule>('teams');
    this.plugins = this.tryModule<PluginManagerModule>('plugins');
    this.modelRegistry = this.tryModule<ModelRegistryModule>('model-registry');
    this.scheduler = this.tryModule<SchedulerModule>('scheduler');
    this.robotics = this.tryModule<RoboticsModule>('robotics');
    this.digitalTwin = this.tryModule<DigitalTwinModule>('digital-twin');
    this.tools = this.tryModule<ToolIntelligenceModule>('tool-intelligence');
    this.readiness = this.tryModule<ReadinessModule>('readiness');
    this.provenance = this.tryModule<ProvenanceModule>('provenance');
    this.commerce = this.tryModule<CommerceModule>('commerce');
    this.organizations = this.tryModule<OrganizationsModule>('organizations');
    this.notifications = this.tryModule<NotificationsModule>('notifications');
    this.policies = this.tryModule<PoliciesModule>('policies');
    this.featureFlags = this.tryModule<FeatureFlagsModule>('feature-flags');
    this.privacy = this.tryModule<PrivacyModule>('privacy');
    this.governance = this.tryModule<PolicyGovernanceModule>('policy-governance');
    this.disasterRecovery = this.tryModule<DisasterRecoveryModule>('disaster-recovery');
    this.tracing = this.tryModule<TracingModule>('tracing');
    this.realtime = this.tryModule<RealtimeModule>('realtime');
    this.conversations = this.tryModule<ConversationsModule>('conversations');
    this.modelRuntime = this.tryModule<ModelRuntimeModule>('model-runtime');
    this.aiSafety = this.tryModule<AiSafetyModule>('ai-safety');
    this.accreditation = this.tryModule<AccreditationModule>('accreditation');
    this.dns = this.tryModule<DnsModule>('dns');
    this.registry = this.tryModule<RegistryModule>('registry');
    this.registrar = this.tryModule<RegistrarModule>('registrar');
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    this.learning = this.tryModule<ContinuousLearningModule>('learning');
    this.aiLearning = this.tryModule<AiLearningModule>('ai-learning');
    this.designSystem = this.tryModule<DesignSystemModule>('design-system');
    this.branding = this.tryModule<BrandingModule>('branding');
    this.wallet = this.tryModule<UniversalWalletModule>('universal-wallet');
    this.crypto = this.tryModule<CryptoModule>('crypto');
    this.dashboard = this.tryModule<DashboardModule>('dashboard');
    this.linkIntel = this.tryModule<LinkIntelligenceModule>('link-intelligence');
    this.multimodalIntel = this.tryModule<MultimodalIntelligenceModule>('multimodal-intelligence');
    this.search = this.tryModule<SearchModule>('search');
    this.automation = this.tryModule<AutomationModule>('automation');
    this.fx = this.tryModule<FxModule>('fx');
    this.pki = this.tryModule<PkiModule>('pki');
    this.mobility = this.tryModule<MobilityModule>('mobility');
    this.logistics = this.tryModule<LogisticsModule>('logistics');
    this.agriculture = this.tryModule<AgricultureModule>('agriculture');
    this.circular = this.tryModule<CircularModule>('circular');
    this.energy = this.tryModule<EnergyModule>('energy');
    this.border = this.tryModule<BorderModule>('border');
    this.restaurants = this.tryModule<RestaurantsModule>('restaurants');
    this.marketplace = this.tryModule<MarketplaceModule>('marketplace');
    this.cloud = this.tryModule<CloudModule>('cloud');
    this.cdn = this.tryModule<CdnModule>('cdn');
    this.email = this.tryModule<EmailModule>('email');
    this.ipam = this.tryModule<IpamModule>('ipam');
    this.tanya = this.tryModule<TanyaModule>('tanya');
    this.activeDefense = this.tryModule<ActiveDefenseModule>('active-defense');
    this.soc = this.tryModule<SocModule>('soc');
    this.supplyChain = this.tryModule<SupplyChainSecurityModule>('supply-chain-security');
    this.infraGovernance = this.tryModule<InfrastructureGovernanceModule>('infra-governance');
    this.resilience = this.tryModule<ResilienceEngineeringModule>('resilience-engineering');
    this.securityReview = this.tryModule<SecurityReviewModule>('security-review');
    this.securityAutomation = this.tryModule<SecurityAutomationModule>('security-automation');
    this.dlp = this.tryModule<DlpModule>('dlp');
    this.pqc = this.tryModule<PqcModule>('pqc');
    this.mobile = this.tryModule<MobileModule>('mobile');
    this.storage = this.tryModule<StorageModule>('storage');
    this.cors = this.resolveCorsPolicy();
    this.registerRoutes();

    // Build the HTTP(S) server. When TLS material is configured we serve HTTPS
    // with secure defaults (PR4 — native TLS termination).
    const tlsOpts = this.buildTlsOptions();
    this.secure = !!tlsOpts;
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void this.handle(req, res); };
    this.server = tlsOpts ? createHttpsServer(tlsOpts, handler) : createServer(handler);

    // Attach the WebSocket real-time server if present (PR10).
    if (this.realtime && this.server) {
      this.realtime.attach(this.server, {
        authenticate: (token) => this.sec.authenticate(token ?? undefined),
        onMessage: (msg, ws, principal) => void this.handleWsMessage(msg, ws, principal),
      });
    }
    this.booted = true;
    // Record an auditable boot record describing the active security posture.
    void this.sec.audit({
      actor: 'system',
      action: 'gateway.start',
      result: 'success',
      detail: {
        tls: this.secure,
        cors: this.cors ? { origins: this.cors.origins === '*' ? '*' : [...this.cors.origins], credentials: this.cors.credentials } : false,
        apiVersion: this.versionSegment ?? false,
        tenantIsolation: !!this.storage,
      },
    }).catch(() => undefined);
    kernel.logger.info(`api-gateway module initialized (transport=${this.secure ? 'https' : 'http'}, not listening)`);
  }

  async stop(_kernel: KernelApi): Promise<void> {
    if (this.server?.listening) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  /** Begin listening. Returns a handle with the bound port and protocol. */
  listen(opts: ListenOptions = {}): Promise<GatewayHandle> {
    if (!this.server) throw new Error('api-gateway: server not started');
    const server = this.server;
    const secure = this.secure;
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const addr = server.address() as AddressInfo;
        resolve({
          port: addr.port,
          protocol: secure ? 'https' : 'http',
          secure,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
    });
  }

  /** Resolve the TLS material to a Node https server options object, or undefined. */
  private buildTlsOptions(): Record<string, unknown> | undefined {
    const t = this.opts.tls;
    if (!t) return undefined;
    const cert = this.readPem(t.cert, t.certPath);
    const key = this.readPem(t.key, t.keyPath);
    if (!cert || !key) return undefined;
    const ca = this.readPem(t.ca, t.caPath);
    return {
      cert,
      key,
      ...(ca ? { ca } : {}),
      minVersion: t.minVersion ?? 'TLSv1.2',
      ...(t.requestCert !== undefined ? { requestCert: t.requestCert } : {}),
      ...(t.rejectUnauthorized !== undefined ? { rejectUnauthorized: t.rejectUnauthorized } : {}),
      ...(t.handshakeTimeout !== undefined ? { handshakeTimeout: t.handshakeTimeout } : {}),
    };
  }

  private readPem(val: string | Buffer | undefined, path: string | undefined): string | Buffer | undefined {
    if (val) return val;
    if (path) return readFileSync(path);
    return undefined;
  }

  /** Normalize the configured CORS option into an internal policy (or null). */
  private resolveCorsPolicy(): ResolvedCorsPolicy | null {
    const opt = this.opts.cors;
    if (!opt) return null;
    if (opt === true) {
      // Legacy permissive default.
      return { origins: '*', methods: SECURE_METHODS, headers: SECURE_HEADERS_ALLOW, exposeHeaders: [], credentials: false, maxAge: 600, enabled: true };
    }
    const originsRaw = opt.origins ?? [];
    const origins = originsRaw === '*' ? '*' as const : new Set(originsRaw);
    // Credentials + '*' is invalid per the Fetch spec; downgrade to an empty allow-list.
    const credentials = opt.credentials === true && origins !== '*';
    return {
      origins,
      methods: (opt.methods ?? SECURE_METHODS).map((m) => m.toUpperCase()),
      headers: opt.headers ?? SECURE_HEADERS_ALLOW,
      exposeHeaders: opt.exposeHeaders ?? [],
      credentials,
      maxAge: opt.maxAge ?? 600,
      enabled: (origins === '*' ? true : origins.size > 0),
    };
  }

  /**
   * Compute CORS response headers for a request Origin. Returns an empty object
   * when the origin is not allowed (or CORS is disabled).
   */
  private corsHeadersFor(origin: string | undefined): Record<string, string> {
    if (!this.cors || !this.cors.enabled || !origin) return {};
    const origins = this.cors.origins;
    const allowAll = origins === '*';
    const allowed = allowAll || origins.has(origin);
    if (!allowed) return {};
    const headers: Record<string, string> = { vary: 'origin' };
    headers['access-control-allow-origin'] = allowAll ? '*' : origin;
    if (this.cors.credentials) headers['access-control-allow-credentials'] = 'true';
    if (this.cors.exposeHeaders.length) headers['access-control-expose-headers'] = this.cors.exposeHeaders.join(', ');
    return headers;
  }

  /** Preflight (OPTIONS) response headers. */
  private corsPreflightHeaders(origin: string | undefined, reqMethod?: string): Record<string, string> {
    const base = this.corsHeadersFor(origin);
    if (Object.keys(base).length === 0) return {};
    const methods = reqMethod && this.cors!.methods.includes(reqMethod.toUpperCase())
      ? [reqMethod.toUpperCase()]
      : this.cors!.methods;
    return {
      ...base,
      'access-control-allow-methods': methods.join(', '),
      'access-control-allow-headers': this.cors!.headers.join(', '),
      'access-control-max-age': String(this.cors!.maxAge),
    };
  }

  /** Standard security headers (HSTS only emitted over TLS). */
  private securityHeaders(): Record<string, string> {
    if (this.opts.securityHeaders === false) return {};
    const h: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-permitted-cross-domain-policies': 'none',
    };
    if (this.secure) {
      h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
    }
    return h;
  }

  // --- routing -------------------------------------------------------------

  private registerRoutes(): void {
    const route = (method: string, path: string, h: RouteHandler): void => {
      this.routes.set(`${method} ${path}`, h);
    };
    const auth = (perm: string | null, h: RouteHandler): RouteHandler => async (req) => {
      const principal = await this.sec.authenticate(req.headers['authorization']);
      if (!principal) return json(401, { error: 'unauthorized' });
      req.principal = principal;
      // Active Defense enforcement: banned / critical-risk sessions are refused
      // before any permission checks (adaptive access control).
      if (this.activeDefense && this.activeDefense.isBlocked(principal.userId)) {
        return json(423, { error: 'session blocked by active defense', code: 'defense.blocked' });
      }
      if (perm) await this.sec.requirePermission(principal, perm);
      return h(req);
    };

    // Public.
    route('GET', '/', () => this.apiIndex());
    route('GET', '/openapi.json', () => this.openapi());
    route('GET', '/health', () => this.health());
    route('GET', '/livez', () => this.livez());
    route('GET', '/readyz', () => this.readyz());
    route('POST', '/auth/register', (req) => this.register(req));
    route('POST', '/auth/login', (req) => this.login(req));

    // Authenticated.
    route('POST', '/auth/logout', auth(null, (req) => this.logout(req)));
    route('GET', '/auth/session', auth(null, (req) => this.sessionInfo(req)));
    route('POST', '/auth/apikey', auth(null, (req) => this.createApiKey(req)));
    route('POST', '/qil', auth('qil:run', (req) => this.runQiL(req)));
    route('POST', '/objective', auth('qil:run', (req) => this.runObjective(req)));
    route('GET', '/workflows', auth('qil:run', (req) => this.listWorkflows(req)));
    route('GET', '/workflow', auth('qil:run', (req) => this.getWorkflow(req)));
    route('POST', '/ask', auth('agent:run', (req) => this.ask(req)));
    route('GET', '/audit', auth('audit:read', (req) => this.audit(req)));
    route('GET', '/audit/export', auth('audit:read', (req) => this.auditExport(req)));
    route('GET', '/stats', auth('knowledge:read', () => this.stats()));
    route('GET', '/whoami', auth(null, (req) => json(200, { principal: req.principal })));
    route('GET', '/metrics', auth('metrics:read', () => this.metricsHandler()));
    route('POST', '/simulate', auth('qil:run', (req) => this.simulate(req)));
    route('POST', '/team', auth('qil:run', (req) => this.team(req)));
    route('GET', '/plugins', auth('plugin:read', () => this.pluginsList()));
    route('POST', '/plugins', auth('plugin:manage', (req) => this.pluginAction(req)));
    route('GET', '/models', auth('model:read', () => this.modelsList()));
    route('POST', '/models/select', auth('model:read', (req) => this.modelSelect(req)));
    route('GET', '/scheduler/stats', auth('metrics:read', () => this.schedulerStats()));
    route('POST', '/compute/stats', auth('qil:run', (req) => this.computeStats(req)));
    route('POST', '/compute/regression', auth('qil:run', (req) => this.computeRegression(req)));
    route('POST', '/scheduler/route', auth('compute:run', (req) => this.schedulerRoute(req)));
    route('GET', '/devices', auth('device:read', (req) => this.listDevices(req)));
    route('POST', '/devices', auth('device:read', (req) => this.addDevice(req)));
    route('POST', '/device', auth('device:read', (req) => this.deviceAction(req)));
    route('GET', '/missions', auth('device:read', (req) => this.listMissions(req)));
    route('POST', '/missions', auth('device:read', (req) => this.missionAction(req)));
    route('GET', '/twins', auth('device:read', (req) => this.listTwins(req)));
    route('POST', '/twins', auth('device:read', (req) => this.addTwin(req)));
    route('POST', '/twin', auth('device:read', (req) => this.twinAction(req)));
    // Readiness (public for transparency).
    route('GET', '/readiness', (req) => this.readinessList(req));
    route('GET', '/readiness/summary', () => this.readinessSummary());
    // Disaster recovery: on-demand backups + scheduler control (PR4).
    route('GET', '/backups', auth('audit:read', (req) => this.backupsList(req)));
    route('POST', '/backup', auth('audit:read', (req) => this.backupCreate(req)));
    route('POST', '/backup/schedule', auth('audit:read', (req) => this.backupSchedule(req)));
    // Universal AI Tool Intelligence Layer.
    route('GET', '/tools', auth('tool:read', (req) => this.toolsList(req)));
    route('GET', '/tools/capability', auth('tool:read', (req) => this.toolsForCapability(req)));
    route('POST', '/tools', auth('tool:read', (req) => this.toolRegister(req)));
    route('POST', '/tools/sync', auth('tool:read', (req) => this.toolsSync(req)));
    route('GET', '/tools/governance-stats', auth('tool:read', (req) => this.toolsGovernanceStats(req)));
    route('GET', '/governance/alerts', auth('tool:read', (req) => this.governanceAlerts(req)));
    route('GET', '/realtime/stats', auth('metrics:read', (req) => this.realtimeStats(req)));
    route('GET', '/tool', auth('tool:read', (req) => this.toolGet(req)));
    route('POST', '/tool/invoke', auth('tool:invoke', (req) => this.toolInvoke(req)));
    route('POST', '/tool/request-approval', auth('tool:invoke', (req) => this.toolRequestApproval(req)));
    route('POST', '/tool/approve', auth('approval:decide', (req) => this.toolApprove(req)));
    route('GET', '/approvals', auth('approval:decide', (req) => this.approvalsList(req)));
    // JQ-CIP creator identity & provenance (public read-only; never exposes private keys).
    route('GET', '/identity', () => this.identityInfo());
    route('GET', '/identity/creator', () => this.identityCreator());
    route('GET', '/identity/root', () => this.identityRoot());
    route('GET', '/identity/provenance', () => this.identityProvenance());
    route('GET', '/identity/verify', () => this.identityVerify());
    // Commerce (product packaging, plans, subscriptions, entitlements).
    route('GET', '/commerce/plans', auth('commerce:read', () => this.plansList()));
    route('POST', '/commerce/subscribe', auth('commerce:read', (req) => this.subscribe(req)));
    route('POST', '/commerce/subscription', auth('commerce:read', (req) => this.subscriptionAction(req)));
    route('GET', '/commerce/check', auth('commerce:read', (req) => this.entitlementCheck(req)));
    route('POST', '/commerce/meter', auth('commerce:read', (req) => this.meterUsage(req)));
    route('GET', '/commerce/credits', auth('commerce:read', (req) => this.creditsBalance(req)));
    route('POST', '/commerce/credits', auth('commerce:read', (req) => this.grantCredits(req)));
    route('GET', '/commerce/analytics', auth('commerce:read', () => this.commerceAnalytics()));
    route('POST', '/commerce/marketplace', auth('commerce:read', (req) => this.marketplacePurchase(req)));
    // Organizations (multi-tenancy).
    route('GET', '/orgs', auth('org:read', (req) => this.orgsList(req)));
    route('POST', '/orgs', auth('org:read', (req) => this.orgCreate(req)));
    route('GET', '/org', auth('org:read', (req) => this.orgGet(req)));
    route('POST', '/org', auth('org:read', (req) => this.orgAction(req)));
    route('GET', '/org/members', auth('org:read', (req) => this.orgMembers(req)));
    // Tenant-scoped data store — proves multi-tenant storage isolation (PR4).
    route('GET', '/org/data', auth('org:read', (req) => this.orgDataGet(req)));
    route('POST', '/org/data', auth('org:read', (req) => this.orgDataMutate(req)));
    route('GET', '/sessions', auth(null, (req) => this.sessionsList(req)));
    // Unified Chat API (PR3 consumer AI — conversations + model routing + safety).
    route('POST', '/chat', auth('agent:run', (req) => this.chat(req)));
    route('GET', '/chats', auth('agent:run', (req) => this.chatList(req)));
    route('POST', '/chats', auth('agent:run', (req) => this.chatCreate(req)));
    route('GET', '/chat', auth('agent:run', (req) => this.chatGet(req)));
    route('POST', '/chat/delete', auth('agent:run', (req) => this.chatDelete(req)));
    route('POST', '/chat/message', auth('agent:run', (req) => this.chatMessage(req)));
    route('POST', '/chat/edit', auth('agent:run', (req) => this.chatEdit(req)));
    route('POST', '/chat/share', auth('agent:run', (req) => this.chatShare(req)));
    route('GET', '/chat/shared', (req) => this.chatShared(req));
    route('POST', '/chat/folder', auth('agent:run', (req) => this.chatFolder(req)));
    route('POST', '/chat/folder/move', auth('agent:run', (req) => this.chatFolderMove(req)));
    route('GET', '/chat/folders', auth('agent:run', (req) => this.chatFolders(req)));
    route('GET', '/chat/export', auth('agent:run', (req) => this.chatExport(req)));
    route('GET', '/chat/search', auth('agent:run', (req) => this.chatSearch(req)));
    // TANYA AI — conversational product layer (personas + persistent chat + identity).
    route('POST', '/tanya/chat', auth('tanya:write', (req) => this.tanyaChat(req)));
    route('GET', '/tanya/conversations', auth('tanya:read', (req) => this.tanyaConversations(req)));
    route('GET', '/tanya/conversation', auth('tanya:read', (req) => this.tanyaConversation(req)));
    route('POST', '/tanya/conversation/delete', auth('tanya:write', (req) => this.tanyaConversationDelete(req)));
    route('GET', '/tanya/personas', auth('tanya:read', () => this.tanyaPersonas()));
    route('POST', '/tanya/persona', auth('tanya:write', (req) => this.tanyaPersonaCreate(req)));
    route('POST', '/tanya/identify', auth('tanya:read', (req) => this.tanyaIdentify(req)));
    route('GET', '/tanya/stats', auth('tanya:read', (req) => this.tanyaStats(req)));
    // TANYA Mobile Native — devices, push, offline outbox, home snapshot.
    route('POST', '/mobile/devices', auth('mobile:write', (req) => this.mobileDevicesRegister(req)));
    route('GET', '/mobile/devices', auth('mobile:read', (req) => this.mobileDevicesList(req)));
    route('POST', '/mobile/devices/unregister', auth('mobile:write', (req) => this.mobileDevicesUnregister(req)));
    route('POST', '/mobile/outbox', auth('mobile:write', (req) => this.mobileOutbox(req)));
    route('GET', '/mobile/snapshot', auth('mobile:read', (req) => this.mobileSnapshot(req)));
    route('POST', '/mobile/notify', auth('mobile:write', (req) => this.mobileNotify(req)));
    route('POST', '/mobile/push', auth('mobile:write', (req) => this.mobilePushEmit(req)));
    route('POST', '/tanya/share', auth('tanya:write', (req) => this.tanyaShare(req)));
    route('POST', '/tanya/unshare', auth('tanya:write', (req) => this.tanyaUnshare(req)));
    route('GET', '/tanya/shared', auth('tanya:read', (req) => this.tanyaShared(req)));
    route('GET', '/tanya/shares', auth('tanya:read', (req) => this.tanyaShares(req)));
    route('GET', '/tanya/org', auth('tanya:read', (req) => this.tanyaOrg(req)));
    route('POST', '/tanya/shares/prune', auth('tanya:write', (req) => this.tanyaSharesPrune(req)));
    route('POST', '/tanya/summarize', auth('tanya:write', (req) => this.tanyaSummarize(req)));
    route('POST', '/tanya/conversation/pin', auth('tanya:write', (req) => this.tanyaPin(req)));
    route('POST', '/tanya/conversation/archive', auth('tanya:write', (req) => this.tanyaArchive(req)));
    route('POST', '/session/revoke', auth(null, (req) => this.sessionRevoke(req)));
    // Notifications.
    route('GET', '/notifications', auth('notification:read', (req) => this.notificationsList(req)));
    route('POST', '/notification/read', auth('notification:read', (req) => this.notificationRead(req)));
    route('POST', '/notify', auth('notification:read', (req) => this.notify(req)));
    route('GET', '/notification/preferences', auth('notification:read', (req) => this.notificationPrefs(req)));
    route('POST', '/notification/preferences', auth('notification:read', (req) => this.notificationSetPrefs(req)));
    // Governance: policies, compliance controls, feature flags, privacy.
    route('GET', '/policies', auth('audit:read', () => this.policiesList()));
    route('POST', '/policy/evaluate', auth('audit:read', (req) => this.policyEvaluate(req)));
    route('POST', '/policy', auth('audit:read', (req) => this.policyCreate(req)));
    route('GET', '/compliance', auth('audit:read', () => this.complianceSummary()));
    route('GET', '/flags', auth('metrics:read', () => this.flagsList()));
    route('GET', '/flag/check', auth('metrics:read', (req) => this.flagCheck(req)));
    route('POST', '/flag', auth('metrics:read', (req) => this.flagSet(req)));
    route('GET', '/privacy/classification', auth('audit:read', (req) => this.privacyClassify(req)));
    route('POST', '/privacy/consent', auth('audit:read', (req) => this.privacyConsent(req)));
    route('GET', '/privacy/consent', auth('audit:read', (req) => this.privacyConsentList(req)));
    route('POST', '/privacy/sar', auth('audit:read', (req) => this.privacySAR(req)));
    route('GET', '/privacy/sar', auth('audit:read', (req) => this.privacySARList(req)));
    // Privacy engineering: PIA / RoPA / secure deletion / minimization.
    route('POST', '/privacy/pia', auth('audit:read', (req) => this.privacyPiaSubmit(req)));
    route('GET', '/privacy/pia', auth('audit:read', (req) => this.privacyPiaList(req)));
    route('POST', '/privacy/pia/decide', auth('audit:read', (req) => this.privacyPiaDecide(req)));
    route('POST', '/privacy/processing', auth('audit:read', (req) => this.privacyProcessingRegister(req)));
    route('GET', '/privacy/processing', auth('audit:read', (req) => this.privacyProcessingList(req)));
    route('POST', '/privacy/secure-delete', auth('audit:read', (req) => this.privacySecureDelete(req)));
    route('GET', '/privacy/deletions', auth('audit:read', (req) => this.privacyDeletionsList(req)));
    route('POST', '/privacy/minimize', auth('audit:read', (req) => this.privacyMinimizeCheck(req)));
    route('GET', '/privacy/minimize', auth('audit:read', () => this.privacyMinimizeList()));
    route('GET', '/privacy/posture', auth('audit:read', () => this.privacyPosture()));
    // Policy & governance registry.
    route('GET', '/gov/policies', auth('policy:read', (req) => this.govList(req)));
    route('POST', '/gov/policies', auth('policy:read', (req) => this.govCreate(req)));
    route('GET', '/gov/policy', auth('policy:read', (req) => this.govGet(req)));
    route('POST', '/gov/policy', auth('policy:read', (req) => this.govUpdate(req)));
    route('POST', '/gov/policies/evaluate', auth('policy:evaluate', (req) => this.govEvaluate(req)));
    route('POST', '/gov/policies/simulate', auth('policy:evaluate', (req) => this.govSimulate(req)));
    route('GET', '/gov/policy/versions', auth('policy:read', (req) => this.govVersions(req)));
    route('GET', '/gov/evaluations', auth('policy:audit', (req) => this.govEvaluations(req)));
    route('POST', '/gov/agent', auth('policy:read', (req) => this.govSetAgent(req)));
    route('POST', '/gov/agent/check', auth('policy:evaluate', (req) => this.govCheckAgent(req)));
    // PRX Part L — Legal Operation Mode + accreditation (public posture; mutations
    // are governance-gated). Public read endpoints let auditors verify the
    // platform never claims accreditation it has not earned.
    route('GET', '/accreditation/status', () => this.accreditationStatus());
    route('GET', '/accreditation/domains', () => this.accreditationDomains());
    route('GET', '/accreditation/compliance', auth('audit:read', () => this.accreditationCompliance()));
    route('GET', '/accreditation/grants', auth('audit:read', (req) => this.accreditationGrants(req)));
    route('GET', '/accreditation/ledger', auth('audit:read', () => this.accreditationLedger()));
    route('GET', '/accreditation/verify-claim', (req) => this.accreditationVerifyClaim(req));
    route('POST', '/accreditation/grant', auth('policy:audit', (req) => this.accreditationRecordGrant(req)));
    route('POST', '/accreditation/grant/status', auth('policy:audit', (req) => this.accreditationSetGrantStatus(req)));
    route('POST', '/accreditation/mode', auth('policy:audit', (req) => this.accreditationSetMode(req)));
    // PRX Part D — Global DNS platform: zones, RDAP/WHOIS, resolution, analytics.
    route('GET', '/dns/zones', auth('audit:read', () => this.dnsZones()));
    route('GET', '/dns/zone', auth('audit:read', (req) => this.dnsZoneGet(req)));
    route('POST', '/dns/zone', auth('policy:audit', (req) => this.dnsZoneCreate(req)));
    route('POST', '/dns/records', auth('policy:audit', (req) => this.dnsRecordsAdd(req)));
    route('POST', '/dns/sign', auth('policy:audit', (req) => this.dnsSign(req)));
    route('GET', '/dns/resolve', auth('audit:read', (req) => this.dnsResolve(req)));
    route('GET', '/dns/rdap', (req) => this.dnsRdap(req));
    route('GET', '/dns/analytics', auth('metrics:read', () => this.dnsAnalytics()));
    // PRX Part A — Registry (RDAP public; management audit-gated).
    route('GET', '/registry/rdap', (req) => this.registryRdap(req));
    route('GET', '/registry/tlds', auth('audit:read', () => this.registryTlds()));
    route('GET', '/registry/report', auth('audit:read', () => this.registryReport()));
    route('GET', '/registry/zones', auth('audit:read', (req) => this.registryZones(req)));
    route('POST', '/registry/escrow', auth('policy:audit', (req) => this.registryEscrow(req)));
    route('POST', '/registry/tld', auth('policy:audit', (req) => this.registryAddTld(req)));
    route('POST', '/registry/registrar', auth('policy:audit', (req) => this.registryAddRegistrar(req)));
    // PRX Part B — Registrar (consumer-facing domain flows).
    route('GET', '/registrar/list', auth('audit:read', () => this.registrarList()));
    route('POST', '/registrar', auth('policy:audit', (req) => this.registrarAdd(req)));
    route('POST', '/registrar/search', auth('commerce:read', (req) => this.registrarSearch(req)));
    route('POST', '/registrar/register', auth('commerce:read', (req) => this.registrarRegister(req)));
    route('POST', '/registrar/renew', auth('commerce:read', (req) => this.registrarRenew(req)));
    route('GET', '/registrar/portfolio', auth('commerce:read', (req) => this.registrarPortfolio(req)));
    // Digital Memory Engine (CLP Phase 1) — governed platform-event memory.
    route('POST', '/memory', auth('memory:write', (req) => this.memoryRecord(req)));
    route('GET', '/memory', auth('memory:read', (req) => this.memoryQuery(req)));
    route('GET', '/memory/stats', auth('memory:read', (req) => this.memoryStats(req)));
    route('GET', '/memory/export', auth('memory:read', (req) => this.memoryExport(req)));
    route('POST', '/memory/delete', auth('memory:write', (req) => this.memoryDelete(req)));
    route('POST', '/memory/policy', auth('memory:write', (req) => this.memoryPolicy(req)));
    route('POST', '/memory/sweep', auth('memory:write', (req) => this.memorySweep(req)));
    // Continuous Learning (CLP Phase 2/6) — insights, recommendations, personalization.
    route('POST', '/learning/analyze', auth('learning:read', (req) => this.learningAnalyze(req)));
    route('GET', '/learning/insights', auth('learning:read', (req) => this.learningInsights(req)));
    route('GET', '/learning/recommendations', auth('learning:read', (req) => this.learningRecommendations(req)));
    route('POST', '/learning/recommendation/review', auth('learning:write', (req) => this.learningReview(req)));
    route('POST', '/learning/recommendation/deploy', auth('learning:write', (req) => this.learningDeploy(req)));
    route('POST', '/learning/preference', auth('learning:write', (req) => this.learningPreference(req)));
    route('GET', '/learning/adaptation', auth('learning:read', (req) => this.learningAdaptation(req)));
    // CLP Phase 5 — knowledge distillation.
    route('POST', '/learning/distill', auth('learning:write', (req) => this.learningDistill(req)));
    route('GET', '/learning/lessons', auth('learning:read', () => this.learningLessons()));
    route('GET', '/learning/playbooks', auth('learning:read', () => this.learningPlaybooks()));
    route('GET', '/learning/distill-stats', auth('learning:read', () => this.learningDistillStats()));
    // AI Learning Platform (CLP Phase 3) — prompt registry, quality, drift.
    route('GET', '/ai-learning/prompts', auth('learning:read', (req) => this.aiPromptsList(req)));
    route('POST', '/ai-learning/prompts', auth('learning:write', (req) => this.aiPromptsCreate(req)));
    route('POST', '/ai-learning/prompts/version', auth('learning:write', (req) => this.aiPromptsVersion(req)));
    route('POST', '/ai-learning/prompts/approve', auth('learning:write', (req) => this.aiPromptsApprove(req)));
    route('POST', '/ai-learning/prompts/activate', auth('learning:write', (req) => this.aiPromptsActivate(req)));
    route('GET', '/ai-learning/prompts/render', auth('learning:read', (req) => this.aiPromptsRender(req)));
    route('POST', '/ai-learning/outcomes', auth('learning:write', (req) => this.aiOutcomesRecord(req)));
    route('GET', '/ai-learning/metrics', auth('learning:read', (req) => this.aiMetrics(req)));
    route('GET', '/ai-learning/benchmarks', auth('learning:read', () => this.aiBenchmarks()));
    route('POST', '/ai-learning/drift', auth('learning:read', () => this.aiDrift()));
    // CLP Phase 4 — eval-gated prompt experiments.
    route('POST', '/ai-learning/experiments', auth('learning:write', (req) => this.aiExperimentsCreate(req)));
    route('GET', '/ai-learning/experiments', auth('learning:read', (req) => this.aiExperimentsList(req)));
    route('POST', '/ai-learning/experiments/evaluate', auth('learning:write', (req) => this.aiExperimentsEvaluate(req)));
    route('POST', '/ai-learning/experiments/conclude', auth('learning:write', (req) => this.aiExperimentsConclude(req)));
    route('POST', '/ai-learning/experiments/cancel', auth('learning:write', (req) => this.aiExperimentsCancel(req)));
    route('POST', '/ai-learning/serve', auth('learning:read', (req) => this.aiServe(req)));
    // Design system — universal design language (tokens, adaptive theming, CSS).
    route('GET', '/design-system/tokens', auth('design:read', (req) => this.designTokens(req)));
    route('GET', '/design-system/css', auth('design:read', (req) => this.designCss(req)));
    route('POST', '/design-system/mode', auth('design:write', (req) => this.designMode(req)));
    route('POST', '/design-system/adaptive', auth('design:write', (req) => this.designAdaptive(req)));
    // Branding — brand identity for the 15 JATA Qi products.
    route('GET', '/branding/products', auth('design:read', () => this.brandingProducts()));
    route('GET', '/branding/brand', auth('design:read', (req) => this.brandingGet(req)));
    route('POST', '/branding/logo', auth('design:write', (req) => this.brandingLogo(req)));
    route('POST', '/branding/app-icon', auth('design:write', (req) => this.brandingAppIcon(req)));
    route('POST', '/branding/splash', auth('design:write', (req) => this.brandingSplash(req)));
    route('POST', '/branding/marketing', auth('design:write', (req) => this.brandingMarketing(req)));
    route('POST', '/branding/business-card', auth('design:write', (req) => this.brandingBusinessCard(req)));
    // Universal Wallet (Phase 2) — double-entry wallet engine.
    route('POST', '/wallet/open', auth('finance:write', (req) => this.walletOpen(req)));
    route('GET', '/wallet', auth('finance:read', (req) => this.walletList(req)));
    route('GET', '/wallet/currencies', auth('finance:read', () => this.walletCurrencies()));
    route('GET', '/wallet/balance', auth('finance:read', (req) => this.walletBalance(req)));
    route('GET', '/wallet/ledger', auth('finance:read', (req) => this.walletLedger(req)));
    route('GET', '/wallet/summary', auth('finance:read', () => this.walletSummary()));
    route('POST', '/wallet/deposit', auth('finance:write', (req) => this.walletDeposit(req)));
    route('POST', '/wallet/withdraw', auth('finance:write', (req) => this.walletWithdraw(req)));
    route('POST', '/wallet/transfer', auth('finance:write', (req) => this.walletTransfer(req)));
    route('POST', '/wallet/status', auth('finance:write', (req) => this.walletStatus(req)));
    // KRT Digital Asset Platform (Phase 4) — tokens, NFTs, staking, exchange, custody.
    route('POST', '/crypto/assets', auth('finance:write', (req) => this.cryptoAssetsRegister(req)));
    route('GET', '/crypto/assets', auth('finance:read', (req) => this.cryptoAssetsList(req)));
    route('POST', '/crypto/mint', auth('finance:write', (req) => this.cryptoMint(req)));
    route('POST', '/crypto/burn', auth('finance:write', (req) => this.cryptoBurn(req)));
    route('POST', '/crypto/transfer', auth('finance:write', (req) => this.cryptoTransfer(req)));
    route('GET', '/crypto/balance', auth('finance:read', (req) => this.cryptoBalance(req)));
    route('POST', '/crypto/nft/mint', auth('finance:write', (req) => this.cryptoNftMint(req)));
    route('POST', '/crypto/nft/transfer', auth('finance:write', (req) => this.cryptoNftTransfer(req)));
    route('POST', '/crypto/stake', auth('finance:write', (req) => this.cryptoStake(req)));
    route('POST', '/crypto/quote', auth('finance:read', (req) => this.cryptoQuote(req)));
    route('POST', '/crypto/swap', auth('finance:write', (req) => this.cryptoSwap(req)));
    route('POST', '/crypto/custody', auth('finance:write', (req) => this.cryptoCustody(req)));
    route('POST', '/crypto/contracts', auth('finance:write', (req) => this.cryptoContracts(req)));
    route('GET', '/crypto/summary', auth('finance:read', () => this.cryptoSummary()));
    // Adaptive Dashboard (Phase 5 step 3) — widget framework + layout + AI personalization.
    route('POST', '/dashboard/layouts', auth('dashboard:write', (req) => this.dashboardLayoutsCreate(req)));
    route('GET', '/dashboard/layouts', auth('dashboard:read', (req) => this.dashboardLayoutsList(req)));
    route('POST', '/dashboard/adapt', auth('dashboard:write', (req) => this.dashboardAdapt(req)));
    route('POST', '/dashboard/widgets', auth('dashboard:write', (req) => this.dashboardWidgetsAdd(req)));
    route('GET', '/dashboard/widgets', auth('dashboard:read', (req) => this.dashboardWidgetsList(req)));
    route('POST', '/dashboard/widgets/move', auth('dashboard:write', (req) => this.dashboardWidgetsMove(req)));
    route('POST', '/dashboard/widgets/resize', auth('dashboard:write', (req) => this.dashboardWidgetsResize(req)));
    route('POST', '/dashboard/auto-arrange', auth('dashboard:write', (req) => this.dashboardAutoArrange(req)));
    route('GET', '/dashboard/analytics', auth('dashboard:read', () => this.dashboardAnalytics()));
    // Universal Link Intelligence — classify, extract, gap analysis, proposals.
    route('POST', '/link/process', auth('knowledge:write', (req) => this.linkProcess(req)));
    route('POST', '/link/process-batch', auth('knowledge:write', (req) => this.linkProcessBatch(req)));
    route('GET', '/link/results', auth('knowledge:read', () => this.linkResults()));
    route('GET', '/link/summary', auth('knowledge:read', () => this.linkSummary()));
    route('POST', '/link/proposals/validate', auth('knowledge:write', (req) => this.linkValidate(req)));
    route('POST', '/link/evolve', auth('knowledge:write', (req) => this.linkEvolve(req)));
    // Universal Multimodal Intelligence — acquisition framework for every modality.
    route('POST', '/multimodal/sources', auth('knowledge:write', (req) => this.multimodalSourcesRegister(req)));
    route('GET', '/multimodal/sources', auth('knowledge:read', (req) => this.multimodalSourcesList(req)));
    route('POST', '/multimodal/sources/authorize', auth('knowledge:write', (req) => this.multimodalSourcesAuthorize(req)));
    route('POST', '/multimodal/sources/revoke', auth('knowledge:write', (req) => this.multimodalSourcesRevoke(req)));
    route('POST', '/multimodal/acquire', auth('knowledge:write', (req) => this.multimodalAcquire(req)));
    route('POST', '/multimodal/acquire-batch', auth('knowledge:write', (req) => this.multimodalAcquireBatch(req)));
    // Phase 6 — Universal Search & Discovery.
    route('GET', '/search', auth('search:read', (req) => this.searchQuery(req)));
    route('GET', '/search/suggest', auth('search:read', (req) => this.searchSuggest(req)));
    route('POST', '/search/history', auth('search:read', (req) => this.searchRecord(req)));
    route('GET', '/search/history', auth('search:read', (req) => this.searchHistory(req)));
    route('GET', '/search/stats', auth('search:read', () => this.searchStats()));
    // Phase 6 — SOMA AI Intelligent Automation Engine.
    route('GET', '/automations', auth('automation:read', (req) => this.automationsList(req)));
    route('POST', '/automations', auth('automation:write', (req) => this.automationsCreate(req)));
    route('GET', '/automation', auth('automation:read', (req) => this.automationGet(req)));
    route('POST', '/automations/run', auth('automation:write', (req) => this.automationsRun(req)));
    route('GET', '/automations/executions', auth('automation:read', (req) => this.automationsExecutions(req)));
    route('POST', '/automations/status', auth('automation:write', (req) => this.automationsStatus(req)));
    route('POST', '/automations/remove', auth('automation:write', (req) => this.automationsRemove(req)));
    route('GET', '/automations/stats', auth('automation:read', () => this.automationsStats()));
    // Phase 6 — KARIS FX foreign exchange intelligence.
    route('POST', '/fx/rates', auth('finance:write', (req) => this.fxRatesSet(req)));
    route('GET', '/fx/rates', auth('finance:read', (req) => this.fxRatesList(req)));
    route('GET', '/fx/rate', auth('finance:read', (req) => this.fxRateGet(req)));
    route('POST', '/fx/convert', auth('finance:read', (req) => this.fxConvert(req)));
    route('GET', '/fx/history', auth('finance:read', (req) => this.fxHistory(req)));
    route('GET', '/fx/analytics', auth('finance:read', (req) => this.fxAnalytics(req)));
    route('GET', '/fx/currencies', auth('finance:read', () => this.fxCurrencies()));
    route('GET', '/fx/stats', auth('finance:read', () => this.fxStats()));
    // PRX Part C — PKI: CA + Registration Authority + Identity Provider.
    route('GET', '/pki/status', auth('pki:read', () => this.pkiStatus()));
    route('POST', '/pki/ca/root', auth('pki:write', (req) => this.pkiCaRoot(req)));
    route('POST', '/pki/ca/intermediate', auth('pki:write', (req) => this.pkiCaIntermediate(req)));
    route('GET', '/pki/cas', auth('pki:read', () => this.pkiCas()));
    route('POST', '/pki/certificates', auth('pki:write', (req) => this.pkiCertificatesIssue(req)));
    route('GET', '/pki/certificates', auth('pki:read', (req) => this.pkiCertificatesList(req)));
    route('POST', '/pki/certificates/revoke', auth('pki:write', (req) => this.pkiCertificatesRevoke(req)));
    route('GET', '/pki/crl', auth('pki:read', (req) => this.pkiCrl(req)));
    route('POST', '/pki/ra/requests', auth('pki:write', (req) => this.pkiRaCreate(req)));
    route('POST', '/pki/ra/validate', auth('pki:write', (req) => this.pkiRaValidate(req)));
    route('POST', '/pki/ra/approve', auth('pki:write', (req) => this.pkiRaApprove(req)));
    route('POST', '/pki/idp/clients', auth('pki:write', (req) => this.pkiIdpClients(req)));
    route('POST', '/pki/idp/authorize', auth('pki:read', (req) => this.pkiIdpAuthorize(req)));
    route('POST', '/pki/idp/token', (req) => this.pkiIdpToken(req));
    route('POST', '/pki/idp/introspect', (req) => this.pkiIdpIntrospect(req));
    route('GET', '/pki/idp/userinfo', auth('pki:read', (req) => this.pkiIdpUserinfo(req)));
    route('GET', '/pki/idp/discovery', () => this.pkiIdpDiscovery());
    route('POST', '/pki/idp/login', (req) => this.pkiIdpLogin(req));
    route('POST', '/pki/idp/console-login', (req) => this.pkiIdpConsoleLogin(req));
    route('POST', '/pki/idp/revoke', (req) => this.pkiIdpRevoke(req));
    route('POST', '/pki/idp/refresh', (req) => this.pkiIdpRefresh(req));
    route('POST', '/pki/idp/rotate', (req) => this.pkiIdpRotate(req));
    route('POST', '/pki/idp/profile', auth('pki:write', (req) => this.pkiIdpProfile(req)));
    // PRX Part C — ACME (RFC 8555) automated certificate issuance.
    route('GET', '/pki/acme/directory', auth('pki:read', () => this.pkiAcmeDirectory()));
    route('GET', '/pki/acme/new-nonce', auth('pki:read', () => this.pkiAcmeNewNonce()));
    route('POST', '/pki/acme/new-account', auth('pki:write', (req) => this.pkiAcmeNewAccount(req)));
    route('POST', '/pki/acme/new-order', auth('pki:write', (req) => this.pkiAcmeNewOrder(req)));
    route('GET', '/pki/acme/order', auth('pki:read', (req) => this.pkiAcmeOrder(req)));
    route('GET', '/pki/acme/authz', auth('pki:read', (req) => this.pkiAcmeAuthz(req)));
    route('GET', '/pki/acme/challenge', auth('pki:read', (req) => this.pkiAcmeChallenge(req)));
    route('GET', '/pki/acme/challenge/key-auth', auth('pki:read', (req) => this.pkiAcmeChallengeKeyAuth(req)));
    route('POST', '/pki/acme/challenge/validate', auth('pki:write', (req) => this.pkiAcmeChallengeValidate(req)));
    route('POST', '/pki/acme/challenge/proof', auth('pki:write', (req) => this.pkiAcmeChallengeProof(req)));
    route('POST', '/pki/acme/finalize', auth('pki:write', (req) => this.pkiAcmeFinalize(req)));
    route('GET', '/pki/acme/certificate', auth('pki:read', (req) => this.pkiAcmeCertificate(req)));
    route('POST', '/pki/acme/revoke', auth('pki:write', (req) => this.pkiAcmeRevoke(req)));
    // Phase 7 — MOTO X mobility intelligence.
    route('POST', '/mobility/vehicles', auth('mobility:write', (req) => this.mobilityVehiclesRegister(req)));
    route('GET', '/mobility/vehicles', auth('mobility:read', (req) => this.mobilityVehiclesList(req)));
    route('POST', '/mobility/vehicles/status', auth('mobility:write', (req) => this.mobilityVehiclesStatus(req)));
    route('POST', '/mobility/fleets', auth('mobility:write', (req) => this.mobilityFleetsCreate(req)));
    route('GET', '/mobility/fleets', auth('mobility:read', () => this.mobilityFleetsList()));
    route('POST', '/mobility/fleets/vehicles', auth('mobility:write', (req) => this.mobilityFleetsAddVehicle(req)));
    route('POST', '/mobility/drivers', auth('mobility:write', (req) => this.mobilityDriversRegister(req)));
    route('GET', '/mobility/drivers', auth('mobility:read', () => this.mobilityDriversList()));
    route('POST', '/mobility/trips', auth('mobility:write', (req) => this.mobilityTripsRequest(req)));
    route('GET', '/mobility/trips', auth('mobility:read', (req) => this.mobilityTripsList(req)));
    route('POST', '/mobility/trips/status', auth('mobility:write', (req) => this.mobilityTripsStatus(req)));
    route('POST', '/mobility/telemetry', auth('mobility:write', (req) => this.mobilityTelemetry(req)));
    route('GET', '/mobility/telemetry', auth('mobility:read', (req) => this.mobilityTelemetryList(req)));
    route('POST', '/mobility/geofences', auth('mobility:write', (req) => this.mobilityGeofencesCreate(req)));
    route('GET', '/mobility/geofences', auth('mobility:read', () => this.mobilityGeofencesList()));
    route('GET', '/mobility/geofences/vehicles', auth('mobility:read', (req) => this.mobilityGeofencesVehicles(req)));
    route('GET', '/mobility/stats', auth('mobility:read', () => this.mobilityStats()));
    // Phase 7 — PORTLINK logistics intelligence.
    route('POST', '/logistics/ports', auth('logistics:write', (req) => this.logisticsPortsRegister(req)));
    route('GET', '/logistics/ports', auth('logistics:read', () => this.logisticsPortsList()));
    route('POST', '/logistics/vessels', auth('logistics:write', (req) => this.logisticsVesselsRegister(req)));
    route('GET', '/logistics/vessels', auth('logistics:read', (req) => this.logisticsVesselsList(req)));
    route('POST', '/logistics/containers', auth('logistics:write', (req) => this.logisticsContainersRegister(req)));
    route('GET', '/logistics/containers', auth('logistics:read', (req) => this.logisticsContainersList(req)));
    route('POST', '/logistics/shipments', auth('logistics:write', (req) => this.logisticsShipmentsCreate(req)));
    route('GET', '/logistics/shipments', auth('logistics:read', (req) => this.logisticsShipmentsList(req)));
    route('GET', '/logistics/shipment', auth('logistics:read', (req) => this.logisticsShipmentGet(req)));
    route('POST', '/logistics/shipments/containers', auth('logistics:write', (req) => this.logisticsShipmentsAssignContainer(req)));
    route('POST', '/logistics/shipments/track', auth('logistics:write', (req) => this.logisticsShipmentsTrack(req)));
    route('GET', '/logistics/shipments/timeline', auth('logistics:read', (req) => this.logisticsShipmentsTimeline(req)));
    route('POST', '/logistics/warehouses', auth('logistics:write', (req) => this.logisticsWarehousesRegister(req)));
    route('GET', '/logistics/warehouses', auth('logistics:read', () => this.logisticsWarehousesList()));
    route('GET', '/logistics/stats', auth('logistics:read', () => this.logisticsStats()));
    // Phase 7 — KARIS FARM agriculture intelligence.
    route('POST', '/agriculture/farms', auth('agriculture:write', (req) => this.agricultureFarmsRegister(req)));
    route('GET', '/agriculture/farms', auth('agriculture:read', (req) => this.agricultureFarmsList(req)));
    route('POST', '/agriculture/fields', auth('agriculture:write', (req) => this.agricultureFieldsAdd(req)));
    route('GET', '/agriculture/fields', auth('agriculture:read', (req) => this.agricultureFieldsList(req)));
    route('POST', '/agriculture/crops', auth('agriculture:write', (req) => this.agricultureCropsPlant(req)));
    route('GET', '/agriculture/crops', auth('agriculture:read', (req) => this.agricultureCropsList(req)));
    route('POST', '/agriculture/crops/stage', auth('agriculture:write', (req) => this.agricultureCropsStage(req)));
    route('POST', '/agriculture/harvests', auth('agriculture:write', (req) => this.agricultureHarvestsRecord(req)));
    route('GET', '/agriculture/harvests', auth('agriculture:read', (req) => this.agricultureHarvestsList(req)));
    route('POST', '/agriculture/herds', auth('agriculture:write', (req) => this.agricultureHerdsRegister(req)));
    route('GET', '/agriculture/herds', auth('agriculture:read', (req) => this.agricultureHerdsList(req)));
    route('GET', '/agriculture/stats', auth('agriculture:read', (req) => this.agricultureStats(req)));
    // Phase 7 — KARIS LOOP circular economy.
    route('POST', '/circular/streams', auth('circular:write', (req) => this.circularStreamsRegister(req)));
    route('GET', '/circular/streams', auth('circular:read', () => this.circularStreamsList()));
    route('POST', '/circular/collections', auth('circular:write', (req) => this.circularCollectionsRecord(req)));
    route('GET', '/circular/collections', auth('circular:read', (req) => this.circularCollectionsList(req)));
    route('POST', '/circular/collections/status', auth('circular:write', (req) => this.circularCollectionsStatus(req)));
    route('POST', '/circular/takeback', auth('circular:write', (req) => this.circularTakebackRegister(req)));
    route('GET', '/circular/takeback', auth('circular:read', (req) => this.circularTakebackList(req)));
    route('POST', '/circular/takeback/status', auth('circular:write', (req) => this.circularTakebackStatus(req)));
    route('GET', '/circular/score', auth('circular:read', (req) => this.circularScore(req)));
    route('GET', '/circular/stats', auth('circular:read', () => this.circularStats()));
    // Phase 7 — KARIS ENERGY.
    route('POST', '/energy/assets', auth('energy:write', (req) => this.energyAssetsRegister(req)));
    route('GET', '/energy/assets', auth('energy:read', (req) => this.energyAssetsList(req)));
    route('POST', '/energy/assets/status', auth('energy:write', (req) => this.energyAssetsStatus(req)));
    route('POST', '/energy/meters', auth('energy:write', (req) => this.energyMetersRegister(req)));
    route('GET', '/energy/meters', auth('energy:read', (req) => this.energyMetersList(req)));
    route('POST', '/energy/readings', auth('energy:write', (req) => this.energyReadingsRecord(req)));
    route('GET', '/energy/readings', auth('energy:read', (req) => this.energyReadingsList(req)));
    route('POST', '/energy/tariffs', auth('energy:write', (req) => this.energyTariffsRegister(req)));
    route('GET', '/energy/tariffs', auth('energy:read', () => this.energyTariffsList()));
    route('POST', '/energy/bills', auth('energy:write', (req) => this.energyBillsIssue(req)));
    route('GET', '/energy/bills', auth('energy:read', (req) => this.energyBillsList(req)));
    route('GET', '/energy/stats', auth('energy:read', () => this.energyStats()));
    // Phase 7 — KARIS BORDER X.
    route('POST', '/border/posts', auth('border:write', (req) => this.borderPostsRegister(req)));
    route('GET', '/border/posts', auth('border:read', (req) => this.borderPostsList(req)));
    route('POST', '/border/posts/status', auth('border:write', (req) => this.borderPostsStatus(req)));
    route('POST', '/border/watchlist', auth('border:write', (req) => this.borderWatchlistAdd(req)));
    route('GET', '/border/watchlist', auth('border:read', () => this.borderWatchlistList()));
    route('POST', '/border/crossings', auth('border:write', (req) => this.borderCrossingsProcess(req)));
    route('GET', '/border/crossings', auth('border:read', (req) => this.borderCrossingsList(req)));
    route('POST', '/border/crossings/override', auth('border:write', (req) => this.borderCrossingsOverride(req)));
    route('POST', '/border/manifests', auth('border:write', (req) => this.borderManifestsDeclare(req)));
    route('GET', '/border/manifests', auth('border:read', (req) => this.borderManifestsList(req)));
    route('POST', '/border/manifests/status', auth('border:write', (req) => this.borderManifestsStatus(req)));
    route('GET', '/border/stats', auth('border:read', () => this.borderStats()));
    // Phase 7 — NYUMBANI KITCHEN restaurant intelligence.
    route('POST', '/restaurants/venues', auth('restaurants:write', (req) => this.restaurantsVenuesRegister(req)));
    route('GET', '/restaurants/venues', auth('restaurants:read', (req) => this.restaurantsVenuesList(req)));
    route('POST', '/restaurants/menu', auth('restaurants:write', (req) => this.restaurantsMenuAdd(req)));
    route('GET', '/restaurants/menu', auth('restaurants:read', (req) => this.restaurantsMenuList(req)));
    route('POST', '/restaurants/menu/available', auth('restaurants:write', (req) => this.restaurantsMenuAvailable(req)));
    route('POST', '/restaurants/tables', auth('restaurants:write', (req) => this.restaurantsTablesAdd(req)));
    route('GET', '/restaurants/tables', auth('restaurants:read', (req) => this.restaurantsTablesList(req)));
    route('POST', '/restaurants/orders', auth('restaurants:write', (req) => this.restaurantsOrdersCreate(req)));
    route('GET', '/restaurants/orders', auth('restaurants:read', (req) => this.restaurantsOrdersList(req)));
    route('POST', '/restaurants/orders/submit', auth('restaurants:write', (req) => this.restaurantsOrdersSubmit(req)));
    route('POST', '/restaurants/orders/status', auth('restaurants:write', (req) => this.restaurantsOrdersStatus(req)));
    route('POST', '/restaurants/ingredients', auth('restaurants:write', (req) => this.restaurantsIngredientsAdd(req)));
    route('GET', '/restaurants/ingredients', auth('restaurants:read', (req) => this.restaurantsIngredientsList(req)));
    route('POST', '/restaurants/ingredients/stock', auth('restaurants:write', (req) => this.restaurantsIngredientsStock(req)));
    route('GET', '/restaurants/stats', auth('restaurants:read', (req) => this.restaurantsStats(req)));
    // Phase 7 — MAZA marketplace.
    route('POST', '/marketplace/storefronts', auth('marketplace:write', (req) => this.marketplaceStorefrontsRegister(req)));
    route('GET', '/marketplace/storefronts', auth('marketplace:read', (req) => this.marketplaceStorefrontsList(req)));
    route('POST', '/marketplace/storefronts/status', auth('marketplace:write', (req) => this.marketplaceStorefrontsStatus(req)));
    route('POST', '/marketplace/listings', auth('marketplace:write', (req) => this.marketplaceListingsCreate(req)));
    route('GET', '/marketplace/listings', auth('marketplace:read', (req) => this.marketplaceListingsList(req)));
    route('POST', '/marketplace/listings/status', auth('marketplace:write', (req) => this.marketplaceListingsStatus(req)));
    route('POST', '/marketplace/listings/stock', auth('marketplace:write', (req) => this.marketplaceListingsStock(req)));
    route('POST', '/marketplace/reviews', auth('marketplace:write', (req) => this.marketplaceReviewsAdd(req)));
    route('GET', '/marketplace/reviews', auth('marketplace:read', (req) => this.marketplaceReviewsList(req)));
    route('POST', '/marketplace/purchases', auth('marketplace:write', (req) => this.marketplacePurchases(req)));
    route('GET', '/marketplace/categories', auth('marketplace:read', () => this.marketplaceCategories()));
    route('GET', '/marketplace/stats', auth('marketplace:read', () => this.marketplaceStats()));
    // MAZA purchase flows: cart → checkout → orders → payouts.
    route('POST', '/marketplace/cart', auth('marketplace:write', (req) => this.marketplaceCartGetOrCreate(req)));
    route('GET', '/marketplace/cart', auth('marketplace:read', (req) => this.marketplaceCartGet(req)));
    route('POST', '/marketplace/cart/items', auth('marketplace:write', (req) => this.marketplaceCartAdd(req)));
    route('POST', '/marketplace/cart/items/remove', auth('marketplace:write', (req) => this.marketplaceCartRemove(req)));
    route('POST', '/marketplace/cart/clear', auth('marketplace:write', (req) => this.marketplaceCartClear(req)));
    route('POST', '/marketplace/checkout', auth('marketplace:write', (req) => this.marketplaceCheckout(req)));
    route('GET', '/marketplace/orders', auth('marketplace:read', (req) => this.marketplaceOrdersList(req)));
    route('GET', '/marketplace/order', auth('marketplace:read', (req) => this.marketplaceOrderGet(req)));
    route('POST', '/marketplace/order/cancel', auth('marketplace:write', (req) => this.marketplaceOrderCancel(req)));
    route('POST', '/marketplace/order/refund', auth('marketplace:write', (req) => this.marketplaceOrderRefund(req)));
    route('GET', '/marketplace/payouts', auth('marketplace:read', (req) => this.marketplacePayoutsList(req)));
    // PRX Part E — Cloud Infrastructure Provider.
    route('POST', '/cloud/regions', auth('cloud:write', (req) => this.cloudRegionsRegister(req)));
    route('GET', '/cloud/regions', auth('cloud:read', (req) => this.cloudRegionsList(req)));
    route('POST', '/cloud/regions/status', auth('cloud:write', (req) => this.cloudRegionsStatus(req)));
    route('POST', '/cloud/flavors', auth('cloud:write', (req) => this.cloudFlavorsRegister(req)));
    route('GET', '/cloud/flavors', auth('cloud:read', (req) => this.cloudFlavorsList(req)));
    route('POST', '/cloud/images', auth('cloud:write', (req) => this.cloudImagesRegister(req)));
    route('GET', '/cloud/images', auth('cloud:read', () => this.cloudImagesList()));
    route('POST', '/cloud/instances', auth('cloud:write', (req) => this.cloudInstancesProvision(req)));
    route('GET', '/cloud/instances', auth('cloud:read', (req) => this.cloudInstancesList(req)));
    route('POST', '/cloud/instances/status', auth('cloud:write', (req) => this.cloudInstancesStatus(req)));
    route('POST', '/cloud/instances/reboot', auth('cloud:write', (req) => this.cloudInstancesReboot(req)));
    route('POST', '/cloud/instances/terminate', auth('cloud:write', (req) => this.cloudInstancesTerminate(req)));
    route('POST', '/cloud/volumes', auth('cloud:write', (req) => this.cloudVolumesCreate(req)));
    route('GET', '/cloud/volumes', auth('cloud:read', (req) => this.cloudVolumesList(req)));
    route('POST', '/cloud/volumes/attach', auth('cloud:write', (req) => this.cloudVolumesAttach(req)));
    route('POST', '/cloud/volumes/detach', auth('cloud:write', (req) => this.cloudVolumesDetach(req)));
    route('POST', '/cloud/snapshots', auth('cloud:write', (req) => this.cloudSnapshotsCreate(req)));
    route('GET', '/cloud/snapshots', auth('cloud:read', (req) => this.cloudSnapshotsList(req)));
    route('POST', '/cloud/vpcs', auth('cloud:write', (req) => this.cloudVpcsCreate(req)));
    route('GET', '/cloud/vpcs', auth('cloud:read', (req) => this.cloudVpcsList(req)));
    route('POST', '/cloud/firewall', auth('cloud:write', (req) => this.cloudFirewallAdd(req)));
    route('GET', '/cloud/firewall', auth('cloud:read', (req) => this.cloudFirewallList(req)));
    route('POST', '/cloud/load-balancers', auth('cloud:write', (req) => this.cloudLoadBalancersCreate(req)));
    route('GET', '/cloud/load-balancers', auth('cloud:read', (req) => this.cloudLoadBalancersList(req)));
    route('POST', '/cloud/load-balancers/targets', auth('cloud:write', (req) => this.cloudLoadBalancersAddTarget(req)));
    route('POST', '/cloud/hosting-plans', auth('cloud:write', (req) => this.cloudHostingPlansCreate(req)));
    route('GET', '/cloud/hosting-plans', auth('cloud:read', (req) => this.cloudHostingPlansList(req)));
    route('POST', '/cloud/hosting', auth('cloud:write', (req) => this.cloudHostingProvision(req)));
    route('POST', '/cloud/autoscaling', auth('cloud:write', (req) => this.cloudAutoscalingCreate(req)));
    route('GET', '/cloud/autoscaling', auth('cloud:read', () => this.cloudAutoscalingList()));
    route('POST', '/cloud/autoscaling/evaluate', auth('cloud:write', (req) => this.cloudAutoscalingEvaluate(req)));
    route('POST', '/cloud/autoscaling/update', auth('cloud:write', (req) => this.cloudAutoscalingUpdate(req)));
    route('GET', '/cloud/autoscaling/history', auth('cloud:read', (req) => this.cloudAutoscalingHistory(req)));
    // Active Defense & Adaptive Resilience Layer.
    route('GET', '/defense/posture', auth('defense:read', () => this.defensePosture()));
    route('GET', '/defense/findings', auth('defense:read', (req) => this.defenseFindings(req)));
    route('POST', '/defense/findings/ack', auth('defense:write', (req) => this.defenseFindingAck(req)));
    route('POST', '/defense/findings/resolve', auth('defense:write', (req) => this.defenseFindingResolve(req)));
    route('POST', '/defense/ingest', auth('defense:write', (req) => this.defenseIngest(req)));
    route('GET', '/defense/risk', auth('defense:read', (req) => this.defenseRisk(req)));
    route('POST', '/defense/risk/signal', auth('defense:write', (req) => this.defenseRiskSignal(req)));
    route('POST', '/defense/trust/reassess', auth('defense:write', (req) => this.defenseTrustReassess(req)));
    route('GET', '/defense/bans', auth('defense:read', () => this.defenseBansList()));
    route('POST', '/defense/bans', auth('defense:write', (req) => this.defenseBansAdd(req)));
    route('POST', '/defense/bans/lift', auth('defense:write', (req) => this.defenseBansLift(req)));
    route('GET', '/defense/actions', auth('defense:read', (req) => this.defenseActionsList(req)));
    route('POST', '/defense/contain', auth('defense:write', (req) => this.defenseContain(req)));
    route('POST', '/defense/actions/approve', auth('defense:write', (req) => this.defenseActionApprove(req)));
    route('POST', '/defense/actions/deny', auth('defense:write', (req) => this.defenseActionDeny(req)));
    route('GET', '/defense/honeytokens', auth('defense:read', () => this.defenseHoneytokensList()));
    route('POST', '/defense/honeytokens', auth('defense:write', (req) => this.defenseHoneytokensAdd(req)));
    route('GET', '/defense/decoys', auth('defense:read', () => this.defenseDecoysList()));
    route('POST', '/defense/decoys', auth('defense:write', (req) => this.defenseDecoysAdd(req)));
    route('GET', '/defense/touches', auth('defense:read', () => this.defenseTouchesList()));
    route('GET', '/defense/incidents', auth('defense:read', () => this.defenseIncidentsList()));
    route('POST', '/defense/incidents', auth('defense:write', (req) => this.defenseIncidentsAdd(req)));
    route('POST', '/defense/incidents/review', auth('defense:write', (req) => this.defenseIncidentsReview(req)));
    route('POST', '/defense/recover', auth('defense:write', (req) => this.defenseRecover(req)));
    route('GET', '/defense/recovery', auth('defense:read', () => this.defenseRecoveryList()));
    route('POST', '/defense/integrity', auth('defense:write', (req) => this.defenseIntegrityValidate(req)));
    route('POST', '/defense/crypto/rotate', auth('defense:write', (req) => this.defenseCryptoRotate(req)));
    route('GET', '/defense/report', auth('defense:read', () => this.defenseReport()));
    // Global Security Operations (SOC).
    route('GET', '/soc/report', auth('soc:read', () => this.socReport()));
    route('GET', '/soc/kpis', auth('soc:read', () => this.socKpis()));
    route('GET', '/soc/lake', auth('soc:read', (req) => this.socLake(req)));
    route('GET', '/soc/lake/status', auth('soc:read', () => this.socLakeStatus()));
    route('GET', '/soc/lake/export', auth('soc:read', (req) => this.socLakeExport(req)));
    route('POST', '/soc/telemetry', auth('soc:write', (req) => this.socTelemetry(req)));
    route('GET', '/soc/incidents', auth('soc:read', (req) => this.socIncidentsList(req)));
    route('POST', '/soc/incidents', auth('soc:write', (req) => this.socIncidentsOpen(req)));
    route('POST', '/soc/incidents/transition', auth('soc:write', (req) => this.socIncidentsTransition(req)));
    route('POST', '/soc/incidents/evidence', auth('soc:write', (req) => this.socIncidentsEvidence(req)));
    route('POST', '/soc/incidents/communicate', auth('soc:write', (req) => this.socIncidentsCommunicate(req)));
    route('POST', '/soc/incidents/review', auth('soc:write', (req) => this.socIncidentsReview(req)));
    route('POST', '/soc/escalate', auth('soc:write', () => this.socEscalate()));
    route('POST', '/soc/hunt', auth('soc:write', (req) => this.socHunt(req)));
    route('GET', '/soc/hunts', auth('soc:read', () => this.socHuntsList()));
    route('GET', '/soc/playbooks', auth('soc:read', () => this.socPlaybooks()));
    route('GET', '/soc/hunt-correlation', auth('soc:read', () => this.socHuntCorrelation()));
    route('POST', '/soc/intel', auth('soc:write', (req) => this.socIntelIngest(req)));
    route('GET', '/soc/intel', auth('soc:read', (req) => this.socIntelList(req)));
    route('POST', '/soc/intel/match', auth('soc:write', (req) => this.socIntelMatch(req)));
    route('GET', '/soc/intel/matches', auth('soc:read', () => this.socIntelMatches()));
    route('GET', '/soc/intel/correlation', auth('soc:read', () => this.socIntelCorrelation()));
    route('GET', '/soc/intel/health', auth('soc:read', () => this.socIntelHealth()));
    route('GET', '/soc/insider/alerts', auth('soc:read', () => this.socInsiderAlerts()));
    route('POST', '/soc/insider/observe', auth('soc:write', (req) => this.socInsiderObserve(req)));
    route('GET', '/soc/insider/posture', auth('soc:read', (req) => this.socInsiderPosture(req)));
    route('GET', '/soc/abuse/alerts', auth('soc:read', () => this.socAbuseAlerts()));
    route('POST', '/soc/abuse/observe', auth('soc:write', (req) => this.socAbuseObserve(req)));
    route('GET', '/soc/abuse/coordinated', auth('soc:read', () => this.socAbuseCoordinated()));
    route('POST', '/soc/campaigns', auth('soc:write', (req) => this.socCampaignsRun(req)));
    route('GET', '/soc/campaigns', auth('soc:read', () => this.socCampaignsList()));
    route('GET', '/soc/validation', auth('soc:read', () => this.socValidationScore()));
    route('POST', '/soc/tabletops', auth('soc:write', (req) => this.socTabletopsAdd(req)));
    route('GET', '/soc/tabletops', auth('soc:read', () => this.socTabletopsList()));
    // Software Supply Chain Governance.
    route('GET', '/supplychain/stats', auth('supplychain:read', () => this.supplyChainStats()));
    route('POST', '/supplychain/repos/check', auth('supplychain:write', (req) => this.supplyChainRepoCheck(req)));
    route('GET', '/supplychain/repos', auth('supplychain:read', () => this.supplyChainRepos()));
    route('POST', '/supplychain/pipelines/check', auth('supplychain:write', (req) => this.supplyChainPipelineCheck(req)));
    route('GET', '/supplychain/pipelines', auth('supplychain:read', () => this.supplyChainPipelines()));
    route('POST', '/supplychain/audit', auth('supplychain:write', (req) => this.supplyChainAudit(req)));
    route('POST', '/supplychain/provenance', auth('supplychain:write', (req) => this.supplyChainProvenanceCreate(req)));
    route('GET', '/supplychain/provenance', auth('supplychain:read', () => this.supplyChainProvenanceList()));
    route('POST', '/supplychain/provenance/verify', auth('supplychain:read', (req) => this.supplyChainProvenanceVerify(req)));
    route('POST', '/supplychain/releases', auth('supplychain:write', (req) => this.supplyChainReleaseSign(req)));
    route('GET', '/supplychain/releases', auth('supplychain:read', () => this.supplyChainReleases()));
    route('POST', '/supplychain/releases/verify', auth('supplychain:read', (req) => this.supplyChainReleaseVerify(req)));
    route('POST', '/supplychain/deployments', auth('supplychain:write', (req) => this.supplyChainDeployAttest(req)));
    route('GET', '/supplychain/deployments', auth('supplychain:read', () => this.supplyChainDeployments()));
    route('POST', '/supplychain/integrity', auth('supplychain:write', (req) => this.supplyChainIntegrityCheck(req)));
    route('GET', '/supplychain/integrity', auth('supplychain:read', () => this.supplyChainIntegrityHistory()));
    route('GET', '/supplychain/monitor', auth('supplychain:read', () => this.supplyChainMonitor()));
    // Secure Infrastructure Governance.
    route('GET', '/infra/stats', auth('infra:read', () => this.infraStats()));
    route('POST', '/infra/assets', auth('infra:write', (req) => this.infraAssetsRegister(req)));
    route('GET', '/infra/assets', auth('infra:read', (req) => this.infraAssetsList(req)));
    route('POST', '/infra/assets/status', auth('infra:write', (req) => this.infraAssetsStatus(req)));
    route('POST', '/infra/provisioning', auth('infra:write', (req) => this.infraProvisioningEnroll(req)));
    route('POST', '/infra/provisioning/approve', auth('infra:write', (req) => this.infraProvisioningApprove(req)));
    route('GET', '/infra/provisioning', auth('infra:read', () => this.infraProvisioningList()));
    route('POST', '/infra/firmware/validate', auth('infra:write', (req) => this.infraFirmwareValidate(req)));
    route('GET', '/infra/firmware', auth('infra:read', () => this.infraFirmwareReport()));
    route('POST', '/infra/drift', auth('infra:write', (req) => this.infraDriftDetect(req)));
    route('GET', '/infra/drift', auth('infra:read', (req) => this.infraDriftList(req)));
    route('POST', '/infra/drift/remediate', auth('infra:write', (req) => this.infraDriftRemediate(req)));
    route('POST', '/infra/compliance', auth('infra:write', (req) => this.infraComplianceRun(req)));
    route('GET', '/infra/compliance', auth('infra:read', () => this.infraComplianceReport()));
    route('POST', '/infra/access', auth('infra:write', (req) => this.infraAccessLog(req)));
    route('GET', '/infra/access', auth('infra:read', (req) => this.infraAccessList(req)));
    // Global Resilience Engineering.
    route('GET', '/resilience/stats', auth('resilience:read', () => this.resilienceStats()));
    route('GET', '/resilience/regions', auth('resilience:read', () => this.resilienceRegions()));
    route('POST', '/resilience/regions', auth('resilience:write', (req) => this.resilienceRegionsAdd(req)));
    route('POST', '/resilience/regions/role', auth('resilience:write', (req) => this.resilienceRegionsRole(req)));
    route('GET', '/resilience/health', auth('resilience:read', () => this.resilienceHealth()));
    route('POST', '/resilience/probe', auth('resilience:write', (req) => this.resilienceProbe(req)));
    route('POST', '/resilience/failover', auth('resilience:write', (req) => this.resilienceFailover(req)));
    route('POST', '/resilience/failback', auth('resilience:write', (req) => this.resilienceFailback(req)));
    route('GET', '/resilience/failovers', auth('resilience:read', () => this.resilienceFailovers()));
    route('POST', '/resilience/plans', auth('resilience:write', (req) => this.resiliencePlansCreate(req)));
    route('GET', '/resilience/plans', auth('resilience:read', () => this.resiliencePlansList()));
    route('POST', '/resilience/plans/execute', auth('resilience:write', (req) => this.resiliencePlansExecute(req)));
    route('GET', '/resilience/executions', auth('resilience:read', () => this.resilienceExecutions()));
    route('GET', '/resilience/compliance', auth('resilience:read', () => this.resilienceCompliance()));
    route('POST', '/resilience/faults', auth('resilience:write', (req) => this.resilienceFaultsInject(req)));
    route('POST', '/resilience/faults/end', auth('resilience:write', (req) => this.resilienceFaultsEnd(req)));
    route('GET', '/resilience/faults', auth('resilience:read', (req) => this.resilienceFaultsList(req)));
    route('POST', '/resilience/tests', auth('resilience:write', (req) => this.resilienceTestsRun(req)));
    route('POST', '/resilience/availability', auth('resilience:write', (req) => this.resilienceAvailabilityRecord(req)));
    route('GET', '/resilience/availability', auth('resilience:read', () => this.resilienceAvailability()));
    route('GET', '/resilience/probes', auth('resilience:read', (req) => this.resilienceProbesList(req)));
    // Independent Security Review.
    route('POST', '/review/schedule', auth('review:write', (req) => this.reviewSchedule(req)));
    route('GET', '/review', auth('review:read', (req) => this.reviewList(req)));
    route('POST', '/review/start', auth('review:write', (req) => this.reviewStart(req)));
    route('POST', '/review/complete', auth('review:write', (req) => this.reviewComplete(req)));
    route('POST', '/review/signoff', auth('review:write', (req) => this.reviewSignOff(req)));
    route('POST', '/review/findings', auth('review:write', (req) => this.reviewFindingsAdd(req)));
    route('GET', '/review/findings', auth('review:read', (req) => this.reviewFindingsList(req)));
    route('POST', '/review/findings/update', auth('review:write', (req) => this.reviewFindingsUpdate(req)));
    route('POST', '/review/scan', auth('review:write', (req) => this.reviewScan(req)));
    route('POST', '/review/architecture', auth('review:write', (req) => this.reviewArchitecture(req)));
    route('POST', '/review/compliance', auth('review:write', (req) => this.reviewCompliance(req)));
    route('GET', '/review/stats', auth('review:read', () => this.reviewStats()));
    // Security Automation (cross-pillar correlation).
    route('GET', '/security-automation/rules', auth('secauto:read', () => this.secautoRules()));
    route('POST', '/security-automation/rules', auth('secauto:write', (req) => this.secautoRulesUpsert(req)));
    route('GET', '/security-automation/correlations', auth('secauto:read', () => this.secautoCorrelations()));
    route('GET', '/security-automation/posture', auth('secauto:read', () => this.secautoPosture()));
    route('GET', '/security-automation/hunts', auth('secauto:read', () => this.secautoHunts()));
    route('POST', '/security-automation/hunts/run', auth('secauto:write', () => this.secautoHuntsRun()));
    route('POST', '/security-automation/hunts/schedule', auth('secauto:write', (req) => this.secautoHuntsSchedule(req)));
    route('GET', '/security-automation/compliance-report', auth('secauto:read', () => this.secautoComplianceReport()));
    route('GET', '/security-automation/compliance-report/export', auth('secauto:read', () => this.secautoComplianceExport()));
    // Data Loss Prevention.
    route('GET', '/dlp/rules', auth('dlp:read', () => this.dlpRules()));
    route('POST', '/dlp/rules', auth('dlp:write', (req) => this.dlpRulesUpsert(req)));
    route('POST', '/dlp/scan', auth('dlp:write', (req) => this.dlpScan(req)));
    route('GET', '/dlp/incidents', auth('dlp:read', (req) => this.dlpIncidents(req)));
    route('POST', '/dlp/incidents/update', auth('dlp:write', (req) => this.dlpIncidentsUpdate(req)));
    route('GET', '/dlp/stats', auth('dlp:read', () => this.dlpStats()));
    // Post-Quantum Readiness.
    route('GET', '/pqc/algorithms', auth('pqc:read', (req) => this.pqcAlgorithms(req)));
    route('POST', '/pqc/deprecate', auth('pqc:write', (req) => this.pqcDeprecate(req)));
    route('POST', '/pqc/keys', auth('pqc:write', (req) => this.pqcKeysGenerate(req)));
    route('GET', '/pqc/keys', auth('pqc:read', (req) => this.pqcKeysList(req)));
    route('GET', '/pqc/keys/public', auth('pqc:read', () => this.pqcKeysPublic()));
    route('POST', '/pqc/sign', auth('pqc:write', (req) => this.pqcSign(req)));
    route('POST', '/pqc/verify', auth('pqc:read', (req) => this.pqcVerify(req)));
    route('GET', '/pqc/signatures', auth('pqc:read', (req) => this.pqcSignatures(req)));
    route('POST', '/pqc/phase', auth('pqc:write', (req) => this.pqcPhaseAdvance(req)));
    route('GET', '/pqc/migration', auth('pqc:read', () => this.pqcMigration()));
    route('GET', '/pqc/stats', auth('pqc:read', () => this.pqcStats()));
    route('GET', '/cloud/stats', auth('cloud:read', () => this.cloudStats()));
    // PRX — CDN Provider.
    route('POST', '/cdn/nodes', auth('cdn:write', (req) => this.cdnNodesRegister(req)));
    route('GET', '/cdn/nodes', auth('cdn:read', (req) => this.cdnNodesList(req)));
    route('POST', '/cdn/zones', auth('cdn:write', (req) => this.cdnZonesCreate(req)));
    route('GET', '/cdn/zones', auth('cdn:read', (req) => this.cdnZonesList(req)));
    route('GET', '/cdn/zone', auth('cdn:read', (req) => this.cdnZoneGet(req)));
    route('POST', '/cdn/assets', auth('cdn:write', (req) => this.cdnAssetsStore(req)));
    route('GET', '/cdn/assets', auth('cdn:read', (req) => this.cdnAssetsList(req)));
    route('GET', '/cdn/lookup', auth('cdn:read', (req) => this.cdnLookup(req)));
    route('POST', '/cdn/purge', auth('cdn:write', (req) => this.cdnPurge(req)));
    route('GET', '/cdn/stats', auth('cdn:read', () => this.cdnStats()));
    // PRX — Email Provider.
    route('POST', '/email/domains', auth('email:write', (req) => this.emailDomainsRegister(req)));
    route('GET', '/email/domains', auth('email:read', (req) => this.emailDomainsList(req)));
    route('POST', '/email/domains/verify', auth('email:write', (req) => this.emailDomainsVerify(req)));
    route('GET', '/email/domains/dns', auth('email:read', (req) => this.emailDomainsDns(req)));
    route('POST', '/email/mailboxes', auth('email:write', (req) => this.emailMailboxesCreate(req)));
    route('GET', '/email/mailboxes', auth('email:read', (req) => this.emailMailboxesList(req)));
    route('POST', '/email/send', auth('email:write', (req) => this.emailSend(req)));
    route('GET', '/email/messages', auth('email:read', (req) => this.emailMessagesList(req)));
    route('POST', '/email/receive', auth('email:write', (req) => this.emailReceive(req)));
    route('GET', '/email/inbox', auth('email:read', (req) => this.emailInboxList(req)));
    route('GET', '/email/stats', auth('email:read', () => this.emailStats()));
    // PRX — RIR Member: IPAM + ASN holdings.
    route('POST', '/ipam/blocks', auth('ipam:write', (req) => this.ipamBlocksAllocate(req)));
    route('GET', '/ipam/blocks', auth('ipam:read', (req) => this.ipamBlocksList(req)));
    route('POST', '/ipam/blocks/split', auth('ipam:write', (req) => this.ipamBlocksSplit(req)));
    route('GET', '/ipam/blocks/addresses', auth('ipam:read', (req) => this.ipamBlocksAddresses(req)));
    route('POST', '/ipam/addresses', auth('ipam:write', (req) => this.ipamAddressesRegister(req)));
    route('GET', '/ipam/addresses', auth('ipam:read', (req) => this.ipamAddressesList(req)));
    route('POST', '/ipam/asns', auth('ipam:write', (req) => this.ipamAsnsHold(req)));
    route('GET', '/ipam/asns', auth('ipam:read', (req) => this.ipamAsnsList(req)));
    route('POST', '/ipam/announce', auth('ipam:write', (req) => this.ipamAnnounce(req)));
    route('GET', '/ipam/announcements', auth('ipam:read', () => this.ipamAnnouncements()));
    route('GET', '/ipam/stats', auth('ipam:read', () => this.ipamStats()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let span: Span | undefined;
    let httpStatus = 0;
    this.metrics?.requestsInFlight.inc();
    try {
      const url = new URL(req.url ?? '/', `${this.secure ? 'https' : 'http'}://localhost`);
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await this.readBody(req) : undefined;
      const origin = (req.headers['origin'] as string | undefined) ?? undefined;

      const greq: GatewayRequest = {
        method,
        path,
        query,
        headers: req.headers as Record<string, string | undefined>,
        body,
        remoteAddress: req.socket.remoteAddress,
      };

      // CORS preflight short-circuit (must happen before auth / rate limiting).
      if (method === 'OPTIONS' && this.cors?.enabled && origin) {
        const preflight = this.corsPreflightHeaders(origin, req.headers['access-control-request-method'] as string | undefined);
        if (Object.keys(preflight).length > 0) {
          this.finish(res, greq, { status: 204, body: '', contentType: 'text/plain', headers: preflight }, origin);
          return;
        }
      }

      // Resolve the versioned route. `/v1/health` and `/health` resolve to the
      // same handler; the de-versioned path is used for metrics + logging so
      // versioned and legacy calls aggregate (PR4 — API versioning).
      const { handler, routePath } = this.resolveRoute(method, path);

      // Start a distributed-tracing SERVER span if tracing is configured, as a
      // child of any incoming W3C traceparent (PR9 — OpenTelemetry tracing).
      if (this.tracing) {
        const parent = extractTraceContext(greq.headers);
        span = this.tracing.getTracer('api-gateway').startSpan(`HTTP ${method} ${routePath}`, {
          kind: 'server', parent, attributes: {
            'http.method': method, 'http.route': routePath, 'http.target': path,
            'http.scheme': this.secure ? 'https' : 'http', 'http.flavor': '1.1',
          },
        });
      }

      // Rate limiting (keyed by token or client IP). Step 15 "API Gateway: rate limiting".
      if (this.limiter) {
        const key = greq.headers['authorization'] ?? greq.remoteAddress ?? 'anon';
        const decision = this.limiter.consume(key);
        if (!decision.allowed) {
          this.finish(res, greq, {
            status: 429,
            body: { error: 'rate limit exceeded', limit: decision.limit },
            headers: rateHeaders(decision),
          }, origin);
          this.metrics?.requests.inc(1, { method, path: routePath, status: '429' });
          this.metrics?.requestDuration.observe(Date.now() - started, { method, path: routePath, status: '429' });
          httpStatus = 429;
          return;
        }
      }

      let resp: GatewayResponse;
      if (!handler) {
        // Try serving static UI files (web-ui module) for /ui paths.
        if (path === '/ui' || path.startsWith('/ui/')) {
          const ui = this.tryModule<import('@jataqi/core-kernel').IModule & { serve(p: string): { content: Buffer; contentType: string } | undefined }>('web-ui');
          if (ui) {
            const file = ui.serve(path);
            if (file) {
              const headers = { ...this.securityHeaders(), ...this.corsHeadersFor(origin), 'content-type': file.contentType, 'content-length': String(file.content.length) };
              res.writeHead(200, headers);
              res.end(file.content);
              httpStatus = 200;
              return;
            }
          }
        }
        resp = json(404, { error: 'not found', path });
      } else {
        try {
          resp = await handler(greq);
        } catch (err) {
          resp = this.toErrorResponse(err);
        }
      }
      this.finish(res, greq, resp, origin);
      httpStatus = resp.status;
      this.metrics?.requests.inc(1, { method, path: routePath, status: String(resp.status) });
      this.metrics?.requestDuration.observe(Date.now() - started, { method, path: routePath, status: String(resp.status) });
      this.api.logger.debug('gateway request', {
        method,
        path: routePath,
        status: resp.status,
        ms: Date.now() - started,
        actor: greq.principal?.username,
      });
    } catch (err) {
      const resp = this.toErrorResponse(err);
      httpStatus = resp.status;
      this.finish(res, { headers: {} } as GatewayRequest, resp, undefined);
      this.metrics?.requests.inc(1, { method: 'UNKNOWN', path: 'unknown', status: String(resp.status) });
      this.metrics?.requestDuration.observe(Date.now() - started, { method: 'UNKNOWN', path: 'unknown', status: String(resp.status) });
    } finally {
      if (span && span.isRecording()) {
        span.setAttribute('http.status_code', httpStatus);
        span.setAttribute('http.duration_ms', Date.now() - started);
        span.setStatus(httpStatus >= 500 ? 'error' : 'ok');
        span.end();
      }
      this.metrics?.requestsInFlight.dec();
    }
  }

  /**
   * Resolve a route handler for a (method, path), honoring the API version
   * prefix. Returns the handler (if any) and the normalized path to use for
   * metrics/logging.
   */
  private resolveRoute(method: string, path: string): { handler: RouteHandler | undefined; routePath: string } {
    const direct = this.routes.get(`${method} ${path}`);
    if (direct) return { handler: direct, routePath: path };
    if (this.versionSegment) {
      const prefix = `/${this.versionSegment}`;
      if (path === prefix) {
        const h = this.routes.get(`${method} /`);
        return { handler: h, routePath: '/' };
      }
      if (path.startsWith(prefix + '/')) {
        const base = path.slice(prefix.length); // e.g. '/health'
        const h = this.routes.get(`${method} ${base}`);
        return { handler: h, routePath: base };
      }
    }
    return { handler: undefined, routePath: path };
  }

  /** Apply security + CORS headers to a response and write it to the socket. */
  private finish(res: ServerResponse, _req: GatewayRequest, resp: GatewayResponse, origin: string | undefined): void {
    const headers: Record<string, string> = {
      ...this.securityHeaders(),
      ...this.corsHeadersFor(origin),
      ...(resp.headers ?? {}),
    };
    this.send(res, { ...resp, headers });
  }

  private send(res: ServerResponse, resp: GatewayResponse): void {
    const contentType = resp.contentType ?? 'application/json; charset=utf-8';
    // Any text/* content type (e.g. Prometheus "text/plain; version=0.0.4") is
    // written verbatim; everything else is JSON-encoded. Previously only an
    // exact "text/plain" match was treated as text, which silently JSON-quoted
    // the metrics exposition and broke Prometheus scraping.
    const isText = contentType.startsWith('text/');
    // String bodies under application/json are already-serialized documents
    // (e.g. audit/chat exports) and must be written verbatim — JSON-encoding
    // them would double-quote the payload.
    const isJsonString = contentType.startsWith('application/json') && typeof resp.body === 'string';
    const payload = isText || isJsonString ? String(resp.body) : JSON.stringify(resp.body);
    res.writeHead(resp.status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(payload),
      ...(resp.headers ?? {}),
    });
    res.end(payload);
  }

  private toErrorResponse(err: unknown): GatewayResponse {
    const e = err as Error & { status?: number; code?: string };
    const status = typeof e.status === 'number' ? e.status : 500;
    return json(status, { error: e.message || 'internal error', code: e.code });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const max = this.opts.maxBodyBytes ?? 1_048_576;
    // Drain cap: once a body exceeds the limit we keep reading (up to a small
    // multiple of the limit) so the underlying connection stream is fully
    // consumed — otherwise a rejected oversized body corrupts the keep-alive
    // connection and breaks subsequent requests on it.
    const drainCap = max * 10;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (!tooLarge && size > max) tooLarge = true;
      if (size > drainCap) break; // stop a runaway drain
      if (!tooLarge) chunks.push(chunk as Buffer);
    }
    if (tooLarge) throw Object.assign(new Error('request body too large'), { status: 413 });
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('invalid JSON body'), { status: 400 });
    }
  }

  // --- route handlers ------------------------------------------------------

  private health(): GatewayResponse {
    return json(200, {
      status: 'healthy',
      booted: this.booted,
      uptimeMs: Date.now() - BOOT_TIME,
      transport: this.secure ? 'https' : 'http',
      secure: this.secure,
      apiVersion: this.versionSegment ?? false,
      cors: this.cors?.enabled === true,
      modules: this.moduleIds(),
    });
  }

  /**
   * Liveness probe (Kubernetes): a cheap "is the process alive and serving?"
   * check. Returns 200 once the server is booted. Never performs dependency
   * checks so a flaky downstream cannot kill a healthy pod.
   */
  private livez(): GatewayResponse {
    return this.booted ? json(200, { status: 'alive' }) : json(503, { status: 'starting' });
  }

  /**
   * Readiness probe (Kubernetes): returns 200 only when the gateway can serve
   * traffic — booted AND its hard dependencies (storage driver, security) are
   * reachable. Returns 503 otherwise so a load balancer stops sending requests.
   */
  private async readyz(): Promise<GatewayResponse> {
    const checks: Record<string, boolean> = { booted: this.booted };
    // Verify the storage driver is open (write+read a probe key).
    if (this.storage) {
      try {
        const ns = await this.storage.namespace('system.health');
        await ns.set('__readyz__', Date.now());
        checks.storage = (await ns.get<number>('__readyz__')) !== undefined;
      } catch {
        checks.storage = false;
      }
    } else {
      checks.storage = true; // no storage module => nothing to verify
    }
    // Verify the security module can authenticate (no throw on the module itself).
    try {
      checks.security = typeof this.sec.authenticate === 'function';
    } catch {
      checks.security = false;
    }
    const ready = Object.values(checks).every(Boolean);
    return ready ? json(200, { status: 'ready', checks }) : json(503, { status: 'not ready', checks });
  }

  /** Self-describing index of all routes (Step 15 API reference / discovery). */
  private apiIndex(): GatewayResponse {
    const endpoints = [...this.routes.keys()].map((key) => {
      const [method, path] = key.split(' ');
      return { method: method ?? 'GET', path: path ?? '/' };
    });
    return json(200, {
      name: 'JATA Qi API',
      version: '0.1.0',
      description: 'Modular AI Operating System — HTTP gateway',
      apiVersion: this.versionSegment ?? null,
      versions: this.versionSegment ? [this.versionSegment] : [],
      ...(this.versionSegment ? { versionedBase: `/${this.versionSegment}` } : {}),
      endpoints,
      docs: '/openapi.json',
    });
  }

  /** Generate a minimal OpenAPI 3.0 document from the registered routes. */
  private openapi(): GatewayResponse {
    const paths: Record<string, Record<string, { summary: string; operationId: string }>> = {};
    for (const key of this.routes.keys()) {
      const [method, path] = key.split(' ');
      const p = path ?? '/';
      const m = (method ?? 'get').toLowerCase();
      const opPath = p.replace(/:(\w+)/g, '{$1}');
      (paths[opPath] ??= {})[m] = {
        summary: `${method} ${p}`,
        operationId: `${m}${p.replace(/[^a-zA-Z0-9]/g, '_')}`,
      };
    }
    return json(200, {
      openapi: '3.0.3',
      info: { title: 'JATA Qi API', version: '0.1.0' },
      paths,
    });
  }

  private moduleIds(): string[] {
    // The kernel does not expose a public list; collect started modules via state.
    const ids: string[] = [];
    for (const id of [
      'storage', 'vector-search', 'knowledge', 'knowledge-graph', 'agent-runtime',
      'qil', 'security', 'orchestrator', 'metrics', 'simulation', 'teams', 'plugins',
      'model-registry', 'scheduler', 'compute', 'robotics', 'digital-twin',
      'tool-intelligence', 'readiness', 'provenance', 'commerce',
      'organizations', 'notifications', 'policies', 'feature-flags', 'privacy',
      'policy-governance', 'api-gateway', 'memory', 'learning', 'ai-learning',
      'design-system', 'branding', 'universal-wallet', 'crypto', 'dashboard',
      'link-intelligence', 'multimodal-intelligence', 'search', 'automation',
      'fx', 'pki', 'mobility', 'logistics', 'agriculture', 'circular',
      'energy', 'border', 'restaurants', 'marketplace', 'cloud', 'cdn', 'email', 'ipam', 'tanya', 'mobile', 'active-defense', 'soc', 'supply-chain-security', 'infra-governance', 'resilience-engineering', 'security-review', 'security-automation', 'dlp', 'pqc',
    ]) {
      try {
        this.api.getModuleState(id);
        ids.push(id);
      } catch {
        /* module not registered */
      }
    }
    return ids;
  }

  /** Resolve an optional module without throwing when it is absent. */
  private tryModule<T extends IModule>(id: string): T | undefined {
    try {
      return this.api.getModule<T>(id);
    } catch {
      return undefined;
    }
  }

  private async register(req: GatewayRequest): Promise<GatewayResponse> {
    const { username, password, roles } = this.asObject(req.body);
    if (!username || !password) return json(400, { error: 'username and password are required' });
    const user = await this.sec.registerUser(String(username), String(password), Array.isArray(roles) ? (roles as string[]) : ['developer']);
    return json(201, { userId: user.id, username: user.username, roles: user.roles });
  }

  private async login(req: GatewayRequest): Promise<GatewayResponse> {
    const { username, password } = this.asObject(req.body);
    if (!username || !password) return json(400, { error: 'username and password are required' });
    const res = await this.sec.login(String(username), String(password), { remoteAddress: req.remoteAddress });
    if (!res.ok || !res.session || !res.principal) return json(401, { error: 'invalid credentials' });
    return json(200, { token: res.session.token, expiresAt: res.session.expiresAt, principal: res.principal });
  }

  private async logout(req: GatewayRequest): Promise<GatewayResponse> {
    const token = this.bearer(req);
    if (token) await this.sec.logout(token);
    return json(200, { ok: true });
  }

  /** Session introspection for clients (web consoles, SDKs) — expiry-aware. */
  private async sessionInfo(req: GatewayRequest): Promise<GatewayResponse> {
    const info = await this.sec.sessionInfo(this.bearer(req));
    if (!info) return json(401, { error: 'no active session' });
    return json(200, {
      ok: true,
      expiresAt: info.expiresAt,
      remainingMs: Math.max(0, info.expiresAt - Date.now()),
      username: info.username,
      userId: info.userId,
      roles: info.roles,
    });
  }

  private async createApiKey(req: GatewayRequest): Promise<GatewayResponse> {
    const { name } = this.asObject(req.body);
    if (!req.principal) return json(401, { error: 'unauthorized' });
    const { apiKey, secret } = await this.sec.createApiKey(req.principal.username, String(name ?? 'default'));
    return json(201, { id: apiKey.id, name: apiKey.name, secret });
  }

  private async runQiL(req: GatewayRequest): Promise<GatewayResponse> {
    const { program } = this.asObject(req.body);
    if (typeof program !== 'string' || !program.trim()) return json(400, { error: 'field "program" (QiL source) is required' });
    const result = await this.orch.runSource(program, { principal: req.principal });
    return json(200, { result });
  }

  private async runObjective(req: GatewayRequest): Promise<GatewayResponse> {
    const { objective } = this.asObject(req.body);
    if (typeof objective !== 'string' || !objective.trim()) return json(400, { error: 'field "objective" is required' });
    const result = await this.orch.runObjective(objective, { principal: req.principal });
    return json(200, { result });
  }

  private async listWorkflows(req: GatewayRequest): Promise<GatewayResponse> {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const runs = await this.orch.listRuns(limit);
    // Return a compact summary (omit verbose per-step outputs).
    const summary = runs.map((r) => ({ id: r.id, mission: r.mission, status: r.status, steps: r.steps.length, startedAt: r.startedAt, finishedAt: r.finishedAt, auditRecordId: r.auditRecordId }));
    return json(200, { runs: summary, count: summary.length });
  }

  private async getWorkflow(req: GatewayRequest): Promise<GatewayResponse> {
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const run = await this.orch.getRun(id);
    if (!run) return json(404, { error: 'workflow run not found' });
    return json(200, { run });
  }

  private async ask(req: GatewayRequest): Promise<GatewayResponse> {
    const { message, agent } = this.asObject(req.body);
    if (typeof message !== 'string' || !message.trim()) return json(400, { error: 'field "message" is required' });
    const res = await this.agents.run(message, typeof agent === 'string' ? { agent } : undefined);
    return json(200, { answer: res.answer, iterations: res.iterations, toolCalls: res.toolCalls.length, finishedReason: res.finishedReason });
  }

  private async audit(req: GatewayRequest): Promise<GatewayResponse> {
    const log = this.sec.getAuditLog();
    const records = await log.query({
      ...(req.query.actor ? { actor: req.query.actor } : {}),
      ...(req.query.action ? { action: req.query.action } : {}),
      ...(req.query.result ? { result: req.query.result as 'success' | 'failure' | 'denied' } : {}),
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    return json(200, { records, count: records.length });
  }

  /**
   * Audit export for compliance handoff: same filters as GET /audit plus
   * ?format=csv|json (default csv). Returns the raw document with an
   * attachment Content-Disposition so clients can download it directly.
   */
  private async auditExport(req: GatewayRequest): Promise<GatewayResponse> {
    const log = this.sec.getAuditLog();
    const records = await log.query({
      ...(req.query.actor ? { actor: req.query.actor } : {}),
      ...(req.query.action ? { action: req.query.action } : {}),
      ...(req.query.result ? { result: req.query.result as 'success' | 'failure' | 'denied' } : {}),
      ...(req.query.since ? { since: Number(req.query.since) } : {}),
      limit: req.query.limit ? Number(req.query.limit) : 10_000,
    });
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const body = format === 'json' ? auditJson(records) : auditCsv(records);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      status: 200,
      body,
      contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      headers: { 'content-disposition': `attachment; filename="audit-${stamp}.${format}"` },
    };
  }

  private async stats(): Promise<GatewayResponse> {
    const knowledge = await this.knowledge.stats();
    let graph: unknown = undefined;
    try {
      const gm = this.api.getModule('knowledge-graph') as unknown as { stats: () => unknown };
      graph = gm.stats();
    } catch {
      /* knowledge-graph not registered */
    }
    return json(200, { knowledge, graph });
  }

  private metricsHandler(): GatewayResponse {
    if (!this.metrics) return json(501, { error: 'metrics module not registered' });
    return { status: 200, body: this.metrics.format(), contentType: 'text/plain; version=0.0.4' };
  }

  private async simulate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.simulation) return json(501, { error: 'simulation module not registered' });
    const body = this.asObject(req.body);
    const name = typeof body.name === 'string' ? body.name : 'scenario';
    const formula = typeof body.formula === 'string' ? body.formula : '';
    const rawInputs = (body.inputs ?? {}) as Record<string, unknown>;
    if (!formula.trim()) return json(400, { error: 'field "formula" is required (e.g. "revenue - cost")' });
    const inputNames = Object.keys(rawInputs);
    if (inputNames.length === 0) return json(400, { error: 'at least one input distribution is required' });

    const inputs: Record<string, ReturnType<typeof createDistribution>> = {};
    try {
      for (const [k, spec] of Object.entries(rawInputs)) {
        inputs[k] = createDistribution(spec as { kind: string } & Record<string, unknown>);
      }
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }

    // Evaluate the formula as a pure arithmetic expression over the inputs.
    // (Behind qil:run auth; intended for local/dev modeling.)
    const evaluate = new Function(...inputNames, `"use strict"; return (${formula});`) as (...args: number[]) => number;
    const scenario: Scenario<number> = {
      name,
      inputs,
      output: (ctx) => evaluate(...inputNames.map((n) => ctx[n] ?? 0)),
      trials: typeof body.trials === 'number' ? body.trials : 10_000,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
      targets: Array.isArray(body.targets) ? (body.targets as number[]) : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
    };
    const result: SimulationResult = await this.simulation.run(scenario);
    return json(200, { result: { ...result, samples: result.samples.slice(0, 50) } });
  }

  private async team(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.teams) return json(501, { error: 'teams module not registered' });
    const body = this.asObject(req.body);
    const objective = typeof body.objective === 'string' ? body.objective : '';
    if (!objective.trim()) return json(400, { error: 'field "objective" is required' });
    let result: TeamResult;
    if (typeof body.team === 'string') {
      result = await this.teams.execute(objective, body.team);
    } else {
      const members = Array.isArray(body.members) ? (body.members as string[]) : [];
      if (members.length === 0) return json(400, { error: 'field "team" (name) or "members" (array) is required' });
      const config: TeamConfig = {
        name: typeof body.name === 'string' ? body.name : 'ad-hoc',
        members,
        mode: typeof body.mode === 'string' ? (body.mode as TeamConfig['mode']) : 'parallel',
        ...(typeof body.synthesizer === 'string' ? { synthesizer: body.synthesizer } : {}),
      };
      result = await this.teams.execute(objective, config);
    }
    return json(200, { result });
  }

  private pluginsList(): GatewayResponse {
    if (!this.plugins) return json(501, { error: 'plugins module not registered' });
    return json(200, { plugins: this.plugins.list() });
  }

  private async pluginAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.plugins) return json(501, { error: 'plugins module not registered' });
    const { id, action } = this.asObject(req.body);
    if (typeof id !== 'string' || typeof action !== 'string') return json(400, { error: 'fields "id" and "action" (enable|disable) are required' });
    if (action === 'enable') this.plugins.enable(id);
    else if (action === 'disable') this.plugins.disable(id);
    else return json(400, { error: 'action must be "enable" or "disable"' });
    const after = this.plugins.get(id) as InstalledPlugin | undefined;
    return json(200, { plugin: after });
  }

  private modelsList(): GatewayResponse {
    if (!this.modelRegistry) return json(501, { error: 'model-registry module not registered' });
    return json(200, { models: this.modelRegistry.list() });
  }

  private async modelSelect(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.modelRegistry) return json(501, { error: 'model-registry module not registered' });
    const body = this.asObject(req.body);
    const selection: SelectionRequest = {};
    if (Array.isArray(body.capabilities)) selection.capabilities = body.capabilities as string[];
    if (typeof body.prefer === 'string') selection.prefer = body.prefer as SelectionRequest['prefer'];
    if (Array.isArray(body.providers)) selection.providers = body.providers as string[];
    if (typeof body.minContextWindow === 'number') selection.minContextWindow = body.minContextWindow;
    const result = await this.modelRegistry.select(selection);
    return json(200, { selection: result });
  }

  private schedulerStats(): GatewayResponse {
    if (!this.scheduler) return json(501, { error: 'scheduler module not registered' });
    return json(200, { stats: this.scheduler.stats() });
  }

  private computeStats(req: GatewayRequest): GatewayResponse {
    const { values } = this.asObject(req.body);
    if (!Array.isArray(values)) return json(400, { error: 'field "values" (number[]) is required' });
    const nums = (values as unknown[]).map((n) => Number(n));
    if (nums.some((n) => Number.isNaN(n))) return json(400, { error: '"values" must contain only numbers' });
    return json(200, { stats: summarize(nums) });
  }

  private computeRegression(req: GatewayRequest): GatewayResponse {
    const { x, y } = this.asObject(req.body);
    if (!Array.isArray(x) || !Array.isArray(y)) return json(400, { error: 'fields "x" and "y" (number[]) are required' });
    const xs = (x as unknown[]).map((n) => Number(n));
    const ys = (y as unknown[]).map((n) => Number(n));
    try {
      return json(200, { fit: linearRegression(xs, ys) });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private schedulerRoute(req: GatewayRequest): GatewayResponse {
    if (!this.scheduler) return json(501, { error: 'scheduler module not registered' });
    const body = this.asObject(req.body);
    const profile: TaskProfile = {
      kind: typeof body.kind === 'string' ? body.kind : 'cpu',
      ...(typeof body.prefer === 'string' ? { prefer: body.prefer as TaskProfile['prefer'] } : {}),
      ...(body.requireGpu === true ? { requireGpu: true } : {}),
    };
    return json(200, { target: this.scheduler.recommendTarget(profile), stats: this.scheduler.stats() });
  }

  // --- robotics (Step 32 embodied intelligence) ---------------------------

  private async listDevices(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.robotics) return json(501, { error: 'robotics module not registered' });
    const devices = await this.robotics.listDevices(req.query.kind);
    return json(200, { devices, count: devices.length });
  }

  private async addDevice(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.robotics) return json(501, { error: 'robotics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.kind !== 'string') return json(400, { error: 'fields "name" and "kind" are required' });
    const device = await this.robotics.addDevice({
      name: b.name,
      kind: b.kind,
      ...(Array.isArray(b.capabilities) ? { capabilities: b.capabilities as string[] } : {}),
      ...(b.location && typeof b.location === 'object' ? { location: b.location as { lat: number; lon: number; label?: string } } : {}),
      ...(b.specs && typeof b.specs === 'object' ? { specs: b.specs as Record<string, unknown> } : {}),
    });
    return json(201, { device });
  }

  private async deviceAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.robotics) return json(501, { error: 'robotics module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return json(400, { error: 'field "id" is required' });
    try {
      if (b.action === 'status' && typeof b.status === 'string') {
        return json(200, { device: await this.robotics.setStatus(id, b.status as 'online' | 'offline' | 'busy' | 'error') });
      }
      if (b.action === 'telemetry' && b.readings && typeof b.readings === 'object') {
        return json(200, { device: await this.robotics.recordTelemetry(id, b.readings as Record<string, number>) });
      }
      if (b.action === 'maintenance' && typeof b.note === 'string') {
        return json(200, { device: await this.robotics.addMaintenance(id, b.note) });
      }
      return json(400, { error: 'unknown device action (use status|telemetry|maintenance)' });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  private async listMissions(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.robotics) return json(501, { error: 'robotics module not registered' });
    const missions = await this.robotics.listMissions(req.query.deviceId, req.query.status as 'queued' | 'active' | 'completed' | 'failed' | 'cancelled' | undefined);
    return json(200, { missions, count: missions.length });
  }

  private async missionAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.robotics) return json(501, { error: 'robotics module not registered' });
    const b = this.asObject(req.body);
    try {
      if (b.action === 'assign') {
        if (typeof b.deviceId !== 'string' || typeof b.objective !== 'string') return json(400, { error: 'assign requires "deviceId" and "objective"' });
        return json(201, { mission: await this.robotics.assignMission(b.deviceId, b.objective) });
      }
      if (b.action === 'complete') {
        if (typeof b.id !== 'string') return json(400, { error: 'complete requires "id"' });
        const status = b.status === 'failed' ? 'failed' : 'completed';
        return json(200, { mission: await this.robotics.completeMission(b.id, status, typeof b.result === 'string' ? b.result : undefined) });
      }
      return json(400, { error: 'unknown mission action (use assign|complete)' });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  // --- digital twins (Digital Twin Universe) ------------------------------

  private async listTwins(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.digitalTwin) return json(501, { error: 'digital-twin module not registered' });
    const twins = await this.digitalTwin.list(req.query.type);
    return json(200, { twins, count: twins.length });
  }

  private async addTwin(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.digitalTwin) return json(501, { error: 'digital-twin module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.type !== 'string' || !b.state || typeof b.state !== 'object') {
      return json(400, { error: 'fields "name", "type", and "state" (object) are required' });
    }
    const twin = await this.digitalTwin.register({
      name: b.name,
      type: b.type,
      state: b.state as Record<string, number>,
      ...(b.metadata && typeof b.metadata === 'object' ? { metadata: b.metadata as Record<string, unknown> } : {}),
    });
    return json(201, { twin });
  }

  private async twinAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.digitalTwin) return json(501, { error: 'digital-twin module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return json(400, { error: 'field "id" is required' });
    try {
      if (b.action === 'update' && b.state && typeof b.state === 'object') {
        return json(200, { twin: await this.digitalTwin.update(id, b.state as Record<string, number>) });
      }
      if (b.action === 'step' && Array.isArray(b.rules)) {
        return json(200, { twin: await this.digitalTwin.step(id, b.rules as { key: string; add?: number; from?: { key: string; factor: number }[] }[]) });
      }
      if (b.action === 'project' && Array.isArray(b.rules) && typeof b.steps === 'number') {
        return json(200, { trajectory: await this.digitalTwin.project(id, b.rules as { key: string; add?: number; from?: { key: string; factor: number }[] }[], Number(b.steps)) });
      }
      return json(400, { error: 'unknown twin action (use update|step|project)' });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  // --- readiness (honest capability matrix) -------------------------------

  private readinessList(req: GatewayRequest): GatewayResponse {
    if (!this.readiness) return json(501, { error: 'readiness module not registered' });
    return json(200, { capabilities: this.readiness.list(req.query.category) });
  }

  private readinessSummary(): GatewayResponse {
    if (!this.readiness) return json(501, { error: 'readiness module not registered' });
    return json(200, this.readiness.summary());
  }

  // --- PRX Part L: accreditation & legal operation mode -------------------

  private accreditationStatus(): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    const report = this.accreditation.complianceReport();
    const activeGrants = report.filter((r) => r.activeGrant).map((r) => r.domain);
    return json(200, {
      mode: this.accreditation.getMode(),
      activeAccreditations: activeGrants,
      ledgerRootHash: this.accreditation.ledgerRootHash(),
      ledgerIntact: this.accreditation.verifyLedger(),
      grantsIntegrity: this.accreditation.verifyAllGrants(),
      // Honest self-description: the platform is NEVER an accredited authority
      // unless verified grants + production mode are present.
      claims: {
        accreditedRegistry: this.accreditation.verifyClaim('JATA Qi is an accredited registry operator').honest,
        accreditedRegistrar: this.accreditation.verifyClaim('JATA Qi is an accredited registrar').honest,
        publicCertificateAuthority: this.accreditation.verifyClaim('JATA Qi is a publicly trusted certificate authority').honest,
        delegatedDnsAuthority: this.accreditation.verifyClaim('JATA Qi is a delegated DNS authority').honest,
      },
    });
  }

  private accreditationDomains(): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    return json(200, { domains: this.accreditation.listDomains() });
  }

  private accreditationCompliance(): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    return json(200, { report: this.accreditation.complianceReport() });
  }

  private accreditationGrants(req: GatewayRequest): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    return json(200, { grants: this.accreditation.listGrants(req.query.domain) });
  }

  private accreditationLedger(): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    return json(200, { entries: this.accreditation.ledgerEntries(), intact: this.accreditation.verifyLedger() });
  }

  private accreditationVerifyClaim(req: GatewayRequest): GatewayResponse {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    const claim = typeof req.query.claim === 'string' ? req.query.claim : '';
    if (!claim) return json(400, { error: 'query parameter "claim" is required' });
    return json(200, this.accreditation.verifyClaim(claim));
  }

  private async accreditationRecordGrant(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    const b = this.asObject(req.body);
    const { domain, issuedBy, scope, validFrom, validUntil } = b;
    if (typeof domain !== 'string' || typeof issuedBy !== 'string' || typeof scope !== 'string') {
      return json(400, { error: 'fields domain, issuedBy, scope are required' });
    }
    const grant = this.accreditation.recordGrant({
      domain, issuedBy, scope,
      ...(typeof b.externalRef === 'string' ? { externalRef: b.externalRef } : {}),
      validFrom: typeof validFrom === 'number' ? validFrom : Date.now(),
      validUntil: typeof validUntil === 'number' ? validUntil : 0,
      recordedBy: req.principal?.username ?? 'system',
      ...(Array.isArray(b.evidence) ? { evidence: b.evidence.map(String) } : {}),
    });
    return json(201, { grant });
  }

  private async accreditationSetGrantStatus(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    const status = typeof b.status === 'string' ? b.status : '';
    if (!id || !['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'PENDING'].includes(status)) {
      return json(400, { error: 'fields id, status (ACTIVE|SUSPENDED|REVOKED|EXPIRED|PENDING) required' });
    }
    const grant = this.accreditation.setGrantStatus(id, status as never, req.principal?.username ?? 'system');
    return json(200, { grant });
  }

  private async accreditationSetMode(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.accreditation) return json(501, { error: 'accreditation module not registered' });
    const b = this.asObject(req.body);
    const mode = typeof b.mode === 'string' ? b.mode : '';
    if (!['DEVELOPMENT', 'PRIVATE_INFRASTRUCTURE', 'ACCREDITED_PRODUCTION'].includes(mode)) {
      return json(400, { error: 'field mode (DEVELOPMENT|PRIVATE_INFRASTRUCTURE|ACCREDITED_PRODUCTION) required' });
    }
    this.accreditation.setMode(mode as never);
    return json(200, { mode });
  }

  // --- PRX Part D: DNS platform (zones, RDAP, resolve, analytics) ---------

  private dnsZones(): GatewayResponse {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    return json(200, { zones: this.dns.listZones().map((z) => ({ origin: z.origin, dnssec: !!z.dnssec, recordCount: z.records.length })) });
  }

  private dnsZoneGet(req: GatewayRequest): GatewayResponse {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const origin = typeof req.query.origin === 'string' ? req.query.origin : '';
    if (!origin) return json(400, { error: 'query parameter "origin" is required' });
    const z = this.dns.getZone(origin);
    if (!z) return json(404, { error: 'zone not found' });
    return json(200, { zone: z });
  }

  private async dnsZoneCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const b = this.asObject(req.body);
    const origin = typeof b.origin === 'string' ? b.origin : '';
    if (!origin) return json(400, { error: 'field "origin" is required' });
    const soa = typeof b.soa === 'object' && b.soa ? b.soa : {
      mname: `ns1.${origin}`, rname: `hostmaster.${origin}`, serial: 1, refresh: 3600, retry: 900, expire: 604800, minimum: 86400,
    };
    this.dns.addZone({ origin, soa: soa as never, records: Array.isArray(b.records) ? b.records as never[] : [] });
    return json(201, { origin });
  }

  private async dnsRecordsAdd(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const b = this.asObject(req.body);
    const origin = typeof b.origin === 'string' ? b.origin : '';
    const records = Array.isArray(b.records) ? b.records : [];
    if (!origin || records.length === 0) return json(400, { error: 'fields origin and records[] are required' });
    this.dns.addRecords(origin, records as never);
    return json(200, { added: records.length, serial: this.dns.store.soaSerial(this.dns.getZone(origin)!) });
  }

  private async dnsSign(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const b = this.asObject(req.body);
    const origin = typeof b.origin === 'string' ? b.origin : '';
    if (!origin) return json(400, { error: 'field "origin" is required' });
    const result = this.dns.signZone(origin);
    return json(200, { origin, keyTag: result.ksk.keyTag, ds: result.ds });
  }

  private async dnsResolve(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const type = typeof req.query.type === 'string' ? req.query.type : 'A';
    if (!name) return json(400, { error: 'query parameter "name" is required' });
    const qtype = dnsTypeFromString(type);
    // Prefer the local authoritative store; fall back to the recursive resolver
    // (real network) only when recursive resolution is enabled.
    const local = this.dns.resolveLocal(name, qtype, { dnssec: true, do: true });
    if (local.rcode !== 5) return json(200, { source: 'authoritative', ...local });
    try {
      const resp = await this.dns.resolve(name, qtype);
      return json(200, { source: 'recursive', rcode: resp.header.rcode, answers: resp.answers });
    } catch {
      return json(200, { source: 'authoritative', rcode: 5, answers: [], aa: false });
    }
  }

  private dnsRdap(req: GatewayRequest): GatewayResponse {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) return json(400, { error: 'query parameter "name" is required' });
    const result = this.dns.rdapLookup(name);
    const status = result.notFound ? 404 : 200;
    return json(status, result);
  }

  private dnsAnalytics(): GatewayResponse {
    if (!this.dns) return json(501, { error: 'dns module not registered' });
    return json(200, { analytics: this.dns.analytics() ?? { totalQueries: 0, byKey: {}, topQnames: [] }, address: this.dns.address });
  }

  // --- PRX Part A: Registry ------------------------------------------------

  private registryRdap(req: GatewayRequest): GatewayResponse {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) return json(400, { error: 'query parameter "name" is required' });
    const result = this.registry.rdapLookup(name);
    const status = result.notFound ? 404 : 200;
    return json(status, result);
  }

  private registryTlds(): GatewayResponse {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    return json(200, { tlds: this.registry.listTlds() });
  }

  private registryReport(): GatewayResponse {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    return json(200, { report: this.registry.report() });
  }

  private registryZones(req: GatewayRequest): GatewayResponse {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    const origin = typeof req.query.origin === 'string' ? req.query.origin : '';
    if (!origin) return json(200, { domains: this.registry.listAllDomains() });
    const reg = this.registry.getTld(origin);
    if (!reg) return json(404, { error: 'TLD not found' });
    return json(200, { domains: reg.listDomains() });
  }

  private async registryEscrow(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    const b = this.asObject(req.body);
    const tld = typeof b.tld === 'string' ? b.tld : '';
    if (!tld) return json(400, { error: 'field "tld" is required' });
    const deposit = this.registry.escrowDeposit(tld);
    return json(200, { deposit });
  }

  private async registryAddTld(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    const b = this.asObject(req.body);
    const tld = typeof b.tld === 'string' ? b.tld : '';
    if (!tld) return json(400, { error: 'field "tld" is required' });
    this.registry.addTld(tld);
    return json(201, { tld });
  }

  private async registryAddRegistrar(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registry) return json(501, { error: 'registry module not registered' });
    const b = this.asObject(req.body);
    const tld = typeof b.tld === 'string' ? b.tld : '';
    const id = typeof b.id === 'string' ? b.id : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!tld || !id || !password) return json(400, { error: 'fields tld, id, password are required' });
    const rec = this.registry.addRegistrar(tld, { id, name: typeof b.name === 'string' ? b.name : id, password, active: true });
    // Mirror into the registrar module so it can provision.
    if (this.registrar && !this.registrar.getRegistrar(id)) {
      this.registrar.addRegistrar({ id, name: rec.name, tld });
    }
    return json(201, { id });
  }

  // --- PRX Part B: Registrar -----------------------------------------------

  private registrarList(): GatewayResponse {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    return json(200, { registrars: this.registrar.listRegistrars() });
  }

  private async registrarAdd(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return json(400, { error: 'field "id" is required' });
    this.registrar.addRegistrar({ id, name: typeof b.name === 'string' ? b.name : id, ...(typeof b.tld === 'string' ? { tld: b.tld } : {}) });
    return json(201, { id });
  }

  private async registrarSearch(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    const b = this.asObject(req.body);
    const registrarId = typeof b.registrarId === 'string' ? b.registrarId : '';
    const names = Array.isArray(b.names) ? b.names.map(String) : [];
    if (!registrarId || names.length === 0) return json(400, { error: 'fields registrarId, names[] are required' });
    const reg = this.registrar.getRegistrar(registrarId);
    if (!reg) return json(404, { error: 'registrar not found' });
    return json(200, { results: await reg.search(names) });
  }

  private async registrarRegister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    const b = this.asObject(req.body);
    const registrarId = typeof b.registrarId === 'string' ? b.registrarId : '';
    const name = typeof b.name === 'string' ? b.name : '';
    const years = typeof b.periodYears === 'number' ? b.periodYears : 1;
    if (!registrarId || !name) return json(400, { error: 'fields registrarId, name are required' });
    const reg = this.registrar.getRegistrar(registrarId);
    if (!reg) return json(404, { error: 'registrar not found' });
    // Create a registrant identity if not supplied.
    const registrantId = typeof b.registrantId === 'string' ? b.registrantId : reg.identities.register({ name: name, email: `${name}@registrant.local` }).id;
    const order = await reg.register({ name, registrantId, periodYears: years });
    return json(order.status === 'completed' ? 201 : 200, { order });
  }

  private async registrarRenew(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    const b = this.asObject(req.body);
    const registrarId = typeof b.registrarId === 'string' ? b.registrarId : '';
    const name = typeof b.name === 'string' ? b.name : '';
    const registrantId = typeof b.registrantId === 'string' ? b.registrantId : '';
    const years = typeof b.periodYears === 'number' ? b.periodYears : 1;
    if (!registrarId || !name || !registrantId) return json(400, { error: 'fields registrarId, name, registrantId are required' });
    const reg = this.registrar.getRegistrar(registrarId);
    if (!reg) return json(404, { error: 'registrar not found' });
    const order = await reg.renew({ name, registrantId, periodYears: years });
    return json(200, { order });
  }

  private registrarPortfolio(req: GatewayRequest): GatewayResponse {
    if (!this.registrar) return json(501, { error: 'registrar module not registered' });
    const registrarId = typeof req.query.registrarId === 'string' ? req.query.registrarId : '';
    const registrantId = typeof req.query.registrantId === 'string' ? req.query.registrantId : '';
    if (!registrarId || !registrantId) return json(400, { error: 'query parameters registrarId, registrantId are required' });
    const reg = this.registrar.getRegistrar(registrarId);
    if (!reg) return json(404, { error: 'registrar not found' });
    return json(200, { domains: reg.portfolio(registrantId) });
  }

  // --- Digital Memory Engine (CLP Phase 1) --------------------------------

  private async memoryRecord(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.category !== 'string' || typeof b.summary !== 'string')
      return json(400, { error: 'fields "category" and "summary" are required' });
    const result = await this.memory.record({
      category: b.category,
      summary: b.summary,
      ...(typeof b.userId === 'string' ? { userId: b.userId } : {}),
      ...(typeof b.orgId === 'string' ? { orgId: b.orgId } : {}),
      ...(typeof b.sessionId === 'string' ? { sessionId: b.sessionId } : {}),
      ...(typeof b.correlationId === 'string' ? { correlationId: b.correlationId } : {}),
      ...(b.data && typeof b.data === 'object' ? { data: b.data as Record<string, unknown> } : {}),
      ...(Array.isArray(b.tags) ? { tags: b.tags as string[] } : {}),
      ...(typeof b.sensitivity === 'string' ? { sensitivity: b.sensitivity as never } : {}),
      ...(typeof b.retentionDays === 'number' ? { retentionDays: b.retentionDays } : {}),
    });
    return result.recorded ? json(201, { event: result.event }) : json(202, { recorded: false, reason: result.reason });
  }

  private memoryQuery(req: GatewayRequest): GatewayResponse {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const q = req.query;
    const events = this.memory.query({
      ...(q.orgId ? { orgId: q.orgId } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.text ? { text: q.text } : {}),
      ...(q.fromTs ? { fromTs: Number(q.fromTs) } : {}),
      ...(q.toTs ? { toTs: Number(q.toTs) } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    return json(200, { events, count: events.length });
  }

  private memoryStats(req: GatewayRequest): GatewayResponse {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    return json(200, { stats: this.memory.stats(req.query.orgId) });
  }

  private memoryExport(req: GatewayRequest): GatewayResponse {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const events = this.memory.exportFor({ userId: req.query.userId, orgId: req.query.orgId });
    return json(200, { events, count: events.length });
  }

  private async memoryDelete(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.userId !== 'string' && typeof b.orgId !== 'string')
      return json(400, { error: 'at least one of "userId" or "orgId" is required (right to delete)' });
    const deleted = await this.memory.deleteForSubject({ userId: b.userId as string | undefined, orgId: b.orgId as string | undefined });
    return json(200, { deleted });
  }

  private async memoryPolicy(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.orgId !== 'string') return json(400, { error: 'field "orgId" is required' });
    this.memory.setPolicy({
      orgId: b.orgId,
      ...(Array.isArray(b.allowedCategories) ? { allowedCategories: b.allowedCategories as string[] } : {}),
      ...(Array.isArray(b.blockedCategories) ? { blockedCategories: b.blockedCategories as string[] } : {}),
      ...(Array.isArray(b.consentRequiredCategories) ? { consentRequiredCategories: b.consentRequiredCategories as string[] } : {}),
      ...(typeof b.retentionDays === 'number' ? { retentionDays: b.retentionDays } : {}),
      ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
    });
    return json(200, { ok: true });
  }

  private async memorySweep(_req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.memory) return json(501, { error: 'memory module not registered' });
    const swept = await this.memory.sweep();
    return json(200, { swept });
  }

  // --- Continuous Learning + Personalization (CLP Phase 2/6) --------------

  private async learningAnalyze(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const b = this.asObject(req.body);
    const result = await this.learning.analyze(typeof b.orgId === 'string' ? b.orgId : undefined);
    return json(200, result);
  }

  private learningInsights(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const insights = this.learning.getInsights({ orgId: req.query.orgId });
    return json(200, { insights, count: insights.length });
  }

  private learningRecommendations(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const recommendations = this.learning.getRecommendations({
      ...(req.query.orgId ? { orgId: req.query.orgId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { recommendations, count: recommendations.length });
  }

  private learningReview(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || (b.decision !== 'accepted' && b.decision !== 'rejected') || typeof b.reviewer !== 'string')
      return json(400, { error: 'fields "id", "decision" (accepted|rejected), and "reviewer" are required' });
    const rec = this.learning.reviewRecommendation(b.id, b.decision, b.reviewer);
    return rec ? json(200, { recommendation: rec }) : json(404, { error: 'recommendation not found' });
  }

  private learningDeploy(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const rec = this.learning.deployRecommendation(b.id);
    return rec ? json(200, { recommendation: rec }) : json(404, { error: 'recommendation not found' });
  }

  private learningPreference(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.userId !== 'string' || typeof b.key !== 'string' || b.value === undefined)
      return json(400, { error: 'fields "userId", "key", and "value" are required' });
    this.learning.setPreference(b.userId, b.key as never, b.value, typeof b.orgId === 'string' ? b.orgId : undefined);
    return json(200, { ok: true });
  }

  private learningAdaptation(req: GatewayRequest): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    if (!req.query.userId) return json(400, { error: 'query parameter "userId" is required' });
    const adaptation = this.learning.adapt(req.query.userId);
    return adaptation ? json(200, { adaptation }) : json(200, { adaptation: null });
  }

  // --- AI Learning Platform (CLP Phase 3) ---------------------------------

  private aiPromptsList(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const prompts = this.aiLearning.listPrompts(req.query.category);
    return json(200, { prompts, count: prompts.length });
  }

  private aiPromptsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.content !== 'string' || typeof b.category !== 'string')
      return json(400, { error: 'fields "name", "content", and "category" are required' });
    const prompt = this.aiLearning.createPrompt({
      name: b.name, content: b.content, category: b.category,
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
    });
    return json(201, { prompt });
  }

  private aiPromptsVersion(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.templateId !== 'string' || typeof b.content !== 'string')
      return json(400, { error: 'fields "templateId" and "content" are required' });
    const version = this.aiLearning.newVersion(b.templateId, b.content, typeof b.notes === 'string' ? b.notes : undefined);
    return json(201, { version });
  }

  private aiPromptsApprove(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.templateId !== 'string' || typeof b.versionId !== 'string' || typeof b.approver !== 'string')
      return json(400, { error: 'fields "templateId", "versionId", and "approver" are required' });
    const version = this.aiLearning.approve(b.templateId, b.versionId, b.approver);
    return version ? json(200, { version }) : json(404, { error: 'template/version not found' });
  }

  private aiPromptsActivate(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.templateId !== 'string' || typeof b.versionId !== 'string')
      return json(400, { error: 'fields "templateId" and "versionId" are required' });
    const version = this.aiLearning.activate(b.templateId, b.versionId);
    return version ? json(200, { version }) : json(404, { error: 'template/version not found' });
  }

  private aiPromptsRender(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    if (!req.query.templateId) return json(400, { error: 'query parameter "templateId" is required' });
    let vars: Record<string, string> = {};
    if (req.query.vars) {
      try { vars = JSON.parse(req.query.vars) as Record<string, string>; } catch { return json(400, { error: 'query parameter "vars" must be a JSON object' }); }
    }
    const text = this.aiLearning.render(req.query.templateId, vars);
    return json(200, { text });
  }

  private aiOutcomesRecord(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.model !== 'string' || typeof b.provider !== 'string' || typeof b.latencyMs !== 'number')
      return json(400, { error: 'fields "model", "provider", and "latencyMs" are required' });
    const outcome = this.aiLearning.recordOutcome({
      ...(typeof b.promptTemplateId === 'string' ? { promptTemplateId: b.promptTemplateId } : {}),
      ...(typeof b.promptVersionId === 'string' ? { promptVersionId: b.promptVersionId } : {}),
      model: b.model,
      provider: b.provider,
      outcome: b.outcome === 'edited' || b.outcome === 'rejected' ? b.outcome : 'accepted',
      ...(typeof b.rating === 'number' ? { rating: b.rating } : {}),
      latencyMs: b.latencyMs,
      ...(typeof b.costUsd === 'number' ? { costUsd: b.costUsd } : {}),
      ...(typeof b.confidence === 'number' ? { confidence: b.confidence } : {}),
      ...(typeof b.tokensIn === 'number' ? { tokensIn: b.tokensIn } : {}),
      ...(typeof b.tokensOut === 'number' ? { tokensOut: b.tokensOut } : {}),
      ts: Date.now(),
      ...(typeof b.userId === 'string' ? { userId: b.userId } : {}),
      ...(typeof b.orgId === 'string' ? { orgId: b.orgId } : {}),
    });
    return json(201, { outcome });
  }

  private aiMetrics(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    if (req.query.templateId) return json(200, { metrics: this.aiLearning.promptMetrics(req.query.templateId) });
    if (req.query.model) return json(200, { metrics: this.aiLearning.modelMetrics(req.query.model) });
    return json(400, { error: 'query parameter "templateId" or "model" is required' });
  }

  private aiBenchmarks(): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    return json(200, { benchmarks: this.aiLearning.modelBenchmarks() });
  }

  private aiDrift(): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    return json(200, { alerts: this.aiLearning.detectDrift() });
  }

  // --- Design system ------------------------------------------------------

  private designTokens(req: GatewayRequest): GatewayResponse {
    if (!this.designSystem) return json(501, { error: 'design-system module not registered' });
    const mode = req.query.mode === 'light' || req.query.mode === 'dark' ? req.query.mode : undefined;
    const brand = this.parseBrandOverride(req.query.brand);
    if (req.query.brand && brand === undefined) return json(400, { error: 'query parameter "brand" must be a JSON object {primary?, secondary?, accent?}' });
    return json(200, { mode: mode ?? this.designSystem.currentMode, tokens: this.designSystem.tokens(mode, brand) });
  }

  private designCss(req: GatewayRequest): GatewayResponse {
    if (!this.designSystem) return json(501, { error: 'design-system module not registered' });
    const brand = this.parseBrandOverride(req.query.brand);
    if (req.query.brand && brand === undefined) return json(400, { error: 'query parameter "brand" must be a JSON object {primary?, secondary?, accent?}' });
    return json(200, { css: this.designSystem.stylesheet(brand) });
  }

  /** Parse a ?brand= JSON query value into a design-system BrandOverride. */
  private parseBrandOverride(raw: string | undefined): { primary?: string; secondary?: string; accent?: string } | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return undefined;
      return {
        ...(typeof parsed.primary === 'string' ? { primary: parsed.primary } : {}),
        ...(typeof parsed.secondary === 'string' ? { secondary: parsed.secondary } : {}),
        ...(typeof parsed.accent === 'string' ? { accent: parsed.accent } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private designMode(req: GatewayRequest): GatewayResponse {
    if (!this.designSystem) return json(501, { error: 'design-system module not registered' });
    const b = this.asObject(req.body);
    if (b.mode !== 'light' && b.mode !== 'dark') return json(400, { error: 'field "mode" must be "light" or "dark"' });
    this.designSystem.setMode(b.mode);
    return json(200, { mode: this.designSystem.currentMode });
  }

  private designAdaptive(req: GatewayRequest): GatewayResponse {
    if (!this.designSystem) return json(501, { error: 'design-system module not registered' });
    const b = this.asObject(req.body);
    const mode = this.designSystem.applyAdaptive({
      ...(b.preference === 'light' || b.preference === 'dark' || b.preference === 'auto' ? { preference: b.preference } : {}),
      ...(typeof b.hour === 'number' ? { hour: b.hour } : {}),
    });
    return json(200, { mode });
  }

  // --- Branding -----------------------------------------------------------

  private brandingProducts(): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    return json(200, { products: this.branding.listProducts() });
  }

  private brandingGet(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    if (!req.query.productId) return json(400, { error: 'query parameter "productId" is required' });
    const brand = this.branding.getBrand(req.query.productId);
    return brand ? json(200, { brand }) : json(404, { error: 'product not found' });
  }

  private brandingLogo(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.productId !== 'string') return json(400, { error: 'field "productId" is required' });
    const logo = this.branding.generateLogo(b.productId, typeof b.size === 'number' ? b.size : undefined);
    return json(200, { logo });
  }

  private brandingAppIcon(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.productId !== 'string') return json(400, { error: 'field "productId" is required' });
    const icon = this.branding.generateAppIcon(b.productId, typeof b.size === 'number' ? b.size : undefined);
    return json(200, { icon });
  }

  private brandingSplash(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.productId !== 'string') return json(400, { error: 'field "productId" is required' });
    return json(200, { splash: this.branding.generateSplashScreen(b.productId) });
  }

  private brandingMarketing(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.productId !== 'string' || typeof b.name !== 'string')
      return json(400, { error: 'fields "productId" and "name" are required' });
    const template = this.branding.generateMarketingTemplate(
      b.productId, b.name,
      typeof b.width === 'number' ? b.width : undefined,
      typeof b.height === 'number' ? b.height : undefined,
    );
    return json(200, { template });
  }

  private brandingBusinessCard(req: GatewayRequest): GatewayResponse {
    if (!this.branding) return json(501, { error: 'branding module not registered' });
    const b = this.asObject(req.body);
    const card = b.card;
    if (typeof b.productId !== 'string' || !card || typeof card !== 'object' ||
        typeof (card as Record<string, unknown>).name !== 'string' ||
        typeof (card as Record<string, unknown>).title !== 'string' ||
        typeof (card as Record<string, unknown>).email !== 'string' ||
        typeof (card as Record<string, unknown>).company !== 'string' ||
        typeof (card as Record<string, unknown>).backgroundColor !== 'string' ||
        typeof (card as Record<string, unknown>).textColor !== 'string' ||
        typeof (card as Record<string, unknown>).accentColor !== 'string') {
      return json(400, { error: 'fields "productId" and "card" (name, title, email, company, backgroundColor, textColor, accentColor) are required' });
    }
    const rendered = this.branding.generateBusinessCard(card as never, b.productId);
    return json(200, { card: rendered });
  }

  // --- Universal Wallet (Phase 2) -----------------------------------------

  private walletOpen(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.ownerId !== 'string' || typeof b.role !== 'string')
      return json(400, { error: 'fields "ownerId" and "role" are required' });
    const wallet = this.wallet.openWallet(b.ownerId, b.role as never, typeof b.orgId === 'string' ? b.orgId : undefined);
    return json(201, { wallet: jsonSafe(wallet) });
  }

  private walletList(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const wallets = this.wallet.listWallets({
      ...(req.query.ownerId ? { ownerId: req.query.ownerId } : {}),
      ...(req.query.role ? { role: req.query.role as never } : {}),
      ...(req.query.orgId ? { orgId: req.query.orgId } : {}),
    });
    return json(200, { wallets: jsonSafe(wallets), count: wallets.length });
  }

  private walletCurrencies(): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    return json(200, { currencies: this.wallet.listCurrencies() });
  }

  private walletBalance(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    if (!req.query.walletId || !req.query.currency) return json(400, { error: 'query parameters "walletId" and "currency" are required' });
    const wallet = this.wallet.getWallet(req.query.walletId);
    if (!wallet) return json(404, { error: 'wallet not found' });
    return json(200, { walletId: wallet.id, currency: req.query.currency, balance: this.wallet.balance(wallet.id, req.query.currency).toString() });
  }

  private walletLedger(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const entries = this.wallet.history({
      ...(req.query.walletId ? { walletId: req.query.walletId } : {}),
      ...(req.query.currency ? { currency: req.query.currency } : {}),
      ...(req.query.category ? { category: req.query.category as never } : {}),
      ...(req.query.fromTs ? { fromTs: Number(req.query.fromTs) } : {}),
      ...(req.query.toTs ? { toTs: Number(req.query.toTs) } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return json(200, { entries: jsonSafe(entries), count: entries.length });
  }

  private walletSummary(): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    return json(200, { summary: jsonSafe(this.wallet.summary()), ledgerBalanced: this.wallet.verifyLedger() });
  }

  private walletDeposit(req: GatewayRequest): GatewayResponse {
    return this.walletMovement(req, 'deposit');
  }

  private walletWithdraw(req: GatewayRequest): GatewayResponse {
    return this.walletMovement(req, 'withdraw');
  }

  private walletTransfer(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.from !== 'string' || typeof b.to !== 'string' || typeof b.currency !== 'string' || typeof b.description !== 'string')
      return json(400, { error: 'fields "from", "to", "currency", and "description" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const tx = this.wallet.transfer(b.from, b.to, b.currency, amount, b.description,
      b.metadata && typeof b.metadata === 'object' ? b.metadata as Record<string, unknown> : undefined);
    return json(201, { transaction: jsonSafe(tx) });
  }

  private walletStatus(req: GatewayRequest): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.walletId !== 'string' || (b.status !== 'active' && b.status !== 'frozen' && b.status !== 'closed'))
      return json(400, { error: 'fields "walletId" and "status" (active|frozen|closed) are required' });
    const wallet = this.wallet.getWallet(b.walletId);
    if (!wallet) return json(404, { error: 'wallet not found' });
    this.wallet.setWalletStatus(b.walletId, b.status);
    return json(200, { wallet: jsonSafe(this.wallet.getWallet(b.walletId)) });
  }

  private walletMovement(req: GatewayRequest, kind: 'deposit' | 'withdraw'): GatewayResponse {
    if (!this.wallet) return json(501, { error: 'universal-wallet module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.walletId !== 'string' || typeof b.currency !== 'string' || typeof b.description !== 'string')
      return json(400, { error: 'fields "walletId", "currency", and "description" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const tx = kind === 'deposit'
      ? this.wallet.deposit(b.walletId, b.currency, amount, b.description, b.metadata && typeof b.metadata === 'object' ? b.metadata as Record<string, unknown> : undefined)
      : this.wallet.withdraw(b.walletId, b.currency, amount, b.description, b.metadata && typeof b.metadata === 'object' ? b.metadata as Record<string, unknown> : undefined);
    return json(201, { transaction: jsonSafe(tx) });
  }

  // --- KRT Digital Asset Platform (Phase 4) -------------------------------

  private cryptoAssetsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.symbol !== 'string' || typeof b.name !== 'string' || typeof b.decimals !== 'number' || typeof b.chain !== 'string')
      return json(400, { error: 'fields "symbol", "name", "decimals", and "chain" are required' });
    const totalSupply = toBigInt(b.totalSupply);
    if (totalSupply === undefined) return json(400, { error: 'field "totalSupply" must be an integer string or number' });
    const asset = this.crypto.registerAsset({
      symbol: b.symbol, name: b.name,
      type: b.type === 'non_fungible' || b.type === 'semi_fungible' ? b.type : 'fungible',
      decimals: b.decimals, totalSupply, chain: b.chain,
      ...(typeof b.contractAddress === 'string' ? { contractAddress: b.contractAddress } : {}),
      ...(b.metadata && typeof b.metadata === 'object' ? { metadata: b.metadata as Record<string, unknown> } : {}),
    });
    return json(201, { asset: jsonSafe(asset) });
  }

  private cryptoAssetsList(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    if (req.query.symbol) {
      const asset = this.crypto.getAsset(req.query.symbol);
      return asset ? json(200, { assets: jsonSafe([asset]) }) : json(404, { error: 'asset not found' });
    }
    return json(200, { assets: jsonSafe(this.crypto.listAssets()), summary: this.crypto.summary() });
  }

  private cryptoMint(req: GatewayRequest): GatewayResponse {
    return this.cryptoMovement(req, 'mint');
  }

  private cryptoBurn(req: GatewayRequest): GatewayResponse {
    return this.cryptoMovement(req, 'burn');
  }

  private cryptoTransfer(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.from !== 'string' || typeof b.to !== 'string' || typeof b.symbol !== 'string')
      return json(400, { error: 'fields "from", "to", and "symbol" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const tx = this.crypto.transfer(b.from, b.to, b.symbol, amount);
    return json(201, { transaction: jsonSafe(tx) });
  }

  private cryptoBalance(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    if (!req.query.address || !req.query.symbol) return json(400, { error: 'query parameters "address" and "symbol" are required' });
    return json(200, { address: req.query.address, symbol: req.query.symbol, balance: this.crypto.getBalance(req.query.address, req.query.symbol).toString() });
  }

  private cryptoNftMint(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.collectionId !== 'string' || typeof b.to !== 'string')
      return json(400, { error: 'fields "collectionId" and "to" are required' });
    const nft = this.crypto.mintNft(b.collectionId, b.to, typeof b.tokenURI === 'string' ? b.tokenURI : undefined,
      b.metadata && typeof b.metadata === 'object' ? b.metadata as Record<string, unknown> : undefined);
    return json(201, { nft: jsonSafe(nft) });
  }

  private cryptoNftTransfer(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.tokenId !== 'string' || typeof b.from !== 'string' || typeof b.to !== 'string')
      return json(400, { error: 'fields "tokenId", "from", and "to" are required' });
    const nft = this.crypto.transferNft(b.tokenId, b.from, b.to);
    return json(200, { nft: jsonSafe(nft) });
  }

  private cryptoStake(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.staker !== 'string' || typeof b.assetSymbol !== 'string')
      return json(400, { error: 'fields "staker" and "assetSymbol" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const position = this.crypto.stake(b.staker, b.assetSymbol, amount, {
      ...(typeof b.apr === 'number' ? { apr: b.apr } : {}),
      ...(typeof b.lockupDays === 'number' ? { lockupDays: b.lockupDays } : {}),
    });
    return json(201, { position: jsonSafe(position) });
  }

  private cryptoQuote(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.from !== 'string' || typeof b.to !== 'string')
      return json(400, { error: 'fields "from" and "to" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const quote = this.crypto.quote(b.from, b.to, amount);
    return json(200, { quote: jsonSafe(quote) });
  }

  private cryptoSwap(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    const quote = b.quote;
    if (!quote || typeof quote !== 'object' || typeof (quote as Record<string, unknown>).fromAsset !== 'string' || typeof b.fromAddress !== 'string')
      return json(400, { error: 'fields "quote" (from /crypto/quote) and "fromAddress" are required' });
    const result = this.crypto.swap(quote as never, b.fromAddress);
    return json(200, { result: jsonSafe(result) });
  }

  private cryptoCustody(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.address !== 'string' || typeof b.owner !== 'string' || (b.type !== 'hot' && b.type !== 'warm' && b.type !== 'cold'))
      return json(400, { error: 'fields "address", "owner", and "type" (hot|warm|cold) are required' });
    return json(201, { wallet: jsonSafe(this.crypto.createCustodyWallet(b.address, b.type, b.owner)) });
  }

  private cryptoContracts(req: GatewayRequest): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.chain !== 'string' || !Array.isArray(b.abi))
      return json(400, { error: 'fields "name", "chain", and "abi" (array) are required' });
    const contract = this.crypto.registerContract({
      name: b.name, chain: b.chain, abi: b.abi as never,
      ...(typeof b.address === 'string' ? { address: b.address } : {}),
    });
    return json(201, { contract });
  }

  private cryptoSummary(): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    return json(200, { summary: this.crypto.summary() });
  }

  private cryptoMovement(req: GatewayRequest, kind: 'mint' | 'burn'): GatewayResponse {
    if (!this.crypto) return json(501, { error: 'crypto module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.to !== 'string' || typeof b.symbol !== 'string')
      return json(400, { error: 'fields "to" and "symbol" are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number (minor units)' });
    const tx = kind === 'mint' ? this.crypto.mint(b.to, b.symbol, amount) : this.crypto.burn(b.to, b.symbol, amount);
    return json(201, { transaction: jsonSafe(tx) });
  }

  // --- Adaptive Dashboard (Phase 5 step 3) --------------------------------

  private dashboardLayoutsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.ownerId !== 'string')
      return json(400, { error: 'fields "name" and "ownerId" are required' });
    const layout = this.dashboard.createLayout({
      name: b.name, ownerId: b.ownerId,
      ...(typeof b.role === 'string' ? { role: b.role } : {}),
      ...(typeof b.orgId === 'string' ? { orgId: b.orgId } : {}),
    });
    return json(201, { layout });
  }

  private dashboardLayoutsList(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const layouts = req.query.orgId
      ? this.dashboard.layoutsForOrg(req.query.orgId)
      : req.query.ownerId
        ? this.dashboard.layoutsForUser(req.query.ownerId)
        : this.dashboard.layouts.listAll();
    return json(200, { layouts, count: layouts.length });
  }

  private async dashboardAdapt(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.layoutId !== 'string' || typeof b.userId !== 'string')
      return json(400, { error: 'fields "layoutId" and "userId" are required' });
    const applied = await this.dashboard.adapt(b.layoutId, b.userId, typeof b.role === 'string' ? b.role : undefined);
    return json(200, { applied });
  }

  private dashboardWidgetsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.layoutId !== 'string' || typeof b.widgetDefId !== 'string')
      return json(400, { error: 'fields "layoutId" and "widgetDefId" are required' });
    const widget = this.dashboard.addWidget(b.layoutId, b.widgetDefId, {
      ...(typeof b.size === 'string' ? { size: b.size as never } : {}),
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(b.config && typeof b.config === 'object' ? { config: b.config as Record<string, unknown> } : {}),
    });
    return json(201, { widget });
  }

  private dashboardWidgetsList(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const widgets = this.dashboard.listWidgets(req.query.category as never, req.query.role);
    return json(200, { widgets, count: widgets.length });
  }

  private dashboardWidgetsMove(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.layoutId !== 'string' || typeof b.widgetId !== 'string' || typeof b.col !== 'number' || typeof b.row !== 'number')
      return json(400, { error: 'fields "layoutId", "widgetId", "col", and "row" are required' });
    this.dashboard.moveWidget(b.layoutId, b.widgetId, b.col, b.row);
    return json(200, { ok: true });
  }

  private dashboardWidgetsResize(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.layoutId !== 'string' || typeof b.widgetId !== 'string' || typeof b.size !== 'string')
      return json(400, { error: 'fields "layoutId", "widgetId", and "size" are required' });
    this.dashboard.resizeWidget(b.layoutId, b.widgetId, b.size as never);
    return json(200, { ok: true });
  }

  private dashboardAutoArrange(req: GatewayRequest): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.layoutId !== 'string') return json(400, { error: 'field "layoutId" is required' });
    this.dashboard.autoArrange(b.layoutId);
    return json(200, { ok: true });
  }

  private dashboardAnalytics(): GatewayResponse {
    if (!this.dashboard) return json(501, { error: 'dashboard module not registered' });
    return json(200, { analytics: this.dashboard.analytics() });
  }

  // --- Universal Link Intelligence ----------------------------------------

  private async linkProcess(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.url !== 'string') return json(400, { error: 'field "url" is required' });
    const result = await this.linkIntel.processLink(b.url, typeof b.content === 'string' ? b.content : undefined);
    return json(201, { result });
  }

  private async linkProcessBatch(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (!Array.isArray(b.links)) return json(400, { error: 'field "links" (array of {url, content?}) is required' });
    const links = (b.links as Array<Record<string, unknown>>).filter((l) => typeof l?.url === 'string');
    const results = await this.linkIntel.processLinks(links.map((l) => ({
      url: l.url as string,
      ...(typeof l.content === 'string' ? { content: l.content } : {}),
    })));
    return json(200, { results, count: results.length });
  }

  private linkResults(): GatewayResponse {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    return json(200, { results: this.linkIntel.getResults(), count: this.linkIntel.getResults().length });
  }

  private linkSummary(): GatewayResponse {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    return json(200, { summary: this.linkIntel.summary() });
  }

  private linkValidate(req: GatewayRequest): GatewayResponse {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (!b.proposal || typeof b.proposal !== 'object') return json(400, { error: 'field "proposal" is required' });
    const validation = this.linkIntel.validateProposal(b.proposal as never);
    return json(200, { validation });
  }

  private async linkEvolve(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.linkIntel) return json(501, { error: 'link-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (!b.proposal || typeof b.proposal !== 'object' || typeof b.createdBy !== 'string')
      return json(400, { error: 'fields "proposal" and "createdBy" are required' });
    const evolutionId = await this.linkIntel.submitForEvolution(b.proposal as never, b.createdBy);
    return evolutionId ? json(200, { evolutionId }) : json(200, { evolutionId: null });
  }

  // --- Universal Multimodal Intelligence ----------------------------------

  private multimodalSourcesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.modality !== 'string' || typeof b.name !== 'string')
      return json(400, { error: 'fields "modality" and "name" are required' });
    const source = this.multimodalIntel.registerSource({
      modality: b.modality as never,
      name: b.name,
      requiresAuth: typeof b.requiresAuth === 'boolean' ? b.requiresAuth : false,
      ...(b.config && typeof b.config === 'object' ? { config: b.config as Record<string, unknown> } : {}),
      ...(typeof b.id === 'string' ? { id: b.id } : {}),
    });
    return json(201, { source });
  }

  private multimodalSourcesList(req: GatewayRequest): GatewayResponse {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const sources = this.multimodalIntel.listSources(req.query.modality as never);
    return json(200, { sources, count: sources.length });
  }

  private multimodalSourcesAuthorize(req: GatewayRequest): GatewayResponse {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.sourceId !== 'string' || typeof b.grantedBy !== 'string' || typeof b.scope !== 'string')
      return json(400, { error: 'fields "sourceId", "grantedBy", and "scope" are required' });
    const source = this.multimodalIntel.authorize(b.sourceId, {
      grantedBy: b.grantedBy, scope: b.scope,
      ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
      ...(typeof b.legalBasis === 'string' ? { legalBasis: b.legalBasis } : {}),
    });
    return source ? json(200, { source }) : json(404, { error: 'source not found' });
  }

  private multimodalSourcesRevoke(req: GatewayRequest): GatewayResponse {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.sourceId !== 'string') return json(400, { error: 'field "sourceId" is required' });
    return json(200, { revoked: this.multimodalIntel.revoke(b.sourceId) });
  }

  private async multimodalAcquire(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.content !== 'string') return json(400, { error: 'field "content" is required' });
    if (typeof b.sourceId === 'string') {
      const result = await this.multimodalIntel.acquire(b.sourceId, b.content);
      return json(200, { result });
    }
    if (typeof b.modality === 'string') {
      const result = await this.multimodalIntel.acquireDirect(b.modality as never, b.content, typeof b.name === 'string' ? b.name : undefined);
      return json(200, { result });
    }
    return json(400, { error: 'field "sourceId" or "modality" is required' });
  }

  private async multimodalAcquireBatch(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.multimodalIntel) return json(501, { error: 'multimodal-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (!Array.isArray(b.inputs)) return json(400, { error: 'field "inputs" (array of {sourceId, content}) is required' });
    const inputs = (b.inputs as Array<Record<string, unknown>>)
      .filter((i) => typeof i?.sourceId === 'string' && typeof i.content === 'string')
      .map((i) => ({ sourceId: i.sourceId as string, content: i.content as string }));
    const results = await this.multimodalIntel.acquireBatch(inputs);
    return json(200, { results, count: results.length });
  }


  // --- CLP Phase 4 — prompt experiments ----------------------------------

  private aiExperimentsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.templateId !== 'string' || typeof b.challengerVersionId !== 'string' || typeof b.createdBy !== 'string')
      return json(400, { error: 'fields "templateId", "challengerVersionId", and "createdBy" are required' });
    const experiment = this.aiLearning.createExperiment({
      templateId: b.templateId,
      challengerVersionId: b.challengerVersionId,
      createdBy: b.createdBy,
      ...(typeof b.name === 'string' ? { name: b.name } : {}),
      ...(typeof b.challengerTraffic === 'number' ? { challengerTraffic: b.challengerTraffic } : {}),
      ...(typeof b.minOutcomes === 'number' ? { minOutcomes: b.minOutcomes } : {}),
      ...(typeof b.minAcceptanceGain === 'number' ? { minAcceptanceGain: b.minAcceptanceGain } : {}),
    });
    return json(201, { experiment });
  }

  private aiExperimentsList(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const status = req.query.status as 'running' | 'concluded' | 'cancelled' | undefined;
    const experiments = status
      ? this.aiLearning.listExperiments(status)
      : this.aiLearning.listExperiments();
    return json(200, { experiments, count: experiments.length });
  }

  private aiExperimentsEvaluate(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const evaluation = this.aiLearning.evaluateExperiment(b.id);
    return json(200, {
      decision: evaluation.decision,
      reason: evaluation.reason,
      promoted: evaluation.promoted,
      championMetrics: evaluation.championMetrics,
      challengerMetrics: evaluation.challengerMetrics,
    });
  }

  private aiExperimentsConclude(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { experiment: this.aiLearning.concludeExperiment(b.id) });
  }

  private aiExperimentsCancel(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { experiment: this.aiLearning.cancelExperiment(b.id) });
  }

  private aiServe(req: GatewayRequest): GatewayResponse {
    if (!this.aiLearning) return json(501, { error: 'ai-learning module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.templateId !== 'string') return json(400, { error: 'field "templateId" is required' });
    const vars = b.vars && typeof b.vars === 'object' ? b.vars as Record<string, string> : {};
    const served = this.aiLearning.servePrompt(b.templateId, vars);
    return json(200, served);
  }

  // --- CLP Phase 5 — knowledge distillation -------------------------------

  private async learningDistill(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const b = this.asObject(req.body);
    const run = await this.learning.distill(typeof b.orgId === 'string' ? b.orgId : undefined);
    return json(200, run);
  }

  private learningLessons(): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const lessons = this.learning.getLessons();
    return json(200, { lessons, count: lessons.length });
  }

  private learningPlaybooks(): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    const playbooks = this.learning.getPlaybooks();
    return json(200, { playbooks, count: playbooks.length });
  }

  private learningDistillStats(): GatewayResponse {
    if (!this.learning) return json(501, { error: 'learning module not registered' });
    return json(200, { stats: this.learning.distillStats() });
  }

  // --- Phase 6 — Universal Search & Discovery ------------------------------

  private async searchQuery(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.search) return json(501, { error: 'search module not registered' });
    const q = req.query.q;
    if (!q) return json(400, { error: 'query parameter "q" is required' });
    const sources = req.query.sources
      ? (req.query.sources.split(',').map((s) => s.trim()).filter(Boolean) as never[])
      : undefined;
    const result = await this.search.search(q, {
      ...(sources?.length ? { sources } : {}),
      ...(req.query.topK ? { topK: Number(req.query.topK) } : {}),
      ...(req.query.minScore ? { minScore: Number(req.query.minScore) } : {}),
      ...(req.query.userId ? { userId: req.query.userId } : {}),
      ...(req.query.orgId ? { orgId: req.query.orgId } : {}),
      ...(req.query.category ? { category: req.query.category } : {}),
    });
    return json(200, result);
  }

  private async searchSuggest(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.search) return json(501, { error: 'search module not registered' });
    const q = req.query.q;
    if (!q) return json(400, { error: 'query parameter "q" is required' });
    const suggestions = await this.search.suggest(q, {
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return json(200, { suggestions, count: suggestions.length });
  }

  private async searchRecord(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.search) return json(501, { error: 'search module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.query !== 'string' || typeof b.userId !== 'string')
      return json(400, { error: 'fields "query" and "userId" are required' });
    const recorded = await this.search.recordSearch(b.userId, b.query, typeof b.orgId === 'string' ? b.orgId : undefined);
    return json(201, { recorded });
  }

  private searchHistory(req: GatewayRequest): GatewayResponse {
    if (!this.search) return json(501, { error: 'search module not registered' });
    if (!req.query.userId) return json(400, { error: 'query parameter "userId" is required' });
    const history = this.search.recentSearches(
      req.query.userId,
      req.query.orgId,
      req.query.limit ? Number(req.query.limit) : 20,
    );
    return json(200, { history, count: history.length });
  }

  private searchStats(): GatewayResponse {
    if (!this.search) return json(501, { error: 'search module not registered' });
    return json(200, { stats: this.search.stats() });
  }

  // --- Phase 6 — SOMA AI Intelligent Automation ---------------------------

  private automationsList(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const status = req.query.status;
    const trigger = req.query.trigger as 'schedule' | 'event' | 'manual' | undefined;
    const automations = this.automation.list({
      ...(status === 'enabled' ? { enabled: true } : status === 'disabled' ? { enabled: false } : {}),
      ...(trigger ? { trigger } : {}),
    });
    return json(200, { automations, count: automations.length });
  }

  private automationsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || !b.trigger || typeof b.trigger !== 'object' || !Array.isArray(b.actions))
      return json(400, { error: 'fields "name", "trigger", and "actions" (array) are required' });
    const trigger = b.trigger as { type?: unknown; intervalMs?: unknown; event?: unknown; filter?: unknown };
    if (trigger.type !== 'schedule' && trigger.type !== 'event' && trigger.type !== 'manual')
      return json(400, { error: 'trigger.type must be schedule|event|manual' });
    const automation = this.automation.create({
      name: b.name,
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
      trigger: {
        type: trigger.type,
        ...(trigger.type === 'schedule' ? { intervalMs: Number(trigger.intervalMs) } : {}),
        ...(trigger.type === 'event'
          ? { event: String(trigger.event), ...(trigger.filter && typeof trigger.filter === 'object' ? { filter: trigger.filter as { field: string; value: string } } : {}) }
          : {}),
      } as never,
      actions: (b.actions as Array<Record<string, unknown>>).map((a) => ({
        type: String(a.type),
        params: a.params && typeof a.params === 'object' ? a.params as Record<string, unknown> : {},
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
        ...(typeof a.continueOnError === 'boolean' ? { continueOnError: a.continueOnError } : {}),
      })) as never,
      ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
      ...(Array.isArray(b.tags) ? { tags: b.tags.map(String) } : {}),
      ...(typeof b.maxConcurrency === 'number' ? { maxConcurrency: b.maxConcurrency } : {}),
      ...(typeof b.timeoutMs === 'number' ? { timeoutMs: b.timeoutMs } : {}),
      createdBy: req.principal?.username ?? 'api',
    });
    return json(201, { automation });
  }

  private automationGet(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const automation = this.automation.get(id);
    return automation ? json(200, { automation }) : json(404, { error: 'automation not found' });
  }

  private async automationsRun(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.automationId !== 'string') return json(400, { error: 'field "automationId" is required' });
    const execution = await this.automation.run({
      automationId: b.automationId,
      trigger: 'manual',
      ...(b.payload && typeof b.payload === 'object' ? { payload: b.payload as Record<string, unknown> } : {}),
    });
    return json(200, { execution });
  }

  private automationsExecutions(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const executions = this.automation.executions({
      ...(req.query.automationId ? { automationId: req.query.automationId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { executions, count: executions.length });
  }

  private automationsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.enabled !== 'boolean')
      return json(400, { error: 'fields "id" and "enabled" (boolean) are required' });
    const automation = this.automation.setEnabled(b.id, b.enabled);
    return automation ? json(200, { automation }) : json(404, { error: 'automation not found' });
  }

  private automationsRemove(req: GatewayRequest): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { removed: this.automation.remove(b.id) });
  }

  private automationsStats(): GatewayResponse {
    if (!this.automation) return json(501, { error: 'automation module not registered' });
    return json(200, { stats: this.automation.stats() });
  }

  // --- Phase 6 — KARIS FX ------------------------------------------------

  private fxRatesSet(req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.base !== 'string' || typeof b.quote !== 'string' || typeof b.bid !== 'number')
      return json(400, { error: 'fields "base", "quote", and "bid" are required' });
    const quote = this.fx.setRate({
      base: b.base, quote: b.quote, bid: b.bid,
      ...(typeof b.ask === 'number' ? { ask: b.ask } : {}),
      ...(typeof b.source === 'string' ? { source: b.source } : {}),
    });
    return json(201, { quote });
  }

  private fxRatesList(_req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    return json(200, { rates: this.fx.listRates(), count: this.fx.listRates().length });
  }

  private fxRateGet(req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    if (!req.query.base || !req.query.quote) return json(400, { error: 'query parameters "base" and "quote" are required' });
    const quote = this.fx.getRate(req.query.base, req.query.quote);
    return quote ? json(200, { quote }) : json(404, { error: `no rate for ${req.query.base}/${req.query.quote}` });
  }

  private fxConvert(req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.from !== 'string' || typeof b.to !== 'string' || b.amount === undefined)
      return json(400, { error: 'fields "from", "to", and "amount" (integer string) are required' });
    const amount = toBigInt(b.amount);
    if (amount === undefined) return json(400, { error: 'field "amount" must be an integer string or number' });
    const result = this.fx.convert({
      from: b.from, to: b.to, amount,
      ...(typeof b.margin === 'number' ? { margin: b.margin } : {}),
      ...(typeof b.toDecimals === 'number' ? { toDecimals: b.toDecimals } : {}),
    });
    return json(200, { result: jsonSafe(result) });
  }

  private fxHistory(req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    if (!req.query.pair) return json(400, { error: 'query parameter "pair" (e.g. USD/KES) is required' });
    const points = this.fx.historyFor(req.query.pair, {
      ...(req.query.fromTs ? { fromTs: Number(req.query.fromTs) } : {}),
      ...(req.query.toTs ? { toTs: Number(req.query.toTs) } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return json(200, { pair: req.query.pair, points, count: points.length });
  }

  private fxAnalytics(req: GatewayRequest): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    if (!req.query.pair) return json(400, { error: 'query parameter "pair" is required' });
    const analytics = this.fx.analyze(req.query.pair, {
      ...(req.query.windowMs ? { windowMs: Number(req.query.windowMs) } : {}),
    });
    return analytics ? json(200, { analytics }) : json(404, { error: `no history for ${req.query.pair}` });
  }

  private fxCurrencies(): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    return json(200, { currencies: this.fx.currencies() });
  }

  private fxStats(): GatewayResponse {
    if (!this.fx) return json(501, { error: 'fx module not registered' });
    return json(200, { stats: this.fx.stats(), anchor: this.fx.anchorCurrency });
  }

  // --- PRX Part C — PKI -----------------------------------------------

  private pkiStatus(): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    return json(200, { stats: this.pki.stats() });
  }

  private pkiCaRoot(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    const subject = parseDn(b.subject);
    if (!subject) return json(400, { error: 'field "subject" must be an array of {oid, value} or an object map' });
    const ca = this.pki.createRootCa(subject);
    return json(201, { ca: { id: ca.id, role: ca.role, subject: ca.subject, certDer: ca.certDer } });
  }

  private pkiCaIntermediate(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    const subject = parseDn(b.subject);
    if (!subject || typeof b.issuerId !== 'string') return json(400, { error: 'fields "subject" and "issuerId" are required' });
    const ca = this.pki.createIntermediateCa(subject, b.issuerId);
    return json(201, { ca: { id: ca.id, role: ca.role, issuerId: ca.issuerId, subject: ca.subject, certDer: ca.certDer } });
  }

  private pkiCas(): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const cas = this.pki.ca.listCas();
    return json(200, { cas: cas.map((c) => ({ id: c.id, role: c.role, subject: c.subject, issuerId: c.issuerId, createdAt: c.createdAt })), count: cas.length });
  }

  private pkiCertificatesIssue(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.caId !== 'string' || !Array.isArray(b.subject) || !b.subjectPublicKeyJwk || typeof b.subjectPublicKeyJwk !== 'object')
      return json(400, { error: 'fields "caId", "subject" (array), and "subjectPublicKeyJwk" are required' });
    const cert = this.pki.issueCertificate({
      caId: b.caId,
      subject: (b.subject as Array<Record<string, unknown>>).map((s) => ({ oid: String(s.oid), value: String(s.value) })),
      subjectPublicKeyJwk: b.subjectPublicKeyJwk as Record<string, string>,
      ...(Array.isArray(b.sanDnsNames) ? { sanDnsNames: b.sanDnsNames.map(String) } : {}),
      ...(typeof b.validityDays === 'number' ? { validityDays: b.validityDays } : {}),
      ...(Array.isArray(b.extendedKeyUsage) ? { extendedKeyUsage: b.extendedKeyUsage.map(String) } : {}),
    });
    return json(201, {
      certificate: {
        id: cert.id, caId: cert.caId, serialNumber: cert.serialNumber.toString(),
        subject: cert.subject, sanDnsNames: cert.sanDnsNames,
        notAfter: cert.notAfter.toISOString(), certDer: cert.certDer,
      },
    });
  }

  private pkiCertificatesList(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const status = req.query.status as 'valid' | 'revoked' | 'expired' | undefined;
    const certs = status ? this.pki.ca.list(status) : this.pki.ca.list();
    const ca = this.pki.ca;
    return json(200, { certificates: certs.map((c) => ({ id: c.id, caId: c.caId, serialNumber: c.serialNumber.toString(), subject: c.subject, status: ca.effectiveStatus(c) })), count: certs.length });
  }

  private pkiCertificatesRevoke(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const cert = this.pki.revokeCertificate(b.id, typeof b.reason === 'string' ? b.reason : undefined);
    return json(200, { certificate: { id: cert.id, status: cert.status, revokedAt: cert.revokedAt, revocationReason: cert.revocationReason } });
  }

  private pkiCrl(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.caId) return json(400, { error: 'query parameter "caId" is required' });
    const crl = this.pki.ca.latestCrl(req.query.caId);
    return crl ? json(200, { crl: { der: crl.der, number: crl.number.toString(), revokedCount: crl.revokedCount, thisUpdate: crl.thisUpdate.toISOString(), nextUpdate: crl.nextUpdate.toISOString() } }) : json(404, { error: 'no CRL for this CA yet' });
  }

  private pkiRaCreate(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (!Array.isArray(b.domains) || !b.publicKeyJwk || typeof b.publicKeyJwk !== 'object' || (b.method !== 'dns-txt' && b.method !== 'http-01' && b.method !== 'email'))
      return json(400, { error: 'fields "domains" (array), "publicKeyJwk", and "method" (dns-txt|http-01|email) are required' });
    const request = this.pki.createRequest({
      domains: b.domains.map(String),
      subject: [{ oid: '2.5.4.3', value: String(b.domains[0]) }],
      publicKeyJwk: b.publicKeyJwk as Record<string, string>,
      method: b.method,
      requestedBy: req.principal?.username ?? 'api',
    });
    return json(201, { request: { id: request.id, domains: request.domains, method: request.method, status: request.status, proof: this.pki.ra.proofLocation(request) } });
  }

  private pkiRaValidate(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.location !== 'string' || typeof b.token !== 'string')
      return json(400, { error: 'fields "id", "location", and "token" are required' });
    const request = this.pki.ra.validate(b.id, { location: b.location, token: b.token });
    return request ? json(200, { request: { id: request.id, status: request.status, validation: request.validation } }) : json(404, { error: 'request not found' });
  }

  private pkiRaApprove(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const request = this.pki.ra.approve(b.id, req.principal?.username ?? 'api');
    return request ? json(200, { request: { id: request.id, status: request.status } }) : json(404, { error: 'request not found or not validated' });
  }

  private pkiIdpClients(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || !Array.isArray(b.redirectUris))
      return json(400, { error: 'fields "name" and "redirectUris" (array) are required' });
    const client = this.pki.registerIdpClient({
      name: b.name,
      redirectUris: b.redirectUris.map(String),
      ...(Array.isArray(b.scopes) ? { scopes: b.scopes.map(String) } : {}),
      ...(typeof b.userId === 'string' && b.userId ? { userId: b.userId } : {}),
    });
    return json(201, { clientId: client.clientId, clientSecret: client.clientSecret, redirectUris: client.redirectUris, scopes: client.scopes, ...(client.userId ? { userId: client.userId } : {}) });
  }

  /** IdP-first login: client-credentials grant → platform session (one call). */
  private async pkiIdpConsoleLogin(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.clientId !== 'string' || typeof b.clientSecret !== 'string')
      return json(400, { error: 'fields "clientId" and "clientSecret" are required' });
    const result = await this.pki.consoleLogin({
      clientId: b.clientId, clientSecret: b.clientSecret,
      ...(typeof b.scope === 'string' ? { scope: b.scope } : {}),
      ...(typeof b.remoteAddress === 'string' ? { remoteAddress: b.remoteAddress } : {}),
    });
    if (!result.ok) return json(401, { error: result.reason ?? 'IdP login failed' });
    return json(200, { ok: true, idpTokens: result.idpTokens, session: result.session, principal: result.principal });
  }

  private pkiIdpAuthorize(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.clientId !== 'string' || typeof b.redirectUri !== 'string' || typeof b.userId !== 'string')
      return json(400, { error: 'fields "clientId", "redirectUri", and "userId" are required' });
    const { code, redirectUri } = this.pki.idpAuthorize({ clientId: b.clientId, redirectUri: b.redirectUri, userId: b.userId, ...(typeof b.scope === 'string' ? { scope: b.scope } : {}) });
    return json(200, { code, redirectUri });
  }

  private pkiIdpToken(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.code !== 'string' || typeof b.clientId !== 'string' || typeof b.clientSecret !== 'string' || typeof b.redirectUri !== 'string')
      return json(400, { error: 'fields "code", "clientId", "clientSecret", and "redirectUri" are required' });
    try {
      const tokens = this.pki.idpToken({ code: b.code, clientId: b.clientId, clientSecret: b.clientSecret, redirectUri: b.redirectUri });
      return json(200, tokens);
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private pkiIdpIntrospect(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.token !== 'string') return json(400, { error: 'field "token" is required' });
    return json(200, this.pki.idp.introspect(b.token));
  }

  private pkiIdpUserinfo(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    // The IdP access token travels in x-idp-token (the Authorization header
    // carries the platform session used for the route's RBAC check).
    const token = (req.headers['x-idp-token'] as string | undefined) ?? this.bearer(req);
    if (!token) return json(401, { error: 'x-idp-token header required' });
    const info = this.pki.idpUserinfo(token);
    return info ? json(200, info) : json(401, { error: 'invalid or expired token' });
  }

  private pkiIdpDiscovery(): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    return json(200, this.pki.idp.discovery());
  }

  private async pkiIdpLogin(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accessToken !== 'string') return json(400, { error: 'field "accessToken" is required' });
    const result = await this.pki.loginWithIdpToken(b.accessToken, {
      ...(typeof b.remoteAddress === 'string' ? { remoteAddress: b.remoteAddress } : {}),
    });
    if (!result.ok) return json(401, { error: result.reason ?? 'login failed' });
    return json(200, { ok: true, session: result.session, principal: result.principal });
  }

  private pkiIdpRefresh(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.refreshToken !== 'string' || typeof b.clientId !== 'string' || typeof b.clientSecret !== 'string')
      return json(400, { error: 'fields "refreshToken", "clientId", and "clientSecret" are required' });
    try {
      const tokens = this.pki.idpRefresh({ refreshToken: b.refreshToken, clientId: b.clientId, clientSecret: b.clientSecret });
      return json(200, { access_token: tokens.access_token, token_type: tokens.token_type, expires_in: tokens.expires_in, ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}), ...(tokens.scope ? { scope: tokens.scope } : {}) });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  /** Revoke an IdP token (access or refresh) — revoke-on-logout parity. */
  private pkiIdpRevoke(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.token !== 'string' || !b.token) return json(400, { error: 'field "token" is required' });
    return json(200, { revoked: this.pki.idpRevoke(b.token) });
  }

  private async pkiIdpRotate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.refreshToken !== 'string' || typeof b.clientId !== 'string' || typeof b.clientSecret !== 'string')
      return json(400, { error: 'fields "refreshToken", "clientId", and "clientSecret" are required' });
    const result = await this.pki.rotateSession({
      refreshToken: b.refreshToken, clientId: b.clientId, clientSecret: b.clientSecret,
      ...(typeof b.remoteAddress === 'string' ? { remoteAddress: b.remoteAddress } : {}),
    });
    if (!result.ok) return json(401, { error: result.reason ?? 'session rotation failed' });
    return json(200, { ok: true, idpTokens: result.idpTokens, session: result.session, principal: result.principal });
  }

  private pkiIdpProfile(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.sub !== 'string' || !b.sub) return json(400, { error: 'field "sub" is required' });
    const claims: Record<string, unknown> = {};
    if (typeof b.name === 'string') claims.name = b.name;
    if (typeof b.email === 'string') claims.email = b.email;
    if (typeof b.preferred_username === 'string') claims.preferred_username = b.preferred_username;
    if (Array.isArray(b.roles)) claims.roles = b.roles.filter((r): r is string => typeof r === 'string');
    const profile = this.pki.idp.upsertUser(b.sub, claims);
    return json(200, { profile: { sub: profile.sub, ...(profile.name ? { name: profile.name } : {}), ...(profile.email ? { email: profile.email } : {}), ...(profile.preferred_username ? { preferred_username: profile.preferred_username } : {}), ...(profile.roles ? { roles: profile.roles } : {}) } });
  }

  // --- Phase 7 — MOTO X mobility -----------------------------------------

  private mobilityVehiclesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.registration !== 'string' || typeof b.make !== 'string' || typeof b.model !== 'string')
      return json(400, { error: 'fields "registration", "make", and "model" are required' });
    const vehicle = this.mobility.registerVehicle({
      registration: b.registration, make: b.make, model: b.model,
      ...(typeof b.type === 'string' ? { type: b.type as never } : {}),
      ...(typeof b.capacity === 'number' ? { capacity: b.capacity } : {}),
      ...(b.location && typeof b.location === 'object' ? { location: b.location as never } : {}),
      ...(typeof b.fleetId === 'string' ? { fleetId: b.fleetId } : {}),
    });
    return json(201, { vehicle });
  }

  private mobilityVehiclesList(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const vehicles = this.mobility.listVehicles({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.type ? { type: req.query.type as never } : {}),
      ...(req.query.fleetId ? { fleetId: req.query.fleetId } : {}),
    });
    return json(200, { vehicles, count: vehicles.length });
  }

  private mobilityVehiclesStatus(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const vehicle = this.mobility.setVehicleStatus(b.id, b.status as never);
    return vehicle ? json(200, { vehicle }) : json(404, { error: 'vehicle not found' });
  }

  private mobilityFleetsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.ownerId !== 'string')
      return json(400, { error: 'fields "name" and "ownerId" are required' });
    return json(201, { fleet: this.mobility.createFleet(b.name, b.ownerId) });
  }

  private mobilityFleetsList(): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const fleets = this.mobility.listFleets();
    return json(200, { fleets, count: fleets.length });
  }

  private mobilityFleetsAddVehicle(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.fleetId !== 'string' || typeof b.vehicleId !== 'string')
      return json(400, { error: 'fields "fleetId" and "vehicleId" are required' });
    const fleet = this.mobility.addVehicleToFleet(b.fleetId, b.vehicleId);
    return fleet ? json(200, { fleet }) : json(404, { error: 'fleet or vehicle not found' });
  }

  private mobilityDriversRegister(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.license !== 'string')
      return json(400, { error: 'fields "name" and "license" are required' });
    return json(201, { driver: this.mobility.registerDriver({ name: b.name, license: b.license, ...(typeof b.phone === 'string' ? { phone: b.phone } : {}) }) });
  }

  private mobilityDriversList(): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const drivers = this.mobility.listDrivers();
    return json(200, { drivers, count: drivers.length });
  }

  private mobilityTripsRequest(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (!b.pickup || typeof b.pickup !== 'object' || !b.dropoff || typeof b.dropoff !== 'object')
      return json(400, { error: 'fields "pickup" and "dropoff" ({lat,lng}) are required' });
    const trip = this.mobility.requestTrip({
      pickup: b.pickup as never,
      dropoff: b.dropoff as never,
      ...(typeof b.riderId === 'string' ? { riderId: b.riderId } : {}),
      ...(typeof b.pricePerKm === 'number' ? { pricePerKm: b.pricePerKm } : {}),
      ...(typeof b.baseFare === 'number' ? { baseFare: b.baseFare } : {}),
    });
    return json(201, { trip });
  }

  private mobilityTripsList(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const trips = this.mobility.listTrips({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.riderId ? { riderId: req.query.riderId } : {}),
    });
    return json(200, { trips, count: trips.length });
  }

  private async mobilityTripsStatus(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const trip = await this.mobility.updateTripStatus(b.id, b.status as never);
    return trip ? json(200, { trip }) : json(404, { error: 'trip not found' });
  }

  private mobilityTelemetry(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.vehicleId !== 'string' || typeof b.lat !== 'number' || typeof b.lng !== 'number')
      return json(400, { error: 'fields "vehicleId", "lat", and "lng" are required' });
    const point = this.mobility.recordTelemetry({
      vehicleId: b.vehicleId, lat: b.lat, lng: b.lng,
      ...(typeof b.speedKmh === 'number' ? { speedKmh: b.speedKmh } : {}),
      ...(typeof b.batteryPct === 'number' ? { batteryPct: b.batteryPct } : {}),
    });
    return json(201, { point });
  }

  private mobilityTelemetryList(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    if (!req.query.vehicleId) return json(400, { error: 'query parameter "vehicleId" is required' });
    const points = this.mobility.telemetryFor(req.query.vehicleId, req.query.limit ? Number(req.query.limit) : 100);
    return json(200, { points, count: points.length });
  }

  private mobilityGeofencesCreate(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || !b.center || typeof b.center !== 'object' || typeof b.radiusM !== 'number')
      return json(400, { error: 'fields "name", "center" ({lat,lng}), and "radiusM" are required' });
    return json(201, { geofence: this.mobility.createGeofence(b.name, b.center as never, b.radiusM) });
  }

  private mobilityGeofencesList(): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    const geofences = this.mobility.listGeofences();
    return json(200, { geofences, count: geofences.length });
  }

  private mobilityGeofencesVehicles(req: GatewayRequest): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" (geofence) is required' });
    const vehicles = this.mobility.vehiclesInGeofence(req.query.id);
    return json(200, { vehicles, count: vehicles.length });
  }

  private mobilityStats(): GatewayResponse {
    if (!this.mobility) return json(501, { error: 'mobility module not registered' });
    return json(200, { stats: this.mobility.stats() });
  }

  // --- Phase 7 — PORTLINK logistics --------------------------------------

  private logisticsPortsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.code !== 'string' || typeof b.country !== 'string')
      return json(400, { error: 'fields "name", "code", and "country" are required' });
    return json(201, { port: this.logistics.registerPort({
      name: b.name, code: b.code, country: b.country,
      ...(typeof b.city === 'string' ? { city: b.city } : {}),
      ...(typeof b.capacityTeu === 'number' ? { capacityTeu: b.capacityTeu } : {}),
      ...(typeof b.berths === 'number' ? { berths: b.berths } : {}),
    }) });
  }

  private logisticsPortsList(): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const ports = this.logistics.listPorts();
    return json(200, { ports, count: ports.length });
  }

  private logisticsVesselsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.imo !== 'string')
      return json(400, { error: 'fields "name" and "imo" are required' });
    return json(201, { vessel: this.logistics.registerVessel({
      name: b.name, imo: b.imo,
      ...(typeof b.portId === 'string' ? { portId: b.portId } : {}),
      ...(typeof b.eta === 'number' ? { eta: b.eta } : {}),
    }) });
  }

  private logisticsVesselsList(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const vessels = this.logistics.listVessels(req.query.status as never);
    return json(200, { vessels, count: vessels.length });
  }

  private logisticsContainersRegister(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.number !== 'string') return json(400, { error: 'field "number" is required' });
    return json(201, { container: this.logistics.registerContainer({
      number: b.number,
      ...(typeof b.type === 'string' ? { type: b.type as never } : {}),
      ...(typeof b.portId === 'string' ? { portId: b.portId } : {}),
    }) });
  }

  private logisticsContainersList(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const containers = this.logistics.listContainers({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.shipmentId ? { shipmentId: req.query.shipmentId } : {}),
    });
    return json(200, { containers, count: containers.length });
  }

  private logisticsShipmentsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.origin !== 'string' || typeof b.destination !== 'string' || typeof b.shipper !== 'string' || typeof b.consignee !== 'string')
      return json(400, { error: 'fields "origin", "destination", "shipper", and "consignee" are required' });
    return json(201, { shipment: this.logistics.createShipment({
      mode: (b.mode as never) ?? 'sea',
      origin: b.origin, destination: b.destination, shipper: b.shipper, consignee: b.consignee,
      ...(typeof b.weightKg === 'number' ? { weightKg: b.weightKg } : {}),
      ...(typeof b.volumeCbm === 'number' ? { volumeCbm: b.volumeCbm } : {}),
    }) });
  }

  private logisticsShipmentsList(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const shipments = this.logistics.listShipments({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.mode ? { mode: req.query.mode as never } : {}),
      ...(req.query.consignee ? { consignee: req.query.consignee } : {}),
    });
    return json(200, { shipments, count: shipments.length });
  }

  private logisticsShipmentGet(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const ref = req.query.ref ?? req.query.id;
    if (!ref) return json(400, { error: 'query parameter "ref" (tracking reference) or "id" is required' });
    const shipment = req.query.id
      ? this.logistics.getShipment(req.query.id)
      : this.logistics.getShipmentByTrackingRef(ref);
    return shipment ? json(200, { shipment }) : json(404, { error: 'shipment not found' });
  }

  private logisticsShipmentsAssignContainer(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.shipmentId !== 'string' || typeof b.containerId !== 'string')
      return json(400, { error: 'fields "shipmentId" and "containerId" are required' });
    const assigned = this.logistics.assignContainer(b.shipmentId, b.containerId);
    return assigned ? json(200, assigned) : json(404, { error: 'shipment or container not found' });
  }

  private async logisticsShipmentsTrack(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.shipmentId !== 'string' || typeof b.code !== 'string' || typeof b.location !== 'string')
      return json(400, { error: 'fields "shipmentId", "code", and "location" are required' });
    const event = await this.logistics.trackShipment({
      shipmentId: b.shipmentId, code: b.code as never, location: b.location,
      ...(typeof b.note === 'string' ? { note: b.note } : {}),
    });
    return json(201, { event });
  }

  private logisticsShipmentsTimeline(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    if (!req.query.shipmentId) return json(400, { error: 'query parameter "shipmentId" is required' });
    const timeline = this.logistics.shipmentTimeline(req.query.shipmentId);
    return json(200, { timeline, count: timeline.length });
  }

  private logisticsWarehousesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.location !== 'string')
      return json(400, { error: 'fields "name" and "location" are required' });
    return json(201, { warehouse: this.logistics.registerWarehouse({
      name: b.name, location: b.location,
      ...(typeof b.capacitySlots === 'number' ? { capacitySlots: b.capacitySlots } : {}),
    }) });
  }

  private logisticsWarehousesList(): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    const warehouses = this.logistics.listWarehouses();
    return json(200, { warehouses, count: warehouses.length });
  }

  private logisticsStats(): GatewayResponse {
    if (!this.logistics) return json(501, { error: 'logistics module not registered' });
    return json(200, { stats: this.logistics.stats() });
  }

  // --- Phase 7 — KARIS FARM ---------------------------------------------

  private agricultureFarmsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.ownerId !== 'string')
      return json(400, { error: 'fields "name" and "ownerId" are required' });
    return json(201, { farm: this.agriculture.registerFarm({
      name: b.name, ownerId: b.ownerId,
      ...(typeof b.location === 'string' ? { location: b.location } : {}),
      ...(typeof b.areaHa === 'number' ? { areaHa: b.areaHa } : {}),
    }) });
  }

  private agricultureFarmsList(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const farms = this.agriculture.listFarms(req.query.ownerId);
    return json(200, { farms, count: farms.length });
  }

  private agricultureFieldsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.farmId !== 'string' || typeof b.name !== 'string')
      return json(400, { error: 'fields "farmId" and "name" are required' });
    return json(201, { field: this.agriculture.addField({
      farmId: b.farmId, name: b.name,
      ...(typeof b.areaHa === 'number' ? { areaHa: b.areaHa } : {}),
      ...(typeof b.soilType === 'string' ? { soilType: b.soilType } : {}),
    }) });
  }

  private agricultureFieldsList(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const fields = this.agriculture.listFields(req.query.farmId, req.query.status as never);
    return json(200, { fields, count: fields.length });
  }

  private agricultureCropsPlant(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.fieldId !== 'string' || typeof b.crop !== 'string')
      return json(400, { error: 'fields "fieldId" and "crop" are required' });
    return json(201, { cycle: this.agriculture.plantCrop({
      fieldId: b.fieldId, crop: b.crop,
      ...(typeof b.variety === 'string' ? { variety: b.variety } : {}),
      ...(typeof b.expectedYieldKg === 'number' ? { expectedYieldKg: b.expectedYieldKg } : {}),
    }) });
  }

  private agricultureCropsList(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const cycles = this.agriculture.listCycles(req.query.fieldId, req.query.stage as never);
    return json(200, { cycles, count: cycles.length });
  }

  private agricultureCropsStage(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.stage !== 'string')
      return json(400, { error: 'fields "id" and "stage" are required' });
    const cycle = this.agriculture.updateCycleStage(b.id, b.stage as never);
    return cycle ? json(200, { cycle }) : json(404, { error: 'cycle not found' });
  }

  private async agricultureHarvestsRecord(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cropCycleId !== 'string' || typeof b.yieldKg !== 'number')
      return json(400, { error: 'fields "cropCycleId" and "yieldKg" are required' });
    const result = await this.agriculture.recordHarvest({ cropCycleId: b.cropCycleId, yieldKg: b.yieldKg });
    return json(201, result);
  }

  private agricultureHarvestsList(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const harvests = this.agriculture.harvestsList(req.query.farmId);
    return json(200, { harvests, count: harvests.length });
  }

  private agricultureHerdsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.farmId !== 'string' || typeof b.type !== 'string' || typeof b.headCount !== 'number')
      return json(400, { error: 'fields "farmId", "type", and "headCount" are required' });
    return json(201, { herd: this.agriculture.registerHerd({ farmId: b.farmId, type: b.type as never, headCount: b.headCount }) });
  }

  private agricultureHerdsList(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    const herds = this.agriculture.listHerds(req.query.farmId);
    return json(200, { herds, count: herds.length });
  }

  private agricultureStats(req: GatewayRequest): GatewayResponse {
    if (!this.agriculture) return json(501, { error: 'agriculture module not registered' });
    return json(200, { stats: this.agriculture.stats(req.query.farmId) });
  }

  // --- Phase 7 — KARIS LOOP ----------------------------------------------

  private circularStreamsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string') return json(400, { error: 'field "name" is required' });
    return json(201, { stream: this.circular.registerStream({
      name: b.name,
      ...(typeof b.type === 'string' ? { type: b.type as never } : {}),
      ...(typeof b.co2ePerKg === 'number' ? { co2ePerKg: b.co2ePerKg } : {}),
    }) });
  }

  private circularStreamsList(): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const streams = this.circular.listStreams();
    return json(200, { streams, count: streams.length });
  }

  private async circularCollectionsRecord(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.streamId !== 'string' || typeof b.weightKg !== 'number' || typeof b.source !== 'string')
      return json(400, { error: 'fields "streamId", "weightKg", and "source" are required' });
    const collection = await this.circular.recordCollection({ streamId: b.streamId, weightKg: b.weightKg, source: b.source });
    return json(201, { collection });
  }

  private circularCollectionsList(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const collections = this.circular.listCollections(req.query.streamId, req.query.status as never);
    return json(200, { collections, count: collections.length });
  }

  private circularCollectionsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const collection = this.circular.updateCollectionStatus(b.id, b.status as never);
    return collection ? json(200, { collection }) : json(404, { error: 'collection not found' });
  }

  private circularTakebackRegister(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.productId !== 'string' || typeof b.productName !== 'string' || typeof b.returnedBy !== 'string')
      return json(400, { error: 'fields "productId", "productName", and "returnedBy" are required' });
    return json(201, { item: this.circular.registerTakeBack({
      productId: b.productId, productName: b.productName,
      composition: b.composition && typeof b.composition === 'object' ? b.composition as Record<string, number> : {},
      returnedBy: b.returnedBy,
    }) });
  }

  private circularTakebackList(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const items = this.circular.listTakeBack(req.query.status as never);
    return json(200, { items, count: items.length });
  }

  private circularTakebackStatus(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const item = this.circular.updateTakeBackStatus(b.id, b.status as never);
    return item ? json(200, { item }) : json(404, { error: 'take-back item not found' });
  }

  private circularScore(req: GatewayRequest): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    const scope = req.query.scope === 'organization' ? 'organization' : 'product';
    const scopeId = req.query.scopeId;
    if (!scopeId) return json(400, { error: 'query parameter "scopeId" is required' });
    return json(200, { score: this.circular.scoreCircularity(scope, scopeId) });
  }

  private circularStats(): GatewayResponse {
    if (!this.circular) return json(501, { error: 'circular module not registered' });
    return json(200, { stats: this.circular.stats() });
  }

  // --- Phase 7 — KARIS ENERGY -------------------------------------------

  private energyAssetsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.source !== 'string' || typeof b.capacityKw !== 'number')
      return json(400, { error: 'fields "name", "source", and "capacityKw" are required' });
    return json(201, { asset: this.energy.registerAsset({
      name: b.name, source: b.source as never, capacityKw: b.capacityKw,
      ...(typeof b.location === 'string' ? { location: b.location } : {}),
    }) });
  }

  private energyAssetsList(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const assets = this.energy.listAssets(req.query.source as never, req.query.status as never);
    return json(200, { assets, count: assets.length });
  }

  private energyAssetsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const asset = this.energy.setAssetStatus(b.id, b.status as never);
    return asset ? json(200, { asset }) : json(404, { error: 'asset not found' });
  }

  private energyMetersRegister(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string') return json(400, { error: 'field "name" is required' });
    return json(201, { meter: this.energy.registerMeter({
      name: b.name,
      ...(typeof b.customerId === 'string' ? { customerId: b.customerId } : {}),
      ...(typeof b.location === 'string' ? { location: b.location } : {}),
    }) });
  }

  private energyMetersList(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const meters = this.energy.listMeters(req.query.customerId);
    return json(200, { meters, count: meters.length });
  }

  private async energyReadingsRecord(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.meterId !== 'string' || typeof b.kwh !== 'number')
      return json(400, { error: 'fields "meterId" and "kwh" are required' });
    const reading = await this.energy.recordReading({
      meterId: b.meterId, kwh: b.kwh,
      ...(typeof b.voltageV === 'number' ? { voltageV: b.voltageV } : {}),
    });
    return json(201, { reading });
  }

  private energyReadingsList(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    if (!req.query.meterId) return json(400, { error: 'query parameter "meterId" is required' });
    const readings = this.energy.readingsFor(req.query.meterId, {
      ...(req.query.fromTs ? { fromTs: Number(req.query.fromTs) } : {}),
      ...(req.query.toTs ? { toTs: Number(req.query.toTs) } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return json(200, { readings, count: readings.length });
  }

  private energyTariffsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.pricePerKwh !== 'number')
      return json(400, { error: 'fields "name" and "pricePerKwh" are required' });
    return json(201, { tariff: this.energy.registerTariff({
      name: b.name, pricePerKwh: b.pricePerKwh,
      ...(typeof b.fixedCharge === 'number' ? { fixedCharge: b.fixedCharge } : {}),
    }) });
  }

  private energyTariffsList(): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const tariffs = this.energy.listTariffs();
    return json(200, { tariffs, count: tariffs.length });
  }

  private async energyBillsIssue(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.meterId !== 'string' || typeof b.tariffId !== 'string')
      return json(400, { error: 'fields "meterId" and "tariffId" are required' });
    const bill = await this.energy.bill({
      meterId: b.meterId, tariffId: b.tariffId,
      ...(typeof b.fromReadingId === 'string' ? { fromReadingId: b.fromReadingId } : {}),
      ...(typeof b.toReadingId === 'string' ? { toReadingId: b.toReadingId } : {}),
    });
    return json(201, { bill });
  }

  private energyBillsList(req: GatewayRequest): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    const bills = this.energy.billsList(req.query.meterId);
    return json(200, { bills, count: bills.length });
  }

  private energyStats(): GatewayResponse {
    if (!this.energy) return json(501, { error: 'energy module not registered' });
    return json(200, { stats: this.energy.stats() });
  }

  // --- Phase 7 — KARIS BORDER X ------------------------------------------

  private borderPostsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.crossing !== 'string')
      return json(400, { error: 'fields "name" and "crossing" are required' });
    return json(201, { post: this.border.registerPost({
      name: b.name, crossing: b.crossing,
      ...(typeof b.location === 'string' ? { location: b.location } : {}),
    }) });
  }

  private borderPostsList(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const posts = this.border.listPosts(req.query.status as never);
    return json(200, { posts, count: posts.length });
  }

  private borderPostsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const post = this.border.setPostStatus(b.id, b.status as never);
    return post ? json(200, { post }) : json(404, { error: 'post not found' });
  }

  private borderWatchlistAdd(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.documentNo !== 'string' || typeof b.reason !== 'string')
      return json(400, { error: 'fields "name", "documentNo", and "reason" are required' });
    return json(201, { entry: this.border.addWatchlist({
      name: b.name, documentNo: b.documentNo,
      category: (b.category as never) ?? 'person', reason: b.reason,
    }) });
  }

  private borderWatchlistList(): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const entries = this.border.listWatchlist();
    return json(200, { entries, count: entries.length });
  }

  private async borderCrossingsProcess(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.postId !== 'string' || typeof b.travelerId !== 'string' || typeof b.travelerName !== 'string' || typeof b.documentNo !== 'string')
      return json(400, { error: 'fields "postId", "travelerId", "travelerName", and "documentNo" are required' });
    const crossing = await this.border.processCrossing({
      postId: b.postId, travelerId: b.travelerId, travelerName: b.travelerName, documentNo: b.documentNo,
      mode: (b.mode as never) ?? 'road', direction: (b.direction as never) ?? 'inbound',
    });
    return json(201, { crossing });
  }

  private borderCrossingsList(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const crossings = this.border.listCrossings({
      ...(req.query.postId ? { postId: req.query.postId } : {}),
      ...(req.query.clearance ? { clearance: req.query.clearance as never } : {}),
      ...(req.query.direction ? { direction: req.query.direction as never } : {}),
    });
    return json(200, { crossings, count: crossings.length });
  }

  private borderCrossingsOverride(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.clearance !== 'string')
      return json(400, { error: 'fields "id" and "clearance" are required' });
    const crossing = this.border.overrideClearance(b.id, b.clearance as never, typeof b.reason === 'string' ? b.reason : undefined);
    return crossing ? json(200, { crossing }) : json(404, { error: 'crossing not found' });
  }

  private async borderManifestsDeclare(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.postId !== 'string' || typeof b.reference !== 'string' || typeof b.description !== 'string' || typeof b.weightKg !== 'number')
      return json(400, { error: 'fields "postId", "reference", "description", and "weightKg" are required' });
    const manifest = await this.border.declareManifest({
      postId: b.postId, reference: b.reference,
      consignor: typeof b.consignor === 'string' ? b.consignor : '',
      consignee: typeof b.consignee === 'string' ? b.consignee : '',
      description: b.description, weightKg: b.weightKg,
    });
    return json(201, { manifest });
  }

  private borderManifestsList(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const manifests = this.border.listManifests({
      ...(req.query.postId ? { postId: req.query.postId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.flagged ? { flagged: req.query.flagged === 'true' } : {}),
    });
    return json(200, { manifests, count: manifests.length });
  }

  private borderManifestsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const manifest = this.border.updateManifestStatus(b.id, b.status as never);
    return manifest ? json(200, { manifest }) : json(404, { error: 'manifest not found' });
  }

  private borderStats(): GatewayResponse {
    if (!this.border) return json(501, { error: 'border module not registered' });
    return json(200, { stats: this.border.stats() });
  }

  // --- Phase 7 — NYUMBANI KITCHEN ---------------------------------------

  private restaurantsVenuesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.ownerId !== 'string')
      return json(400, { error: 'fields "name" and "ownerId" are required' });
    return json(201, { venue: this.restaurants.registerVenue({
      name: b.name, ownerId: b.ownerId,
      ...(typeof b.location === 'string' ? { location: b.location } : {}),
      ...(typeof b.cuisine === 'string' ? { cuisine: b.cuisine } : {}),
    }) });
  }

  private restaurantsVenuesList(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const venues = this.restaurants.listVenues(req.query.ownerId);
    return json(200, { venues, count: venues.length });
  }

  private restaurantsMenuAdd(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.venueId !== 'string' || typeof b.name !== 'string' || typeof b.price !== 'number')
      return json(400, { error: 'fields "venueId", "name", and "price" are required' });
    return json(201, { item: this.restaurants.addMenuItem({
      venueId: b.venueId, name: b.name, price: b.price,
      ...(typeof b.category === 'string' ? { category: b.category as never } : {}),
    }) });
  }

  private restaurantsMenuList(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    if (!req.query.venueId) return json(400, { error: 'query parameter "venueId" is required' });
    const items = this.restaurants.listMenu(req.query.venueId, req.query.category as never);
    return json(200, { items, count: items.length });
  }

  private restaurantsMenuAvailable(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.available !== 'boolean')
      return json(400, { error: 'fields "id" and "available" are required' });
    const item = this.restaurants.setMenuItemAvailable(b.id, b.available);
    return item ? json(200, { item }) : json(404, { error: 'menu item not found' });
  }

  private restaurantsTablesAdd(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.venueId !== 'string' || typeof b.number !== 'string')
      return json(400, { error: 'fields "venueId" and "number" are required' });
    return json(201, { table: this.restaurants.addTable({
      venueId: b.venueId, number: b.number,
      ...(typeof b.seats === 'number' ? { seats: b.seats } : {}),
    }) });
  }

  private restaurantsTablesList(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    if (!req.query.venueId) return json(400, { error: 'query parameter "venueId" is required' });
    const tables = this.restaurants.listTables(req.query.venueId, req.query.status as never);
    return json(200, { tables, count: tables.length });
  }

  private async restaurantsOrdersCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.venueId !== 'string' || !Array.isArray(b.lines))
      return json(400, { error: 'fields "venueId" and "lines" (array of {menuItemId, quantity}) are required' });
    const order = await this.restaurants.createOrder({
      venueId: b.venueId,
      ...(typeof b.tableId === 'string' ? { tableId: b.tableId } : {}),
      lines: (b.lines as Array<Record<string, unknown>>).map((l) => ({
        menuItemId: String(l.menuItemId), quantity: Number(l.quantity),
      })),
    });
    return json(201, { order });
  }

  private restaurantsOrdersList(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const orders = this.restaurants.listOrders({
      ...(req.query.venueId ? { venueId: req.query.venueId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { orders, count: orders.length });
  }

  private async restaurantsOrdersSubmit(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const order = await this.restaurants.submitOrder(b.id);
    return order ? json(200, { order }) : json(404, { error: 'order not found' });
  }

  private async restaurantsOrdersStatus(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const order = await this.restaurants.updateOrderStatus(b.id, b.status as never);
    return order ? json(200, { order }) : json(404, { error: 'order not found' });
  }

  private restaurantsIngredientsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.venueId !== 'string' || typeof b.name !== 'string')
      return json(400, { error: 'fields "venueId" and "name" are required' });
    return json(201, { ingredient: this.restaurants.addIngredient({
      venueId: b.venueId, name: b.name,
      ...(typeof b.stock === 'number' ? { stock: b.stock } : {}),
      ...(typeof b.reorderLevel === 'number' ? { reorderLevel: b.reorderLevel } : {}),
    }) });
  }

  private restaurantsIngredientsList(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    if (!req.query.venueId) return json(400, { error: 'query parameter "venueId" is required' });
    const ingredients = this.restaurants.listIngredients(req.query.venueId);
    return json(200, { ingredients, count: ingredients.length });
  }

  private async restaurantsIngredientsStock(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.delta !== 'number')
      return json(400, { error: 'fields "id" and "delta" are required' });
    const ingredient = await this.restaurants.adjustStock(b.id, b.delta);
    return ingredient ? json(200, { ingredient }) : json(404, { error: 'ingredient not found' });
  }

  private restaurantsStats(req: GatewayRequest): GatewayResponse {
    if (!this.restaurants) return json(501, { error: 'restaurants module not registered' });
    return json(200, { stats: this.restaurants.stats(req.query.venueId) });
  }

  // --- PRX Part C — ACME (RFC 8555) --------------------------------------

  private pkiAcmeDirectory(): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    return json(200, this.pki.acmeDirectory());
  }

  private pkiAcmeNewNonce(): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    return json(200, { nonce: this.pki.acmeNewNonce() });
  }

  private pkiAcmeNewAccount(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.jws !== 'string') return json(400, { error: 'field "jws" (compact JWS) is required' });
    try {
      const result = this.pki.acmeNewAccount(b.jws, {
        ...(typeof b.onlyReturnExisting === 'boolean' ? { onlyReturnExisting: b.onlyReturnExisting } : {}),
        ...(Array.isArray(b.contact) ? { contact: b.contact.map(String) } : {}),
      });
      return json(201, { account: { id: result.account.id, status: result.account.status, contact: result.account.contact }, kid: result.kid, existing: result.existing });
    } catch (err) {
      const e = err as { type?: string; status?: number; message: string };
      return json(e.status ?? 400, { error: e.message, type: e.type });
    }
  }

  private pkiAcmeNewOrder(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accountId !== 'string' || !Array.isArray(b.identifiers)) {
      return json(400, { error: 'fields "accountId" and "identifiers" (array of {type, value}) are required' });
    }
    const identifiers = (b.identifiers as Array<Record<string, unknown>>).map((i) => ({
      type: String(i.type ?? 'dns') as 'dns',
      value: String(i.value),
    }));
    const order = this.pki.acmeNewOrder(b.accountId, identifiers);
    return json(201, {
      order: {
        id: order.id, status: order.status, identifiers: order.identifiers,
        authorizationIds: order.authorizationIds, finalizeUrl: order.finalizeUrl,
        expiresAt: order.expiresAt,
      },
    });
  }

  private pkiAcmeOrder(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" is required' });
    const order = this.pki.acmeGetOrder(req.query.id);
    return order ? json(200, { order }) : json(404, { error: 'order not found' });
  }

  private pkiAcmeAuthz(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" is required' });
    const authz = this.pki.acmeGetAuthorization(req.query.id);
    return authz ? json(200, { authorization: authz }) : json(404, { error: 'authorization not found' });
  }

  private pkiAcmeChallenge(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" is required' });
    const challenge = this.pki.acmeGetChallenge(req.query.id);
    return challenge ? json(200, { challenge }) : json(404, { error: 'challenge not found' });
  }

  private pkiAcmeChallengeKeyAuth(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" is required' });
    try {
      return json(200, this.pki.acmeChallengeKeyAuthorization(req.query.id));
    } catch (err) {
      const e = err as { status?: number; message: string };
      return json(e.status ?? 400, { error: e.message });
    }
  }

  private pkiAcmeChallengeValidate(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accountId !== 'string' || typeof b.challengeId !== 'string')
      return json(400, { error: 'fields "accountId" and "challengeId" are required' });
    try {
      const challenge = this.pki.acmeRequestValidation(b.accountId, b.challengeId);
      return json(200, { challenge });
    } catch (err) {
      const e = err as { status?: number; message: string };
      return json(e.status ?? 400, { error: e.message });
    }
  }

  private pkiAcmeChallengeProof(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accountId !== 'string' || typeof b.challengeId !== 'string' || typeof b.location !== 'string' || typeof b.value !== 'string')
      return json(400, { error: 'fields "accountId", "challengeId", "location", and "value" are required' });
    try {
      const challenge = this.pki.acmeSubmitProof(b.accountId, b.challengeId, { location: b.location, value: b.value });
      return json(200, { challenge });
    } catch (err) {
      const e = err as { status?: number; message: string };
      return json(e.status ?? 400, { error: e.message });
    }
  }

  private pkiAcmeFinalize(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accountId !== 'string' || typeof b.orderId !== 'string' || typeof b.csr !== 'string')
      return json(400, { error: 'fields "accountId", "orderId", and "csr" (base64 DER) are required' });
    let csr: Buffer;
    try {
      csr = Buffer.from(b.csr, 'base64');
    } catch {
      return json(400, { error: 'csr must be base64-encoded DER' });
    }
    const result = this.pki.acmeFinalize(b.accountId, b.orderId, csr);
    return result.certificate
      ? json(200, { order: { id: result.order.id, status: result.order.status, certificateUrl: result.order.certificateUrl }, certificate: { id: result.certificate.id, certDer: result.certificate.certDer } })
      : json(400, { error: result.order.error?.detail ?? 'finalization failed', type: result.order.error?.type });
  }

  private pkiAcmeCertificate(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    if (!req.query.orderId) return json(400, { error: 'query parameter "orderId" is required' });
    const cert = this.pki.acmeCertificate(req.query.orderId);
    return cert ? json(200, { certificate: { id: cert.id, certDer: cert.certDer, sanDnsNames: cert.sanDnsNames, notAfter: cert.notAfter.toISOString() } }) : json(404, { error: 'no certificate for this order' });
  }

  private pkiAcmeRevoke(req: GatewayRequest): GatewayResponse {
    if (!this.pki) return json(501, { error: 'pki module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accountId !== 'string' || typeof b.certId !== 'string')
      return json(400, { error: 'fields "accountId" and "certId" are required' });
    try {
      this.pki.acmeRevoke(b.accountId, b.certId, typeof b.reason === 'string' ? b.reason : undefined);
      return json(200, { revoked: true });
    } catch (err) {
      const e = err as { status?: number; message: string };
      return json(e.status ?? 400, { error: e.message });
    }
  }

  // --- PRX Part E — Cloud Infrastructure Provider ------------------------

  private cloudRegionsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.code !== 'string' || typeof b.country !== 'string' || !Array.isArray(b.zones))
      return json(400, { error: 'fields "name", "code", "country", and "zones" (array) are required' });
    return json(201, { region: this.cloud.registerRegion({
      name: b.name, code: b.code, country: b.country, zones: b.zones.map(String),
      ...(typeof b.capacitySlots === 'number' ? { capacitySlots: b.capacitySlots } : {}),
    }) });
  }

  private cloudRegionsList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const regions = this.cloud.listRegions(req.query.status as never);
    return json(200, { regions, count: regions.length });
  }

  private cloudRegionsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const region = this.cloud.setRegionStatus(b.id, b.status as never);
    return region ? json(200, { region }) : json(404, { error: 'region not found' });
  }

  private cloudFlavorsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.tier !== 'string' || typeof b.vcpu !== 'number' || typeof b.ramGb !== 'number' || typeof b.diskGb !== 'number' || typeof b.pricePerHourMinor !== 'number')
      return json(400, { error: 'fields "name", "tier", "vcpu", "ramGb", "diskGb", and "pricePerHourMinor" are required' });
    return json(201, { flavor: this.cloud.registerFlavor({
      name: b.name, tier: b.tier as never, vcpu: b.vcpu, ramGb: b.ramGb, diskGb: b.diskGb,
      ...(typeof b.gpu === 'number' ? { gpu: b.gpu } : {}),
      pricePerHourMinor: b.pricePerHourMinor,
    }) });
  }

  private cloudFlavorsList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const flavors = this.cloud.listFlavors(req.query.tier as never);
    return json(200, { flavors, count: flavors.length });
  }

  private cloudImagesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.os !== 'string' || typeof b.version !== 'string')
      return json(400, { error: 'fields "name", "os", and "version" are required' });
    return json(201, { image: this.cloud.registerImage({ name: b.name, os: b.os, version: b.version, ...(typeof b.arch === 'string' ? { arch: b.arch as never } : {}) }) });
  }

  private cloudImagesList(): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const images = this.cloud.listImages();
    return json(200, { images, count: images.length });
  }

  private async cloudInstancesProvision(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.regionId !== 'string' || typeof b.flavorId !== 'string' || typeof b.imageId !== 'string')
      return json(400, { error: 'fields "name", "regionId", "flavorId", and "imageId" are required' });
    const instance = await this.cloud.provisionInstance({
      name: b.name, regionId: b.regionId, flavorId: b.flavorId, imageId: b.imageId,
      ...(typeof b.zone === 'string' ? { zone: b.zone } : {}),
      ...(typeof b.vpcId === 'string' ? { vpcId: b.vpcId } : {}),
      ...(typeof b.hostingPlanId === 'string' ? { hostingPlanId: b.hostingPlanId } : {}),
    });
    return json(201, { instance });
  }

  private cloudInstancesList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const instances = this.cloud.listInstances({
      ...(req.query.regionId ? { regionId: req.query.regionId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { instances, count: instances.length });
  }

  private async cloudInstancesStatus(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const instance = await this.cloud.setInstanceStatus(b.id, b.status as never);
    return instance ? json(200, { instance }) : json(404, { error: 'instance not found' });
  }

  private cloudInstancesReboot(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const instance = this.cloud.rebootInstance(b.id);
    return instance ? json(200, { instance }) : json(404, { error: 'instance not found' });
  }

  private async cloudInstancesTerminate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const instance = await this.cloud.terminateInstance(b.id);
    return instance ? json(200, { instance }) : json(404, { error: 'instance not found' });
  }

  private cloudVolumesCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.sizeGb !== 'number' || typeof b.regionId !== 'string')
      return json(400, { error: 'fields "name", "sizeGb", and "regionId" are required' });
    return json(201, { volume: this.cloud.createVolume({ name: b.name, sizeGb: b.sizeGb, regionId: b.regionId }) });
  }

  private cloudVolumesList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const volumes = this.cloud.listVolumes(req.query.regionId);
    return json(200, { volumes, count: volumes.length });
  }

  private cloudVolumesAttach(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.volumeId !== 'string' || typeof b.instanceId !== 'string')
      return json(400, { error: 'fields "volumeId" and "instanceId" are required' });
    const volume = this.cloud.attachVolume(b.volumeId, b.instanceId);
    return volume ? json(200, { volume }) : json(404, { error: 'volume or instance not found' });
  }

  private cloudVolumesDetach(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.volumeId !== 'string') return json(400, { error: 'field "volumeId" is required' });
    const volume = this.cloud.detachVolume(b.volumeId);
    return volume ? json(200, { volume }) : json(404, { error: 'volume not found' });
  }

  private cloudSnapshotsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.volumeId !== 'string') return json(400, { error: 'field "volumeId" is required' });
    return json(201, { snapshot: this.cloud.createSnapshot(b.volumeId) });
  }

  private cloudSnapshotsList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const snapshots = this.cloud.listSnapshots(req.query.volumeId);
    return json(200, { snapshots, count: snapshots.length });
  }

  private cloudVpcsCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.regionId !== 'string' || typeof b.cidr !== 'string')
      return json(400, { error: 'fields "name", "regionId", and "cidr" are required' });
    return json(201, { vpc: this.cloud.createVpc({
      name: b.name, regionId: b.regionId, cidr: b.cidr,
      subnetCidrs: Array.isArray(b.subnetCidrs) ? b.subnetCidrs.map(String) : [],
    }) });
  }

  private cloudVpcsList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const vpcs = this.cloud.listVpcs(req.query.regionId);
    return json(200, { vpcs, count: vpcs.length });
  }

  private cloudFirewallAdd(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.vpcId !== 'string' || typeof b.name !== 'string' || typeof b.direction !== 'string' || typeof b.protocol !== 'string')
      return json(400, { error: 'fields "vpcId", "name", "direction", and "protocol" are required' });
    return json(201, { rule: this.cloud.addFirewallRule({
      vpcId: b.vpcId, name: b.name, direction: b.direction as never, protocol: b.protocol as never,
      ...(typeof b.portRange === 'string' ? { portRange: b.portRange } : {}),
      ...(typeof b.sourceCidr === 'string' ? { sourceCidr: b.sourceCidr } : {}),
      action: (b.action as never) ?? 'allow',
    }) });
  }

  private cloudFirewallList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    if (!req.query.vpcId) return json(400, { error: 'query parameter "vpcId" is required' });
    const rules = this.cloud.listFirewallRules(req.query.vpcId);
    return json(200, { rules, count: rules.length });
  }

  private cloudLoadBalancersCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.regionId !== 'string' || typeof b.port !== 'number')
      return json(400, { error: 'fields "name", "regionId", and "port" are required' });
    return json(201, { loadBalancer: this.cloud.createLoadBalancer({ name: b.name, regionId: b.regionId, protocol: (b.protocol as never) ?? 'tcp', port: b.port }) });
  }

  private cloudLoadBalancersList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const loadBalancers = this.cloud.listLoadBalancers(req.query.regionId);
    return json(200, { loadBalancers, count: loadBalancers.length });
  }

  private cloudLoadBalancersAddTarget(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.lbId !== 'string' || typeof b.instanceId !== 'string')
      return json(400, { error: 'fields "lbId" and "instanceId" are required' });
    const lb = this.cloud.addLoadBalancerTarget(b.lbId, b.instanceId);
    return lb ? json(200, { loadBalancer: lb }) : json(404, { error: 'load balancer or instance not found' });
  }

  private cloudHostingPlansCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.tier !== 'string' || typeof b.monthlyPriceMinor !== 'number')
      return json(400, { error: 'fields "name", "tier", and "monthlyPriceMinor" are required' });
    return json(201, { plan: this.cloud.createHostingPlan({
      name: b.name, tier: b.tier as never, monthlyPriceMinor: b.monthlyPriceMinor,
      ...(typeof b.flavorId === 'string' ? { flavorId: b.flavorId } : {}),
      ...(typeof b.sslAutomation === 'boolean' ? { sslAutomation: b.sslAutomation } : {}),
      ...(typeof b.cdnIncluded === 'boolean' ? { cdnIncluded: b.cdnIncluded } : {}),
      ...(typeof b.backupIncluded === 'boolean' ? { backupIncluded: b.backupIncluded } : {}),
      ...(typeof b.databasesIncluded === 'number' ? { databasesIncluded: b.databasesIncluded } : {}),
    }) });
  }

  private cloudHostingPlansList(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const plans = this.cloud.listHostingPlans(req.query.tier as never);
    return json(200, { plans, count: plans.length });
  }

  private async cloudHostingProvision(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.planId !== 'string' || typeof b.regionId !== 'string' || typeof b.siteName !== 'string' || typeof b.imageId !== 'string')
      return json(400, { error: 'fields "planId", "regionId", "siteName", and "imageId" are required' });
    const instance = await this.cloud.provisionHosting({ planId: b.planId, regionId: b.regionId, siteName: b.siteName, imageId: b.imageId });
    return json(201, { instance });
  }

  private cloudAutoscalingCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.regionId !== 'string' || typeof b.templateInstanceId !== 'string' || typeof b.min !== 'number' || typeof b.max !== 'number')
      return json(400, { error: 'fields "name", "regionId", "templateInstanceId", "min", and "max" are required' });
    return json(201, { group: this.cloud.createAutoscalingGroup({
      name: b.name, regionId: b.regionId, templateInstanceId: b.templateInstanceId, min: b.min, max: b.max,
      ...(typeof b.cpuHighThreshold === 'number' ? { cpuHighThreshold: b.cpuHighThreshold } : {}),
      ...(typeof b.cpuLowThreshold === 'number' ? { cpuLowThreshold: b.cpuLowThreshold } : {}),
      ...(typeof b.cooldownMs === 'number' ? { cooldownMs: b.cooldownMs } : {}),
      ...(typeof b.memoryHighThreshold === 'number' ? { memoryHighThreshold: b.memoryHighThreshold } : {}),
      ...(typeof b.memoryLowThreshold === 'number' ? { memoryLowThreshold: b.memoryLowThreshold } : {}),
      ...(typeof b.requestsHigh === 'number' ? { requestsHigh: b.requestsHigh } : {}),
      ...(typeof b.requestsLow === 'number' ? { requestsLow: b.requestsLow } : {}),
      ...(Array.isArray(b.schedule) ? { schedule: b.schedule as never } : {}),
    }) });
  }

  private cloudAutoscalingList(): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const groups = this.cloud.listAutoscalingGroups();
    return json(200, { groups, count: groups.length });
  }

  private cloudAutoscalingEvaluate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.groupId !== 'string') return json(400, { error: 'field "groupId" is required' });
    // Backward compatible: { load } (cpu) or { cpu, memory, requestsPerMinute }.
    const signals: Record<string, number> = {};
    for (const k of ['load', 'cpu', 'memory', 'requestsPerMinute'] as const) {
      if (typeof b[k] === 'number') signals[k === 'load' ? 'cpu' : k] = b[k] as number;
    }
    if (Object.keys(signals).length === 0) return json(400, { error: 'provide load/cpu, memory, or requestsPerMinute' });
    const result = this.cloud.evaluateAutoscaling(b.groupId, signals);
    return json(200, { result });
  }

  private cloudAutoscalingUpdate(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.groupId !== 'string') return json(400, { error: 'field "groupId" is required' });
    try {
      const group = this.cloud.updateAutoscalingGroup(b.groupId, {
        ...(typeof b.min === 'number' ? { min: b.min } : {}),
        ...(typeof b.max === 'number' ? { max: b.max } : {}),
        ...(typeof b.cpuHighThreshold === 'number' ? { cpuHighThreshold: b.cpuHighThreshold } : {}),
        ...(typeof b.cpuLowThreshold === 'number' ? { cpuLowThreshold: b.cpuLowThreshold } : {}),
        ...(typeof b.cooldownMs === 'number' ? { cooldownMs: b.cooldownMs } : {}),
        ...(typeof b.memoryHighThreshold === 'number' ? { memoryHighThreshold: b.memoryHighThreshold } : {}),
        ...(typeof b.memoryLowThreshold === 'number' ? { memoryLowThreshold: b.memoryLowThreshold } : {}),
        ...(typeof b.requestsHigh === 'number' ? { requestsHigh: b.requestsHigh } : {}),
        ...(typeof b.requestsLow === 'number' ? { requestsLow: b.requestsLow } : {}),
        ...(Array.isArray(b.schedule) ? { schedule: b.schedule as never } : {}),
      });
      return json(200, { group });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private cloudAutoscalingHistory(req: GatewayRequest): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    const decisions = this.cloud.autoscalingHistory(req.query.groupId);
    return json(200, { decisions, count: decisions.length });
  }

  // ---- Active Defense handlers --------------------------------------------

  private defensePosture(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const engine = this.activeDefense.engine;
    return json(200, {
      stats: engine.stats(),
      riskDistribution: engine.risk.distribution(),
      findingsBySeverity: engine.detection.bySeverity(),
      blockedSessions: engine.risk.all().filter((a) => a.level === 'critical').length,
    });
  }

  private defenseFindings(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const findings = this.activeDefense.findings({
      ...(req.query.severity ? { severity: req.query.severity as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { findings, count: findings.length });
  }

  private defenseFindingAck(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    const f = typeof b.id === 'string' ? this.activeDefense.acknowledgeFinding(b.id) : undefined;
    return f ? json(200, { finding: f }) : json(404, { error: 'finding not found' });
  }

  private defenseFindingResolve(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    const f = typeof b.id === 'string' ? this.activeDefense.resolveFinding(b.id) : undefined;
    return f ? json(200, { finding: f }) : json(404, { error: 'finding not found' });
  }

  private defenseIngest(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.type !== 'string') return json(400, { error: 'field "type" is required' });
    const finding = this.activeDefense.ingest({
      type: b.type,
      ...(typeof b.actor === 'string' ? { actor: b.actor } : {}),
      ...(typeof b.severity === 'string' ? { severity: b.severity as never } : {}),
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(typeof b.detail === 'string' ? { detail: b.detail } : {}),
      ...(b.context && typeof b.context === 'object' ? { context: b.context as Record<string, unknown> } : {}),
    });
    return json(200, { finding });
  }

  private defenseRisk(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const userId = req.query.userId ?? req.principal?.userId;
    if (!userId) return json(400, { error: 'userId required' });
    return json(200, { risk: this.activeDefense.risk(userId) ?? { score: 0, level: 'low', signals: [] } });
  }

  private defenseRiskSignal(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.userId !== 'string' || typeof b.type !== 'string')
      return json(400, { error: 'fields "userId" and "type" are required' });
    const assessment = this.activeDefense.engine.risk.signal(b.userId, {
      type: b.type,
      ...(typeof b.weight === 'number' ? { weight: b.weight } : {}),
      ...(typeof b.context === 'string' ? { context: b.context } : {}),
    });
    return json(200, { risk: assessment });
  }

  private defenseTrustReassess(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.userId !== 'string') return json(400, { error: 'field "userId" is required' });
    this.activeDefense.reassessTrust(b.userId);
    return json(200, { reassessed: true, userId: b.userId });
  }

  private defenseBansList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const bans = this.activeDefense.listBans();
    return json(200, { bans, count: bans.length });
  }

  private defenseBansAdd(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.scope !== 'string' || typeof b.value !== 'string' || typeof b.reason !== 'string')
      return json(400, { error: 'fields "scope", "value", and "reason" are required' });
    try {
      const ban = this.activeDefense.ban({
        scope: b.scope as never,
        value: b.value,
        reason: b.reason,
        ...(typeof b.durationMs === 'number' ? { durationMs: b.durationMs } : {}),
        ...(this.principalUsername(req) ? { createdBy: this.principalUsername(req) } : {}),
      });
      return json(201, { ban });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private defenseBansLift(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { lifted: this.activeDefense.liftBan(b.id) });
  }

  private defenseActionsList(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const actions = this.activeDefense.listActions({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.kind ? { kind: req.query.kind as never } : {}),
    });
    return json(200, { actions, count: actions.length });
  }

  private defenseContain(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.kind !== 'string' || typeof b.target !== 'string' || typeof b.reason !== 'string')
      return json(400, { error: 'fields "kind", "target", and "reason" are required' });
    const action = this.activeDefense.contain({
      kind: b.kind as never,
      target: b.target,
      reason: b.reason,
      ...(this.principalUsername(req) ? { requestedBy: this.principalUsername(req) } : {}),
    });
    return json(201, { action });
  }

  private defenseActionApprove(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const action = this.activeDefense.approveAction(b.id, this.principalUsername(req) ?? 'unknown');
    return action ? json(200, { action }) : json(404, { error: 'action not found or not pending' });
  }

  private defenseActionDeny(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const action = this.activeDefense.denyAction(b.id, this.principalUsername(req) ?? 'unknown', typeof b.reason === 'string' ? b.reason : undefined);
    return action ? json(200, { action }) : json(404, { error: 'action not found or not pending' });
  }

  private defenseHoneytokensList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { honeytokens: this.activeDefense.listHoneytokens() });
  }

  private defenseHoneytokensAdd(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.label !== 'string' || typeof b.value !== 'string' || typeof b.placement !== 'string')
      return json(400, { error: 'fields "label", "value", and "placement" are required' });
    try {
      const token = this.activeDefense.createHoneytoken({
        label: b.label, value: b.value, placement: b.placement,
        ...(typeof b.oneTime === 'boolean' ? { oneTime: b.oneTime } : {}),
      });
      return json(201, { honeytoken: token });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private defenseDecoysList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { decoys: this.activeDefense.listDecoys() });
  }

  private defenseDecoysAdd(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.kind !== 'string')
      return json(400, { error: 'fields "name" and "kind" are required' });
    try {
      const decoy = this.activeDefense.registerDecoy({
        name: b.name, kind: b.kind as never,
        ...(typeof b.endpoint === 'string' ? { endpoint: b.endpoint } : {}),
      });
      return json(201, { decoy });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private defenseTouchesList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { touches: this.activeDefense.touches() });
  }

  private defenseIncidentsList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { incidents: this.activeDefense.listIncidents() });
  }

  private defenseIncidentsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.title !== 'string' || typeof b.severity !== 'string')
      return json(400, { error: 'fields "title" and "severity" are required' });
    const incident = this.activeDefense.recordIncident({
      title: b.title,
      severity: b.severity as never,
      ...(Array.isArray(b.findingIds) ? { findingIds: b.findingIds as string[] } : {}),
      ...(Array.isArray(b.actionIds) ? { actionIds: b.actionIds as string[] } : {}),
    });
    return json(201, { incident });
  }

  private defenseIncidentsReview(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.rca !== 'string')
      return json(400, { error: 'fields "id" and "rca" are required' });
    const incident = this.activeDefense.reviewIncident(b.id, {
      rca: b.rca,
      lessonsLearned: Array.isArray(b.lessonsLearned) ? b.lessonsLearned as string[] : [],
    });
    return incident ? json(200, { incident }) : json(404, { error: 'incident not found' });
  }

  private defenseRecover(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.target !== 'string') return json(400, { error: 'field "target" is required' });
    const run = this.activeDefense.recover({
      target: b.target,
      ...(typeof b.fromSnapshot === 'string' ? { fromSnapshot: b.fromSnapshot } : {}),
    });
    return json(201, { recovery: run });
  }

  private defenseRecoveryList(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { recoveries: this.activeDefense.recoveryRuns() });
  }

  private defenseIntegrityValidate(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    const manifest = Array.isArray(b.manifest) ? b.manifest as Array<{ path: string; sha256: string }> : [];
    if (manifest.length === 0) return json(400, { error: 'field "manifest" (array of {path, sha256}) is required' });
    const results = this.activeDefense.validateRuntimeIntegrity(manifest);
    return json(200, { results, ok: results.every((r) => r.ok) });
  }

  private defenseCryptoRotate(req: GatewayRequest): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.scope !== 'string') return json(400, { error: 'field "scope" is required' });
    const r = this.activeDefense.rotateCryptoMaterial(b.scope, typeof b.minIntervalMs === 'number' ? b.minIntervalMs : undefined);
    return r.rotated ? json(200, r) : json(200, r);
  }

  private defenseReport(): GatewayResponse {
    if (!this.activeDefense) return json(501, { error: 'active-defense module not registered' });
    return json(200, { report: this.activeDefense.report() });
  }

  // ---- Global Security Operations handlers ---------------------------------

  private socReport(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { report: this.soc.report() });
  }

  private socKpis(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { kpis: this.soc.kpis() });
  }

  private socLake(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const entries = this.soc.query({
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.query.actor ? { actor: req.query.actor } : {}),
      ...(req.query.origin ? { origin: req.query.origin } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return json(200, { entries: entries.slice(-50), count: this.soc.lake.count(), analytics: this.soc.lakeAnalytics() });
  }

  private socLakeStatus(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { entries: this.soc.lake.count(), chainValid: this.soc.verifyLake().valid, integrity: this.soc.verifyLake() });
  }

  private socLakeExport(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
    const body = format === 'csv' ? this.soc.exportCsv() : this.soc.exportJsonl();
    return { status: 200, body, contentType: format === 'csv' ? 'text/csv' : 'application/x-ndjson' };
  }

  private socTelemetry(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.type !== 'string' || typeof b.source !== 'string')
      return json(400, { error: 'fields "type" and "source" are required' });
    const entry = this.soc.ingest({
      source: b.source as never,
      type: b.type,
      ...(typeof b.actor === 'string' ? { actor: b.actor } : {}),
      ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
      ...(typeof b.severity === 'string' ? { severity: b.severity as never } : {}),
      ...(typeof b.detail === 'string' ? { detail: b.detail } : {}),
      ...(b.data && typeof b.data === 'object' ? { data: b.data as Record<string, unknown> } : {}),
    });
    return json(201, { entry });
  }

  private socIncidentsList(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const incidents = this.soc.listIncidents({
      ...(req.query.severity ? { severity: req.query.severity } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
    });
    return json(200, { incidents, count: incidents.length });
  }

  private socIncidentsOpen(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.title !== 'string' || typeof b.severity !== 'string')
      return json(400, { error: 'fields "title" and "severity" are required' });
    const incident = this.soc.openIncident({
      title: b.title, severity: b.severity,
      ...(typeof b.commander === 'string' ? { commander: b.commander } : {}),
      ...(Array.isArray(b.responders) ? { responders: b.responders as string[] } : {}),
    });
    return json(201, { incident });
  }

  private socIncidentsTransition(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string' || typeof b.by !== 'string')
      return json(400, { error: 'fields "id", "status", and "by" are required' });
    try {
      const incident = this.soc.transitionIncident(b.id, b.status, b.by, typeof b.note === 'string' ? b.note : '');
      return incident ? json(200, { incident }) : json(404, { error: 'incident not found' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private socIncidentsEvidence(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.description !== 'string' || typeof b.preservedBy !== 'string')
      return json(400, { error: 'fields "id", "description", and "preservedBy" are required' });
    const evidence = this.soc.preserveEvidence(b.id, {
      description: b.description,
      preservedBy: b.preservedBy,
      ...(typeof b.artifactHash === 'string' ? { artifactHash: b.artifactHash } : {}),
    });
    return evidence ? json(201, { evidence }) : json(404, { error: 'incident not found' });
  }

  private socIncidentsCommunicate(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.channel !== 'string' || typeof b.message !== 'string' || typeof b.by !== 'string')
      return json(400, { error: 'fields "id", "channel", "message", and "by" are required' });
    const comm = this.soc.communicateIncident(b.id, {
      channel: b.channel, message: b.message, by: b.by,
      ...(typeof b.to === 'string' ? { to: b.to } : {}),
    });
    return comm ? json(201, { communication: comm }) : json(404, { error: 'incident not found' });
  }

  private socIncidentsReview(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.rca !== 'string' || typeof b.by !== 'string')
      return json(400, { error: 'fields "id", "rca", and "by" are required' });
    const incident = this.soc.reviewIncident(b.id, {
      rca: b.rca, by: b.by,
      lessons: Array.isArray(b.lessons) ? b.lessons as string[] : [],
    });
    return incident ? json(200, { incident }) : json(404, { error: 'incident not found' });
  }

  private socEscalate(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { results: this.soc.sweepEscalations() });
  }

  private socHunt(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.playbook !== 'string') return json(400, { error: 'field "playbook" is required' });
    try {
      const session = this.soc.hunt(b.playbook, {
        ...(typeof b.since === 'number' ? { since: b.since } : {}),
        ...(typeof b.limit === 'number' ? { limit: b.limit } : {}),
      });
      return json(200, { session });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private socHuntsList(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { hunts: this.soc.huntSessions() });
  }

  private socPlaybooks(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { playbooks: this.soc.huntPlaybooks() });
  }

  private socHuntCorrelation(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { actors: this.soc.huntCorrelation() });
  }

  private socIntelIngest(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.type !== 'string' || typeof b.value !== 'string' || typeof b.confidence !== 'number' || typeof b.severity !== 'string' || typeof b.source !== 'string')
      return json(400, { error: 'fields "type", "value", "confidence", "severity", and "source" are required' });
    try {
      const indicator = this.soc.ingestIntel({
        type: b.type, value: b.value, confidence: b.confidence, severity: b.severity, source: b.source,
        ...(typeof b.tlp === 'string' ? { tlp: b.tlp } : {}),
        ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
        ...(Array.isArray(b.tags) ? { tags: b.tags as string[] } : {}),
      });
      return json(201, { indicator });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private socIntelList(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { indicators: this.soc.listIntel({
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.query.severity ? { severity: req.query.severity } : {}),
      ...(req.query.source ? { source: req.query.source } : {}),
    }) });
  }

  private socIntelMatch(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    const observations = Array.isArray(b.observations) ? b.observations as Array<{ value: string; context?: Record<string, unknown> }> : [];
    if (observations.length === 0) return json(400, { error: 'field "observations" (array of {value}) is required' });
    return json(200, { matches: this.soc.matchIntel(observations) });
  }

  private socIntelMatches(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { matches: this.soc.intelMatches() });
  }

  private socIntelCorrelation(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { correlation: this.soc.intelCorrelation() });
  }

  private socIntelHealth(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { health: this.soc.intelFeedHealth() });
  }

  private socInsiderAlerts(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { alerts: this.soc.insiderAlerts() });
  }

  private socInsiderObserve(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.actor !== 'string' || typeof b.action !== 'string' || typeof b.sensitivity !== 'string')
      return json(400, { error: 'fields "actor", "action", and "sensitivity" are required' });
    const alert = this.soc.observeInsider({
      actor: b.actor, action: b.action, sensitivity: b.sensitivity,
      ...(typeof b.detail === 'string' ? { detail: b.detail } : {}),
    });
    return json(200, { alert });
  }

  private socInsiderPosture(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    const principals = Array.isArray(b.principals) ? b.principals as Array<{ principal: string; roles: string[] }> : [];
    return json(200, { posture: this.soc.insiderPosture(principals) });
  }

  private socAbuseAlerts(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { alerts: this.soc.abuseAlerts() });
  }

  private socAbuseObserve(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.kind !== 'string') return json(400, { error: 'field "kind" is required' });
    const alert = this.soc.observeAbuse({
      kind: b.kind,
      ...(typeof b.actor === 'string' ? { actor: b.actor } : {}),
      ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
      ...(typeof b.value === 'string' ? { value: b.value } : {}),
    });
    return json(200, { alert });
  }

  private socAbuseCoordinated(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { clusters: this.soc.abuseCoordinated() });
  }

  private socCampaignsRun(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.kind !== 'string') return json(400, { error: 'field "kind" is required' });
    try {
      return json(201, { campaign: this.soc.runCampaign(b.kind) });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private socCampaignsList(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { campaigns: this.soc.campaigns() });
  }

  private socValidationScore(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { score: this.soc.validationScore(), campaigns: this.soc.campaigns().length });
  }

  private socTabletopsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.title !== 'string' || typeof b.description !== 'string' || !Array.isArray(b.injects))
      return json(400, { error: 'fields "title", "description", and "injects" are required' });
    return json(201, { scenario: this.soc.addTabletop({
      title: b.title, description: b.description, injects: b.injects as string[],
      ...(Array.isArray(b.facilitatorNotes) ? { facilitatorNotes: b.facilitatorNotes as string[] } : {}),
    }) });
  }

  private socTabletopsList(): GatewayResponse {
    if (!this.soc) return json(501, { error: 'soc module not registered' });
    return json(200, { scenarios: this.soc.tabletops() });
  }

  // ---- Software Supply Chain Governance handlers ---------------------------

  private supplyChainStats(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { stats: this.supplyChain.stats() });
  }

  private supplyChainRepoCheck(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.repo !== 'string' || typeof b.branch !== 'string')
      return json(400, { error: 'fields "repo" and "branch" are required' });
    const check = this.supplyChain.checkRepository(b.repo, {
      branch: b.branch,
      signedCommits: b.signedCommits === true,
      ciPassing: b.ciPassing === true,
      reviewers: typeof b.reviewers === 'number' ? b.reviewers : 0,
    });
    return json(200, { check });
  }

  private supplyChainRepos(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { repositories: this.supplyChain.repositoryChecks() });
  }

  private supplyChainPipelineCheck(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.pipeline !== 'string') return json(400, { error: 'field "pipeline" is required' });
    const check = this.supplyChain.checkPipeline(b.pipeline, {
      pinnedSteps: b.pinnedSteps === true,
      hasSecrets: b.hasSecrets === true,
      hasApproval: b.hasApproval === true,
    });
    return json(200, { check });
  }

  private supplyChainPipelines(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { pipelines: this.supplyChain.pipelineChecks() });
  }

  private supplyChainAudit(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    const records = Array.isArray(b.records) ? b.records as Array<{ name: string; integritySha512: string; license?: string }> : [];
    const computed = (b.computed && typeof b.computed === 'object') ? new Map(Object.entries(b.computed as Record<string, string>)) : new Map<string, string>();
    if (records.length === 0) return json(400, { error: 'field "records" is required' });
    return json(200, { audit: this.supplyChain.auditLockfile(records, computed) });
  }

  private supplyChainProvenanceCreate(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.artifactName !== 'string' || typeof b.artifactSha256 !== 'string' || typeof b.builderId !== 'string' || typeof b.buildId !== 'string')
      return json(400, { error: 'fields "artifactName", "artifactSha256", "builderId", "buildId" are required' });
    const provenance = this.supplyChain.createProvenance({
      artifactName: b.artifactName, artifactSha256: b.artifactSha256, builderId: b.builderId, buildId: b.buildId,
      materials: Array.isArray(b.materials) ? b.materials as Array<{ uri: string; digest: string }> : [],
    });
    return json(201, { provenance });
  }

  private supplyChainProvenanceList(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { provenances: this.supplyChain.listProvenances() });
  }

  private supplyChainProvenanceVerify(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { verification: this.supplyChain.verifyProvenance(b.id) });
  }

  private supplyChainReleaseSign(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.release !== 'string' || typeof b.artifactName !== 'string' || typeof b.artifactSha256 !== 'string')
      return json(400, { error: 'fields "release", "artifactName", "artifactSha256" are required' });
    const release = this.supplyChain.signRelease({
      release: b.release, artifactName: b.artifactName, artifactSha256: b.artifactSha256,
      ...(typeof b.notes === 'string' ? { notes: b.notes } : {}),
    });
    return json(201, { release });
  }

  private supplyChainReleases(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { releases: this.supplyChain.listReleases() });
  }

  private supplyChainReleaseVerify(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    return json(200, { verification: this.supplyChain.verifyRelease(b.id) });
  }

  private supplyChainDeployAttest(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.environment !== 'string' || typeof b.artifactName !== 'string' || typeof b.artifactSha256 !== 'string' || typeof b.deployer !== 'string')
      return json(400, { error: 'fields "environment", "artifactName", "artifactSha256", "deployer" are required' });
    return json(201, this.supplyChain.attestDeployment({
      environment: b.environment, artifactName: b.artifactName, artifactSha256: b.artifactSha256, deployer: b.deployer,
    }));
  }

  private supplyChainDeployments(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { attestations: this.supplyChain.attestationsList() });
  }

  private supplyChainIntegrityCheck(req: GatewayRequest): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.release !== 'string' || typeof b.artifactName !== 'string' || typeof b.artifactSha256 !== 'string')
      return json(400, { error: 'fields "release", "artifactName", "artifactSha256" are required' });
    return json(200, { check: this.supplyChain.checkIntegrity({
      release: b.release, artifactName: b.artifactName, artifactSha256: b.artifactSha256,
      ...(typeof b.deployedSha256 === 'string' ? { deployedSha256: b.deployedSha256 } : {}),
    }) });
  }

  private supplyChainIntegrityHistory(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { checks: this.supplyChain.integrityHistory() });
  }

  private supplyChainMonitor(): GatewayResponse {
    if (!this.supplyChain) return json(501, { error: 'supply-chain-security module not registered' });
    return json(200, { monitoring: this.supplyChain.monitor() });
  }

  // ---- Secure Infrastructure Governance handlers ------------------------------

  private infraStats(): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    return json(200, { stats: this.infraGovernance.stats(), lifecycle: this.infraGovernance.lifecycleAnalytics() });
  }

  private infraAssetsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.serial !== 'string' || typeof b.model !== 'string' || typeof b.role !== 'string' || typeof b.firmwareVersion !== 'string')
      return json(400, { error: 'fields "serial", "model", "role", "firmwareVersion" are required' });
    try {
      const asset = this.infraGovernance.registerAsset({
        serial: b.serial, model: b.model, role: b.role as never, firmwareVersion: b.firmwareVersion,
        ...(typeof b.firmwareSha256 === 'string' ? { firmwareSha256: b.firmwareSha256 } : {}),
        ...(typeof b.measuredBoot === 'string' ? { measuredBoot: b.measuredBoot } : {}),
        ...(typeof b.location === 'string' ? { location: b.location } : {}),
        ...(typeof b.purchasedAt === 'number' ? { purchasedAt: b.purchasedAt } : {}),
        ...(typeof b.eolAt === 'number' ? { eolAt: b.eolAt } : {}),
      });
      return json(201, { asset });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private infraAssetsList(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const assets = this.infraGovernance.listAssets({
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.role ? { role: req.query.role as never } : {}),
      ...(req.query.eol === '1' ? { eol: true } : {}),
    });
    return json(200, { assets, count: assets.length });
  }

  private infraAssetsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.serial !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "serial" and "status" are required' });
    const asset = this.infraGovernance.setStatus(b.serial, b.status as never);
    return asset ? json(200, { asset }) : json(404, { error: 'asset not found' });
  }

  private infraProvisioningEnroll(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.serial !== 'string' || typeof b.token !== 'string' || typeof b.enrolledBy !== 'string')
      return json(400, { error: 'fields "serial", "token", "enrolledBy" are required' });
    try {
      const record = this.infraGovernance.enrollProvisioning({
        serial: b.serial, token: b.token, enrolledBy: b.enrolledBy,
        method: b.method === 'tpm' || b.method === 'serial' || b.method === 'network' ? b.method : 'serial',
      });
      return json(201, { provisioning: record });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private infraProvisioningApprove(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const record = this.infraGovernance.approveProvisioning(b.id, this.principalUsername(req) ?? 'operator');
    return record ? json(200, { provisioning: record }) : json(404, { error: 'provisioning not found' });
  }

  private infraProvisioningList(): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    return json(200, { provisionings: this.infraGovernance.provisioningsList() });
  }

  private infraFirmwareValidate(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.serial !== 'string' || typeof b.actualSha256 !== 'string')
      return json(400, { error: 'fields "serial" and "actualSha256" are required' });
    try {
      return json(200, this.infraGovernance.validateFirmware(b.serial, b.actualSha256, typeof b.measuredBoot === 'string' ? b.measuredBoot : undefined));
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private infraFirmwareReport(): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    return json(200, { report: this.infraGovernance.firmwareStatusReport() });
  }

  private infraDriftDetect(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.serial !== 'string' || !b.golden || typeof b.golden !== 'object' || !b.live || typeof b.live !== 'object')
      return json(400, { error: 'fields "serial", "golden", "live" (objects) are required' });
    try {
      const drifts = this.infraGovernance.detectDrift(b.serial, b.golden as Record<string, string>, b.live as Record<string, string>);
      return json(200, { drifts, count: drifts.length });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private infraDriftList(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const drifts = this.infraGovernance.driftsList({
      ...(req.query.severity ? { severity: req.query.severity as never } : {}),
      ...(req.query.open === '1' ? { open: true } : {}),
    });
    return json(200, { drifts, count: drifts.length });
  }

  private infraDriftRemediate(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const drift = this.infraGovernance.remediateDrift(b.id);
    return drift ? json(200, { drift }) : json(404, { error: 'drift not found' });
  }

  private infraComplianceRun(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    const facts = b.facts && typeof b.facts === 'object' ? b.facts as Record<string, boolean> : {};
    return json(200, { checks: this.infraGovernance.runComplianceChecks(facts) });
  }

  private infraComplianceReport(): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    return json(200, { report: this.infraGovernance.complianceReport() });
  }

  private infraAccessLog(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.facility !== 'string' || typeof b.zone !== 'string' || typeof b.person !== 'string' || typeof b.action !== 'string')
      return json(400, { error: 'fields "facility", "zone", "person", "action" are required' });
    const record = this.infraGovernance.logAccess({
      facility: b.facility, zone: b.zone, person: b.person, action: b.action as never,
      ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
    });
    return json(201, { record });
  }

  private infraAccessList(req: GatewayRequest): GatewayResponse {
    if (!this.infraGovernance) return json(501, { error: 'infra-governance module not registered' });
    const log = this.infraGovernance.accessLog({
      ...(req.query.facility ? { facility: req.query.facility } : {}),
      ...(req.query.action ? { action: req.query.action as never } : {}),
    });
    return json(200, { log, count: log.length, patterns: this.infraGovernance.deniedAccessPatterns() });
  }

  // ---- Global Resilience Engineering handlers --------------------------------

  private resilienceStats(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { stats: this.resilience.stats() });
  }

  private resilienceRegions(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { regions: this.resilience.regionsList() });
  }

  private resilienceRegionsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.location !== 'string' || typeof b.role !== 'string' || typeof b.priority !== 'number')
      return json(400, { error: 'fields "name", "location", "role", "priority" are required' });
    try {
      return json(201, { region: this.resilience.registerRegion({ name: b.name, location: b.location, role: b.role as never, priority: b.priority }) });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resilienceRegionsRole(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.role !== 'string')
      return json(400, { error: 'fields "name" and "role" are required' });
    const region = this.resilience.setRegionRole(b.name, b.role as never);
    return region ? json(200, { region }) : json(404, { error: 'region not found' });
  }

  private resilienceHealth(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { regions: this.resilience.regionHealth() });
  }

  private resilienceProbe(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.region !== 'string' || typeof b.ok !== 'boolean')
      return json(400, { error: 'fields "workload", "region", "ok" are required' });
    const probe = this.resilience.recordProbe(b.workload, b.region, b.ok, typeof b.latencyMs === 'number' ? b.latencyMs : 0, typeof b.detail === 'string' ? b.detail : undefined);
    return json(200, { probe });
  }

  private resilienceFailover(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string') return json(400, { error: 'field "workload" is required' });
    const run = this.resilience.evaluateFailover(b.workload);
    return run ? json(200, { run }) : json(200, { run: null, note: 'no failover required' });
  }

  private resilienceFailback(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.approver !== 'string')
      return json(400, { error: 'fields "workload" and "approver" are required' });
    const run = this.resilience.failback(b.workload, b.approver);
    return run ? json(200, { run }) : json(404, { error: 'failback not possible' });
  }

  private resilienceFailovers(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { failovers: this.resilience.failoverHistory() });
  }

  private resiliencePlansCreate(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.rpoMs !== 'number' || typeof b.rtoMs !== 'number' || typeof b.createdBy !== 'string')
      return json(400, { error: 'fields "workload", "rpoMs", "rtoMs", "createdBy" are required' });
    try {
      return json(201, { plan: this.resilience.createPlan({ workload: b.workload, rpoMs: b.rpoMs, rtoMs: b.rtoMs, createdBy: b.createdBy }) });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resiliencePlansList(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { plans: this.resilience.plansList() });
  }

  private resiliencePlansExecute(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.planId !== 'string') return json(400, { error: 'field "planId" is required' });
    try {
      return json(200, { execution: this.resilience.executePlan(b.planId, {
        ...(typeof b.snapshotAgeMs === 'number' ? { snapshotAgeMs: b.snapshotAgeMs } : {}),
        ...(typeof b.failStep === 'string' ? { failStep: b.failStep } : {}),
      }) });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resilienceExecutions(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { executions: this.resilience.executionsList() });
  }

  private resilienceCompliance(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { compliance: this.resilience.drCompliance() });
  }

  private resilienceFaultsInject(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.kind !== 'string' || typeof b.target !== 'string' || typeof b.intensity !== 'number' || typeof b.durationMs !== 'number')
      return json(400, { error: 'fields "workload", "kind", "target", "intensity", "durationMs" are required' });
    try {
      return json(201, { fault: this.resilience.injectFault({ workload: b.workload, kind: b.kind as never, target: b.target, intensity: b.intensity, durationMs: b.durationMs }) });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resilienceFaultsEnd(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const fault = this.resilience.endFault(b.id);
    return fault ? json(200, { fault }) : json(404, { error: 'fault not found' });
  }

  private resilienceFaultsList(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    if (req.query.active === '1') return json(200, { faults: this.resilience.activeFaults() });
    return json(200, { faults: this.resilience.faultsList() });
  }

  private resilienceTestsRun(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.kind !== 'string' || typeof b.target !== 'string' || typeof b.intensity !== 'number' || typeof b.durationMs !== 'number' || typeof b.planId !== 'string')
      return json(400, { error: 'fields "workload", "kind", "target", "intensity", "durationMs", "planId" are required' });
    try {
      return json(201, this.resilience.runResilienceTest({
        workload: b.workload, kind: b.kind as never, target: b.target, intensity: b.intensity,
        durationMs: b.durationMs, planId: b.planId,
        ...(typeof b.snapshotAgeMs === 'number' ? { snapshotAgeMs: b.snapshotAgeMs } : {}),
        ...(typeof b.failStep === 'string' ? { failStep: b.failStep } : {}),
      }));
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resilienceAvailabilityRecord(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.windowMs !== 'number' || typeof b.uptime !== 'number' || typeof b.slo !== 'number')
      return json(400, { error: 'fields "workload", "windowMs", "uptime", "slo" are required' });
    return json(201, { availability: this.resilience.recordAvailability({ workload: b.workload, windowMs: b.windowMs, uptime: b.uptime, slo: b.slo }) });
  }

  private resilienceAvailability(): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    return json(200, { availability: this.resilience.availabilitySummary(), records: this.resilience.availabilityList() });
  }

  private resilienceProbesList(req: GatewayRequest): GatewayResponse {
    if (!this.resilience) return json(501, { error: 'resilience-engineering module not registered' });
    const probes = this.resilience.probesList({
      ...(req.query.workload ? { workload: req.query.workload } : {}),
      ...(req.query.region ? { region: req.query.region } : {}),
      ...(req.query.ok === '1' ? { ok: true } : req.query.ok === '0' ? { ok: false } : {}),
    });
    return json(200, { probes: probes.slice(-50), count: probes.length });
  }

  // ---- Independent Security Review handlers --------------------------------

  private reviewSchedule(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.kind !== 'string' || typeof b.target !== 'string' || typeof b.reviewer !== 'string')
      return json(400, { error: 'fields "kind", "target", "reviewer" are required' });
    try {
      const review = this.securityReview.scheduleReview({
        kind: b.kind as never, target: b.target, reviewer: b.reviewer,
        ...(typeof b.phase === 'string' ? { phase: b.phase as never } : {}),
      });
      return json(201, { review });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private reviewList(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const reviews = this.securityReview.listReviews({
      ...(req.query.kind ? { kind: req.query.kind as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.target ? { target: req.query.target } : {}),
    });
    return json(200, { reviews, count: reviews.length });
  }

  private reviewStart(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const review = this.securityReview.startReview(b.id);
    return review ? json(200, { review }) : json(404, { error: 'review not found' });
  }

  private reviewComplete(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.summary !== 'string')
      return json(400, { error: 'fields "id" and "summary" are required' });
    const review = this.securityReview.completeReview(b.id, b.summary);
    return review ? json(200, { review }) : json(404, { error: 'review not found' });
  }

  private reviewSignOff(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.approver !== 'string')
      return json(400, { error: 'fields "id" and "approver" are required' });
    try {
      const review = this.securityReview.signOff(b.id, b.approver);
      return review ? json(200, { review }) : json(404, { error: 'review not found' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private reviewFindingsAdd(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.reviewId !== 'string' || typeof b.severity !== 'string' || typeof b.title !== 'string')
      return json(400, { error: 'fields "reviewId", "severity", "title" are required' });
    try {
      const finding = this.securityReview.addFinding({
        reviewId: b.reviewId, severity: b.severity as never, title: b.title,
        ...(typeof b.description === 'string' ? { description: b.description } : {}),
        ...(typeof b.controlRef === 'string' ? { controlRef: b.controlRef } : {}),
        ...(typeof b.recommendation === 'string' ? { recommendation: b.recommendation } : {}),
        ...(typeof b.createdBy === 'string' ? { createdBy: b.createdBy } : { createdBy: this.principalUsername(req) ?? 'reviewer' }),
      });
      return json(201, { finding });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private reviewFindingsList(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const findings = this.securityReview.listFindings({
      ...(req.query.reviewId ? { reviewId: req.query.reviewId } : {}),
      ...(req.query.severity ? { severity: req.query.severity as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { findings, count: findings.length });
  }

  private reviewFindingsUpdate(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const finding = this.securityReview.updateFinding(b.id, b.status as never, typeof b.by === 'string' ? b.by : 'reviewer', typeof b.note === 'string' ? b.note : undefined);
    return finding ? json(200, { finding }) : json(404, { error: 'finding not found' });
  }

  private reviewScan(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    const files = Array.isArray(b.files) ? b.files as Array<{ path: string; content: string }> : [];
    if (files.length === 0) return json(400, { error: 'field "files" (array of {path, content}) is required' });
    const hits = typeof b.reviewId === 'string'
      ? this.securityReview.scanAndFind(b.reviewId, files, typeof b.reviewer === 'string' ? b.reviewer : 'reviewer')
      : this.securityReview.scanCode(files);
    return json(200, { hits, count: hits.length });
  }

  private reviewArchitecture(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    const answers = Array.isArray(b.answers) ? b.answers as Array<{ questionId: string; score: number }> : [];
    if (answers.length === 0) return json(400, { error: 'field "answers" is required' });
    return json(200, { assessment: this.securityReview.assessArchitecture(answers) });
  }

  private reviewCompliance(req: GatewayRequest): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    const b = this.asObject(req.body);
    const evidence = b.evidence && typeof b.evidence === 'object' ? b.evidence as Record<string, boolean> : {};
    return json(200, { assessment: this.securityReview.assessCompliance(evidence) });
  }

  private reviewStats(): GatewayResponse {
    if (!this.securityReview) return json(501, { error: 'security-review module not registered' });
    return json(200, { stats: this.securityReview.stats() });
  }

  // ---- Security Automation handlers --------------------------------------

  private secautoRules(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    return json(200, { rules: this.securityAutomation.rules() });
  }

  private secautoRulesUpsert(req: GatewayRequest): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.event !== 'string' || typeof b.severity !== 'string' || typeof b.title !== 'string' || typeof b.key !== 'string')
      return json(400, { error: 'fields "id", "event", "severity", "title", "key" are required' });
    this.securityAutomation.upsertRule({
      id: b.id, event: b.event, severity: b.severity as never, title: b.title, key: b.key,
      ...(typeof b.closeOn === 'string' ? { closeOn: b.closeOn } : {}),
      ...(typeof b.closeKey === 'string' ? { closeKey: b.closeKey } : {}),
      ...(typeof b.banActorsFrom === 'string' ? { banActorsFrom: b.banActorsFrom } : {}),
      ...(typeof b.banOriginsFrom === 'string' ? { banOriginsFrom: b.banOriginsFrom } : {}),
      ...(typeof b.riskSignalFor === 'string' ? { riskSignalFor: b.riskSignalFor } : {}),
      ...(typeof b.riskType === 'string' ? { riskType: b.riskType } : {}),
    });
    return json(200, { rules: this.securityAutomation.rules() });
  }

  private secautoCorrelations(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    return json(200, { correlations: this.securityAutomation.correlations(), open: this.securityAutomation.correlatedOpenCount() });
  }

  private secautoPosture(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    return json(200, {
      correlations: this.securityAutomation.correlations(),
      openCorrelations: this.securityAutomation.correlatedOpenCount(),
      rules: this.securityAutomation.rules().length,
      huntsRunning: this.securityAutomation.huntsRunning(),
      huntConfig: this.securityAutomation.huntConfig(),
      sweeps: this.securityAutomation.huntSweeps().length,
    });
  }

  private secautoHunts(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    return json(200, { sweeps: this.securityAutomation.huntSweeps() });
  }

  private async secautoHuntsRun(): Promise<GatewayResponse> {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    const result = await this.securityAutomation.runHuntSweep();
    return json(200, { result });
  }

  private secautoHuntsSchedule(req: GatewayRequest): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    const b = this.asObject(req.body);
    const config = this.securityAutomation.configureHunts({
      intervalMs: typeof b.intervalMs === 'number' ? b.intervalMs : 0,
      ...(Array.isArray(b.playbooks) ? { playbooks: b.playbooks as string[] } : {}),
      ...(typeof b.sinceMs === 'number' ? { sinceMs: b.sinceMs } : {}),
    });
    return json(200, { config });
  }

  private secautoComplianceReport(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    return json(200, { report: this.securityAutomation.buildComplianceReport() });
  }

  private secautoComplianceExport(): GatewayResponse {
    if (!this.securityAutomation) return json(501, { error: 'security-automation module not registered' });
    const format = (this.asObject({}).format ?? 'json');
    const report = this.securityAutomation.buildComplianceReport();
    if (format === 'markdown') {
      return { status: 200, body: this.securityAutomation.compliance.toMarkdown(report), contentType: 'text/markdown' };
    }
    return { status: 200, body: this.securityAutomation.compliance.toJson(report), contentType: 'application/json' };
  }

  // ---- Data Loss Prevention handlers -------------------------------------

  private dlpRules(): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    return json(200, { rules: this.dlp.rules() });
  }

  private dlpRulesUpsert(req: GatewayRequest): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.dataType !== 'string' || !Array.isArray(b.patterns) || typeof b.action !== 'string')
      return json(400, { error: 'fields "id", "name", "dataType", "patterns", "action" are required' });
    this.dlp.upsertRule({
      id: b.id, name: b.name, dataType: b.dataType as never, patterns: b.patterns as string[], action: b.action as never,
      ...(typeof b.minEntropy === 'number' ? { minEntropy: b.minEntropy } : {}),
      ...(Array.isArray(b.channels) ? { channels: b.channels as never } : {}),
      ...(typeof b.threshold === 'number' ? { threshold: b.threshold } : {}),
      ...(typeof b.redactionMask === 'string' ? { redactionMask: b.redactionMask } : {}),
      ...(Array.isArray(b.notifyTo) ? { notifyTo: b.notifyTo as string[] } : {}),
    });
    return json(200, { rules: this.dlp.rules() });
  }

  private dlpScan(req: GatewayRequest): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.content !== 'string' || typeof b.channel !== 'string')
      return json(400, { error: 'fields "content" and "channel" are required' });
    const result = this.dlp.scan({
      content: b.content, channel: b.channel as never,
      ...(typeof b.actor === 'string' ? { actor: b.actor } : {}),
      ...(typeof b.destination === 'string' ? { destination: b.destination } : {}),
    });
    return json(200, result);
  }

  private dlpIncidents(req: GatewayRequest): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    const incidents = this.dlp.incidents({
      ...(req.query.dataType ? { dataType: req.query.dataType as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.channel ? { channel: req.query.channel as never } : {}),
    });
    return json(200, { incidents, count: incidents.length });
  }

  private dlpIncidentsUpdate(req: GatewayRequest): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const incident = this.dlp.updateIncident(b.id, b.status as never);
    return incident ? json(200, { incident }) : json(404, { error: 'incident not found' });
  }

  private dlpStats(): GatewayResponse {
    if (!this.dlp) return json(501, { error: 'dlp module not registered' });
    return json(200, { stats: this.dlp.stats() });
  }

  // ---- Post-Quantum Readiness handlers ------------------------------------

  private pqcAlgorithms(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { algorithms: this.pqc.algorithms({
      ...(req.query.purpose ? { purpose: req.query.purpose as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    }) });
  }

  private pqcDeprecate(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const algorithm = this.pqc.deprecate(b.id as never);
    return algorithm ? json(200, { algorithm }) : json(404, { error: 'algorithm not found' });
  }

  private pqcKeysGenerate(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.algorithm !== 'string' || typeof b.purpose !== 'string')
      return json(400, { error: 'fields "algorithm" and "purpose" are required' });
    try {
      const key = this.pqc.generateKey({
        algorithm: b.algorithm as never, purpose: b.purpose as never,
        ...(typeof b.hybridWith === 'string' ? { hybridWith: b.hybridWith as never } : {}),
      });
      return json(201, { key });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private pqcKeysList(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { keys: this.pqc.keys({
      ...(req.query.purpose ? { purpose: req.query.purpose as never } : {}),
      ...(req.query.hybrid === '1' ? { hybrid: true } : {}),
    }) });
  }

  private pqcKeysPublic(): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { keys: this.pqc.exportPublicKeys() });
  }

  private pqcSign(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.workload !== 'string' || typeof b.algorithm !== 'string' || typeof b.payload !== 'string' || typeof b.privateKey !== 'string')
      return json(400, { error: 'fields "workload", "algorithm", "payload", "privateKey" are required' });
    try {
      const envelope = this.pqc.sign({ workload: b.workload, algorithm: b.algorithm as never, payload: b.payload, privateKey: b.privateKey });
      return json(201, { envelope });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private pqcVerify(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.envelope !== 'object' || b.envelope === null || typeof b.payload !== 'string' || typeof b.publicKey !== 'string')
      return json(400, { error: 'fields "envelope", "payload", "publicKey" are required' });
    const result = this.pqc.verifyEnvelope(b.envelope as never, b.payload, b.publicKey);
    return json(200, { result });
  }

  private pqcSignatures(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { signatures: this.pqc.signatures({
      ...(req.query.workload ? { workload: req.query.workload } : {}),
      ...(req.query.hybrid === '1' ? { hybrid: true } : {}),
    }) });
  }

  private pqcPhaseAdvance(req: GatewayRequest): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    const b = this.asObject(req.body);
    const workloads = Array.isArray(b.workloads) ? b.workloads as string[] : [];
    try {
      const phase = this.pqc.advancePhase(workloads, b.force === true);
      return json(200, { phase, migration: this.pqc.migrationHistory() });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private pqcMigration(): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { phase: this.pqc.phase(), migration: this.pqc.migrationHistory(), policy: this.pqc.policy(), pendingDeprecations: this.pqc.pendingDeprecations() });
  }

  private pqcStats(): GatewayResponse {
    if (!this.pqc) return json(501, { error: 'pqc module not registered' });
    return json(200, { stats: this.pqc.stats() });
  }

  private principalUsername(req: GatewayRequest): string | undefined {
    return req.principal?.username;
  }

  private cloudStats(): GatewayResponse {
    if (!this.cloud) return json(501, { error: 'cloud module not registered' });
    return json(200, { stats: this.cloud.stats() });
  }

  // --- PRX — CDN Provider ------------------------------------------------

  private cdnNodesRegister(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.region !== 'string' || typeof b.country !== 'string')
      return json(400, { error: 'fields "name", "region", and "country" are required' });
    return json(201, { node: this.cdn.registerEdgeNode({ name: b.name, region: b.region, country: b.country, ...(typeof b.capacityRps === 'number' ? { capacityRps: b.capacityRps } : {}) }) });
  }

  private cdnNodesList(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const nodes = this.cdn.listEdgeNodes(req.query.status as never);
    return json(200, { nodes, count: nodes.length });
  }

  private cdnZonesCreate(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.domain !== 'string' || typeof b.origin !== 'string')
      return json(400, { error: 'fields "domain" and "origin" are required' });
    return json(201, { zone: this.cdn.createZone({
      domain: b.domain, origin: b.origin,
      ...(typeof b.originShield === 'boolean' ? { originShield: b.originShield } : {}),
      ...(typeof b.tlsEnabled === 'boolean' ? { tlsEnabled: b.tlsEnabled } : {}),
      ...(typeof b.defaultTtlSec === 'number' ? { defaultTtlSec: b.defaultTtlSec } : {}),
    }) });
  }

  private cdnZonesList(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const zones = this.cdn.listZones(req.query.status as never);
    return json(200, { zones, count: zones.length });
  }

  private cdnZoneGet(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const zone = req.query.domain ? this.cdn.getZoneByDomain(req.query.domain) : req.query.id ? this.cdn.getZone(req.query.id) : undefined;
    return zone ? json(200, { zone }) : json(404, { error: 'zone not found' });
  }

  private async cdnAssetsStore(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.zoneId !== 'string' || typeof b.path !== 'string' || typeof b.contentType !== 'string' || typeof b.sizeBytes !== 'number')
      return json(400, { error: 'fields "zoneId", "path", "contentType", and "sizeBytes" are required' });
    const asset = await this.cdn.storeAsset({
      zoneId: b.zoneId, path: b.path, contentType: b.contentType, sizeBytes: b.sizeBytes,
      ...(typeof b.ttlSec === 'number' ? { ttlSec: b.ttlSec } : {}),
    });
    return json(201, { asset });
  }

  private cdnAssetsList(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const assets = this.cdn.listAssets(req.query.zoneId);
    return json(200, { assets, count: assets.length });
  }

  private cdnLookup(req: GatewayRequest): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    if (!req.query.zoneId || !req.query.path) return json(400, { error: 'query parameters "zoneId" and "path" are required' });
    const result = this.cdn.lookup(req.query.zoneId, req.query.path);
    return json(200, { outcome: result.outcome, asset: result.asset ?? undefined });
  }

  private async cdnPurge(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.zoneId !== 'string') return json(400, { error: 'field "zoneId" is required' });
    const result = await this.cdn.purge(b.zoneId, {
      ...(typeof b.path === 'string' ? { path: b.path } : {}),
      ...(typeof b.prefix === 'string' ? { prefix: b.prefix } : {}),
      ...(b.all === true ? { all: true } : {}),
    });
    return json(200, result);
  }

  private cdnStats(): GatewayResponse {
    if (!this.cdn) return json(501, { error: 'cdn module not registered' });
    return json(200, { stats: this.cdn.stats() });
  }

  // --- PRX — Email Provider ----------------------------------------------

  private emailDomainsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.domain !== 'string') return json(400, { error: 'field "domain" is required' });
    return json(201, { domain: this.email.registerDomain({
      domain: b.domain,
      ...(Array.isArray(b.mxHosts) ? { mxHosts: b.mxHosts.map(String) } : {}),
      ...(typeof b.spfRecord === 'string' ? { spfRecord: b.spfRecord } : {}),
      ...(typeof b.dkimSelector === 'string' ? { dkimSelector: b.dkimSelector } : {}),
      ...(typeof b.dmarcPolicy === 'string' ? { dmarcPolicy: b.dmarcPolicy as never } : {}),
    }) });
  }

  private emailDomainsList(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const domains = this.email.listDomains(req.query.verified === 'true');
    return json(200, { domains, count: domains.length });
  }

  private emailDomainsVerify(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const domain = this.email.verifyDomain(b.id);
    return domain ? json(200, { domain }) : json(404, { error: 'domain not found' });
  }

  private emailDomainsDns(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    if (!req.query.id) return json(400, { error: 'query parameter "id" is required' });
    try {
      return json(200, { records: this.email.dnsRecords(req.query.id) });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  private emailMailboxesCreate(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.domainId !== 'string' || typeof b.address !== 'string')
      return json(400, { error: 'fields "domainId" and "address" are required' });
    return json(201, { mailbox: this.email.createMailbox({
      domainId: b.domainId, address: b.address,
      ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
      ...(typeof b.quotaMb === 'number' ? { quotaMb: b.quotaMb } : {}),
    }) });
  }

  private emailMailboxesList(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const mailboxes = this.email.listMailboxes(req.query.domainId);
    return json(200, { mailboxes, count: mailboxes.length });
  }

  private async emailSend(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.from !== 'string' || !Array.isArray(b.to) || typeof b.subject !== 'string' || typeof b.body !== 'string')
      return json(400, { error: 'fields "from", "to" (array), "subject", and "body" are required' });
    try {
      const message = await this.email.send({ from: b.from, to: b.to.map(String), subject: b.subject, body: b.body });
      return json(201, { message });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private emailMessagesList(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const messages = this.email.listMessages(req.query.status as never);
    return json(200, { messages, count: messages.length });
  }

  private async emailReceive(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.to !== 'string' || typeof b.from !== 'string' || typeof b.subject !== 'string' || typeof b.body !== 'string')
      return json(400, { error: 'fields "to", "from", "subject", and "body" are required' });
    try {
      const message = await this.email.receive({ to: b.to, from: b.from, subject: b.subject, body: b.body });
      return json(201, { message });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private emailInboxList(req: GatewayRequest): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    const messages = this.email.listInbound(req.query.mailboxId, req.query.status as never);
    return json(200, { messages, count: messages.length });
  }

  private emailStats(): GatewayResponse {
    if (!this.email) return json(501, { error: 'email module not registered' });
    return json(200, { stats: this.email.stats() });
  }

  // --- PRX — RIR Member (IPAM + ASN) -------------------------------------

  private async ipamBlocksAllocate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cidr !== 'string' || typeof b.rir !== 'string')
      return json(400, { error: 'fields "cidr" and "rir" (AFRINIC/APNIC/ARIN/RIPE/LACNIC) are required' });
    try {
      const block = await this.ipam.allocateBlock({
        cidr: b.cidr, rir: b.rir as never,
        ...(typeof b.purpose === 'string' ? { purpose: b.purpose } : {}),
        ...(typeof b.parentId === 'string' ? { parentId: b.parentId } : {}),
      });
      return json(201, { block });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private ipamBlocksList(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const blocks = this.ipam.listBlocks({
      ...(req.query.family ? { family: req.query.family as never } : {}),
      ...(req.query.rir ? { rir: req.query.rir as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { blocks, count: blocks.length });
  }

  private ipamBlocksSplit(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.blockId !== 'string' || typeof b.newPrefix !== 'number')
      return json(400, { error: 'fields "blockId" and "newPrefix" are required' });
    try {
      const children = this.ipam.splitBlock(b.blockId, b.newPrefix);
      return json(201, { children, count: children.length });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private ipamBlocksAddresses(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    if (!req.query.blockId) return json(400, { error: 'query parameter "blockId" is required' });
    const addresses = this.ipam.addressesInBlock(req.query.blockId, req.query.limit ? Number(req.query.limit) : 1000);
    return json(200, { addresses, count: addresses.length });
  }

  private async ipamAddressesRegister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.blockId !== 'string' || typeof b.address !== 'string')
      return json(400, { error: 'fields "blockId" and "address" are required' });
    try {
      const entry = await this.ipam.registerAddress({
        blockId: b.blockId, address: b.address,
        ...(typeof b.assignedTo === 'string' ? { assignedTo: b.assignedTo } : {}),
      });
      return json(201, { entry });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private ipamAddressesList(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const entries = this.ipam.listAddresses(req.query.blockId);
    return json(200, { entries, count: entries.length });
  }

  private ipamAsnsHold(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.asn !== 'number' || typeof b.rir !== 'string')
      return json(400, { error: 'fields "asn" (number) and "rir" are required' });
    try {
      const holding = this.ipam.holdAsn({
        asn: b.asn, rir: b.rir as never,
        ...(typeof b.announcementType === 'string' ? { announcementType: b.announcementType as never } : {}),
      });
      return json(201, { asn: holding });
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private ipamAsnsList(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const asns = this.ipam.listAsns(req.query.status as never);
    return json(200, { asns, count: asns.length });
  }

  private ipamAnnounce(req: GatewayRequest): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.blockId !== 'string' || typeof b.asnId !== 'string')
      return json(400, { error: 'fields "blockId" and "asnId" are required' });
    try {
      const record = this.ipam.announce({ blockId: b.blockId, asnId: b.asnId });
      return json(201, record);
    } catch (err) {
      return json(400, { error: (err as Error).message });
    }
  }

  private ipamAnnouncements(): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    return json(200, { announcements: this.ipam.listAnnouncements() });
  }

  private ipamStats(): GatewayResponse {
    if (!this.ipam) return json(501, { error: 'ipam module not registered' });
    const stats = this.ipam.stats();
    return json(200, {
      stats: {
        ...stats,
        totalAddresses: stats.totalAddresses.toString(),
        allocatedAddresses: stats.allocatedAddresses.toString(),
      },
    });
  }

  // --- Phase 7 — MAZA marketplace ----------------------------------------

  private marketplaceStorefrontsRegister(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.vendorId !== 'string' || typeof b.name !== 'string')
      return json(400, { error: 'fields "vendorId" and "name" are required' });
    return json(201, { storefront: this.marketplace.registerStorefront({
      vendorId: b.vendorId, name: b.name,
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
      ...(Array.isArray(b.categories) ? { categories: b.categories.map(String) } : {}),
    }) });
  }

  private marketplaceStorefrontsList(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const storefronts = this.marketplace.listStorefronts({
      ...(req.query.vendorId ? { vendorId: req.query.vendorId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { storefronts, count: storefronts.length });
  }

  private marketplaceStorefrontsStatus(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const storefront = this.marketplace.setStorefrontStatus(b.id, b.status as never);
    return storefront ? json(200, { storefront }) : json(404, { error: 'storefront not found' });
  }

  private async marketplaceListingsCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.storefrontId !== 'string' || typeof b.title !== 'string' || typeof b.category !== 'string' || typeof b.priceMinor !== 'number')
      return json(400, { error: 'fields "storefrontId", "title", "category", and "priceMinor" are required' });
    const listing = await this.marketplace.createListing({
      storefrontId: b.storefrontId, title: b.title, category: b.category, priceMinor: b.priceMinor,
      ...(typeof b.currency === 'string' ? { currency: b.currency } : {}),
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
      ...(typeof b.stock === 'number' ? { stock: b.stock } : {}),
    });
    return json(201, { listing });
  }

  private marketplaceListingsList(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const listings = this.marketplace.listListings({
      ...(req.query.storefrontId ? { storefrontId: req.query.storefrontId } : {}),
      ...(req.query.category ? { category: req.query.category } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
      ...(req.query.q ? { query: req.query.q } : {}),
      ...(req.query.maxPrice ? { maxPrice: Number(req.query.maxPrice) } : {}),
      ...(req.query.minRating ? { minRating: Number(req.query.minRating) } : {}),
    });
    return json(200, { listings, count: listings.length });
  }

  private async marketplaceListingsStatus(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.status !== 'string')
      return json(400, { error: 'fields "id" and "status" are required' });
    const listing = await this.marketplace.setListingStatus(b.id, b.status as never);
    return listing ? json(200, { listing }) : json(404, { error: 'listing not found' });
  }

  private marketplaceListingsStock(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.delta !== 'number')
      return json(400, { error: 'fields "id" and "delta" are required' });
    const listing = this.marketplace.adjustStock(b.id, b.delta);
    return listing ? json(200, { listing }) : json(404, { error: 'listing not found' });
  }

  private async marketplaceReviewsAdd(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.listingId !== 'string' || typeof b.reviewerId !== 'string' || typeof b.rating !== 'number')
      return json(400, { error: 'fields "listingId", "reviewerId", and "rating" (1..5) are required' });
    const review = await this.marketplace.addReview({
      listingId: b.listingId, reviewerId: b.reviewerId, rating: b.rating,
      ...(typeof b.comment === 'string' ? { comment: b.comment } : {}),
    });
    return json(201, { review });
  }

  private marketplaceReviewsList(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const reviews = req.query.listingId
      ? this.marketplace.reviewsForListing(req.query.listingId)
      : req.query.storefrontId
        ? this.marketplace.reviewsForStorefront(req.query.storefrontId)
        : [];
    return json(200, { reviews, count: reviews.length });
  }

  private async marketplacePurchases(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.listingId !== 'string' || typeof b.buyerId !== 'string')
      return json(400, { error: 'fields "listingId" and "buyerId" are required' });
    const result = await this.marketplace.purchase(b.listingId, b.buyerId);
    return result.ok ? json(200, { orderId: result.orderId }) : json(400, { error: result.error });
  }

  private marketplaceCategories(): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    return json(200, { categories: this.marketplace.categories() });
  }

  private marketplaceStats(): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    return json(200, { stats: this.marketplace.stats(), analytics: this.marketplace.orderAnalytics() });
  }

  // ---- MAZA purchase flows handlers --------------------------------------

  private marketplaceCartGetOrCreate(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.buyerId !== 'string') return json(400, { error: 'field "buyerId" is required' });
    const cart = this.marketplace.getCartForBuyer(b.buyerId) ?? this.marketplace.createCart(b.buyerId);
    return json(200, { cart });
  }

  private marketplaceCartGet(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const cart = this.marketplace.getCart(req.query.id ?? '');
    return cart ? json(200, { cart }) : json(404, { error: 'cart not found' });
  }

  private async marketplaceCartAdd(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cartId !== 'string' || typeof b.listingId !== 'string')
      return json(400, { error: 'fields "cartId" and "listingId" are required' });
    try {
      const cart = await this.marketplace.addToCart(b.cartId, b.listingId, typeof b.quantity === 'number' ? b.quantity : 1);
      return json(200, { cart });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private marketplaceCartRemove(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cartId !== 'string' || typeof b.listingId !== 'string')
      return json(400, { error: 'fields "cartId" and "listingId" are required' });
    return json(200, { cart: this.marketplace.removeFromCart(b.cartId, b.listingId) });
  }

  private marketplaceCartClear(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cartId !== 'string') return json(400, { error: 'field "cartId" is required' });
    return json(200, { cart: this.marketplace.clearCart(b.cartId) });
  }

  private async marketplaceCheckout(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.cartId !== 'string') return json(400, { error: 'field "cartId" is required' });
    try {
      const order = await this.marketplace.checkout(b.cartId);
      return json(200, { order });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private marketplaceOrdersList(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const orders = this.marketplace.listOrders({
      ...(req.query.buyerId ? { buyerId: req.query.buyerId } : {}),
      ...(req.query.vendorId ? { vendorId: req.query.vendorId } : {}),
      ...(req.query.status ? { status: req.query.status as never } : {}),
    });
    return json(200, { orders, count: orders.length });
  }

  private marketplaceOrderGet(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const order = this.marketplace.getOrder(req.query.id ?? '');
    return order ? json(200, { order }) : json(404, { error: 'order not found' });
  }

  private async marketplaceOrderCancel(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.orderId !== 'string' || typeof b.buyerId !== 'string')
      return json(400, { error: 'fields "orderId" and "buyerId" are required' });
    try {
      const order = await this.marketplace.cancelOrder(b.orderId, b.buyerId);
      return json(200, { order });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async marketplaceOrderRefund(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.orderId !== 'string') return json(400, { error: 'field "orderId" is required' });
    try {
      const order = await this.marketplace.refundOrder(b.orderId);
      return json(200, { order });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private marketplacePayoutsList(req: GatewayRequest): GatewayResponse {
    if (!this.marketplace) return json(501, { error: 'marketplace module not registered' });
    const payouts = this.marketplace.listPayouts(
      req.query.vendorId,
      req.query.status ? (req.query.status as never) : undefined,
    );
    return json(200, { payouts, count: payouts.length });
  }

  private async backupsList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.disasterRecovery) return json(501, { error: 'disaster-recovery module not registered' });
    const schedulers = this.disasterRecovery.listSchedulers();
    const snapshots = await this.disasterRecovery.listSnapshots(req.query.namespace);
    return json(200, { schedulers, snapshots: snapshots.map((s) => ({ id: s.id, namespace: s.namespace, entryCount: s.entryCount, contentHash: s.contentHash, createdAt: s.createdAt, createdBy: s.createdBy })), count: snapshots.length });
  }

  private async backupCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.disasterRecovery) return json(501, { error: 'disaster-recovery module not registered' });
    const b = this.asObject(req.body);
    const namespaces = Array.isArray(b.namespaces) ? (b.namespaces as string[]) : [];
    if (namespaces.length === 0) return json(400, { error: 'field "namespaces" (string[]) is required' });
    const result = await this.disasterRecovery.runBackupCycle({
      namespaces,
      intervalMs: 0,
      createdBy: req.principal!.userId,
      notifyRecipient: req.principal!.userId,
    });
    return json(201, { result });
  }

  private async backupSchedule(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.disasterRecovery) return json(501, { error: 'disaster-recovery module not registered' });
    const b = this.asObject(req.body);
    const namespaces = Array.isArray(b.namespaces) ? (b.namespaces as string[]) : [];
    const intervalMs = typeof b.intervalMs === 'number' ? b.intervalMs : 0;
    if (namespaces.length === 0 || intervalMs <= 0) return json(400, { error: 'fields "namespaces" (string[]) and "intervalMs" (>0) are required' });
    const handle = await this.disasterRecovery.startScheduler({
      namespaces,
      intervalMs,
      ...(typeof b.retention === 'number' ? { retention: b.retention } : {}),
      createdBy: req.principal!.userId,
      notifyRecipient: req.principal!.userId,
    });
    return json(201, { scheduler: { id: handle.id, running: handle.running, config: handle.config } });
  }

  // --- universal AI tool intelligence -------------------------------------

  private async toolsList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const tools = await this.tools.list(req.query.category, req.query.status as ToolStatus | undefined);
    return json(200, { tools, count: tools.length });
  }

  private async toolsForCapability(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const cap = req.query.capability;
    if (!cap) return json(400, { error: 'query parameter "capability" is required' });
    const ranked = await this.tools.rankForCapability(cap);
    return json(200, { capability: cap, ranked });
  }

  private async toolRegister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.canonicalName !== 'string' || typeof b.provider !== 'string') return json(400, { error: 'fields "canonicalName" and "provider" are required' });
    const tool = await this.tools.register({
      canonicalName: b.canonicalName,
      provider: b.provider,
      version: typeof b.version === 'string' ? b.version : '1.0.0',
      category: typeof b.category === 'string' ? b.category : 'general',
      capabilities: Array.isArray(b.capabilities) ? b.capabilities as string[] : [],
      protocol: typeof b.protocol === 'string' ? b.protocol : 'REST',
      riskClass: typeof b.riskClass === 'string' ? b.riskClass as 'R0' : 'R0',
      ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
      ...(typeof b.status === 'string' ? { status: b.status as 'ACTIVE' } : {}),
    });
    return json(201, { tool });
  }

  private async toolsSync(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    // Pull the default agent's tool surface and register every tool in the
    // governance registry with its catalog risk/privacy classification.
    const tools = this.agents.getAgent('main').getTools();
    const result = await this.tools.syncAgentTools(tools, { provider: 'agent-runtime', version: '1.0.0' });
    return json(200, { synced: result.synced.length, created: result.created, updated: result.updated });
  }

  private realtimeStats(req: GatewayRequest): GatewayResponse {
    if (!this.realtime) return json(501, { error: 'realtime module not registered' });
    return json(200, this.realtime.stats());
  }

  private async governanceAlerts(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const result = await this.tools.evaluateSlaRules();
    return json(200, result);
  }

  private async toolsGovernanceStats(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const stats = await this.tools.governanceStats();
    return json(200, stats);
  }

  private async toolGet(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const tool = await this.tools.get(id);
    if (!tool) return json(404, { error: 'tool not found' });
    return json(200, { tool });
  }

  private async toolInvoke(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const result = await this.tools.invoke(b.id, b.input, req.principal, typeof b.approvalRequestId === 'string' ? b.approvalRequestId : undefined);
    // 202 when human approval is required.
    const status = result.status === 'pending_approval' ? 202 : result.status === 'success' ? 200 : 500;
    return json(status, { result });
  }

  private toolRequestApproval(req: GatewayRequest): GatewayResponse {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.action !== 'string') return json(400, { error: 'fields "id" and "action" are required' });
    const req2 = this.tools.requestApproval(b.id, req.principal?.userId ?? 'anonymous', b.action, typeof b.reason === 'string' ? b.reason : undefined);
    return json(202, { approvalRequest: req2 });
  }

  private toolApprove(req: GatewayRequest): GatewayResponse {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || (b.decision !== 'approved' && b.decision !== 'denied')) return json(400, { error: 'fields "id" and "decision" (approved|denied) are required' });
    try {
      const decided = this.tools.decideApproval(b.id, b.decision, req.principal?.userId ?? 'admin');
      return json(200, { approvalRequest: decided });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  private approvalsList(req: GatewayRequest): GatewayResponse {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    // Backward compatible: no filter → pending only. `?status=all` (or any
    // explicit status) returns the full history / filtered history.
    const status = req.query.status;
    if (!status || status === 'pending') return json(200, { approvals: this.tools.listPendingApprovals() });
    if (status === 'all') return json(200, { approvals: this.tools.listApprovals() });
    const valid = ['pending', 'approved', 'denied', 'expired'].includes(status);
    if (!valid) return json(400, { error: 'query "status" must be pending|approved|denied|expired|all' });
    return json(200, { approvals: this.tools.listApprovals(status as 'pending' | 'approved' | 'denied' | 'expired') });
  }

  // --- JQ-CIP creator identity & provenance (public, read-only) -----------

  private identityInfo(): GatewayResponse {
    if (!this.provenance) return json(501, { error: 'provenance module not registered' });
    return json(200, {
      ...this.provenance.identity(),
      self: {
        who_created_you: this.provenance.whoCreatedYou(),
        what_are_you: this.provenance.whatAreYou(),
        how_do_you_know: this.provenance.howDoYouKnow(),
      },
    });
  }

  private identityCreator(): GatewayResponse {
    if (!this.provenance) return json(501, { error: 'provenance module not registered' });
    return json(200, { creator: this.provenance.creator() });
  }

  private identityRoot(): GatewayResponse {
    if (!this.provenance) return json(501, { error: 'provenance module not registered' });
    return json(200, { root: this.provenance.root() });
  }

  private async identityProvenance(): Promise<GatewayResponse> {
    if (!this.provenance) return json(501, { error: 'provenance module not registered' });
    return json(200, { events: await this.provenance.events() });
  }

  private async identityVerify(): Promise<GatewayResponse> {
    if (!this.provenance) return json(501, { error: 'provenance module not registered' });
    return json(200, await this.provenance.verify());
  }

  // --- commerce (product packaging, plans, subscriptions, entitlements) ----

  private async plansList(): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    return json(200, { plans: await this.commerce.listPlans() });
  }

  private async subscribe(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.planSlug !== 'string') return json(400, { error: 'field "planSlug" is required' });
    const sub = await this.commerce.subscribe(req.principal!.userId, b.planSlug, {
      ...(typeof b.currency === 'string' ? { currency: b.currency } : {}),
      ...(typeof b.seats === 'number' ? { seats: b.seats } : {}),
      ...(b.trial === true ? { trial: true } : {}),
    });
    return json(201, { subscription: sub });
  }

  private async subscriptionAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    const action = typeof b.action === 'string' ? b.action : '';
    if (!id || !action) return json(400, { error: 'fields "id" and "action" are required' });
    try {
      if (action === 'upgrade') return json(200, { subscription: await this.commerce.upgrade(id, String(b.planSlug)) });
      if (action === 'downgrade') return json(200, { subscription: await this.commerce.downgrade(id, String(b.planSlug), { scheduleAtPeriodEnd: b.scheduleAtPeriodEnd === true }) });
      if (action === 'cancel') return json(200, { subscription: await this.commerce.cancel(id, { immediate: b.immediate === true }) });
      if (action === 'pause') return json(200, { subscription: await this.commerce.pause(id) });
      if (action === 'resume') return json(200, { subscription: await this.commerce.resume(id) });
      return json(400, { error: 'unknown action (upgrade|downgrade|cancel|pause|resume)' });
    } catch (err) {
      return json(404, { error: (err as Error).message });
    }
  }

  private async entitlementCheck(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const customerId = req.query.customerId ?? req.principal!.userId;
    const feature = req.query.feature;
    if (!feature) return json(400, { error: 'query parameter "feature" is required' });
    return json(200, { decision: await this.commerce.check(customerId, feature) });
  }

  private async meterUsage(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const b = this.asObject(req.body);
    const customerId = typeof b.customerId === 'string' ? b.customerId : req.principal!.userId;
    if (typeof b.metric !== 'string') return json(400, { error: 'field "metric" is required' });
    const res = await this.commerce.meterUsage(customerId, b.metric, typeof b.qty === 'number' ? b.qty : 1);
    return json(200, res);
  }

  private async creditsBalance(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const customerId = req.query.customerId ?? req.principal!.userId;
    return json(200, { balance: await this.commerce.creditBalance(customerId) });
  }

  private async grantCredits(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.customerId !== 'string' || typeof b.amount !== 'number') return json(400, { error: 'fields "customerId" and "amount" are required' });
    const batch = await this.commerce.grantCredits(b.customerId, b.amount, typeof b.source === 'string' ? b.source : 'grant');
    return json(201, { batch });
  }

  private async commerceAnalytics(): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    return json(200, await this.commerce.analytics());
  }

  private async marketplacePurchase(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.commerce) return json(501, { error: 'commerce module not registered' });
    const b = this.asObject(req.body);
    if (!b.item || typeof b.item !== 'object') return json(400, { error: 'field "item" (marketplace item) is required' });
    const result = await this.commerce.purchase(req.principal!.userId, b.item as Parameters<CommerceModule['purchase']>[1], { ...(typeof b.currency === 'string' ? { currency: b.currency } : {}) });
    return json(201, result);
  }

  // --- organizations (multi-tenancy) --------------------------------------

  private async orgsList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    const mine = await this.organizations.organizationsForUser(req.principal!.userId);
    return json(200, { organizations: mine });
  }

  private async orgCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string') return json(400, { error: 'field "name" is required' });
    const org = await this.organizations.createOrganization(b.name, req.principal!.userId, typeof b.slug === 'string' ? b.slug : undefined);
    return json(201, { organization: org });
  }

  private async orgGet(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const org = await this.organizations.getOrganization(id);
    if (!org) return json(404, { error: 'organization not found' });
    await this.organizations.requireRole(id, req.principal!.userId, 'guest');
    return json(200, { organization: org });
  }

  private async orgAction(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    const b = this.asObject(req.body);
    const orgId = typeof b.id === 'string' ? b.id : '';
    const me = req.principal!.userId;
    if (!orgId || typeof b.action !== 'string') return json(400, { error: 'fields "id" and "action" are required' });
    try {
      switch (b.action) {
        case 'addMember': {
          await this.organizations.requireRole(orgId, me, 'admin');
          return json(200, { membership: await this.organizations.addMember(orgId, String(b.userId), (b.role as 'member') ?? 'member') });
        }
        case 'removeMember': {
          await this.organizations.requireRole(orgId, me, 'admin');
          return json(200, { removed: await this.organizations.removeMember(orgId, String(b.userId)) });
        }
        case 'setRole': {
          await this.organizations.requireRole(orgId, me, 'owner');
          return json(200, { membership: await this.organizations.setRole(orgId, String(b.userId), b.role as 'member') });
        }
        case 'invite': {
          await this.organizations.requireRole(orgId, me, 'admin');
          return json(201, { invitation: await this.organizations.invite(orgId, String(b.target), (b.role as 'member') ?? 'member', me) });
        }
        case 'accept': {
          return json(200, { membership: await this.organizations.acceptInvitation(String(b.token), me) });
        }
        case 'decline': {
          return json(200, { invitation: await this.organizations.declineInvitation(String(b.token)) });
        }
        default:
          return json(400, { error: 'unknown action (addMember|removeMember|setRole|invite|accept|decline)' });
      }
    } catch (err) {
      return json(403, { error: (err as Error).message });
    }
  }

  private async orgMembers(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    await this.organizations.requireRole(id, req.principal!.userId, 'guest');
    return json(200, { members: await this.organizations.listMembers(id) });
  }

  // --- tenant-scoped data (multi-tenant isolation, PR4) -------------------

  /**
   * Resolve a tenant-scoped storage view for the caller's organization after
   * enforcing membership. Throws a 403-style error if the user is not a member,
   * which the router translates into a 403 response — guaranteeing one org can
   * never touch another org's data.
   */
  private async requireTenantScope(req: GatewayRequest, orgId: string | undefined): Promise<{ scope: TenantScope; ns: INamespace } | GatewayResponse> {
    if (!this.organizations) return json(501, { error: 'organizations module not registered' });
    if (!this.storage) return json(501, { error: 'storage module not registered' });
    if (!orgId) return json(400, { error: 'field/query "orgId" is required' });
    try {
      // Enforce membership at the org level before exposing the tenant scope.
      await this.organizations.requireRole(orgId, req.principal!.userId, 'member');
    } catch (err) {
      return json(403, { error: (err as Error).message });
    }
    const scope = this.storage.tenant(orgId);
    const ns = await scope.namespace('org.data');
    return { scope, ns };
  }

  private async orgDataGet(req: GatewayRequest): Promise<GatewayResponse> {
    const resolved = await this.requireTenantScope(req, req.query.orgId);
    if ('status' in resolved) return resolved;
    const { ns } = resolved;
    if (req.query.id) {
      const value = await ns.get(req.query.id);
      return json(200, { id: req.query.id, value });
    }
    const result = await ns.list({ ...(req.query.prefix ? { prefix: req.query.prefix } : {}), limit: req.query.limit ? Number(req.query.limit) : 1000 });
    return json(200, { keys: result.items.map((e) => e.meta.key), count: result.items.length });
  }

  private async orgDataMutate(req: GatewayRequest): Promise<GatewayResponse> {
    const b = this.asObject(req.body);
    const resolved = await this.requireTenantScope(req, typeof b.orgId === 'string' ? b.orgId : undefined);
    if ('status' in resolved) return resolved;
    const { ns } = resolved;
    const action = typeof b.action === 'string' ? b.action : '';
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id && action !== 'list') return json(400, { error: 'field "id" is required' });
    if (action === 'set') {
      await ns.set(id, b.value);
      await this.sec.audit({ actor: req.principal!.userId, action: 'org.data.set', result: 'success', resource: id, detail: { orgId: b.orgId } });
      return json(201, { ok: true, id });
    }
    if (action === 'get') {
      const value = await ns.get(id);
      return json(200, { id, value });
    }
    if (action === 'delete') {
      const deleted = await ns.delete(id);
      await this.sec.audit({ actor: req.principal!.userId, action: 'org.data.delete', result: deleted ? 'success' : 'failure', resource: id, detail: { orgId: b.orgId } });
      return json(200, { deleted });
    }
    if (action === 'list') {
      const result = await ns.list({ limit: 1000 });
      return json(200, { keys: result.items.map((e) => e.meta.key), count: result.items.length });
    }
    return json(400, { error: 'unknown action (set|get|delete|list)' });
  }

  // --- session management (restart-safe sessions, PR4) -------------------

  private async sessionsList(req: GatewayRequest): Promise<GatewayResponse> {
    // Admins may list any user's sessions; others may only see their own.
    const requested = req.query.userId;
    const userId = requested && this.sec.authorize(req.principal!, 'audit:read') ? requested : req.principal!.userId;
    const sessions = await this.sec.listSessions(userId);
    // Never expose the raw token in listings (only metadata).
    const safe = sessions.map((s) => ({ userId: s.userId, username: s.username, createdAt: s.createdAt, expiresAt: s.expiresAt, lastUsedAt: s.lastUsedAt, remoteAddress: s.remoteAddress }));
    return json(200, { sessions: safe, count: safe.length });
  }

  private async sessionRevoke(req: GatewayRequest): Promise<GatewayResponse> {
    const b = this.asObject(req.body);
    const me = req.principal!.userId;
    if (b.all === true) {
      const currentToken = this.bearer(req);
      const n = await this.sec.revokeAllUserSessions(me, currentToken);
      return json(200, { revoked: n });
    }
    if (typeof b.token !== 'string') return json(400, { error: 'field "token" (or "all": true) is required' });
    const ok = await this.sec.revokeSession(b.token);
    return ok ? json(200, { revoked: true }) : json(404, { error: 'session not found' });
  }

  // --- notifications -------------------------------------------------------

  private async notificationsList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.notifications) return json(501, { error: 'notifications module not registered' });
    const recipient = req.query.recipientId ?? req.principal!.userId;
    const items = await this.notifications.list(recipient, { unreadOnly: req.query.unread === 'true' });
    return json(200, { notifications: items, unread: await this.notifications.unreadCount(recipient) });
  }

  private async notificationRead(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.notifications) return json(501, { error: 'notifications module not registered' });
    const b = this.asObject(req.body);
    if (b.all === true) return json(200, { marked: await this.notifications.markAllRead(req.principal!.userId) });
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" (or "all": true) is required' });
    const n = await this.notifications.markRead(b.id);
    return n ? json(200, { notification: n }) : json(404, { error: 'notification not found' });
  }

  private async notify(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.notifications) return json(501, { error: 'notifications module not registered' });
    const b = this.asObject(req.body);
    const recipientId = typeof b.recipientId === 'string' ? b.recipientId : req.principal!.userId;
    if (typeof b.type !== 'string' || typeof b.title !== 'string') return json(400, { error: 'fields "type" and "title" are required' });
    const payload: Parameters<NotificationsModule['notify']>[1] = { type: b.type, title: b.title, ...(typeof b.body === 'string' ? { body: b.body } : {}) };
    if (typeof b.priority === 'string') payload.priority = b.priority as 'normal';
    const result = await this.notifications.notify(recipientId, payload);
    return json(201, result);
  }

  private async notificationPrefs(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.notifications) return json(501, { error: 'notifications module not registered' });
    return json(200, { preferences: await this.notifications.getPreferences(req.principal!.userId) });
  }

  private async notificationSetPrefs(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.notifications) return json(501, { error: 'notifications module not registered' });
    const b = this.asObject(req.body);
    if (!b.preferences || typeof b.preferences !== 'object') return json(400, { error: 'field "preferences" (object) is required' });
    return json(200, { preferences: await this.notifications.setPreferences(req.principal!.userId, b.preferences as Record<string, { enabled: boolean; channels: string[] }>) });
  }

  // --- governance: policies, compliance, feature flags, privacy ------------

  private async policiesList(): Promise<GatewayResponse> {
    if (!this.policies) return json(501, { error: 'policies module not registered' });
    return json(200, { policies: await this.policies.listPolicies(), controls: await this.policies.listControls() });
  }

  private async policyEvaluate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.policies) return json(501, { error: 'policies module not registered' });
    const b = this.asObject(req.body);
    const decision = await this.policies.decide({
      ...(typeof b.action === 'string' ? { action: b.action } : {}),
      ...(typeof b.resource === 'string' ? { resource: b.resource } : {}),
      ...(typeof b.risk === 'number' ? { risk: b.risk } : {}),
      ...(typeof b.organizationId === 'string' ? { organizationId: b.organizationId } : {}),
    });
    return json(200, { decision });
  }

  private async policyCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.policies) return json(501, { error: 'policies module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.effect !== 'string') return json(400, { error: 'fields "name" and "effect" are required' });
    const policy = await this.policies.createPolicy({
      name: b.name,
      effect: b.effect as 'allow',
      match: (b.match as { action?: string; resource?: string; riskMin?: number; organizationId?: string }) ?? {},
      priority: typeof b.priority === 'number' ? b.priority : 1,
      status: 'active',
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
    });
    return json(201, { policy });
  }

  private async complianceSummary(): Promise<GatewayResponse> {
    if (!this.policies) return json(501, { error: 'policies module not registered' });
    return json(200, { summary: await this.policies.complianceSummary() });
  }

  private async flagsList(): Promise<GatewayResponse> {
    if (!this.featureFlags) return json(501, { error: 'feature-flags module not registered' });
    return json(200, { flags: await this.featureFlags.list() });
  }

  private async flagCheck(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.featureFlags) return json(501, { error: 'feature-flags module not registered' });
    const key = req.query.key;
    if (!key) return json(400, { error: 'query parameter "key" is required' });
    return json(200, { key, enabled: await this.featureFlags.isEnabled(key, req.query.userId ?? req.principal!.userId) });
  }

  private async flagSet(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.featureFlags) return json(501, { error: 'feature-flags module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.key !== 'string') return json(400, { error: 'field "key" is required' });
    const flag = await this.featureFlags.set(b.key, b.enabled !== false, typeof b.rolloutPct === 'number' ? b.rolloutPct : 100, typeof b.description === 'string' ? b.description : undefined);
    return json(201, { flag });
  }

  private async privacyClassify(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const dataKind = req.query.dataKind;
    if (!dataKind) return json(400, { error: 'query parameter "dataKind" is required' });
    return json(200, { ...(await this.privacy.classify(dataKind)), aiRestricted: await this.privacy.isAIRestricted(dataKind) });
  }

  private async privacyConsent(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    const subjectId = typeof b.subjectId === 'string' ? b.subjectId : req.principal!.userId;
    if (typeof b.purpose !== 'string' || typeof b.status !== 'string') return json(400, { error: 'fields "purpose" and "status" are required' });
    return json(200, { consent: await this.privacy.recordConsent(subjectId, b.purpose, b.status as 'granted') });
  }

  private async privacyConsentList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { consent: await this.privacy.listConsent(req.query.subjectId ?? req.principal!.userId) });
  }

  private async privacySAR(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    const subjectId = typeof b.subjectId === 'string' ? b.subjectId : req.principal!.userId;
    if (b.type !== 'export' && b.type !== 'delete') return json(400, { error: 'field "type" (export|delete) is required' });
    const sar = await this.privacy.requestSAR(subjectId, b.type, typeof b.reason === 'string' ? b.reason : undefined);
    return json(201, { sar });
  }

  private async privacySARList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { requests: await this.privacy.listSARs(req.query.subjectId ?? req.principal!.userId) });
  }

  // ---- privacy engineering handlers --------------------------------------

  private async privacyPiaSubmit(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.title !== 'string' || typeof b.flow !== 'string' || !Array.isArray(b.dataFlows) || typeof b.assessedBy !== 'string')
      return json(400, { error: 'fields "title", "flow", "dataFlows", "assessedBy" are required' });
    try {
      const pia = await this.privacy.submitPia({
        title: b.title, flow: b.flow,
        dataFlows: b.dataFlows as never,
        assessedBy: b.assessedBy,
      });
      return json(201, { pia });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async privacyPiaList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { pias: await this.privacy.listPias(req.query.status as never) });
  }

  private async privacyPiaDecide(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || (b.decision !== 'approved' && b.decision !== 'rejected') || typeof b.approver !== 'string')
      return json(400, { error: 'fields "id", "decision" (approved|rejected), "approver" are required' });
    try {
      const pia = await this.privacy.decidePia(b.id, b.decision, b.approver, typeof b.reason === 'string' ? b.reason : undefined);
      return pia ? json(200, { pia }) : json(404, { error: 'PIA not found' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async privacyProcessingRegister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.activity !== 'string' || typeof b.controller !== 'string' || !Array.isArray(b.dataKinds) || typeof b.legalBasis !== 'string')
      return json(400, { error: 'fields "activity", "controller", "dataKinds", "legalBasis" are required' });
    try {
      const record = await this.privacy.registerProcessing({
        activity: b.activity, controller: b.controller,
        dataKinds: b.dataKinds as string[],
        purposes: Array.isArray(b.purposes) ? b.purposes as string[] : [],
        legalBasis: b.legalBasis,
        recipients: Array.isArray(b.recipients) ? b.recipients as string[] : [],
        ...(Array.isArray(b.transfers) ? { transfers: b.transfers as string[] } : {}),
        ...(typeof b.retentionDays === 'number' ? { retentionDays: b.retentionDays } : {}),
      });
      return json(201, { record });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async privacyProcessingList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { records: await this.privacy.listProcessing(req.query.controller) });
  }

  private async privacySecureDelete(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.target !== 'string' || typeof b.dataKind !== 'string' || typeof b.performedBy !== 'string')
      return json(400, { error: 'fields "target", "dataKind", "performedBy" are required' });
    try {
      const deletion = await this.privacy.secureDelete({
        target: b.target, dataKind: b.dataKind, performedBy: b.performedBy,
        ...(typeof b.method === 'string' ? { method: b.method as never } : {}),
        ...(typeof b.keyDestroyed === 'boolean' ? { keyDestroyed: b.keyDestroyed } : {}),
      });
      return json(201, { deletion });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async privacyDeletionsList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { deletions: await this.privacy.listDeletions(req.query.target) });
  }

  private async privacyMinimizeCheck(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.purpose !== 'string' || !Array.isArray(b.collected) || !Array.isArray(b.necessary))
      return json(400, { error: 'fields "purpose", "collected", "necessary" are required' });
    return json(200, { check: await this.privacy.minimizeCheck({ purpose: b.purpose, collected: b.collected as string[], necessary: b.necessary as string[] }) });
  }

  private async privacyMinimizeList(): Promise<GatewayResponse> {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { checks: await this.privacy.minimizationChecks() });
  }

  private privacyPosture(): GatewayResponse {
    if (!this.privacy) return json(501, { error: 'privacy module not registered' });
    return json(200, { posture: this.privacy.privacyPosture() });
  }

  // --- policy & governance registry ---------------------------------------

  /** Build a governance subject from the principal, org membership, and entitlements. */
  private async governanceSubject(req: GatewayRequest): Promise<{ userId: string; organizationId?: string; roles: string[]; entitlements: string[]; isAgent?: boolean; agentId?: string }> {
    const principal = req.principal!;
    const body = this.asObject(req.body);
    const orgId = typeof body.organizationId === 'string' ? body.organizationId : undefined;
    const roles = [...(principal.roles ?? [])];
    let entitlements: string[] = [];
    if (orgId && this.organizations) {
      try {
        const m = await this.organizations.getMembership(orgId, principal.userId);
        if (m) roles.push(m.role);
      } catch { /* not a member */ }
    }
    if (this.commerce) {
      try {
        const sub = await this.commerce.activeSubscription(principal.userId);
        if (sub) {
          const plan = await this.commerce.getPlan(sub.planId);
          if (plan) entitlements = Object.keys(plan.entitlements);
        }
      } catch { /* commerce optional */ }
    }
    return { userId: principal.userId, ...(orgId ? { organizationId: orgId } : {}), roles, entitlements, ...(body.isAgent === true ? { isAgent: true, agentId: typeof body.agentId === 'string' ? body.agentId : principal.userId } : {}) };
  }

  private async govList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const policies = await this.governance.listPolicies({
      ...(req.query.category ? { category: req.query.category } : {}),
      ...(req.query.scope ? { scope: req.query.scope } : {}),
      ...(req.query.organizationId ? { organizationId: req.query.organizationId } : {}),
      ...(req.query.status ? { status: req.query.status as 'active' } : {}),
    });
    return json(200, { policies });
  }

  private async govCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string' || typeof b.effect !== 'string' || typeof b.category !== 'string' || typeof b.scope !== 'string') {
      return json(400, { error: 'fields "name", "effect", "category", "scope" are required' });
    }
    const policy = await this.governance.createPolicy({
      name: b.name, effect: b.effect as 'ALLOW', category: b.category, scope: b.scope,
      ...(typeof b.action === 'string' ? { action: b.action } : {}),
      ...(typeof b.subjectType === 'string' ? { subjectType: b.subjectType } : {}),
      ...(typeof b.resourceType === 'string' ? { resourceType: b.resourceType } : {}),
      ...(b.conditions ? { conditions: b.conditions as Record<string, unknown> as never } : {}),
      ...(typeof b.priority === 'number' ? { priority: b.priority } : {}),
      ...(typeof b.organizationId === 'string' ? { organizationId: b.organizationId } : {}),
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
    }, req.principal!.userId);
    return json(201, { policy });
  }

  private async govGet(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const policy = await this.governance.getPolicy(id);
    return policy ? json(200, { policy }) : json(404, { error: 'policy not found' });
  }

  private async govUpdate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return json(400, { error: 'field "id" is required' });
    if (b.action === 'deactivate') return json(200, { policy: await this.governance.deactivatePolicy(id, req.principal!.userId) });
    const changes: Record<string, unknown> = { ...b };
    delete changes.id; delete changes.action;
    return json(200, { policy: await this.governance.updatePolicy(id, changes as never, req.principal!.userId) });
  }

  private async govEvaluate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.action !== 'string') return json(400, { error: 'field "action" is required' });
    const subject = await this.governanceSubject(req);
    const result = await this.governance.evaluate(subject, b.action, {
      ...(typeof b.resource === 'string' ? { resource: b.resource } : {}),
      ...(typeof b.amount === 'number' ? { amount: b.amount } : {}),
      ...(typeof b.risk === 'number' ? { risk: b.risk } : {}),
      ...(typeof b.dataClassification === 'string' ? { dataClassification: b.dataClassification } : {}),
      ...(typeof b.toolId === 'string' ? { toolId: b.toolId } : {}),
    });
    return json(200, { result });
  }

  private async govSimulate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.action !== 'string') return json(400, { error: 'field "action" is required' });
    const subject = await this.governanceSubject(req);
    const result = await this.governance.simulate(subject, b.action, { ...(typeof b.amount === 'number' ? { amount: b.amount } : {}) });
    return json(200, { result });
  }

  private async govVersions(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    return json(200, { versions: await this.governance.policyVersions(id) });
  }

  private async govEvaluations(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    return json(200, { evaluations: await this.governance.evaluationHistory(req.query.actor ?? req.principal!.userId) });
  }

  private async govSetAgent(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.agentId !== 'string') return json(400, { error: 'field "agentId" is required' });
    const gov = await this.governance.setAgentGovernance(b as never);
    return json(201, { governance: gov });
  }

  private async govCheckAgent(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.governance) return json(501, { error: 'policy-governance module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.agentId !== 'string') return json(400, { error: 'field "agentId" is required' });
    const result = await this.governance.checkAgent(b.agentId, {
      ...(typeof b.action === 'string' ? { action: b.action } : {}),
      ...(typeof b.toolId === 'string' ? { toolId: b.toolId } : {}),
      ...(typeof b.autonomy === 'string' ? { autonomy: b.autonomy as 'L0' } : {}),
      ...(typeof b.spent === 'number' ? { spent: b.spent } : {}),
      ...(typeof b.cost === 'number' ? { cost: b.cost } : {}),
      ...(typeof b.iterations === 'number' ? { iterations: b.iterations } : {}),
    });
    return json(200, { result });
  }

  // --- unified chat API (conversations + model routing + safety) -----------

  private async chat(req: GatewayRequest): Promise<GatewayResponse> {
    const body = this.asObject(req.body);
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) return json(400, { error: 'field "message" is required' });
    if (!req.principal) return json(401, { error: 'unauthorized' });

    // AI safety scan.
    if (this.aiSafety) {
      const scan = this.aiSafety.scan(message);
      if (scan.blocked) return json(400, { error: 'input blocked by safety filter', risk: scan.risk, violations: scan.violations.map((v) => v.type) });
    }

    // Resolve or create a conversation.
    let conv;
    const convMod = this.conversations;
    if (convMod) {
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      if (conversationId) {
        conv = await convMod.get(conversationId);
        if (!conv || conv.userId !== req.principal.userId) return json(404, { error: 'conversation not found' });
      } else {
        conv = await convMod.create(req.principal.userId, { title: typeof body.title === 'string' ? body.title : undefined });
      }
      await convMod.addMessage(conv.id, 'user', message);
    }

    const messages = conv?.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })) ?? [{ role: 'user', content: message }];
    if (conv?.systemPrompt) messages.unshift({ role: 'system', content: conv.systemPrompt });

    let answer: string;
    try {
      if (this.modelRuntime) {
        const res = await this.modelRuntime.complete({ messages: messages.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })) });
        answer = res.message.content;
        if (conv && convMod) await convMod.addMessage(conv.id, 'assistant', answer, { ...(res.usage ? { usage: { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens } } : {}) });
      } else {
        const res = await this.agents.run(message);
        answer = res.answer;
        if (conv && convMod) await convMod.addMessage(conv.id, 'assistant', answer);
      }
    } catch {
      answer = 'I encountered an error processing your request. Please try again.';
      if (conv && convMod) await convMod.addMessage(conv.id, 'assistant', answer);
    }

    return json(200, {
      answer,
      conversationId: conv?.id,
      ...(conv ? { messageCount: conv.messages.length + 1 } : {}),
    });
  }

  private async chatList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const result = await this.conversations.list(req.principal!.userId, {
      ...(req.query.folderId ? { folderId: req.query.folderId } : {}),
      ...(req.query.search ? { search: req.query.search } : {}),
      ...(req.query.pinned === 'true' ? { pinned: true } : {}),
      ...(req.query.archived === 'true' ? { archived: true } : {}),
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    return json(200, { conversations: result.conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, pinned: c.pinned, messageCount: c.messages.length })), total: result.total });
  }

  private async chatCreate(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    const conv = await this.conversations.create(req.principal!.userId, {
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(typeof b.systemPrompt === 'string' ? { systemPrompt: b.systemPrompt } : {}),
      ...(typeof b.modelPreference === 'string' ? { modelPreference: b.modelPreference } : {}),
    });
    return json(201, { conversation: { id: conv.id, title: conv.title } });
  }

  private async chatGet(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const conv = await this.conversations.get(id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    return json(200, { conversation: conv });
  }

  private async chatDelete(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const conv = await this.conversations.get(b.id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    await this.conversations.delete(b.id);
    return json(200, { deleted: true });
  }

  private async chatMessage(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.conversationId !== 'string' || typeof b.content !== 'string') return json(400, { error: 'fields "conversationId" and "content" are required' });
    const conv = await this.conversations.get(b.conversationId);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    const msg = await this.conversations.addMessage(b.conversationId, b.role === 'assistant' ? 'assistant' : 'user', b.content);
    return json(201, { message: msg });
  }

  private async chatEdit(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.conversationId !== 'string' || typeof b.messageId !== 'string' || typeof b.content !== 'string')
      return json(400, { error: 'fields "conversationId", "messageId", and "content" are required' });
    const conv = await this.conversations.get(b.conversationId);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    const edited = await this.conversations.editMessage(b.conversationId, b.messageId, b.content);
    return edited ? json(200, { message: edited }) : json(404, { error: 'message not found' });
  }

  private async chatShare(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const conv = await this.conversations.get(b.id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    const shareId = await this.conversations.share(b.id);
    return json(200, { shareId });
  }

  private async chatShared(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const shareId = req.query.id;
    if (!shareId) return json(400, { error: 'query parameter "id" (share id) is required' });
    const conv = await this.conversations.getByShareId(shareId);
    if (!conv) return json(404, { error: 'shared conversation not found' });
    return json(200, { conversation: { title: conv.title, messages: conv.messages } });
  }

  private async chatFolder(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.name !== 'string') return json(400, { error: 'field "name" is required' });
    const folder = await this.conversations.createFolder(req.principal!.userId, b.name, typeof b.color === 'string' ? b.color : undefined);
    return json(201, { folder });
  }

  private async chatFolderMove(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string') return json(400, { error: 'field "id" is required' });
    const conv = await this.conversations.get(b.id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    await this.conversations.moveToFolder(b.id, typeof b.folderId === 'string' ? b.folderId : undefined);
    return json(200, { ok: true });
  }

  private async chatFolders(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const folders = await this.conversations.listFolders(req.principal!.userId);
    return json(200, { folders });
  }

  private async chatExport(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query parameter "id" is required' });
    const conv = await this.conversations.get(id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    const format = (req.query.format ?? 'json') as 'json' | 'markdown' | 'text';
    const exported = await this.conversations.export(id, format);
    return { status: 200, body: exported, contentType: format === 'json' ? 'application/json' : 'text/plain' };
  }

  private async chatSearch(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.conversations) return json(501, { error: 'conversations module not registered' });
    const q = req.query.q;
    if (!q) return json(400, { error: 'query parameter "q" is required' });
    const result = await this.conversations.list(req.principal!.userId, { search: q, limit: 20 });
    return json(200, { results: result.conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })), total: result.total });
  }

  // --- WebSocket streaming chat (real-time /ws) ----------------------------

  private async handleWsMessage(msg: Record<string, unknown>, ws: { send: (data: string) => void }, principal: { userId: string; username: string } | undefined): Promise<void> {
    if (msg.type === 'chat' && typeof msg.message === 'string' && principal) {
      const message = msg.message as string;
      const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;

      // Safety scan.
      if (this.aiSafety) {
        const scan = this.aiSafety.scan(message);
        if (scan.blocked) {
          ws.send(JSON.stringify({ type: 'chat.error', error: 'input blocked by safety filter', risk: scan.risk }));
          return;
        }
      }

      // Persist user message.
      let convId: string | undefined;
      if (this.conversations) {
        let conv;
        if (conversationId) {
          conv = await this.conversations.get(conversationId);
          if (!conv || conv.userId !== principal.userId) { ws.send(JSON.stringify({ type: 'chat.error', error: 'conversation not found' })); return; }
        } else {
          conv = await this.conversations.create(principal.userId);
        }
        convId = conv.id;
        await this.conversations.addMessage(convId, 'user', message);
      }

      // Generate response.
      let answer: string;
      try {
        if (this.modelRuntime) {
          const res = await this.modelRuntime.complete({ messages: [{ role: 'user', content: message }] });
          answer = res.message.content;
        } else {
          const res = await this.agents.run(message);
          answer = res.answer;
        }
      } catch {
        answer = 'I encountered an error. Please try again.';
      }

      // Stream the response word-by-word.
      const words = answer.split(/(\s+)/); // keep whitespace
      for (let i = 0; i < words.length; i++) {
        ws.send(JSON.stringify({ type: 'chat.chunk', content: words[i] }));
      }

      // Persist assistant message.
      if (this.conversations && convId) {
        await this.conversations.addMessage(convId, 'assistant', answer);
      }

      ws.send(JSON.stringify({ type: 'chat.done', ...(convId ? { conversationId: convId } : {}), full: answer }));
    }

    // TANYA streaming chat — product-layer protocol over /ws. Reuses the
    // TANYA module (personas, history, tool calls, persistence) and streams
    // the reply in word chunks via tanya.chunk, ending with tanya.done.
    if (msg.type === 'tanya.chat' && typeof msg.message === 'string' && principal) {
      const message = msg.message as string;
      const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined;
      const persona = typeof msg.persona === 'string' && msg.persona ? msg.persona : 'main';
      const orgId = typeof msg.orgId === 'string' && msg.orgId ? msg.orgId : undefined;

      // Safety scan.
      if (this.aiSafety) {
        const scan = this.aiSafety.scan(message);
        if (scan.blocked) {
          ws.send(JSON.stringify({ type: 'tanya.error', error: 'input blocked by safety filter', risk: scan.risk }));
          return;
        }
      }

      if (!this.tanya) {
        ws.send(JSON.stringify({ type: 'tanya.error', error: 'tanya module not registered' }));
        return;
      }

      try {
        const result = await this.tanya.chat({
          userId: principal.userId,
          message,
          ...(conversationId ? { conversationId } : {}),
          persona,
          ...(orgId ? { orgId } : {}),
          ...(msg.modelRouting === true ? { modelRouting: true } : {}),
          onChunk: (chunk) => { ws.send(JSON.stringify({ type: 'tanya.chunk', content: chunk })); },
        });
        ws.send(JSON.stringify({
          type: 'tanya.done',
          conversationId: result.conversationId,
          persona: result.persona,
          agent: result.agent,
          reply: result.reply,
          toolCalls: result.toolCalls,
          finishedReason: result.finishedReason,
          messageCount: result.messageCount,
          ...(result.error ? { error: result.error } : {}),
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'tanya.error', error: e instanceof Error ? e.message : String(e) }));
      }
    }

    // QiL live execution — streams plan steps as they complete over /ws.
    // Accepts `{ type: 'qil.run', source }` (raw QiL) or
    // `{ type: 'qil.run', objective }` (natural language, compiled to a
    // retrieve→reason→report plan). Emits qil.step per step and qil.done
    // with the full result.
    if (msg.type === 'qil.run' && principal) {
      if (!this.orch) {
        ws.send(JSON.stringify({ type: 'qil.error', error: 'orchestrator module not registered' }));
        return;
      }
      const source = typeof msg.source === 'string' && msg.source.trim() ? msg.source : undefined;
      const objective = typeof msg.objective === 'string' && msg.objective.trim() ? msg.objective : undefined;
      if (!source && !objective) {
        ws.send(JSON.stringify({ type: 'qil.error', error: 'field "source" (QiL) or "objective" (natural language) is required' }));
        return;
      }

      // Safety scan on the human-provided text (objectives are free text).
      if (objective && this.aiSafety) {
        const scan = this.aiSafety.scan(objective);
        if (scan.blocked) {
          ws.send(JSON.stringify({ type: 'qil.error', error: 'input blocked by safety filter', risk: scan.risk }));
          return;
        }
      }

      try {
        const started = Date.now();
        const options = {
          principal: { userId: principal.userId, username: principal.username, roles: [] },
          onStep: (step: unknown, index: number, total: number): void => { ws.send(JSON.stringify({ type: 'qil.step', index, total, step })); },
        };
        const result = source
          ? await this.orch.runSource(source, options)
          : await this.orch.runObjective(objective!, options);
        ws.send(JSON.stringify({
          type: 'qil.done',
          runId: result.id,
          status: result.status,
          mission: result.mission,
          stepCount: result.steps.length,
          finalReport: result.finalReport,
          durationMs: Date.now() - started,
          ...(result.auditRecordId ? { auditRecordId: result.auditRecordId } : {}),
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'qil.error', error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }

  // --- TANYA AI conversational product layer --------------------------------

  private async tanyaChat(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.message !== 'string' || !b.message.trim()) return json(400, { error: 'field "message" is required' });
    // AI safety scan (parity with the unified /chat API).
    if (this.aiSafety) {
      const scan = this.aiSafety.scan(b.message);
      if (scan.blocked) return json(400, { error: 'input blocked by safety filter', risk: scan.risk, violations: scan.violations.map((v) => v.type) });
    }
    try {
      const result = await this.tanya.chat({
        userId: req.principal!.userId,
        message: b.message,
        ...(typeof b.conversationId === 'string' ? { conversationId: b.conversationId } : {}),
        ...(typeof b.persona === 'string' ? { persona: b.persona } : {}),
        ...(typeof b.title === 'string' ? { title: b.title } : {}),
        ...(typeof b.orgId === 'string' ? { orgId: b.orgId } : {}),
        ...(b.modelRouting === true ? { modelRouting: true } : {}),
      });
      return json(200, result);
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaConversations(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const q = req.query ?? {};
    const result = await this.tanya.listConversations(req.principal!.userId, {
      ...(typeof q.search === 'string' ? { search: q.search } : {}),
      ...(typeof q.orgId === 'string' ? { orgId: q.orgId } : {}),
      ...(typeof q.folderId === 'string' ? { folderId: q.folderId } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
      ...(q.offset ? { offset: Number(q.offset) } : {}),
    });
    return json(200, {
      conversations: result.conversations.map((c) => ({
        id: c.id, title: c.title, updatedAt: c.updatedAt, pinned: c.pinned ?? false,
        messageCount: c.messages.length,
        persona: (c.tags ?? []).find((t) => t !== 'tanya'),
      })),
      total: result.total,
    });
  }

  private async tanyaConversation(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query "id" is required' });
    const conv = await this.tanya.getConversation(id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    return json(200, {
      id: conv.id, title: conv.title, userId: conv.userId, systemPrompt: conv.systemPrompt,
      pinned: conv.pinned ?? false, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
      tags: conv.tags ?? [], messages: conv.messages,
    });
  }

  private async tanyaConversationDelete(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    const id = typeof b.id === 'string' ? b.id : undefined;
    if (!id) return json(400, { error: 'field "id" is required' });
    const conv = await this.tanya.getConversation(id);
    if (!conv || conv.userId !== req.principal!.userId) return json(404, { error: 'conversation not found' });
    const removed = await this.tanya.deleteConversation(id);
    return json(200, { deleted: removed });
  }

  private tanyaPersonas(): GatewayResponse {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    return json(200, {
      personas: this.tanya.listPersonas().map((p) => ({
        id: p.id, name: p.name, description: p.description, agentName: p.agentName,
      })),
    });
  }

  private tanyaPersonaCreate(req: GatewayRequest): GatewayResponse {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.systemPrompt !== 'string')
      return json(400, { error: 'fields "id" and "systemPrompt" are required' });
    try {
      const persona = this.tanya.registerPersona({
        id: b.id, systemPrompt: b.systemPrompt,
        ...(typeof b.name === 'string' ? { name: b.name } : {}),
        ...(typeof b.description === 'string' ? { description: b.description } : {}),
      });
      return json(201, { persona });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private tanyaIdentify(req: GatewayRequest): GatewayResponse {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.accessToken !== 'string') return json(400, { error: 'field "accessToken" is required' });
    const identity = this.tanya.identify(b.accessToken);
    if (!identity) return json(404, { error: 'no identity for the given access token' });
    return json(200, { identity });
  }

  private async tanyaStats(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const stats = await this.tanya.stats(req.principal!.userId);
    return json(200, stats);
  }

  private async tanyaShare(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.conversationId !== 'string' || !b.conversationId) return json(400, { error: 'field "conversationId" is required' });
    const recipientUserId = typeof b.recipientUserId === 'string' && b.recipientUserId ? b.recipientUserId : undefined;
    const email = typeof b.email === 'string' && b.email ? b.email : undefined;
    if (!recipientUserId && !email) return json(400, { error: 'field "recipientUserId" or "email" (IdP identity) is required' });
    const expiresInDays = typeof b.expiresInDays === 'number' ? b.expiresInDays : undefined;
    try {
      const share = recipientUserId
        ? await this.tanya.shareWith(b.conversationId, req.principal!.userId, recipientUserId, { ...(expiresInDays ? { expiresInDays } : {}) })
        : await this.tanya.shareWithIdpIdentity(b.conversationId, req.principal!.userId, { email }, { ...(expiresInDays ? { expiresInDays } : {}) });
      return json(201, { share });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaUnshare(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.conversationId !== 'string' || typeof b.recipientUserId !== 'string')
      return json(400, { error: 'fields "conversationId" and "recipientUserId" are required' });
    try {
      const removed = await this.tanya.unshareFrom(b.conversationId, req.principal!.userId, b.recipientUserId);
      return json(200, { removed });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaShared(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const conversations = await this.tanya.sharedWithMe(req.principal!.userId);
    return json(200, { conversations, count: conversations.length });
  }

  private async tanyaArchive(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.archived !== 'boolean')
      return json(400, { error: 'fields "id" and "archived" (boolean) are required' });
    try {
      await this.tanya.setArchived(b.id, req.principal!.userId, b.archived);
      return json(200, { archived: b.archived });
    } catch (e) {
      return json(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaPin(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.id !== 'string' || typeof b.pinned !== 'boolean')
      return json(400, { error: 'fields "id" and "pinned" (boolean) are required' });
    try {
      await this.tanya.setPinned(b.id, req.principal!.userId, b.pinned);
      return json(200, { pinned: b.pinned });
    } catch (e) {
      return json(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaSummarize(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.conversationId !== 'string' || !b.conversationId) return json(400, { error: 'field "conversationId" is required' });
    try {
      const summary = await this.tanya.summarize(b.conversationId, req.principal!.userId);
      return json(200, { summary });
    } catch (e) {
      return json(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaSharesPrune(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const removed = await this.tanya.pruneExpiredShares();
    return json(200, { removed });
  }

  private async tanyaOrg(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const orgId = req.query.orgId;
    if (!orgId) return json(400, { error: 'query "orgId" is required' });
    try {
      const conversations = await this.tanya.orgConversations(orgId, req.principal!.userId, { adminOnly: req.query.adminOnly === '1' });
      return json(200, { orgId, conversations, count: conversations.length });
    } catch (e) {
      return json(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tanyaShares(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.tanya) return json(501, { error: 'tanya module not registered' });
    const id = req.query.id;
    if (!id) return json(400, { error: 'query "id" (conversationId) is required' });
    try {
      const shares = await this.tanya.sharesFor(id, req.principal!.userId);
      return json(200, { shares, count: shares.length });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- TANYA Mobile Native ---------------------------------------------------

  private async mobileDevicesRegister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const b = this.asObject(req.body);
    if (b.platform !== 'ios' && b.platform !== 'android') return json(400, { error: 'field "platform" must be "ios" or "android"' });
    try {
      const device = await this.mobile.registerDevice(req.principal!.userId, {
        platform: b.platform,
        ...(typeof b.pushToken === 'string' ? { pushToken: b.pushToken } : {}),
        ...(typeof b.name === 'string' ? { name: b.name } : {}),
        ...(typeof b.locale === 'string' ? { locale: b.locale } : {}),
      });
      return json(201, { device });
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async mobileDevicesList(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const devices = await this.mobile.listDevices(req.principal!.userId);
    return json(200, { devices, count: devices.length });
  }

  private async mobileDevicesUnregister(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.deviceId !== 'string' || !b.deviceId) return json(400, { error: 'field "deviceId" is required' });
    const removed = await this.mobile.unregisterDevice(req.principal!.userId, b.deviceId);
    return json(200, { removed });
  }

  private async mobileOutbox(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const b = this.asObject(req.body);
    if (!Array.isArray(b.messages)) return json(400, { error: 'field "messages" (array) is required' });
    const result = await this.mobile.syncOutbox(req.principal!.userId, b.messages as never[]);
    return json(200, result);
  }

  private async mobileSnapshot(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const snapshot = await this.mobile.snapshot(req.principal!.userId);
    return json(200, snapshot);
  }

  private async mobilePushEmit(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.userId !== 'string' || typeof b.title !== 'string' || typeof b.body !== 'string')
      return json(400, { error: 'fields "userId", "title", and "body" are required' });
    const result = await this.mobile.emitPush(b.userId, b.title, b.body, {
      ...(typeof b.event === 'string' ? { event: b.event } : {}),
      ...(b.data && typeof b.data === 'object' ? { data: b.data as Record<string, unknown> } : {}),
    });
    return json(200, result);
  }

  private async mobileNotify(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.mobile) return json(501, { error: 'mobile module not registered' });
    const b = this.asObject(req.body);
    if (typeof b.title !== 'string' || typeof b.body !== 'string')
      return json(400, { error: 'fields "title" and "body" are required' });
    const result = await this.mobile.notifyUser(req.principal!.userId, {
      title: b.title,
      body: b.body,
      ...(typeof b.event === 'string' ? { event: b.event } : {}),
      ...(b.data && typeof b.data === 'object' ? { data: b.data as Record<string, unknown> } : {}),
    });
    return json(200, result);
  }

  // --- helpers -------------------------------------------------------------

  private asObject(body: unknown): Record<string, unknown> {
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  }

  private bearer(req: GatewayRequest): string | undefined {
    const h = req.headers['authorization'];
    if (!h) return undefined;
    return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : h;
  }
}

function json(status: number, body: unknown): GatewayResponse {
  return { status, body };
}

/**
 * Recursively convert bigint values to decimal strings so wallet/crypto
 * payloads (exact integer arithmetic) survive JSON serialization.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return jsonSafe(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

/** Parse an integer amount from a JSON body value into bigint minor units. */
function toBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : undefined;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
}

/** Parse a DN from an array of {oid,value} or an object map. */
function parseDn(v: unknown): Array<{ oid: string; value: string }> | undefined {
  if (Array.isArray(v)) {
    const out: Array<{ oid: string; value: string }> = [];
    for (const item of v) {
      if (!item || typeof item !== 'object') return undefined;
      const rec = item as Record<string, unknown>;
      if (typeof rec.oid !== 'string' || typeof rec.value !== 'string') return undefined;
      out.push({ oid: rec.oid, value: rec.value });
    }
    return out.length > 0 ? out : undefined;
  }
  if (v && typeof v === 'object') {
    const map: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val !== 'string') return undefined;
      map[k] = val;
    }
    const OID_BY_NAME: Record<string, string> = {
      CN: '2.5.4.3', C: '2.5.4.6', L: '2.5.4.7', ST: '2.5.4.8',
      O: '2.5.4.10', OU: '2.5.4.11', emailAddress: '1.2.840.113549.1.9.1',
    };
    return Object.entries(map).map(([k, value]) => ({ oid: OID_BY_NAME[k.toUpperCase()] ?? k, value }));
  }
  return undefined;
}

/** Map a DNS type name (case-insensitive) to its numeric code. */
function dnsTypeFromString(name: string): number {
  const n = name.toUpperCase();
  const map: Record<string, number> = {
    A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28,
    SRV: 33, DS: 43, RRSIG: 46, NSEC: 47, DNSKEY: 48, CAA: 257, ANY: 255,
  };
  return map[n] ?? 1;
}

function rateHeaders(d: { limit: number; remaining: number; resetAt: number; retryAfterSec: number }): Record<string, string> {
  return {
    'x-ratelimit-limit': String(d.limit),
    'x-ratelimit-remaining': String(d.remaining),
    'x-ratelimit-reset': String(d.resetAt),
    'retry-after': String(d.retryAfterSec),
  };
}
