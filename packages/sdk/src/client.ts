// JATA Qi SDK — strongly typed HTTP client for the JATA Qi API Gateway.
//
// Usage:
//   const client = new JataQiClient({ baseUrl: 'http://localhost:7400' });
//   await client.auth.login('alice', 'pw');
//   const result = await client.qil.run('MISSION "test" { REASON REPORT }');
//
// The client manages authentication tokens automatically and provides typed
// namespaces for every platform module.

export interface JataQiClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class JataQiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'JataQiError';
  }
}

export class JataQiClient {
  readonly baseUrl: string;
  private token?: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  // Typed namespaces (initialised lazily).
  readonly auth: AuthClient;
  readonly health: HealthClient;
  readonly identity: IdentityClient;
  readonly readiness: ReadinessClient;
  readonly knowledge: KnowledgeClient;
  readonly agent: AgentClient;
  readonly qil: QiLClient;
  readonly workflow: WorkflowClient;
  readonly tools: ToolsClient;
  readonly devices: DevicesClient;
  readonly twins: TwinsClient;
  readonly models: ModelsClient;
  readonly simulate: SimulateClient;
  readonly team: TeamClient;
  readonly commerce: CommerceClient;
  readonly org: OrgClient;
  readonly notifications: NotificationsClient;
  readonly flags: FlagsClient;
  readonly gov: GovClient;
  readonly media: MediaClient;
  readonly mfa: MFAClient;
  readonly commerceStats: CommerceStatsClient;

  constructor(opts: JataQiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.extraHeaders = opts.headers ?? {};

    this.auth = new AuthClient(this);
    this.health = new HealthClient(this);
    this.identity = new IdentityClient(this);
    this.readiness = new ReadinessClient(this);
    this.knowledge = new KnowledgeClient(this);
    this.agent = new AgentClient(this);
    this.qil = new QiLClient(this);
    this.workflow = new WorkflowClient(this);
    this.tools = new ToolsClient(this);
    this.devices = new DevicesClient(this);
    this.twins = new TwinsClient(this);
    this.models = new ModelsClient(this);
    this.simulate = new SimulateClient(this);
    this.team = new TeamClient(this);
    this.commerce = new CommerceClient(this);
    this.org = new OrgClient(this);
    this.notifications = new NotificationsClient(this);
    this.flags = new FlagsClient(this);
    this.gov = new GovClient(this);
    this.media = new MediaClient(this);
    this.mfa = new MFAClient(this);
    this.commerceStats = new CommerceStatsClient(this);
  }

