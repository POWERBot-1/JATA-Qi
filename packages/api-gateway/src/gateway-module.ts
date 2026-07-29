// ApiGatewayModule — HTTP entrypoint for JATA Qi (Step 92 Task 4 "API Gateway",
// Step 15 "API Gateway"). Exposes auth, QiL submission, orchestration, agent
// passthrough, audit and stats over a tiny zero-dependency HTTP server.
//
// The gateway is the front of the "Alpha vertical slice" defined in Step 93:
//   authenticate -> submit request -> QiL generates a workflow -> agents run ->
//   knowledge retrieved -> structured response -> auditable execution record.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { SecurityModule } from '@jataqi/security';
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
import type { TaskProfile } from '@jataqi/scheduler';
import type { GatewayHandle, GatewayOptions, GatewayRequest, GatewayResponse, RouteHandler } from './types.js';
import { RateLimiter } from './rate-limit.js';

const BOOT_TIME = Date.now();
const DEFAULT_RATE_LIMIT = { limit: 1000, windowMs: 60_000 };

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
  private server: Server | undefined;
  private booted = false;
  private readonly opts: GatewayOptions;
  private readonly routes = new Map<string, RouteHandler>();
  private readonly limiter: RateLimiter | undefined;

  constructor(opts: GatewayOptions = {}) {
    this.opts = { maxBodyBytes: 1_048_576, ...opts };
    const rl = opts.rateLimit === null ? null : (opts.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.limiter = rl ? new RateLimiter(rl) : undefined;
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
    this.registerRoutes();
    this.server = createServer((req, res) => this.handle(req, res));
    this.booted = true;
    kernel.logger.info('api-gateway module initialized (not listening)');
  }

  async stop(_kernel: KernelApi): Promise<void> {
    if (this.server?.listening) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  /** Begin listening. Returns a handle with the bound port. */
  listen(opts: ListenOptions = {}): Promise<GatewayHandle> {
    if (!this.server) throw new Error('api-gateway: server not started');
    const server = this.server;
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
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
    });
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
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await this.readBody(req) : undefined;

      const greq: GatewayRequest = {
        method,
        path,
        query,
        headers: req.headers as Record<string, string | undefined>,
        body,
        remoteAddress: req.socket.remoteAddress,
      };

      const handler = this.routes.get(`${method} ${path}`);
      let resp: GatewayResponse;

      // Rate limiting (keyed by token or client IP). Step 15 "API Gateway: rate limiting".
      if (this.limiter) {
        const key = greq.headers['authorization'] ?? greq.remoteAddress ?? 'anon';
        const decision = this.limiter.consume(key);
        if (!decision.allowed) {
          resp = {
            status: 429,
            body: { error: 'rate limit exceeded', limit: decision.limit },
            headers: rateHeaders(decision),
          };
          this.send(res, resp);
          this.metrics?.requests.inc(1, { method, path, status: '429' });
          return;
        }
      }

      if (!handler) {
        resp = json(404, { error: 'not found', path });
      } else {
        try {
          resp = await handler(greq);
        } catch (err) {
          resp = this.toErrorResponse(err);
        }
      }
      this.send(res, resp);
      this.metrics?.requests.inc(1, { method, path, status: String(resp.status) });
      this.api.logger.debug('gateway request', {
        method,
        path,
        status: resp.status,
        ms: Date.now() - started,
        actor: greq.principal?.username,
      });
    } catch (err) {
      this.send(res, this.toErrorResponse(err));
    }
  }

  private send(res: ServerResponse, resp: GatewayResponse): void {
    const isText = resp.contentType === 'text/plain';
    const payload = isText ? String(resp.body) : JSON.stringify(resp.body);
    res.writeHead(resp.status, {
      'content-type': resp.contentType ?? 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...(resp.headers ?? {}),
      ...(this.opts.cors ? { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } : {}),
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
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw Object.assign(new Error('request body too large'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
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
      modules: this.moduleIds(),
    });
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
      'organizations', 'notifications', 'policies', 'feature-flags', 'privacy', 'api-gateway',
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
    const res = await this.sec.login(String(username), String(password));
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

function rateHeaders(d: { limit: number; remaining: number; resetAt: number; retryAfterSec: number }): Record<string, string> {
  return {
    'x-ratelimit-limit': String(d.limit),
    'x-ratelimit-remaining': String(d.remaining),
    'x-ratelimit-reset': String(d.resetAt),
    'retry-after': String(d.retryAfterSec),
  };
}
