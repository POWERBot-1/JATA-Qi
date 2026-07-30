// Public API for @jataqi/security.
export { SecurityModule } from './security-module.js';
export type { SecurityModuleConfig } from './security-module.js';
export { RolePolicy, checkAll } from './rbac.js';
export { AuditLog } from './audit.js';
export type { AuditQuery } from './audit.js';
export { hashSecret, verifySecret, generateToken, extractBearer } from './crypto.js';
export type { HashedSecret } from './crypto.js';
export { DEFAULT_ROLE_POLICY, SecurityEvents } from './types.js';
export type {
  ApiKey,
  AuditRecord,
  AuthResult,
  Principal,
  Role,
  Session,
  SessionRecord,
  User,
} from './types.js';
