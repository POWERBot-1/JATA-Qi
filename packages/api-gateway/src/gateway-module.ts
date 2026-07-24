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
    route('POST', '/ask', auth('agent:run', (req) => this.ask(req)));
    route('GET', '/audit', auth('audit:read', (req) => this.audit(req)));
    route('GET', '/stats', auth('knowledge:read', () => this.stats()));
    route('GET', '/whoami', auth(null, (req) => json(200, { principal: req.principal })));
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
    const payload = JSON.stringify(resp.body);
    res.writeHead(resp.status, {
      'content-type': 'application/json; charset=utf-8',
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
    for (const id of ['storage', 'vector-search', 'knowledge', 'knowledge-graph', 'agent-runtime', 'qil', 'security', 'orchestrator', 'api-gateway']) {
      try {
        this.api.getModuleState(id);
        ids.push(id);
      } catch {
        /* module not registered */
      }
    }
    return ids;
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