  /** Internal request method. */
  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      if (!res.ok) {
        const err = parsed as { error?: string; code?: string } | undefined;
        throw new JataQiError(err?.error ?? `HTTP ${res.status}`, res.status, err?.code, parsed);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Set the bearer token manually (e.g. from storage). */
  setToken(token: string): void { this.token = token; }
  getToken(): string | undefined { return this.token; }
  clearToken(): void { this.token = undefined; }
}

// --- Auth ---------------------------------------------------------------------

export class AuthClient {
  constructor(private c: JataQiClient) {}
  async register(username: string, password: string, roles?: string[]): Promise<{ userId: string; username: string; roles: string[] }> {
    return this.c.request('POST', '/auth/register', { username, password, roles });
  }
  async login(username: string, password: string): Promise<{ token: string; expiresAt: number; principal: { userId: string; username: string; roles: string[] } }> {
    const r = await this.c.request<{ token: string; expiresAt: number; principal: { userId: string; username: string; roles: string[] } }>('POST', '/auth/login', { username, password });
    this.c.setToken(r.token);
    return r;
  }
  async logout(): Promise<void> { await this.c.request('POST', '/auth/logout'); this.c.clearToken(); }
  async whoami(): Promise<{ principal: { userId: string; username: string; roles: string[] } }> { return this.c.request('GET', '/whoami'); }
}

// --- Health / Identity / Readiness --------------------------------------------

export class HealthClient {
  constructor(private c: JataQiClient) {}
  async check(): Promise<{ status: string; booted: boolean; uptimeMs: number; modules: string[] }> {
    return this.c.request('GET', '/health');
  }
}

export class IdentityClient {
  constructor(private c: JataQiClient) {}
  async info(): Promise<Record<string, unknown>> { return this.c.request('GET', '/identity'); }
  async creator(): Promise<{ creator: { display_name: string; role: string } }> { return this.c.request('GET', '/identity/creator'); }
  async verify(): Promise<{ valid: boolean; reason: string }> { return this.c.request('GET', '/identity/verify'); }
  async provenance(): Promise<{ events: unknown[] }> { return this.c.request('GET', '/identity/provenance'); }
}

export class ReadinessClient {
  constructor(private c: JataQiClient) {}
  async list(category?: string): Promise<{ capabilities: unknown[] }> {
    return this.c.request('GET', '/readiness', undefined, category ? { category } : undefined);
  }
  async summary(): Promise<{ total: number; byStatus: Record<string, number>; overall: string }> {
    return this.c.request('GET', '/readiness/summary');
  }
}

// --- Knowledge / Agent / QiL / Workflow ---------------------------------------

export class KnowledgeClient {
  constructor(private c: JataQiClient) {}
  async search(query: string): Promise<unknown> { return this.c.request('POST', '/ask', { message: query }); }
  async stats(): Promise<unknown> { return this.c.request('GET', '/stats'); }
}

export class AgentClient {
  constructor(private c: JataQiClient) {}
  async ask(message: string): Promise<{ answer: string; iterations: number; toolCalls: number; finishedReason: string }> {
    return this.c.request('POST', '/ask', { message });
  }
}

export class QiLClient {
  constructor(private c: JataQiClient) {}
  async run(program: string): Promise<{ result: { status: string; finalReport: string; steps: unknown[]; auditRecordId?: string } }> {
    return this.c.request('POST', '/qil', { program });
  }
  async objective(text: string): Promise<{ result: { status: string; finalReport: string; steps: unknown[]; retrieved: string[]; auditRecordId?: string } }> {
    return this.c.request('POST', '/objective', { objective: text });
  }
}

export class WorkflowClient {
  constructor(private c: JataQiClient) {}
  async list(limit?: number): Promise<{ runs: unknown[]; count: number }> {
    return this.c.request('GET', '/workflows', undefined, limit ? { limit: String(limit) } : undefined);
  }
  async get(id: string): Promise<{ run: unknown }> { return this.c.request('GET', '/workflow', undefined, { id }); }
}

// --- Tools --------------------------------------------------------------------

export class ToolsClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ tools: unknown[] }> { return this.c.request('GET', '/tools'); }
  async register(input: Record<string, unknown>): Promise<{ tool: unknown }> { return this.c.request('POST', '/tools', input); }
  async get(id: string): Promise<{ tool: unknown }> { return this.c.request('GET', '/tool', undefined, { id }); }
  async invoke(id: string, inputBody: unknown, approvalRequestId?: string): Promise<{ result: { status: string; output?: unknown; error?: string; governance?: unknown } }> {
    return this.c.request('POST', '/tool/invoke', { id, input: inputBody, ...(approvalRequestId ? { approvalRequestId } : {}) });
  }
  async requestApproval(toolId: string, action: string, reason?: string): Promise<{ approvalRequest: unknown }> {
    return this.c.request('POST', '/tool/request-approval', { id: toolId, action, reason });
  }
  async approve(requestId: string, decision: 'approved' | 'denied'): Promise<{ approvalRequest: unknown }> {
    return this.c.request('POST', '/tool/approve', { id: requestId, decision });
  }
  async rankedByCapability(capability: string): Promise<{ capability: string; ranked: unknown[] }> {
    return this.c.request('GET', '/tools/capability', undefined, { capability });
  }
}

// --- Devices / Twins / Models / Simulate / Team -------------------------------

export class DevicesClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ devices: unknown[] }> { return this.c.request('GET', '/devices'); }
  async register(input: Record<string, unknown>): Promise<{ device: unknown }> { return this.c.request('POST', '/devices', input); }
  async action(input: Record<string, unknown>): Promise<unknown> { return this.c.request('POST', '/device', input); }
  async missions(deviceId?: string): Promise<{ missions: unknown[] }> {
    return this.c.request('GET', '/missions', undefined, deviceId ? { deviceId } : undefined);
  }
}

export class TwinsClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ twins: unknown[] }> { return this.c.request('GET', '/twins'); }
  async create(input: Record<string, unknown>): Promise<{ twin: unknown }> { return this.c.request('POST', '/twins', input); }
  async action(input: Record<string, unknown>): Promise<unknown> { return this.c.request('POST', '/twin', input); }
}

export class ModelsClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ models: unknown[] }> { return this.c.request('GET', '/models'); }
  async select(capabilities: string[], prefer?: string): Promise<{ selection: unknown }> {
    return this.c.request('POST', '/models/select', { capabilities, ...(prefer ? { prefer } : {}) });
  }
}

export class SimulateClient {
  constructor(private c: JataQiClient) {}
  async run(input: { name: string; inputs: Record<string, unknown>; formula: string; trials?: number; seed?: number; targets?: number[] }): Promise<{ result: Record<string, unknown> }> {
    return this.c.request('POST', '/simulate', input);
  }
}

export class TeamClient {
  constructor(private c: JataQiClient) {}
  async run(objective: string, members: string[], mode?: string): Promise<{ result: { mode: string; contributions: unknown[]; synthesis: string } }> {
    return this.c.request('POST', '/team', { objective, members, ...(mode ? { mode } : {}) });
  }
}

// --- Commerce / Org / Notifications / Flags / Gov / Media / MFA ----------------

