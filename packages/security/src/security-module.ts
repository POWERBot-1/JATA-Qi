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
}

const COL_USERS = 'security.users';
const COL_KEYS = 'security.apikeys';
const NS_AUDIT = 'security.audit';

export class SecurityModule implements IModule {
  readonly id = 'security';
  readonly tags = ['core', 'security'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private users!: ICollection<User>;
  private apiKeys!: ICollection<ApiKey>;
  private auditLog!: AuditLog;
  private readonly sessions = new Map<string, { session: Session; principal: Principal }>();
  private readonly policy: RolePolicy;
  private readonly sessionTtlMs: number;
  private readonly bootstrapAdmin?: { username: string; password: string };

  constructor(cfg: SecurityModuleConfig = {}) {
    this.sessionTtlMs = cfg.sessionTtlMs ?? 3_600_000;
    this.policy = new RolePolicy({ ...DEFAULT_ROLE_POLICY, ...(cfg.roles ?? {}) });
    this.bootstrapAdmin = cfg.bootstrapAdmin;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
      namespace: (n: string) => Promise<import('@jataqi/storage').INamespace>;
    };
    this.users = await storage.collection<User>(COL_USERS);
    this.apiKeys = await storage.collection<ApiKey>(COL_KEYS);
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
    kernel.logger.info('security module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }

  async stop(_kernel: KernelApi): Promise<void> {
    this.sessions.clear();
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

  async login(username: string, password: string): Promise<AuthResult> {
    const user = await this.getUser(username);
    if (!user) return this.failLogin(username, 'unknown user');
    if (!user.active) return this.failLogin(username, 'inactive user');
    const ok = verifySecret(password, { hash: user.passwordHash, salt: user.salt });
    if (!ok) return this.failLogin(username, 'invalid credentials');

    const token = generateToken(32);
    const now = Date.now();
    const session = {
      token,
      userId: user.id,
      username: user.username,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    const principal: Principal = { userId: user.id, username: user.username, roles: [...user.roles] };
    this.sessions.set(token, { session, principal });
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
    const entry = this.sessions.get(token);
    this.sessions.delete(token);
    if (entry) {
      await this.api.bus.emit(SecurityEvents.UserLogout, { userId: entry.principal.userId });
      await this.audit({ actor: entry.principal.userId, action: 'auth.logout', result: 'success' });
    }
  }

  /** Resolve a bearer token (or raw token) to a Principal, or undefined. */
  async authenticate(tokenOrHeader: string | undefined | null): Promise<Principal | undefined> {
    const token = extractBearer(tokenOrHeader);
    if (!token) return undefined;
    const entry = this.sessions.get(token);
    if (!entry) return undefined;
    if (entry.session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      await this.audit({ actor: entry.principal.userId, action: 'auth.session', result: 'failure', detail: { reason: 'expired' } });
      return undefined;
    }
    return entry.principal;
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
