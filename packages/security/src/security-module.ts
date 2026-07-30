// SecurityModule — the kernel module that wires identity, authentication,
// authorization (RBAC), API keys and the audit ledger together. Backed by the
// storage layer so users, api keys and audit records persist across restarts.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { DEFAULT_ROLE_POLICY, SecurityEvents } from './types.js';
import type {
  ApiKey,
  AuditRecord,
  AuthResult,
  Principal,
  Role,
  Session,
  SessionRecord,
  User,
} from './types.js';
import { extractBearer, generateToken, hashSecret, verifySecret } from './crypto.js';
import { RolePolicy } from './rbac.js';
import { AuditLog } from './audit.js';

export interface SecurityModuleConfig {
  /** Session lifetime in ms (default 1h). */
  sessionTtlMs?: number;
  /** Initial role policy (merged over the defaults). */
  roles?: Record<string, string[]>;
  /** If set, a bootstrap admin { username, password } is created on init when absent. */
  bootstrapAdmin?: { username: string; password: string };
  /**
   * Persist sessions to the storage layer so they survive restarts (default true).
   * Set to false for purely ephemeral (in-memory) sessions.
   */
  persistSessions?: boolean;
}

const COL_USERS = 'security.users';
const COL_KEYS = 'security.apikeys';
const COL_SESSIONS = 'security.sessions';
const NS_AUDIT = 'security.audit';

/** Update the persisted `lastUsedAt` at most this often (avoids write churn). */
const LAST_USED_FLUSH_INTERVAL_MS = 60_000;

