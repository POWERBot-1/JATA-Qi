// JATA Qi SDK — strongly typed HTTP client for the JATA Qi API Gateway.
//
// Usage:
//   const client = new JataQiClient({ baseUrl: 'http://localhost:7400' });
//   await client.auth.login('alice', 'pw');
//   const result = await client.qil.run('MISSION "test" { REASON REPORT }');
//
// The client manages authentication tokens automatically and provides typed
// namespaces for every platform module.

import { StreamingClient } from './streaming.js';

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
  readonly pki: PkiClient;
  readonly audit: AuditClient;
  readonly tanya: TanyaClient;
  readonly alerts: AlertsClient;
  readonly mobile: MobileClient;
  readonly marketplace: MarketplaceClient;
  readonly cloud: CloudClient;
  readonly defense: DefenseClient;
  readonly soc: SocClient;
  readonly supplyChain: SupplyChainClient;
  readonly infra: InfraClient;
  readonly resilience: ResilienceClient;
  readonly privacy: PrivacyClient;
  readonly review: ReviewClient;
  readonly secauto: SecautoClient;
  readonly dlp: DlpClient;
  readonly pqc: PqcClient;
  readonly products: ProductMarketplaceClient;
  readonly onboarding: OnboardingClient;
  readonly ops: OperationsClient;
  readonly commerceStats: CommerceStatsClient;
  /** WebSocket streaming client for the /ws realtime channel. */
  readonly streaming: StreamingClient;

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
    this.pki = new PkiClient(this);
    this.audit = new AuditClient(this);
    this.tanya = new TanyaClient(this);
    this.alerts = new AlertsClient(this);
    this.mobile = new MobileClient(this);
    this.marketplace = new MarketplaceClient(this);
    this.cloud = new CloudClient(this);
    this.defense = new DefenseClient(this);
    this.soc = new SocClient(this);
    this.supplyChain = new SupplyChainClient(this);
    this.infra = new InfraClient(this);
    this.resilience = new ResilienceClient(this);
    this.privacy = new PrivacyClient(this);
    this.review = new ReviewClient(this);
    this.secauto = new SecautoClient(this);
    this.dlp = new DlpClient(this);
    this.pqc = new PqcClient(this);
    this.products = new ProductMarketplaceClient(this);
    this.onboarding = new OnboardingClient(this);
    this.ops = new OperationsClient(this);
    this.commerceStats = new CommerceStatsClient(this);
    this.streaming = new StreamingClient({ baseUrl: this.baseUrl, token: this.token });
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

  /** Like request() but returns the raw response body as text (for CSV/plain exports). */
  async requestText(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<string> {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: { error?: string } | undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      throw new JataQiError(parsed?.error ?? `HTTP ${res.status}`, res.status, undefined, text);
    }
    return text;
  }

  /** Set the bearer token manually (e.g. from storage). */
  setToken(token: string): void {
    this.token = token;
    this.streaming.setToken(token);
  }
  getToken(): string | undefined { return this.token; }
  clearToken(): void { this.token = undefined; }
}

// --- Audit ---------------------------------------------------------------------

export class AuditClient {
  constructor(private c: JataQiClient) {}
  /** Query the immutable audit ledger (newest first). */
  async list(opts: { actor?: string; action?: string; result?: string; limit?: number } = {}): Promise<{ records: Record<string, unknown>[]; count: number }> {
    const query: Record<string, string> = {};
    if (opts.actor) query.actor = opts.actor;
    if (opts.action) query.action = opts.action;
    if (opts.result) query.result = opts.result;
    if (opts.limit) query.limit = String(opts.limit);
    return this.c.request('GET', '/audit', undefined, query);
  }
  /** Export the ledger as CSV (default) or JSON for compliance handoff. */
  async exportCsv(opts: { actor?: string; action?: string; result?: string; limit?: number } = {}): Promise<string> {
    return this.c.requestText('GET', '/audit/export?format=csv', undefined, this.query(opts));
  }
  /** Export the ledger as a pretty JSON document. */
  async exportJson(opts: { actor?: string; action?: string; result?: string; limit?: number } = {}): Promise<string> {
    return this.c.requestText('GET', '/audit/export?format=json', undefined, this.query(opts));
  }
  private query(opts: { actor?: string; action?: string; result?: string; limit?: number }): Record<string, string> {
    const q: Record<string, string> = {};
    if (opts.actor) q.actor = opts.actor;
    if (opts.action) q.action = opts.action;
    if (opts.result) q.result = opts.result;
    if (opts.limit) q.limit = String(opts.limit);
    return q;
  }
}

// --- TANYA AI -------------------------------------------------------------------

