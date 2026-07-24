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
import type { GatewayHandle, GatewayOptions, GatewayRequest, GatewayResponse, RouteHandler } from './types.js';

const BOOT_TIME = Date.now();

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
  private server: Server | undefined;
  private booted = false;
  private readonly opts: GatewayOptions;
  private readonly routes = new Map<string, RouteHandler>();

  constructor(opts: GatewayOptions = {}) {
    this.opts = { maxBodyBytes: 1_048_576, ...opts };
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

  private moduleIds(): string[] {
    // The kernel does not expose a public list; collect started modules via state.
    const ids: string[] = [];
    for (const id of [
      'storage', 'vector-search', 'knowledge', 'knowledge-graph', 'agent-runtime',
      'qil', 'security', 'orchestrator', 'metrics', 'simulation', 'teams', 'plugins',
      'model-registry', 'scheduler', 'api-gateway',
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