export class SecurityModule implements IModule {
  readonly id = 'security';
  readonly tags = ['core', 'security'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private users!: ICollection<User>;
  private apiKeys!: ICollection<ApiKey>;
  private sessions!: ICollection<SessionRecord>;
  private auditLog!: AuditLog;
  /**
   * Hot-path cache of resolved sessions. The persisted collection is the source
   * of truth; the cache is rebuilt lazily on cache miss. Cleared on stop without
   * deleting persisted sessions (so they survive restarts).
   */
  private readonly sessionCache = new Map<string, { session: Session; principal: Principal; lastUsedFlushedAt: number }>();
  private readonly policy: RolePolicy;
  private readonly sessionTtlMs: number;
  private readonly bootstrapAdmin?: { username: string; password: string };
  private readonly persistSessions: boolean;

  constructor(cfg: SecurityModuleConfig = {}) {
    this.sessionTtlMs = cfg.sessionTtlMs ?? 3_600_000;
    this.policy = new RolePolicy({ ...DEFAULT_ROLE_POLICY, ...(cfg.roles ?? {}) });
    this.bootstrapAdmin = cfg.bootstrapAdmin;
    this.persistSessions = cfg.persistSessions ?? true;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
      namespace: (n: string) => Promise<import('@jataqi/storage').INamespace>;
    };
    this.users = await storage.collection<User>(COL_USERS);
    this.apiKeys = await storage.collection<ApiKey>(COL_KEYS);
    this.sessions = await storage.collection<SessionRecord>(COL_SESSIONS);
    this.auditLog = new AuditLog(await storage.namespace(NS_AUDIT));
    kernel.container.registerValue('security', this);
    kernel.container.registerValue('security.audit', this.auditLog);

    if (this.bootstrapAdmin) {
      const existing = await this.users.query({ where: (u) => u.username === this.bootstrapAdmin!.username });
      if (existing.length === 0) {
        await this.registerUser(this.bootstrapAdmin.username, this.bootstrapAdmin.password, ['admin'], { system: true });
        kernel.logger.info(`security: bootstrap admin "${this.bootstrapAdmin.username}" created`);
      }
    }

    // Reap expired sessions left over from a previous run, and emit a restore
    // event per surviving session so the rest of the platform knows sessions
    // were recovered from durable storage (PR4 — restart-safe sessions).
    if (this.persistSessions) {
      const restored = await this.pruneExpiredSessions();
      const live = await this.sessions.all();
      for (const rec of live) {
        if (rec.revokedAt) continue;
        await this.api.bus.emit(SecurityEvents.SessionRestored, { userId: rec.userId, token: rec.token });
      }
      if (restored > 0) kernel.logger.info(`security: pruned ${restored} expired persisted session(s)`);
      kernel.logger.info(`security: ${live.filter((s) => !s.revokedAt).length} persisted session(s) restored`);
    }

    kernel.logger.info('security module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }

  async stop(_kernel: KernelApi): Promise<void> {
    // Only clear the in-memory cache; persisted sessions are intentionally kept
    // so they remain valid across restarts.
    this.sessionCache.clear();
  }

  // --- role policy ---------------------------------------------------------

  getRoles(): Role[] {
    const out: Role[] = [];
    for (const [name, perms] of Object.entries({ ...DEFAULT_ROLE_POLICY })) {
      const set = this.policy.getRole(name);
      out.push({ name, permissions: set ? [...set] : perms });
    }
    return out;
  }

  setRolePolicy(name: string, permissions: string[]): void {
    this.policy.setRole(name, permissions);
  }

  // --- users ---------------------------------------------------------------

  async registerUser(username: string, password: string, roles: string[] = ['developer'], metadata?: Record<string, unknown>): Promise<User> {
    if (!username || !password) throw new Error('security: username and password are required');
    const dupes = await this.users.query({ where: (u) => u.username === username });
    if (dupes.length > 0) throw new Error(`security: username "${username}" already exists`);
    const { hash, salt } = hashSecret(password);
    const user: User = {
      id: randomUUID(),
      username,
      passwordHash: hash,
      salt,
      roles,
      active: true,
      createdAt: Date.now(),
      ...(metadata ? { metadata } : {}),
    };
    await this.users.put(user);
    await this.api.bus.emit(SecurityEvents.UserRegistered, { userId: user.id, username });
    await this.audit({ actor: user.id, action: 'user.register', result: 'success' });
    return user;
  }

  async getUser(username: string): Promise<User | undefined> {
    const list = await this.users.query({ where: (u) => u.username === username });
    return list[0];
  }

  async listUsers(): Promise<User[]> {
    return this.users.all();
  }

  // --- authentication ------------------------------------------------------

  async login(username: string, password: string, opts: { remoteAddress?: string } = {}): Promise<AuthResult> {
    const user = await this.getUser(username);
    if (!user) return this.failLogin(username, 'unknown user');
    if (!user.active) return this.failLogin(username, 'inactive user');
    const ok = verifySecret(password, { hash: user.passwordHash, salt: user.salt });
    if (!ok) return this.failLogin(username, 'invalid credentials');

    const token = generateToken(32);
    const now = Date.now();
    const session: Session = {
      token,
      userId: user.id,
      username: user.username,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    const principal: Principal = { userId: user.id, username: user.username, roles: [...user.roles] };
    await this.persistSession(session, principal.roles, opts.remoteAddress, now);
    this.sessionCache.set(token, { session, principal, lastUsedFlushedAt: now });
    await this.api.bus.emit(SecurityEvents.UserLogin, { userId: user.id, username });
    await this.audit({ actor: user.id, action: 'auth.login', result: 'success' });
    return { ok: true, principal, session };
  }

  private async failLogin(username: string, reason: string): Promise<AuthResult> {
    await this.api.bus.emit(SecurityEvents.AuthDenied, { username, reason });
    await this.audit({ actor: username, action: 'auth.login', result: 'failure', detail: { reason } });
    return { ok: false, reason };
  }

  async logout(token: string): Promise<void> {
    const entry = await this.loadSession(token);
    this.sessionCache.delete(token);
    if (this.persistSessions) await this.sessions.delete(token).catch(() => false);
    if (entry) {
      await this.api.bus.emit(SecurityEvents.UserLogout, { userId: entry.principal.userId });
      await this.audit({ actor: entry.principal.userId, action: 'auth.logout', result: 'success' });
    }
  }

  /** Resolve a bearer token (or raw token) to a Principal, or undefined. */
  async authenticate(tokenOrHeader: string | undefined | null): Promise<Principal | undefined> {
    const token = extractBearer(tokenOrHeader);
    if (!token) return undefined;
    const cached = this.sessionCache.get(token);
    if (cached) {
      if (cached.session.expiresAt < Date.now()) {
        await this.expireSession(token, cached.principal.userId);
        return undefined;
      }
      this.maybeFlushLastUsed(token, cached);
      return cached.principal;
    }
    // Cache miss — consult the persisted store (survives restarts).
    const loaded = await this.loadSession(token);
    if (!loaded) return undefined;
    if (loaded.session.expiresAt < Date.now()) {
      await this.expireSession(token, loaded.principal.userId);
      return undefined;
    }
    const entry = { session: loaded.session, principal: loaded.principal, lastUsedFlushedAt: loaded.session.createdAt };
    this.sessionCache.set(token, entry);
    this.maybeFlushLastUsed(token, entry);
    return loaded.principal;
  }

  /** Throttled persistence of lastUsedAt (avoid a write on every request). */
  private maybeFlushLastUsed(token: string, entry: { session: Session; principal: Principal; lastUsedFlushedAt: number }): void {
    const now = Date.now();
    if (now - entry.lastUsedFlushedAt <= LAST_USED_FLUSH_INTERVAL_MS) return;
    const updated = { ...entry, lastUsedFlushedAt: now };
    this.sessionCache.set(token, updated);
    if (!this.persistSessions) return;
    void this.sessions.get(token).then((rec) => {
      if (!rec) return;
      rec.lastUsedAt = now;
      void this.sessions.put(rec).catch(() => rec);
    }).catch(() => undefined);
  }

  // --- session lifecycle (persistence) ------------------------------------

  /** Persist (or update) a session record. No-op when persistence is disabled. */
  private async persistSession(session: Session, roles: string[], remoteAddress: string | undefined, lastUsedAt: number): Promise<void> {
    if (!this.persistSessions) return;
    const rec: SessionRecord = {
      id: session.token,
      token: session.token,
      userId: session.userId,
      username: session.username,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      roles: [...roles],
      lastUsedAt,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
    await this.sessions.put(rec);
  }

  /** Resolve a token to a cached or persisted session+principal, or undefined. */
  private async loadSession(token: string): Promise<{ session: Session; principal: Principal } | undefined> {
    const cached = this.sessionCache.get(token);
    if (cached) return { session: cached.session, principal: cached.principal };
    if (!this.persistSessions) return undefined;
    const rec = await this.sessions.get(token).catch(() => undefined);
    if (!rec || rec.revokedAt) return undefined;
    const principal: Principal = { userId: rec.userId, username: rec.username, roles: [...rec.roles] };
    const session: Session = { token: rec.token, userId: rec.userId, username: rec.username, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
    return { session, principal };
  }

  private async expireSession(token: string, userId: string): Promise<void> {
    this.sessionCache.delete(token);
    if (this.persistSessions) await this.sessions.delete(token).catch(() => false);
    await this.api.bus.emit(SecurityEvents.SessionExpired, { userId, token });
    await this.audit({ actor: userId, action: 'auth.session', result: 'failure', detail: { reason: 'expired' } });
  }

  /** Remove sessions whose TTL has elapsed. Returns the number removed. */
  async pruneExpiredSessions(): Promise<number> {
    if (!this.persistSessions) return 0;
    const all = await this.sessions.all();
    const now = Date.now();
    let pruned = 0;
    for (const s of all) {
      if (s.expiresAt < now) {
        await this.sessions.delete(s.token).catch(() => false);
        this.sessionCache.delete(s.token);
        pruned++;
      }
    }
    return pruned;
  }

  /** List active (non-expired, non-revoked) sessions, optionally for one user. */
  async listSessions(userId?: string): Promise<SessionRecord[]> {
    if (!this.persistSessions) return [];
    const now = Date.now();
    const all = await this.sessions.all();
    return all
      .filter((s) => !s.revokedAt && s.expiresAt >= now && (!userId || s.userId === userId))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Revoke a single session by token. */
  async revokeSession(token: string): Promise<boolean> {
    this.sessionCache.delete(token);
    if (!this.persistSessions) return false;
    const rec = await this.sessions.get(token).catch(() => undefined);
    if (!rec) return false;
    await this.sessions.delete(token).catch(() => false);
    await this.api.bus.emit(SecurityEvents.SessionRevoked, { userId: rec.userId, token });
    await this.audit({ actor: rec.userId, action: 'auth.session.revoke', result: 'success' });
    return true;
  }

  /** Revoke every active session for a user (e.g. on password change). */
  async revokeAllUserSessions(userId: string, exceptToken?: string): Promise<number> {
    if (!this.persistSessions) {
      let n = 0;
      for (const [token, entry] of this.sessionCache) {
        if (entry.principal.userId === userId && token !== exceptToken) { this.sessionCache.delete(token); n++; }
      }
      return n;
    }
    const all = await this.sessions.all();
    let revoked = 0;
    for (const s of all) {
      if (s.userId === userId && s.token !== exceptToken && !s.revokedAt) {
        await this.sessions.delete(s.token).catch(() => false);
        this.sessionCache.delete(s.token);
        revoked++;
      }
    }
    await this.api.bus.emit(SecurityEvents.SessionRevoked, { userId, count: revoked });
    await this.audit({ actor: userId, action: 'auth.session.revokeAll', result: 'success', detail: { count: revoked } });
    return revoked;
  }

  // --- API keys ------------------------------------------------------------

  async createApiKey(username: string, name: string, ttlMs?: number): Promise<{ apiKey: ApiKey; secret: string }> {
    const user = await this.getUser(username);
    if (!user) throw new Error(`security: unknown user "${username}"`);
    const secret = `jqk_${generateToken(24)}`;
    const { hash, salt } = hashSecret(secret);
    const now = Date.now();
    const apiKey: ApiKey = {
      id: randomUUID(),
      name,
      keyHash: hash,
      keySalt: salt,
      userId: user.id,
      createdAt: now,
      ...(ttlMs ? { expiresAt: now + ttlMs } : {}),
    };
    await this.apiKeys.put(apiKey);
    await this.audit({ actor: user.id, action: 'apikey.create', result: 'success', resource: name });
    return { apiKey, secret };
  }

  async authenticateApiKey(secret: string): Promise<Principal | undefined> {
    if (!secret) return undefined;
    const all = await this.apiKeys.all();
    for (const k of all) {
      if (verifySecret(secret, { hash: k.keyHash, salt: k.keySalt })) {
        if (k.expiresAt && k.expiresAt < Date.now()) return undefined;
        const user = (await this.users.all()).find((u) => u.id === k.userId);
        if (!user || !user.active) return undefined;
        return { userId: user.id, username: user.username, roles: [...user.roles] };
      }
    }
    return undefined;
  }

  // --- authorization -------------------------------------------------------

  authorize(principal: Principal, permission: string): boolean {
    return this.policy.authorize(principal, permission);
  }

  /** Authorize and audit a denial; throws JataQi-style error if not permitted. */
  async requirePermission(principal: Principal, permission: string, resource?: string): Promise<void> {
    if (this.policy.authorize(principal, permission)) return;
    await this.api.bus.emit(SecurityEvents.AuthDenied, { userId: principal.userId, permission, resource });
    await this.audit({ actor: principal.userId, action: 'auth.denied', result: 'denied', resource, detail: { permission } });
    const err = new Error(`security: permission denied — requires "${permission}"`) as Error & { code?: string; status?: number };
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  // --- audit ---------------------------------------------------------------

  /** Append to the audit ledger and emit an event. */
  async audit(rec: Omit<AuditRecord, 'id' | 'ts'> & { ts?: number }): Promise<AuditRecord> {
    const full = await this.auditLog.record(rec);
    await this.api.bus.emit(SecurityEvents.AuditAppended, { id: full.id, action: full.action });
    return full;
  }

  getAuditLog(): AuditLog {
    return this.auditLog;
  }
}