export class CommerceClient {
  constructor(private c: JataQiClient) {}
  async plans(): Promise<{ plans: unknown[] }> { return this.c.request('GET', '/commerce/plans'); }
  async subscribe(planSlug: string, opts?: Record<string, unknown>): Promise<{ subscription: unknown }> {
    return this.c.request('POST', '/commerce/subscribe', { planSlug, ...opts });
  }
  async subscriptionAction(id: string, action: string, planSlug?: string): Promise<{ subscription: unknown }> {
    return this.c.request('POST', '/commerce/subscription', { id, action, ...(planSlug ? { planSlug } : {}) });
  }
  async check(feature: string): Promise<{ decision: { allowed: boolean; quota: number; remaining: number } }> {
    return this.c.request('GET', '/commerce/check', undefined, { feature });
  }
  async meter(metric: string, qty?: number): Promise<unknown> {
    return this.c.request('POST', '/commerce/meter', { metric, ...(qty ? { qty } : {}) });
  }
  async creditBalance(): Promise<{ balance: number }> { return this.c.request('GET', '/commerce/credits'); }
  async grantCredits(customerId: string, amount: number, source?: string): Promise<{ batch: unknown }> {
    return this.c.request('POST', '/commerce/credits', { customerId, amount, ...(source ? { source } : {}) });
  }
  async marketplace(item: Record<string, unknown>): Promise<unknown> {
    return this.c.request('POST', '/commerce/marketplace', { item });
  }
}

export class CommerceStatsClient {
  constructor(private c: JataQiClient) {}
  async analytics(): Promise<Record<string, unknown>> { return this.c.request('GET', '/commerce/analytics'); }
}

export class OrgClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ organizations: unknown[] }> { return this.c.request('GET', '/orgs'); }
  async create(name: string, slug?: string): Promise<{ organization: unknown }> {
    return this.c.request('POST', '/orgs', { name, ...(slug ? { slug } : {}) });
  }
  async action(input: Record<string, unknown>): Promise<unknown> { return this.c.request('POST', '/org', input); }
  async members(id: string): Promise<{ members: unknown[] }> { return this.c.request('GET', '/org/members', undefined, { id }); }
}

export class NotificationsClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ notifications: unknown[]; unread: number }> { return this.c.request('GET', '/notifications'); }
  async markRead(id: string): Promise<{ notification: unknown }> { return this.c.request('POST', '/notification/read', { id }); }
  async markAllRead(): Promise<{ marked: number }> { return this.c.request('POST', '/notification/read', { all: true }); }
  async send(type: string, title: string, body?: string): Promise<unknown> {
    return this.c.request('POST', '/notify', { type, title, ...(body ? { body } : {}) });
  }
  async getPreferences(): Promise<{ preferences: Record<string, unknown> }> { return this.c.request('GET', '/notification/preferences'); }
  async setPreferences(prefs: Record<string, unknown>): Promise<{ preferences: Record<string, unknown> }> {
    return this.c.request('POST', '/notification/preferences', { preferences: prefs });
  }
}

export class FlagsClient {
  constructor(private c: JataQiClient) {}
  async list(): Promise<{ flags: unknown[] }> { return this.c.request('GET', '/flags'); }
  async check(key: string, userId?: string): Promise<{ key: string; enabled: boolean }> {
    return this.c.request('GET', '/flag/check', undefined, { key, ...(userId ? { userId } : {}) });
  }
  async set(key: string, enabled: boolean, rolloutPct?: number): Promise<{ flag: unknown }> {
    return this.c.request('POST', '/flag', { key, enabled, ...(rolloutPct !== undefined ? { rolloutPct } : {}) });
  }
}

export class GovClient {
  constructor(private c: JataQiClient) {}
  async policies(): Promise<{ policies: unknown[]; controls: unknown[] }> { return this.c.request('GET', '/gov/policies'); }
  async createPolicy(input: Record<string, unknown>): Promise<{ policy: unknown }> { return this.c.request('POST', '/gov/policies', input); }
  async evaluate(action: string, opts?: Record<string, unknown>): Promise<{ result: { decision: string; reason: string; evaluationId: string } }> {
    return this.c.request('POST', '/gov/policies/evaluate', { action, ...opts });
  }
  async simulate(action: string, opts?: Record<string, unknown>): Promise<{ result: unknown }> {
    return this.c.request('POST', '/gov/policies/simulate', { action, ...opts });
  }
  async versions(id: string): Promise<{ versions: unknown[] }> { return this.c.request('GET', '/gov/policy/versions', undefined, { id }); }
  async evaluations(): Promise<{ evaluations: unknown[] }> { return this.c.request('GET', '/gov/evaluations'); }
}

export class MediaClient {
  constructor(private c: JataQiClient) {}
  // Media is accessed via direct module API, not gateway (no endpoints yet).
  // This namespace is reserved for future gateway endpoints.
}

export class MFAClient {
  constructor(private c: JataQiClient) {}
  // MFA is accessed via direct module API, not gateway (no endpoints yet).
  // This namespace is reserved for future gateway endpoints.
}