export class TanyaClient {
  constructor(private c: JataQiClient) {}
  /** Run a conversational turn (persona + optional conversation/org scope). */
  async chat(message: string, opts: { persona?: string; conversationId?: string; orgId?: string; title?: string; modelRouting?: boolean } = {}): Promise<{
    conversationId: string; userId: string; persona: string; agent: string;
    reply: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: unknown }>;
    finishedReason: string; messageCount: number;
  }> {
    return this.c.request('POST', '/tanya/chat', { message, ...opts });
  }
  /** List conversations (org/folder-scoped filters supported). */
  async listConversations(opts: { orgId?: string; folderId?: string; search?: string; limit?: number; offset?: number } = {}): Promise<{ conversations: Array<{ id: string; title: string; updatedAt: number; pinned: boolean; messageCount: number; persona?: string }>; total: number }> {
    return this.c.request('GET', '/tanya/conversations', undefined, this.q(opts));
  }
  async getConversation(id: string): Promise<{ id: string; title: string; messages: Array<{ id: string; role: string; content: string; createdAt: number; toolCalls?: unknown[] }>; orgId?: string }> {
    return this.c.request('GET', '/tanya/conversation', undefined, { id });
  }
  async deleteConversation(id: string): Promise<{ deleted: boolean }> {
    return this.c.request('POST', '/tanya/conversation/delete', { id });
  }
  async personas(): Promise<{ personas: Array<{ id: string; name: string; description: string; agentName: string }> }> {
    return this.c.request('GET', '/tanya/personas');
  }
  async createPersona(id: string, systemPrompt: string, opts: { name?: string; description?: string } = {}): Promise<{ persona: unknown }> {
    return this.c.request('POST', '/tanya/persona', { id, systemPrompt, ...opts });
  }
  async identify(accessToken: string): Promise<{ identity: { sub: string; name?: string; email?: string } }> {
    return this.c.request('POST', '/tanya/identify', { accessToken });
  }
  async stats(): Promise<{ conversations: number; messages: number; personas: number }> {
    return this.c.request('GET', '/tanya/stats');
  }
  /** Share a conversation with a platform user (or by IdP email). */
  async share(conversationId: string, opts: { recipientUserId?: string; email?: string; expiresInDays?: number } = {}): Promise<{ share: { id: string; conversationId: string; recipientUserId: string; via?: string; expiresAt?: number } }> {
    return this.c.request('POST', '/tanya/share', { conversationId, ...opts });
  }
  async unshare(conversationId: string, recipientUserId: string): Promise<{ removed: boolean }> {
    return this.c.request('POST', '/tanya/unshare', { conversationId, recipientUserId });
  }
  /** Conversations shared with me (multi-user inbox). */
  async shared(): Promise<{ conversations: Array<{ id: string; title: string; ownerId: string; updatedAt: number }>; count: number }> {
    return this.c.request('GET', '/tanya/shared');
  }
  /** Share grants of a conversation (owner view). */
  async shares(conversationId: string): Promise<{ shares: Array<{ id: string; recipientUserId?: string; createdAt: number; expiresAt?: number }>; count: number }> {
    return this.c.request('GET', '/tanya/shares', undefined, { id: conversationId });
  }
  /** Create a folder. */
  async createFolder(name: string, color?: string): Promise<{ folder: { id: string; name: string; color?: string } }> {
    return this.c.request('POST', '/chat/folder', { name, ...(color ? { color } : {}) });
  }
  /** List the caller's folders. */
  async listFolders(): Promise<{ folders: Array<{ id: string; name: string; color?: string }> }> {
    return this.c.request('GET', '/chat/folders');
  }
  /** Move a conversation into a folder (or clear it with undefined). */
  async moveToFolder(conversationId: string, folderId?: string): Promise<{ ok: boolean }> {
    return this.c.request('POST', '/chat/folder/move', { id: conversationId, ...(folderId ? { folderId } : {}) });
  }
  /** Archive or restore a conversation (owner only; archived hidden from lists). */
  async setArchived(conversationId: string, archived: boolean): Promise<{ archived: boolean }> {
    return this.c.request('POST', '/tanya/conversation/archive', { id: conversationId, archived });
  }
  /** Pin or unpin a conversation (owner only). */
  async setPinned(conversationId: string, pinned: boolean): Promise<{ pinned: boolean }> {
    return this.c.request('POST', '/tanya/conversation/pin', { id: conversationId, pinned });
  }
  /** Rollup summary of a conversation (owned by the caller). */
  async summarize(conversationId: string): Promise<{ summary: { conversationId: string; title: string; messageCount: number; userMessages: number; assistantMessages: number; firstMessage?: string; lastReply?: string; toolCalls: string[]; orgId?: string } }> {
    return this.c.request('POST', '/tanya/summarize', { conversationId });
  }
  /** Public share link for a conversation (anyone with the share id can read). */
  async createShareLink(conversationId: string): Promise<{ shareId: string }> {
    return this.c.request('POST', '/chat/share', { id: conversationId });
  }
  /** Read a publicly shared conversation by its share id (no auth required). */
  async getShared(shareId: string): Promise<{ title: string; messages: Array<{ id: string; role: string; content: string; createdAt: number }> }> {
    const r = await this.c.request<{ conversation: { title: string; messages: Array<{ id: string; role: string; content: string; createdAt: number }> } }>('GET', '/chat/shared', undefined, { id: shareId });
    return r.conversation;
  }
  /**
   * Org directory: conversations in an org. Owners/admins see everything
   * (adminOnly=1 requires owner/admin); regular members see their own.
   */
  async orgConversations(orgId: string, opts: { adminOnly?: boolean } = {}): Promise<{ orgId: string; conversations: Array<{ id: string; title: string; userId: string; messageCount: number; updatedAt: number }>; count: number }> {
    return this.c.request('GET', '/tanya/org', undefined, { orgId, ...(opts.adminOnly ? { adminOnly: '1' } : {}) });
  }
  /** Export a conversation as JSON (default), Markdown, or plain text. */
  async export(conversationId: string, format: 'json' | 'markdown' | 'text' = 'json'): Promise<string> {
    return this.c.requestText('GET', `/chat/export?format=${format}`, undefined, { id: conversationId });
  }
  private q(opts: Record<string, string | number | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) out[k] = String(v);
    return out;
  }
}

// --- Governance alerts ----------------------------------------------------------

export class AlertsClient {
  constructor(private c: JataQiClient) {}
  /** Evaluate the governance SLA rules (approval queue / DENY spike / R4 rate). */
  async list(): Promise<{ checkedAt: number; alerts: Array<{ id: string; severity: string; state: string; message: string; value: number; threshold: number; checkedAt: number }> }> {
    return this.c.request('GET', '/governance/alerts');
  }
}

// --- TANYA Mobile Native ---------------------------------------------------------

export class MobileClient {
  constructor(private c: JataQiClient) {}
  /** Register this device for push notifications (FCM/APNs token). */
  async registerDevice(platform: 'ios' | 'android', opts: { pushToken?: string; name?: string; locale?: string } = {}): Promise<{ device: { id: string; platform: string; pushToken?: string; name?: string; locale?: string; lastSeenAt: number } }> {
    return this.c.request('POST', '/mobile/devices', { platform, ...opts });
  }
  /** List the caller's registered devices. */
  async listDevices(): Promise<{ devices: Array<{ id: string; platform: string; pushToken?: string; name?: string; locale?: string; lastSeenAt: number }>; count: number }> {
    return this.c.request('GET', '/mobile/devices');
  }
  async unregisterDevice(deviceId: string): Promise<{ removed: boolean }> {
    return this.c.request('POST', '/mobile/devices/unregister', { deviceId });
  }
  /** Replay offline-queued messages through TANYA chat. */
  async syncOutbox(messages: Array<{ id: string; message: string; conversationId?: string; persona?: string; orgId?: string }>): Promise<{ results: Array<{ messageId: string; status: string; conversationId?: string; reply?: string; error?: string }>; storedForRetry: number }> {
    return this.c.request('POST', '/mobile/outbox', { messages });
  }
  /** One-call home-screen bootstrap. */
  async snapshot(): Promise<{ serverTime: number; userId: string; devices: unknown[]; personas: Array<{ id: string; name: string; description: string }>; myOrgs: Array<{ id: string; name: string; slug: string; role?: string }>; recentConversations: Array<{ id: string; title: string; updatedAt: number; messageCount: number; pinned: boolean; orgId?: string }>; sharedWithMeCount: number; pendingApprovalCount: number }> {
    return this.c.request('GET', '/mobile/snapshot');
  }
  /** Send a push notification to the caller's devices (payloads returned). */
  async notify(title: string, body: string, opts: { event?: string; data?: Record<string, unknown> } = {}): Promise<{ delivered: number; payloads: Array<{ apns: Record<string, unknown>; fcm: Record<string, unknown> }> }> {
    return this.c.request('POST', '/mobile/notify', { title, body, ...opts });
  }
  /** Publish a push through the event bridge to any user's devices. */
  async emitPush(userId: string, title: string, body: string, opts: { event?: string; data?: Record<string, unknown> } = {}): Promise<{ delivered: number }> {
    return this.c.request('POST', '/mobile/push', { userId, title, body, ...opts });
  }
}

// --- PKI / IdP ------------------------------------------------------------------

