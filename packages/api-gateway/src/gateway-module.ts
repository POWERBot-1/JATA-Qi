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
    route('POST', '/auth/apikey', auth(null, (req) => this.createApiKey(req)));
    route('POST', '/qil', auth('qil:run', (req) => this.runQiL(req)));
    route('POST', '/objective', auth('qil:run', (req) => this.runObjective(req)));
    route('GET', '/workflows', auth('qil:run', (req) => this.listWorkflows(req)));
    route('GET', '/workflow', auth('qil:run', (req) => this.getWorkflow(req)));
    route('POST', '/ask', auth('agent:run', (req) => this.ask(req)));
    route('GET', '/audit', auth('audit:read', (req) => this.audit(req)));
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
    route('GET', '/tool', auth('tool:read', (req) => this.toolGet(req)));
    route('POST', '/tool/invoke', auth('tool:invoke', (req) => this.toolInvoke(req)));
    route('POST', '/tool/request-approval', auth('tool:invoke', (req) => this.toolRequestApproval(req)));
    route('POST', '/tool/approve', auth('approval:decide', (req) => this.toolApprove(req)));
    route('GET', '/approvals', auth('approval:decide', () => this.approvalsList()));
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
    route('GET', '/chat/folders', auth('agent:run', (req) => this.chatFolders(req)));
    route('GET', '/chat/export', auth('agent:run', (req) => this.chatExport(req)));
    route('GET', '/chat/search', auth('agent:run', (req) => this.chatSearch(req)));
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
    const payload = isText ? String(resp.body) : JSON.stringify(resp.body);
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
      'link-intelligence', 'multimodal-intelligence', 'search',
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

  private approvalsList(): GatewayResponse {
    if (!this.tools) return json(501, { error: 'tool-intelligence module not registered' });
    return json(200, { approvals: this.tools.listPendingApprovals() });
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
