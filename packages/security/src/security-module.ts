// SecurityModule — the kernel module that wires identity, authentication,
// authorization (RBAC), API keys and the audit ledger together. Backed by the
// storage layer so users, api keys and audit records persist across restarts.

import { randomUUID, createHash } from 'node:crypto';
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

/**
 * Derive the storage key for a session token. We never store the raw bearer
 * token as the collection primary key (which would be plaintext on disk even
 * with encryption at rest); instead we store it under a non-reversible SHA-256
 * digest. The raw token only ever lives inside the (encrypted) document body.
 */
function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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
   * In-memory session store, used as the source of truth ONLY when session
   * persistence is disabled (single-instance ephemeral mode). In persistent
   * mode (the default and the horizontal-scaling topology) the shared storage
   * collection is the source of truth: every authentication reads it, so the
   * gateway is stateless w.r.t. sessions and a session revoked on one instance
   * is rejected on every other instance immediately.
   */
  private readonly sessionCache = new Map<string, SessionRecord>();
  /** Per-token throttle map so `lastUsedAt` is flushed at most once per minute. */
  private readonly lastUsedFlushedAt = new Map<string, number>();
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
      try {
        const restored = await this.pruneExpiredSessions();
        const live = await this.sessions.all();
        for (const rec of live) {
          if (rec.revokedAt) continue;
          await this.api.bus.emit(SecurityEvents.SessionRestored, { userId: rec.userId, token: rec.token });
        }
        if (restored > 0) kernel.logger.info(`security: pruned ${restored} expired persisted session(s)`);
        kernel.logger.info(`security: ${live.filter((s) => !s.revokedAt).length} persisted session(s) restored`);
      } catch (err) {
        // An undecryptable store (e.g. encryption-key mismatch or corruption)
        // must NOT crash boot — affected sessions simply fail to authenticate.
        kernel.logger.warn(`security: could not restore persisted sessions (possible key mismatch/corruption): ${(err as Error).message}`);
      }
    }

    kernel.logger.info('security module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }

  async stop(_kernel: KernelApi): Promise<void> {
    // Only clear the in-memory caches; persisted sessions are intentionally kept
    // so they remain valid across restarts.
    this.sessionCache.clear();
    this.lastUsedFlushedAt.clear();
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
    await this.storeSession(session, principal.roles, opts.remoteAddress, now);
    this.lastUsedFlushedAt.set(token, now);
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
    const rec = await this.readSession(token);
    await this.destroySession(token);
    if (rec) {
      await this.api.bus.emit(SecurityEvents.UserLogout, { userId: rec.userId });
      await this.audit({ actor: rec.userId, action: 'auth.logout', result: 'success' });
    }
  }

  /**
   * Resolve a bearer token (or raw token) to a Principal, or undefined. Tries
   * the session store first; falls back to API-key authentication for
   * `jqk_`-prefixed secrets. In persistent mode the shared store is read on
   * every call (stateless), so revocations on other instances take effect
   * immediately — the foundation of horizontal scaling.
   */
  async authenticate(tokenOrHeader: string | undefined | null): Promise<Principal | undefined> {
    const token = extractBearer(tokenOrHeader);
    if (!token) return undefined;
    const rec = await this.readSession(token);
    if (rec) {
      if (rec.revokedAt) return undefined;
      if (rec.expiresAt < Date.now()) {
        await this.expireSession(token, rec.userId);
        return undefined;
      }
      this.maybeFlushLastUsed(token);
      return { userId: rec.userId, username: rec.username, roles: [...rec.roles] };
    }
    // API-key fallback (bounded to jqk_-shaped secrets to limit scan cost).
    if (token.startsWith('jqk_')) return this.authenticateApiKey(token);
    return undefined;
  }

  // --- session lifecycle (persistence) ------------------------------------

  /** Build a SessionRecord from a session + role snapshot. */
  private buildSessionRecord(session: Session, roles: string[], remoteAddress: string | undefined, lastUsedAt: number): SessionRecord {
    return {
      id: sessionKey(session.token),
      token: session.token,
      userId: session.userId,
      username: session.username,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      roles: [...roles],
      lastUsedAt,
      ...(remoteAddress ? { remoteAddress } : {}),
    };
  }

  /** Persist a session to the shared store (persistent mode) or in-memory map (ephemeral). */
  private async storeSession(session: Session, roles: string[], remoteAddress: string | undefined, lastUsedAt: number): Promise<SessionRecord> {
    const rec = this.buildSessionRecord(session, roles, remoteAddress, lastUsedAt);
    if (this.persistSessions) await this.sessions.put(rec);
    else this.sessionCache.set(rec.id, rec); // keyed by the hash (matches readSession/destroySession)
    return rec;
  }

  /** Read a session record from the authoritative store for the active mode. */
  private async readSession(token: string): Promise<SessionRecord | undefined> {
    const key = sessionKey(token);
    if (this.persistSessions) return this.sessions.get(key).catch(() => undefined);
    return this.sessionCache.get(key);
  }

  /** Delete a session from both the store and the in-memory map. */
  private async destroySession(token: string): Promise<void> {
    const key = sessionKey(token);
    this.sessionCache.delete(key);
    this.lastUsedFlushedAt.delete(token);
    if (this.persistSessions) await this.sessions.delete(key).catch(() => false);
  }

  /** Throttled persistence of lastUsedAt (avoid a write on every request). */
  private maybeFlushLastUsed(token: string): void {
    if (!this.persistSessions) return;
    const now = Date.now();
    const last = this.lastUsedFlushedAt.get(token) ?? 0;
    if (now - last <= LAST_USED_FLUSH_INTERVAL_MS) return;
    this.lastUsedFlushedAt.set(token, now);
    const key = sessionKey(token);
    void this.sessions.get(key).then((rec) => {
      if (!rec) return;
      rec.lastUsedAt = now;
      void this.sessions.put(rec).catch(() => undefined);
    }).catch(() => undefined);
  }

  private async expireSession(token: string, userId: string): Promise<void> {
    await this.destroySession(token);
    await this.api.bus.emit(SecurityEvents.SessionExpired, { userId, token });
    await this.audit({ actor: userId, action: 'auth.session', result: 'failure', detail: { reason: 'expired' } });
  }

  /** Remove sessions whose TTL has elapsed. Returns the number removed. */
  async pruneExpiredSessions(): Promise<number> {
    const now = Date.now();
    if (this.persistSessions) {
      const all = await this.sessions.all();
      let pruned = 0;
      for (const s of all) {
        if (s.expiresAt < now) {
          await this.destroySession(s.token);
          pruned++;
        }
      }
      return pruned;
    }
    let n = 0;
    for (const [token, rec] of [...this.sessionCache]) {
      if (rec.expiresAt < now) { await this.destroySession(token); n++; }
    }
    return n;
  }

  /** List active (non-expired, non-revoked) sessions, optionally for one user. */
  async listSessions(userId?: string): Promise<SessionRecord[]> {
    const now = Date.now();
    const all = this.persistSessions ? await this.sessions.all() : [...this.sessionCache.values()];
    return all
      .filter((s) => !s.revokedAt && s.expiresAt >= now && (!userId || s.userId === userId))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Revoke a single session by token. */
  async revokeSession(token: string): Promise<boolean> {
    const rec = await this.readSession(token);
    if (!rec) return false;
    await this.destroySession(token);
    await this.api.bus.emit(SecurityEvents.SessionRevoked, { userId: rec.userId, token });
    await this.audit({ actor: rec.userId, action: 'auth.session.revoke', result: 'success' });
    return true;
  }

  /** Revoke every active session for a user (e.g. on password change). */
  async revokeAllUserSessions(userId: string, exceptToken?: string): Promise<number> {
    const all = this.persistSessions ? await this.sessions.all() : [...this.sessionCache.values()];
    let revoked = 0;
    for (const s of all) {
      if (s.userId === userId && s.token !== exceptToken && !s.revokedAt) {
        await this.destroySession(s.token);
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