export class PkiClient {
  constructor(private c: JataQiClient) {}
  /** OIDC refresh_token grant — new access token + rotated refresh token. */
  async idpRefresh(refreshToken: string, clientId: string, clientSecret: string): Promise<{ access_token: string; token_type: string; expires_in: number; refresh_token?: string; scope?: string }> {
    return this.c.request('POST', '/pki/idp/refresh', { refreshToken, clientId, clientSecret });
  }
  /** Revoke an IdP token (access or refresh) — revoke-on-logout parity. */
  async revoke(token: string): Promise<{ revoked: boolean }> {
    return this.c.request('POST', '/pki/idp/revoke', { token });
  }
  /** One-call session rotation — refreshed IdP token + fresh platform session. */
  async rotate(refreshToken: string, clientId: string, clientSecret: string): Promise<{
    ok: boolean; reason?: string;
    idpTokens?: { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
    session?: { token: string; userId: string; username: string; expiresAt: number };
    principal?: { userId: string; username: string; roles: string[] };
  }> {
    return this.c.request('POST', '/pki/idp/rotate', { refreshToken, clientId, clientSecret });
  }
  /** Upsert an IdP user profile (claims incl. roles) — requires pki:write. */
  async upsertProfile(sub: string, claims: { name?: string; email?: string; preferred_username?: string; roles?: string[] } = {}): Promise<{ profile: Record<string, unknown> }> {
    return this.c.request('POST', '/pki/idp/profile', { sub, ...claims });
  }
  /** IdP-first login: client-credentials grant → fresh platform session (no password). */
  async consoleLogin(clientId: string, clientSecret: string): Promise<{
    ok: boolean; reason?: string;
    idpTokens?: { access_token: string; expires_in: number; scope?: string };
    session?: { token: string; userId: string; username: string; expiresAt: number };
    principal?: { userId: string; username: string; roles: string[] };
  }> {
    try {
      const r = await this.c.request<{ ok: boolean; reason?: string; idpTokens?: { access_token: string; expires_in: number; scope?: string }; session?: { token: string; userId: string; username: string; expiresAt: number }; principal?: { userId: string; username: string; roles: string[] } }>('POST', '/pki/idp/console-login', { clientId, clientSecret, scope: 'openid profile' });
      if (r.ok && r.session) this.c.setToken(r.session.token);
      return r;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
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
  /** Session introspection — expiresAt/remainingMs for the current token (undefined when unauthenticated). */
  async session(): Promise<{ ok: boolean; expiresAt: number; remainingMs: number; username: string; userId: string; roles: string[] } | undefined> {
    if (!this.c.getToken()) return undefined;
    try {
      return await this.c.request('GET', '/auth/session');
    } catch {
      return undefined;
    }
  }
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
  /** Invite a colleague (by email or userId) — returns the invitation token. */
  async invite(orgId: string, target: string, role: 'member' | 'admin' | 'owner' = 'member'): Promise<{ invitation: { token: string; target: string; role: string } }> {
    return this.c.request('POST', '/org', { id: orgId, action: 'invite', target, role });
  }
  /** Accept an invitation with its token. */
  async acceptInvitation(token: string): Promise<{ membership: unknown }> {
    return this.c.request('POST', '/org', { id: 'invite', action: 'accept', token });
  }
  /** Organizations the current user belongs to. */
  async mine(): Promise<{ organizations: Array<{ id: string; name: string; slug: string; ownerId: string }> }> {
    return this.c.request('GET', '/orgs');
  }
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

// --- MAZA marketplace (purchase flows) --------------------------------------

export class MarketplaceClient {
  constructor(private c: JataQiClient) {}
  async storefronts(): Promise<{ storefronts: unknown[]; count: number }> { return this.c.request('GET', '/marketplace/storefronts'); }
  async registerStorefront(vendorId: string, name: string, opts: { description?: string; categories?: string[] } = {}): Promise<{ storefront: unknown }> {
    return this.c.request('POST', '/marketplace/storefronts', { vendorId, name, ...opts });
  }
  async listings(opts: { category?: string; status?: string; query?: string; maxPrice?: number } = {}): Promise<{ listings: unknown[]; count: number }> {
    return this.c.request('GET', '/marketplace/listings', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async createListing(input: { storefrontId: string; title: string; category: string; priceMinor: number; currency?: string; description?: string; stock?: number }): Promise<{ listing: unknown }> {
    return this.c.request('POST', '/marketplace/listings', input);
  }
  async stats(): Promise<{ stats: unknown; analytics: unknown }> { return this.c.request('GET', '/marketplace/stats'); }
  async cart(buyerId: string): Promise<{ cart: unknown }> { return this.c.request('POST', '/marketplace/cart', { buyerId }); }
  async getCart(cartId: string): Promise<{ cart: unknown }> { return this.c.request('GET', '/marketplace/cart', undefined, { id: cartId }); }
  async addToCart(cartId: string, listingId: string, quantity = 1): Promise<{ cart: unknown }> {
    return this.c.request('POST', '/marketplace/cart/items', { cartId, listingId, quantity });
  }
  async removeFromCart(cartId: string, listingId: string): Promise<{ cart: unknown }> {
    return this.c.request('POST', '/marketplace/cart/items/remove', { cartId, listingId });
  }
  async clearCart(cartId: string): Promise<{ cart: unknown }> { return this.c.request('POST', '/marketplace/cart/clear', { cartId }); }
  async checkout(cartId: string): Promise<{ order: unknown }> { return this.c.request('POST', '/marketplace/checkout', { cartId }); }
  async orders(opts: { buyerId?: string; vendorId?: string; status?: string } = {}): Promise<{ orders: unknown[]; count: number }> {
    return this.c.request('GET', '/marketplace/orders', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async getOrder(orderId: string): Promise<{ order: unknown }> { return this.c.request('GET', '/marketplace/order', undefined, { id: orderId }); }
  async cancelOrder(orderId: string, buyerId: string): Promise<{ order: unknown }> {
    return this.c.request('POST', '/marketplace/order/cancel', { orderId, buyerId });
  }
  async refundOrder(orderId: string): Promise<{ order: unknown }> { return this.c.request('POST', '/marketplace/order/refund', { orderId }); }
  async payouts(opts: { vendorId?: string; status?: string } = {}): Promise<{ payouts: unknown[]; count: number }> {
    return this.c.request('GET', '/marketplace/payouts', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
}

// --- Cloud (PRX Part E) ------------------------------------------------------

export class CloudClient {
  constructor(private c: JataQiClient) {}
  async regions(): Promise<{ regions: unknown[]; count: number }> { return this.c.request('GET', '/cloud/regions'); }
  async registerRegion(input: { name: string; code: string; country: string; zones: string[]; capacitySlots?: number }): Promise<{ region: unknown }> {
    return this.c.request('POST', '/cloud/regions', input);
  }
  async flavors(): Promise<{ flavors: unknown[]; count: number }> { return this.c.request('GET', '/cloud/flavors'); }
  async registerFlavor(input: { name: string; tier: string; vcpu: number; ramGb: number; diskGb: number; pricePerHourMinor: number; gpu?: number }): Promise<{ flavor: unknown }> {
    return this.c.request('POST', '/cloud/flavors', input);
  }
  async images(): Promise<{ images: unknown[]; count: number }> { return this.c.request('GET', '/cloud/images'); }
  async instances(opts: { regionId?: string; status?: string } = {}): Promise<{ instances: unknown[]; count: number }> {
    return this.c.request('GET', '/cloud/instances', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async provisionInstance(input: { name: string; regionId: string; flavorId: string; imageId: string; vpcId?: string; autoscalingGroupId?: string }): Promise<{ instance: unknown }> {
    return this.c.request('POST', '/cloud/instances', input);
  }
  async setInstanceStatus(instanceId: string, status: string): Promise<{ instance: unknown }> {
    return this.c.request('POST', '/cloud/instances/status', { instanceId, status });
  }
  async autoscaleGroups(): Promise<{ groups: unknown[]; count: number }> { return this.c.request('GET', '/cloud/autoscaling'); }
  async createAutoscaleGroup(input: { name: string; regionId: string; templateInstanceId: string; min: number; max: number; cpuHighThreshold?: number; cpuLowThreshold?: number; cooldownMs?: number; memoryHighThreshold?: number; memoryLowThreshold?: number; schedule?: unknown }): Promise<{ group: unknown }> {
    return this.c.request('POST', '/cloud/autoscaling', input);
  }
  async evaluateAutoscale(groupId: string, load: { cpu?: number; memory?: number; requestsPerMinute?: number }): Promise<{ result: unknown }> {
    return this.c.request('POST', '/cloud/autoscaling/evaluate', { groupId, ...load });
  }
  async updateAutoscaleGroup(groupId: string, input: Record<string, unknown>): Promise<{ group: unknown }> {
    return this.c.request('POST', '/cloud/autoscaling/update', { groupId, ...input });
  }
  async autoscaleHistory(groupId?: string): Promise<{ decisions: unknown[]; count: number }> {
    return this.c.request('GET', '/cloud/autoscaling/history', undefined, groupId ? { groupId } : undefined);
  }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/cloud/stats'); }
}

// --- Active Defense & Adaptive Resilience -------------------------------------

export class DefenseClient {
  constructor(private c: JataQiClient) {}
  /** Current security posture: stats, risk distribution, findings by severity. */
  async posture(): Promise<{ stats: Record<string, unknown>; riskDistribution: Record<string, number>; findingsBySeverity: Record<string, number>; blockedSessions: number }> {
    return this.c.request('GET', '/defense/posture');
  }
  async findings(opts: { severity?: string; status?: string } = {}): Promise<{ findings: unknown[]; count: number }> {
    return this.c.request('GET', '/defense/findings', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async acknowledgeFinding(id: string): Promise<{ finding: unknown }> { return this.c.request('POST', '/defense/findings/ack', { id }); }
  async resolveFinding(id: string): Promise<{ finding: unknown }> { return this.c.request('POST', '/defense/findings/resolve', { id }); }
  /** Ingest a telemetry event → optional finding. */
  async ingest(type: string, opts: { actor?: string; severity?: string; title?: string; detail?: string; context?: Record<string, unknown> } = {}): Promise<{ finding: unknown }> {
    return this.c.request('POST', '/defense/ingest', { type, ...opts });
  }
  async risk(userId: string): Promise<{ risk: { score: number; level: string; signals: unknown[] } }> {
    return this.c.request('GET', '/defense/risk', undefined, { userId });
  }
  /** Add a risk signal; returns the reassessed risk. */
  async signalRisk(userId: string, type: string, opts: { weight?: number; context?: string } = {}): Promise<{ risk: unknown }> {
    return this.c.request('POST', '/defense/risk/signal', { userId, type, ...opts });
  }
  async reassessTrust(userId: string): Promise<{ reassessed: boolean; userId: string }> {
    return this.c.request('POST', '/defense/trust/reassess', { userId });
  }
  async bans(): Promise<{ bans: unknown[]; count: number }> { return this.c.request('GET', '/defense/bans'); }
  async ban(scope: string, value: string, reason: string, opts: { durationMs?: number } = {}): Promise<{ ban: unknown }> {
    return this.c.request('POST', '/defense/bans', { scope, value, reason, ...opts });
  }
  async liftBan(id: string): Promise<{ lifted: boolean }> { return this.c.request('POST', '/defense/bans/lift', { id }); }
  async actions(opts: { status?: string; kind?: string } = {}): Promise<{ actions: unknown[]; count: number }> {
    return this.c.request('GET', '/defense/actions', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async contain(kind: string, target: string, reason: string): Promise<{ action: unknown }> {
    return this.c.request('POST', '/defense/contain', { kind, target, reason });
  }
  async approveAction(id: string): Promise<{ action: unknown }> { return this.c.request('POST', '/defense/actions/approve', { id }); }
  async denyAction(id: string, reason?: string): Promise<{ action: unknown }> { return this.c.request('POST', '/defense/actions/deny', { id, ...(reason ? { reason } : {}) }); }
  async honeytokens(): Promise<{ honeytokens: unknown[] }> { return this.c.request('GET', '/defense/honeytokens'); }
  async createHoneytoken(label: string, value: string, placement: string): Promise<{ honeytoken: unknown }> {
    return this.c.request('POST', '/defense/honeytokens', { label, value, placement });
  }
  async decoys(): Promise<{ decoys: unknown[] }> { return this.c.request('GET', '/defense/decoys'); }
  async createDecoy(name: string, kind: string, opts: { endpoint?: string } = {}): Promise<{ decoy: unknown }> {
    return this.c.request('POST', '/defense/decoys', { name, kind, ...opts });
  }
  async touches(): Promise<{ touches: unknown[] }> { return this.c.request('GET', '/defense/touches'); }
  async incidents(): Promise<{ incidents: unknown[] }> { return this.c.request('GET', '/defense/incidents'); }
  async recordIncident(title: string, severity: string): Promise<{ incident: unknown }> {
    return this.c.request('POST', '/defense/incidents', { title, severity });
  }
  async reviewIncident(id: string, rca: string, lessonsLearned: string[] = []): Promise<{ incident: unknown }> {
    return this.c.request('POST', '/defense/incidents/review', { id, rca, lessonsLearned });
  }
  async recover(target: string, opts: { fromSnapshot?: string } = {}): Promise<{ recovery: unknown }> {
    return this.c.request('POST', '/defense/recover', { target, ...opts });
  }
  async recoveries(): Promise<{ recoveries: unknown[] }> { return this.c.request('GET', '/defense/recovery'); }
  async validateIntegrity(manifest: Array<{ path: string; sha256: string }>): Promise<{ results: Array<{ path: string; ok: boolean; actual?: string }>; ok: boolean }> {
    return this.c.request('POST', '/defense/integrity', { manifest });
  }
  async rotateCrypto(scope: string, minIntervalMs?: number): Promise<{ rotated: boolean; rotatedAt: number; reason?: string }> {
    return this.c.request('POST', '/defense/crypto/rotate', { scope, ...(minIntervalMs !== undefined ? { minIntervalMs } : {}) });
  }
  /** Executive security report. */
  async report(): Promise<{ report: unknown }> { return this.c.request('GET', '/defense/report'); }
}

// --- Global Security Operations (SOC) ------------------------------------------

export class SocClient {
  constructor(private c: JataQiClient) {}
  /** Executive SOC report: KPIs, open incidents, alerts, intel, lake integrity. */
  async report(): Promise<{ report: unknown }> { return this.c.request('GET', '/soc/report'); }
  async kpis(): Promise<{ kpis: unknown }> { return this.c.request('GET', '/soc/kpis'); }
  async lakeStatus(): Promise<{ entries: number; chainValid: boolean; integrity: { valid: boolean; brokenAt?: string } }> {
    return this.c.request('GET', '/soc/lake/status');
  }
  async lake(opts: { type?: string; actor?: string; limit?: number } = {}): Promise<{ entries: unknown[]; count: number; analytics: unknown }> {
    return this.c.request('GET', '/soc/lake', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  /** Ingest a security telemetry event into the pipeline + data lake. */
  async ingestEvent(input: { source: string; type: string; actor?: string; origin?: string; severity?: string; detail?: string; data?: Record<string, unknown> }): Promise<{ entry: unknown }> {
    return this.c.request('POST', '/soc/telemetry', input);
  }
  async incidents(opts: { severity?: string; status?: string } = {}): Promise<{ incidents: unknown[]; count: number }> {
    return this.c.request('GET', '/soc/incidents', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async openIncident(title: string, severity: string, opts: { commander?: string; responders?: string[] } = {}): Promise<{ incident: unknown }> {
    return this.c.request('POST', '/soc/incidents', { title, severity, ...opts });
  }
  async transition(incidentId: string, status: string, by: string, note = ''): Promise<{ incident: unknown }> {
    return this.c.request('POST', '/soc/incidents/transition', { id: incidentId, status, by, note });
  }
  async preserveEvidence(incidentId: string, input: { description: string; artifactHash?: string; preservedBy: string }): Promise<{ evidence: unknown }> {
    return this.c.request('POST', '/soc/incidents/evidence', { id: incidentId, ...input });
  }
  async communicate(incidentId: string, input: { channel: string; message: string; by: string; to?: string }): Promise<{ communication: unknown }> {
    return this.c.request('POST', '/soc/incidents/communicate', { id: incidentId, ...input });
  }
  async reviewIncident(incidentId: string, rca: string, by: string, lessons: string[] = []): Promise<{ incident: unknown }> {
    return this.c.request('POST', '/soc/incidents/review', { id: incidentId, rca, by, lessons });
  }
  async escalate(): Promise<{ results: unknown[] }> { return this.c.request('POST', '/soc/escalate'); }
  /** Run a threat hunt playbook against the lake. */
  async hunt(playbook: string, opts: { since?: number; limit?: number } = {}): Promise<{ session: unknown }> {
    return this.c.request('POST', '/soc/hunt', { playbook, ...opts });
  }
  async hunts(): Promise<{ hunts: unknown[] }> { return this.c.request('GET', '/soc/hunts'); }
  async playbooks(): Promise<{ playbooks: unknown[] }> { return this.c.request('GET', '/soc/playbooks'); }
  async huntCorrelation(): Promise<{ actors: unknown[] }> { return this.c.request('GET', '/soc/hunt-correlation'); }
  async ingestIntel(input: { type: string; value: string; confidence: number; severity: string; source: string; tlp?: string; expiresAt?: number; tags?: string[] }): Promise<{ indicator: unknown }> {
    return this.c.request('POST', '/soc/intel', input);
  }
  async intel(opts: { type?: string; severity?: string; source?: string } = {}): Promise<{ indicators: unknown[] }> {
    return this.c.request('GET', '/soc/intel', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async matchIntel(observations: Array<{ value: string; context?: Record<string, unknown> }>): Promise<{ matches: unknown[] }> {
    return this.c.request('POST', '/soc/intel/match', { observations });
  }
  async intelMatches(): Promise<{ matches: unknown[] }> { return this.c.request('GET', '/soc/intel/matches'); }
  async intelCorrelation(): Promise<{ correlation: unknown[] }> { return this.c.request('GET', '/soc/intel/correlation'); }
  async intelHealth(): Promise<{ health: unknown }> { return this.c.request('GET', '/soc/intel/health'); }
  async insiderAlerts(): Promise<{ alerts: unknown[] }> { return this.c.request('GET', '/soc/insider/alerts'); }
  async observeInsider(input: { actor: string; action: string; sensitivity: string; detail?: string }): Promise<{ alert: unknown }> {
    return this.c.request('POST', '/soc/insider/observe', input);
  }
  async insiderPosture(principals: Array<{ principal: string; roles: string[] }>): Promise<{ posture: unknown[] }> {
    return this.c.request('POST', '/soc/insider/posture', { principals });
  }
  async abuseAlerts(): Promise<{ alerts: unknown[] }> { return this.c.request('GET', '/soc/abuse/alerts'); }
  async observeAbuse(input: { kind: string; actor?: string; origin?: string; value?: string }): Promise<{ alert: unknown }> {
    return this.c.request('POST', '/soc/abuse/observe', input);
  }
  async abuseCoordinated(): Promise<{ clusters: unknown[] }> { return this.c.request('GET', '/soc/abuse/coordinated'); }
  /** Run an adversarial validation campaign (red/purple team). */
  async runCampaign(kind: string): Promise<{ campaign: unknown }> { return this.c.request('POST', '/soc/campaigns', { kind }); }
  async campaigns(): Promise<{ campaigns: unknown[] }> { return this.c.request('GET', '/soc/campaigns'); }
  async validationScore(): Promise<{ score: number; campaigns: number }> { return this.c.request('GET', '/soc/validation'); }
  async addTabletop(input: { title: string; description: string; injects: string[]; facilitatorNotes?: string[] }): Promise<{ scenario: unknown }> {
    return this.c.request('POST', '/soc/tabletops', input);
  }
  async tabletops(): Promise<{ scenarios: unknown[] }> { return this.c.request('GET', '/soc/tabletops'); }
}

// --- Software Supply Chain Governance ---------------------------------------------

export class SupplyChainClient {
  constructor(private c: JataQiClient) {}
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/supplychain/stats'); }
  async checkRepository(repo: string, facts: { branch: string; signedCommits?: boolean; ciPassing?: boolean; reviewers?: number }): Promise<{ check: unknown }> {
    return this.c.request('POST', '/supplychain/repos/check', { repo, ...facts });
  }
  async repositories(): Promise<{ repositories: unknown[] }> { return this.c.request('GET', '/supplychain/repos'); }
  async checkPipeline(pipeline: string, facts: { pinnedSteps?: boolean; hasSecrets?: boolean; hasApproval?: boolean }): Promise<{ check: unknown }> {
    return this.c.request('POST', '/supplychain/pipelines/check', { pipeline, ...facts });
  }
  async pipelines(): Promise<{ pipelines: unknown[] }> { return this.c.request('GET', '/supplychain/pipelines'); }
  async auditLockfile(records: Array<{ name: string; integritySha512: string; license?: string }>, computed: Record<string, string>): Promise<{ audit: unknown }> {
    return this.c.request('POST', '/supplychain/audit', { records, computed });
  }
  async createProvenance(input: { artifactName: string; artifactSha256: string; builderId: string; buildId: string; materials?: Array<{ uri: string; digest: string }> }): Promise<{ provenance: unknown }> {
    return this.c.request('POST', '/supplychain/provenance', input);
  }
  async provenances(): Promise<{ provenances: unknown[] }> { return this.c.request('GET', '/supplychain/provenance'); }
  async verifyProvenance(id: string): Promise<{ verification: unknown }> { return this.c.request('POST', '/supplychain/provenance/verify', { id }); }
  async signRelease(input: { release: string; artifactName: string; artifactSha256: string; notes?: string }): Promise<{ release: unknown }> {
    return this.c.request('POST', '/supplychain/releases', input);
  }
  async releases(): Promise<{ releases: unknown[] }> { return this.c.request('GET', '/supplychain/releases'); }
  async verifyRelease(id: string): Promise<{ verification: unknown }> { return this.c.request('POST', '/supplychain/releases/verify', { id }); }
  async attestDeployment(input: { environment: string; artifactName: string; artifactSha256: string; deployer: string }): Promise<{ attestation: unknown; status: string }> {
    return this.c.request('POST', '/supplychain/deployments', input);
  }
  async deployments(): Promise<{ attestations: unknown[] }> { return this.c.request('GET', '/supplychain/deployments'); }
  async checkIntegrity(input: { release: string; artifactName: string; artifactSha256: string; deployedSha256?: string }): Promise<{ check: unknown }> {
    return this.c.request('POST', '/supplychain/integrity', input);
  }
  async integrityHistory(): Promise<{ checks: unknown[] }> { return this.c.request('GET', '/supplychain/integrity'); }
  async monitor(): Promise<{ monitoring: unknown[] }> { return this.c.request('GET', '/supplychain/monitor'); }
}

// --- Secure Infrastructure Governance ---------------------------------------------

export class InfraClient {
  constructor(private c: JataQiClient) {}
  async stats(): Promise<{ stats: unknown; lifecycle: unknown }> { return this.c.request('GET', '/infra/stats'); }
  async registerAsset(input: { serial: string; model: string; role: string; firmwareVersion: string; firmwareSha256?: string; measuredBoot?: string; location?: string; eolAt?: number }): Promise<{ asset: unknown }> {
    return this.c.request('POST', '/infra/assets', input);
  }
  async assets(opts: { status?: string; role?: string; eol?: boolean } = {}): Promise<{ assets: unknown[]; count: number }> {
    const query: Record<string, string> = {};
    if (opts.status) query.status = opts.status;
    if (opts.role) query.role = opts.role;
    if (opts.eol) query.eol = '1';
    return this.c.request('GET', '/infra/assets', undefined, query);
  }
  async setAssetStatus(serial: string, status: string): Promise<{ asset: unknown }> { return this.c.request('POST', '/infra/assets/status', { serial, status }); }
  async enrollProvisioning(input: { serial: string; token: string; enrolledBy: string; method?: string }): Promise<{ provisioning: unknown }> {
    return this.c.request('POST', '/infra/provisioning', input);
  }
  async approveProvisioning(id: string): Promise<{ provisioning: unknown }> { return this.c.request('POST', '/infra/provisioning/approve', { id }); }
  async provisionings(): Promise<{ provisionings: unknown[] }> { return this.c.request('GET', '/infra/provisioning'); }
  async validateFirmware(serial: string, actualSha256: string, measuredBoot?: string): Promise<{ asset: unknown; status: string }> {
    return this.c.request('POST', '/infra/firmware/validate', { serial, actualSha256, ...(measuredBoot ? { measuredBoot } : {}) });
  }
  async firmwareReport(): Promise<{ report: unknown }> { return this.c.request('GET', '/infra/firmware'); }
  async detectDrift(serial: string, golden: Record<string, string>, live: Record<string, string>): Promise<{ drifts: unknown[]; count: number }> {
    return this.c.request('POST', '/infra/drift', { serial, golden, live });
  }
  async drifts(opts: { severity?: string; open?: boolean } = {}): Promise<{ drifts: unknown[]; count: number }> {
    const query: Record<string, string> = {};
    if (opts.severity) query.severity = opts.severity;
    if (opts.open) query.open = '1';
    return this.c.request('GET', '/infra/drift', undefined, query);
  }
  async remediateDrift(id: string): Promise<{ drift: unknown }> { return this.c.request('POST', '/infra/drift/remediate', { id }); }
  async runCompliance(facts: Record<string, boolean>): Promise<{ checks: unknown[] }> { return this.c.request('POST', '/infra/compliance', { facts }); }
  async complianceReport(): Promise<{ report: unknown }> { return this.c.request('GET', '/infra/compliance'); }
  async logAccess(input: { facility: string; zone: string; person: string; action: string; reason?: string }): Promise<{ record: unknown }> {
    return this.c.request('POST', '/infra/access', input);
  }
  async accessLog(opts: { facility?: string; action?: string } = {}): Promise<{ log: unknown[]; count: number; patterns: unknown[] }> {
    return this.c.request('GET', '/infra/access', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
}

// --- Global Resilience Engineering ------------------------------------------------

export class ResilienceClient {
  constructor(private c: JataQiClient) {}
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/resilience/stats'); }
  async regions(): Promise<{ regions: unknown[] }> { return this.c.request('GET', '/resilience/regions'); }
  async registerRegion(input: { name: string; location: string; role: string; priority: number }): Promise<{ region: unknown }> {
    return this.c.request('POST', '/resilience/regions', input);
  }
  async setRegionRole(name: string, role: string): Promise<{ region: unknown }> { return this.c.request('POST', '/resilience/regions/role', { name, role }); }
  async health(): Promise<{ regions: Record<string, string> }> { return this.c.request('GET', '/resilience/health'); }
  /** Record a readiness probe for a workload in a region. */
  async probe(workload: string, region: string, ok: boolean, latencyMs?: number, detail?: string): Promise<{ probe: unknown }> {
    return this.c.request('POST', '/resilience/probe', { workload, region, ok, ...(latencyMs !== undefined ? { latencyMs } : {}), ...(detail ? { detail } : {}) });
  }
  /** Evaluate automated failover for a workload (primary down → promote standby). */
  async failover(workload: string): Promise<{ run: unknown }> { return this.c.request('POST', '/resilience/failover', { workload }); }
  async failback(workload: string, approver: string): Promise<{ run: unknown }> { return this.c.request('POST', '/resilience/failback', { workload, approver }); }
  async failovers(): Promise<{ failovers: unknown[] }> { return this.c.request('GET', '/resilience/failovers'); }
  async createPlan(workload: string, rpoMs: number, rtoMs: number, createdBy: string): Promise<{ plan: unknown }> {
    return this.c.request('POST', '/resilience/plans', { workload, rpoMs, rtoMs, createdBy });
  }
  async plans(): Promise<{ plans: unknown[] }> { return this.c.request('GET', '/resilience/plans'); }
  async executePlan(planId: string, opts: { snapshotAgeMs?: number; failStep?: string } = {}): Promise<{ execution: unknown }> {
    return this.c.request('POST', '/resilience/plans/execute', { planId, ...opts });
  }
  async executions(): Promise<{ executions: unknown[] }> { return this.c.request('GET', '/resilience/executions'); }
  async compliance(): Promise<{ compliance: unknown }> { return this.c.request('GET', '/resilience/compliance'); }
  async injectFault(input: { workload: string; kind: string; target: string; intensity: number; durationMs: number }): Promise<{ fault: unknown }> {
    return this.c.request('POST', '/resilience/faults', input);
  }
  async endFault(id: string): Promise<{ fault: unknown }> { return this.c.request('POST', '/resilience/faults/end', { id }); }
  async faults(opts: { active?: boolean } = {}): Promise<{ faults: unknown[] }> {
    return this.c.request('GET', '/resilience/faults', undefined, opts.active ? { active: '1' } : undefined);
  }
  /** Run a full resilience test: inject fault → recover within RTO → survived? */
  async runTest(input: { workload: string; kind: string; target: string; intensity: number; durationMs: number; planId: string; snapshotAgeMs?: number; failStep?: string }): Promise<{ fault: unknown; execution: unknown; survived: boolean }> {
    return this.c.request('POST', '/resilience/tests', input);
  }
  async recordAvailability(workload: string, windowMs: number, uptime: number, slo: number): Promise<{ availability: unknown }> {
    return this.c.request('POST', '/resilience/availability', { workload, windowMs, uptime, slo });
  }
  async availability(): Promise<{ availability: Array<{ workload: string; healthy: boolean }>; records: unknown[] }> {
    return this.c.request('GET', '/resilience/availability');
  }
  async probes(opts: { workload?: string; region?: string; ok?: boolean } = {}): Promise<{ probes: unknown[]; count: number }> {
    const query: Record<string, string> = {};
    if (opts.workload) query.workload = opts.workload;
    if (opts.region) query.region = opts.region;
    if (opts.ok !== undefined) query.ok = opts.ok ? '1' : '0';
    return this.c.request('GET', '/resilience/probes', undefined, query);
  }
}

// --- Privacy Engineering (PIA / RoPA / secure deletion / minimization) -----------

export class PrivacyClient {
  constructor(private c: JataQiClient) {}
  async submitPia(input: { title: string; flow: string; dataFlows: Array<{ flow: string; dataKinds: string[]; recipients: string[]; storage?: string; retentionDays?: number }>; assessedBy: string }): Promise<{ pia: unknown }> {
    return this.c.request('POST', '/privacy/pia', input);
  }
  async pias(opts: { status?: string } = {}): Promise<{ pias: unknown[] }> {
    return this.c.request('GET', '/privacy/pia', undefined, opts.status ? { status: opts.status } : undefined);
  }
  async decidePia(id: string, decision: 'approved' | 'rejected', approver: string, reason?: string): Promise<{ pia: unknown }> {
    return this.c.request('POST', '/privacy/pia/decide', { id, decision, approver, ...(reason ? { reason } : {}) });
  }
  async registerProcessing(input: { activity: string; controller: string; dataKinds: string[]; purposes: string[]; legalBasis: string; recipients: string[]; transfers?: string[]; retentionDays?: number }): Promise<{ record: unknown }> {
    return this.c.request('POST', '/privacy/processing', input);
  }
  async processing(controller?: string): Promise<{ records: unknown[] }> {
    return this.c.request('GET', '/privacy/processing', undefined, controller ? { controller } : undefined);
  }
  async secureDelete(target: string, dataKind: string, performedBy: string, opts: { method?: string; keyDestroyed?: boolean } = {}): Promise<{ deletion: unknown }> {
    return this.c.request('POST', '/privacy/secure-delete', { target, dataKind, performedBy, ...opts });
  }
  async deletions(target?: string): Promise<{ deletions: unknown[] }> {
    return this.c.request('GET', '/privacy/deletions', undefined, target ? { target } : undefined);
  }
  async minimizeCheck(purpose: string, collected: string[], necessary: string[]): Promise<{ check: unknown }> {
    return this.c.request('POST', '/privacy/minimize', { purpose, collected, necessary });
  }
  async minimizationChecks(): Promise<{ checks: unknown[] }> { return this.c.request('GET', '/privacy/minimize'); }
  async posture(): Promise<{ posture: unknown }> { return this.c.request('GET', '/privacy/posture'); }
}

// --- Independent Security Review ------------------------------------------------

export class ReviewClient {
  constructor(private c: JataQiClient) {}
  /** Schedule an independent security review (architecture/code/infra/ai_safety/compliance/independent_audit). */
  async schedule(kind: string, target: string, reviewer: string, opts: { phase?: string } = {}): Promise<{ review: unknown }> {
    return this.c.request('POST', '/review/schedule', { kind, target, reviewer, ...opts });
  }
  async list(opts: { kind?: string; status?: string; target?: string } = {}): Promise<{ reviews: unknown[]; count: number }> {
    return this.c.request('GET', '/review', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async start(id: string): Promise<{ review: unknown }> { return this.c.request('POST', '/review/start', { id }); }
  async complete(id: string, summary: string): Promise<{ review: unknown }> { return this.c.request('POST', '/review/complete', { id, summary }); }
  async signOff(id: string, approver: string): Promise<{ review: unknown }> { return this.c.request('POST', '/review/signoff', { id, approver }); }
  async addFinding(reviewId: string, severity: string, title: string, opts: { description?: string; controlRef?: string; recommendation?: string; createdBy?: string } = {}): Promise<{ finding: unknown }> {
    return this.c.request('POST', '/review/findings', { reviewId, severity, title, ...opts });
  }
  async findings(opts: { reviewId?: string; severity?: string; status?: string } = {}): Promise<{ findings: unknown[]; count: number }> {
    return this.c.request('GET', '/review/findings', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async updateFinding(id: string, status: string, by: string, note?: string): Promise<{ finding: unknown }> {
    return this.c.request('POST', '/review/findings/update', { id, status, by, ...(note ? { note } : {}) });
  }
  /** Static secure-code scan (optionally auto-creating findings for a review). */
  async scanCode(files: Array<{ path: string; content: string }>, opts: { reviewId?: string; reviewer?: string } = {}): Promise<{ hits: unknown[]; count: number }> {
    return this.c.request('POST', '/review/scan', { files, ...opts });
  }
  async architecture(answers: Array<{ questionId: string; score: number }>): Promise<{ assessment: unknown }> {
    return this.c.request('POST', '/review/architecture', { answers });
  }
  async compliance(evidence: Record<string, boolean>): Promise<{ assessment: unknown }> {
    return this.c.request('POST', '/review/compliance', { evidence });
  }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/review/stats'); }
}

// --- Security Automation (cross-pillar) ------------------------------------------

export class SecautoClient {
  constructor(private c: JataQiClient) {}
  /** Correlation rules (bus event → SOC incident/ban/risk mappings). */
  async rules(): Promise<{ rules: unknown[] }> { return this.c.request('GET', '/security-automation/rules'); }
  async upsertRule(rule: Record<string, unknown>): Promise<{ rules: unknown[] }> {
    return this.c.request('POST', '/security-automation/rules', rule);
  }
  async correlations(): Promise<{ correlations: unknown[]; open: number }> {
    return this.c.request('GET', '/security-automation/correlations');
  }
  async posture(): Promise<{ correlations: unknown[]; openCorrelations: number; rules: number; huntsRunning: boolean; huntConfig: unknown; sweeps: number }> {
    return this.c.request('GET', '/security-automation/posture');
  }
  async hunts(): Promise<{ sweeps: unknown[] }> { return this.c.request('GET', '/security-automation/hunts'); }
  /** Run a full threat-hunt sweep now. */
  async runHunts(): Promise<{ result: { at: number; totalHits: number; triggered: boolean } }> {
    return this.c.request('POST', '/security-automation/hunts/run');
  }
  async scheduleHunts(input: { intervalMs: number; playbooks?: string[]; sinceMs?: number }): Promise<{ config: unknown }> {
    return this.c.request('POST', '/security-automation/hunts/schedule', input);
  }
  async complianceReport(): Promise<{ report: unknown }> { return this.c.request('GET', '/security-automation/compliance-report'); }
  /** Compliance evidence export (JSON). */
  async complianceExport(): Promise<string> { return this.c.requestText('GET', '/security-automation/compliance-report/export'); }
}

// --- Data Loss Prevention -----------------------------------------------------

export class DlpClient {
  constructor(private c: JataQiClient) {}
  async rules(): Promise<{ rules: unknown[] }> { return this.c.request('GET', '/dlp/rules'); }
  async upsertRule(rule: Record<string, unknown>): Promise<{ rules: unknown[] }> { return this.c.request('POST', '/dlp/rules', rule); }
  /** Scan content on a channel; returns the action, results, and optional incident. */
  async scan(input: { content: string; channel: string; actor?: string; destination?: string }): Promise<{ results: unknown[]; incident?: unknown; action: string }> {
    return this.c.request('POST', '/dlp/scan', input);
  }
  async incidents(opts: { dataType?: string; status?: string; channel?: string } = {}): Promise<{ incidents: unknown[]; count: number }> {
    return this.c.request('GET', '/dlp/incidents', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async updateIncident(id: string, status: string): Promise<{ incident: unknown }> { return this.c.request('POST', '/dlp/incidents/update', { id, status }); }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/dlp/stats'); }
}

// --- Post-Quantum Readiness ----------------------------------------------------

export class PqcClient {
  constructor(private c: JataQiClient) {}
  async algorithms(opts: { purpose?: string; status?: string } = {}): Promise<{ algorithms: unknown[] }> {
    return this.c.request('GET', '/pqc/algorithms', undefined, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
  }
  async deprecate(id: string): Promise<{ algorithm: unknown }> { return this.c.request('POST', '/pqc/deprecate', { id }); }
  async generateKey(algorithm: string, purpose: string, opts: { hybridWith?: string } = {}): Promise<{ key: unknown }> {
    return this.c.request('POST', '/pqc/keys', { algorithm, purpose, ...opts });
  }
  async keys(opts: { purpose?: string; hybrid?: boolean } = {}): Promise<{ keys: unknown[] }> {
    const query: Record<string, string> = {};
    if (opts.purpose) query.purpose = opts.purpose;
    if (opts.hybrid) query.hybrid = '1';
    return this.c.request('GET', '/pqc/keys', undefined, query);
  }
  async publicKeys(): Promise<{ keys: unknown[] }> { return this.c.request('GET', '/pqc/keys/public'); }
  async sign(workload: string, algorithm: string, payload: string, privateKey: string): Promise<{ envelope: unknown }> {
    return this.c.request('POST', '/pqc/sign', { workload, algorithm, payload, privateKey });
  }
  async verify(envelope: unknown, payload: string, publicKey: string): Promise<{ result: { verified: boolean; reason?: string } }> {
    return this.c.request('POST', '/pqc/verify', { envelope, payload, publicKey });
  }
  async signatures(opts: { workload?: string; hybrid?: boolean } = {}): Promise<{ signatures: unknown[] }> {
    const query: Record<string, string> = {};
    if (opts.workload) query.workload = opts.workload;
    if (opts.hybrid) query.hybrid = '1';
    return this.c.request('GET', '/pqc/signatures', undefined, query);
  }
  async advancePhase(workloads: string[], force = false): Promise<{ phase: string; migration: unknown[] }> {
    return this.c.request('POST', '/pqc/phase', { workloads, force });
  }
  async migration(): Promise<{ phase: string; migration: unknown[]; policy: unknown; pendingDeprecations: string[] }> {
    return this.c.request('GET', '/pqc/migration');
  }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/pqc/stats'); }
}

// --- Product Marketplace -----------------------------------------------------------

export class ProductMarketplaceClient {
  constructor(private c: JataQiClient) {}
  async catalog(): Promise<{ catalog: unknown[] }> { return this.c.request('GET', '/products/catalog'); }
  async registerProduct(input: { id: string; name: string; version: string; activates: string[]; kind?: string; description?: string; dependencies?: string[]; sizeMb?: number }): Promise<{ manifest: unknown }> {
    return this.c.request('POST', '/products', input);
  }
  /** One-click install (dependencies resolved + provisioned automatically). */
  async install(id: string): Promise<{ installed: unknown; order: string[] }> { return this.c.request('POST', '/products/install', { id }); }
  async upgrade(id: string): Promise<{ installed: unknown }> { return this.c.request('POST', '/products/upgrade', { id }); }
  async uninstall(id: string): Promise<{ removed: boolean; blockedBy: string[] }> { return this.c.request('POST', '/products/uninstall', { id }); }
  async setRuntime(id: string, runtime: string): Promise<{ installed: unknown }> { return this.c.request('POST', '/products/runtime', { id, runtime }); }
  async installed(): Promise<{ installed: unknown[] }> { return this.c.request('GET', '/products/installed'); }
  async upgrades(): Promise<{ upgrades: unknown[] }> { return this.c.request('GET', '/products/upgrades'); }
  async dependencies(id: string): Promise<{ graph: unknown }> { return this.c.request('GET', '/products/dependencies', undefined, { id }); }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/products/stats'); }
}

// --- Enterprise Onboarding ------------------------------------------------------------

export class OnboardingClient {
  constructor(private c: JataQiClient) {}
  async start(orgName: string, adminEmail: string, opts: { industry?: string; region?: string } = {}): Promise<{ run: unknown }> {
    return this.c.request('POST', '/onboarding/start', { orgName, adminEmail, ...opts });
  }
  async runs(): Promise<{ runs: unknown[] }> { return this.c.request('GET', '/onboarding'); }
  async getRun(id: string): Promise<{ run: unknown; progress: unknown }> { return this.c.request('GET', '/onboarding/run', undefined, { id }); }
  async setProfile(runId: string, profile: { name: string; slug: string; industry?: string; region?: string; sizeBand?: string }): Promise<{ run: unknown }> {
    return this.c.request('POST', '/onboarding/profile', { runId, ...profile });
  }
  async completeAdmin(runId: string, adminRoles: string[] = ['admin', 'developer']): Promise<{ run: unknown }> {
    return this.c.request('POST', '/onboarding/admin', { runId, adminRoles });
  }
  async provisionTenant(runId: string, opts: { region?: string; storageDriver?: string; quotas?: Record<string, number> } = {}): Promise<{ run: unknown }> {
    return this.c.request('POST', '/onboarding/tenant', { runId, ...opts });
  }
  async invite(runId: string, email: string, role: string): Promise<{ invite: unknown }> { return this.c.request('POST', '/onboarding/invite', { runId, email, role }); }
  async acceptInvite(runId: string, inviteId: string): Promise<{ invite: unknown }> { return this.c.request('POST', '/onboarding/invite/accept', { runId, inviteId }); }
  async completeInvitations(runId: string): Promise<{ run: unknown }> { return this.c.request('POST', '/onboarding/invitations/done', { runId }); }
  async generateSampleData(runId: string, kinds: string[], seed?: number): Promise<{ run: unknown }> {
    return this.c.request('POST', '/onboarding/sample-data', { runId, kinds, ...(seed !== undefined ? { seed } : {}) });
  }
  async complete(runId: string): Promise<{ run: unknown }> { return this.c.request('POST', '/onboarding/complete', { runId }); }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/onboarding/stats'); }
}

// --- Production Operations --------------------------------------------------------------

export class OperationsClient {
  constructor(private c: JataQiClient) {}
  async createRotation(engineers: string[], opts: { id?: string; shiftMs?: number; maxConsecutive?: number } = {}): Promise<{ rotation: unknown }> {
    return this.c.request('POST', '/ops/rotations', { engineers, ...opts });
  }
  async rotations(): Promise<{ rotations: unknown[] }> { return this.c.request('GET', '/ops/rotations'); }
  async onCall(rotationId: string): Promise<{ onCall: string }> { return this.c.request('GET', '/ops/oncall', undefined, { rotationId }); }
  async escalationChain(rotationId: string, severity: string): Promise<{ chain: string[] }> {
    return this.c.request('GET', '/ops/escalation-chain', undefined, { rotationId, severity });
  }
  async addEscalationSla(severity: string, minutes: number, level: number): Promise<{ sla: unknown }> {
    return this.c.request('POST', '/ops/escalation-slas', { severity, minutes, level });
  }
  async escalationSlas(): Promise<{ slas: unknown[] }> { return this.c.request('GET', '/ops/escalation-slas'); }
  /** Verify a backup restores correctly (content hash match). */
  async verifyBackup(input: { backupId: string; namespace: string; entries: number; recordedHash: string; actualHash?: string }): Promise<{ verification: unknown }> {
    return this.c.request('POST', '/ops/backup/verify', input);
  }
  async verifications(): Promise<{ verifications: unknown[] }> { return this.c.request('GET', '/ops/backup/verifications'); }
  async startDrill(name: string, scope: string): Promise<{ drill: unknown }> { return this.c.request('POST', '/ops/drills', { name, scope }); }
  async advanceDrill(id: string, stage: string, notes?: string): Promise<{ drill: unknown }> {
    return this.c.request('POST', '/ops/drills/advance', { id, stage, ...(notes ? { notes } : {}) });
  }
  async failDrill(id: string, notes?: string): Promise<{ drill: unknown }> { return this.c.request('POST', '/ops/drills/fail', { id, ...(notes ? { notes } : {}) }); }
  async drills(): Promise<{ drills: unknown[] }> { return this.c.request('GET', '/ops/drills'); }
  /** Generate an operational health report. */
  async healthReport(input: { checks: Array<{ name: string; status: string; detail?: string }>; uptimePct?: number; openIncidents?: number; rotationId?: string }): Promise<{ report: unknown }> {
    return this.c.request('POST', '/ops/health', input);
  }
  async healthReports(): Promise<{ reports: unknown[] }> { return this.c.request('GET', '/ops/health'); }
  async stats(): Promise<{ stats: unknown }> { return this.c.request('GET', '/ops/stats'); }
}
