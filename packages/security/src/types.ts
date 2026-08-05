// JATA Qi Security — domain types.
// Implements the Identity Service (Step 15), Security Manager (Step 3 #9),
// Authentication Service (Step 92 Task 3) and the immutable audit ledger
// (Step 93 success criterion #7: "Produce an auditable execution record").

/** A registered user. Passwords are never stored in plaintext. */
export interface User {
  id: string;
  username: string;
  /** scrypt hash, base64. */
  passwordHash: string;
  /** scrypt salt, base64. */
  salt: string;
  roles: string[];
  active: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/** An authenticated session keyed by an opaque bearer token. */
export interface Session {
  token: string;
  userId: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A persistable session record. Mirrors {@link Session} plus the role snapshot
 * captured at login (so the principal can be reconstructed after a restart),
 * a last-access timestamp, and an optional revocation marker.
 *
 * Stored in the `security.sessions` storage collection so sessions survive
 * process restarts (PR4 — Security Hardening). The collection key (`id`) is the
 * session token.
 */
export interface SessionRecord extends Session {
  /** Collection key — equal to {@link Session.token}. */
  id: string;
  /** Roles snapshot at login — used to rebuild the Principal after restart. */
  roles: string[];
  /** Epoch ms of the last successful authentication with this token. */
  lastUsedAt: number;
  /** Originating client address (best-effort), for forensics. */
  remoteAddress?: string;
  /** Set when the session was explicitly revoked. */
  revokedAt?: number;
}

/** A long-lived API key bound to a user. */
export interface ApiKey {
  id: string;
  name: string;
  /** The secret is stored only as a hash; the plaintext is returned once at creation. */
  keyHash: string;
  /** scrypt salt for the key hash, base64. */
  keySalt: string;
  userId: string;
  createdAt: number;
  expiresAt?: number;
}

/** The identity established for an authenticated request. */
export interface Principal {
  userId: string;
  username: string;
  roles: string[];
}

/** A role grants a set of permission strings (e.g. "qil:run", "audit:read"). */
export interface Role {
  name: string;
  permissions: string[];
  description?: string;
}

/** An append-only audit record. */
export interface AuditRecord {
  id: string;
  ts: number;
  /** Who performed the action: a userId, "system", or "anonymous". */
  actor: string;
  /** What was done, e.g. "auth.login", "qil.run", "auth.denied". */
  action: string;
  /** Optional resource reference. */
  resource?: string;
  result: 'success' | 'failure' | 'denied';
  detail?: Record<string, unknown>;
}

/** Result of an authentication attempt. */
export interface AuthResult {
  ok: boolean;
  principal?: Principal;
  session?: Session;
  reason?: string;
}

export const SecurityEvents = Object.freeze({
  UserRegistered: 'security.user.registered',
  UserLogin: 'security.user.login',
  UserLogout: 'security.user.logout',
  SessionRestored: 'security.session.restored',
  SessionRevoked: 'security.session.revoked',
  SessionExpired: 'security.session.expired',
  AuthDenied: 'security.auth.denied',
  AuditAppended: 'security.audit.appended',
} as const);

/**
 * Default role -> permission map. Callers may extend or replace this via
 * SecurityModule.setRolePolicy(...). The wildcard "*" grants everything.
 */
export const DEFAULT_ROLE_POLICY: Record<string, string[]> = Object.freeze({
  admin: ['*'],
  developer: ['health:read', 'qil:run', 'knowledge:read', 'knowledge:write', 'agent:run', 'audit:read', 'metrics:read', 'plugin:read', 'model:read', 'device:read', 'compute:run', 'tool:read', 'tool:invoke', 'approval:decide', 'commerce:read', 'org:read', 'notification:read', 'policy:read', 'policy:evaluate', 'policy:audit', 'memory:read', 'memory:write', 'learning:read', 'learning:write', 'design:read', 'design:write', 'dashboard:read', 'dashboard:write', 'finance:read', 'finance:write', 'search:read', 'automation:read', 'automation:write', 'pki:read', 'pki:write', 'mobility:read', 'mobility:write', 'logistics:read', 'logistics:write', 'agriculture:read', 'agriculture:write', 'circular:read', 'circular:write', 'energy:read', 'energy:write', 'border:read', 'border:write', 'restaurants:read', 'restaurants:write', 'marketplace:read', 'marketplace:write'],
  analyst: ['health:read', 'qil:run', 'knowledge:read', 'agent:run', 'audit:read', 'metrics:read', 'plugin:read', 'model:read', 'device:read', 'compute:run', 'tool:read', 'tool:invoke', 'approval:decide', 'commerce:read', 'org:read', 'notification:read', 'policy:read', 'policy:evaluate', 'policy:audit', 'memory:read', 'learning:read', 'design:read', 'dashboard:read', 'finance:read', 'search:read', 'automation:read', 'pki:read', 'mobility:read', 'logistics:read', 'agriculture:read', 'circular:read', 'energy:read', 'border:read', 'restaurants:read', 'marketplace:read'],
  guest: ['health:read'],
});
