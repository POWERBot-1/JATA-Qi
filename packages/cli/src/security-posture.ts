// P1 (S1/S5) — PRODUCTION SECURITY POSTURE.
//
// The R2 security architecture is library-complete but composition-optional:
// `durableSecurity`, durable sessions, and the production credential provider
// are opt-in switches that no shipped composition enables, and nothing
// distinguishes a production process from a development one. This module
// converts those advisories into enforced, fail-closed composition
// invariants (P1 INV-01…INV-16).
//
// Two enforcement layers:
//   1. `validateProductionSecurityConfig` — PRE-BOOT configuration checks
//      (rejects unsafe combinations before any module is even registered).
//   2. `declareProductionSecurityInvariants` — kernel security invariants
//      evaluated at the END of init, before ANY module starts (the same
//      append-only, non-overridable registry as
//      `a01.authorization-boundary.mandatory`). A failing invariant aborts
//      boot deterministically: no module reaches `start`, so no protected
//      surface can serve traffic in an unsafe posture.
//
// The development posture preserves today's behavior exactly. There is no
// runtime path that changes posture after boot.

import type { KernelApi } from '@jataqi/core-kernel';
import type { StorageModule } from '@jataqi/storage';
import type { PostgresDriver } from '@jataqi/storage-postgres';
import type {
  AuthorizationBoundaryModule,
  A01AuthorizationRequest,
  CredentialMaterialProvider,
} from '@jataqi/authorization-boundary';
import { isDevelopmentCredentialMaterialProvider, MIN_DURABLE_MANIFEST_LIFETIME_MS } from '@jataqi/authorization-boundary';
import type { AuthenticationModule, ServerAuthenticator } from '@jataqi/authentication';
import { DeterministicTestAuthenticator } from '@jataqi/authentication';

/** The security posture of a composition. Default: `development`. */
export type SecurityPosture = 'production' | 'development';

/** Deterministic, machine-readable posture violation codes. */
export type ProductionPostureViolationCode =
  | 'P1_POSTURE_UNKNOWN'
  | 'P1_CFG_DURABLE_SECURITY_REQUIRED'
  | 'P1_CFG_STORAGE_DRIVER_NOT_DURABLE'
  | 'P1_CFG_DURABLE_SESSIONS_REQUIRED'
  | 'P1_CFG_DEV_CREDENTIAL_PROVIDER'
  | 'P1_CFG_DURABLE_AUDIT_REQUIRED'
  | 'P1_CFG_TEST_AUTH_REFUSED'
  | 'P1_CFG_UNSAFE_ESCAPE_HATCH'
  | 'P1_CFG_STATIC_TOKEN_REQUIRES_OPT_IN';

/**
 * A production-posture violation: an unsafe production configuration or an
 * unverifiable production security assumption. Carries a deterministic
 * `code` for machine-readable classification. Diagnostics NEVER contain
 * credentials or connection strings.
 */
export class ProductionPostureViolation extends Error {
  readonly code: ProductionPostureViolationCode;
  constructor(code: ProductionPostureViolationCode, message: string) {
    super(`[P1 production posture ${code}] ${message}`);
    this.name = 'ProductionPostureViolation';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Resolve the posture from the environment. Default `development` (today's
 * behavior). Unknown values fail closed — a typo must never silently boot a
 * permissive process that intended to be production.
 */
export function resolveSecurityPosture(env: NodeJS.ProcessEnv = process.env): SecurityPosture {
  const raw = (env.JATAQI_SECURITY_POSTURE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'development') return 'development';
  if (raw === 'production') return 'production';
  throw new ProductionPostureViolation(
    'P1_POSTURE_UNKNOWN',
    `JATAQI_SECURITY_POSTURE="${raw}" is not recognized; expected "production" or "development" (fail-closed).`,
  );
}

// ---------------------------------------------------------------------------
// Layer 1 — pre-boot configuration validation
// ---------------------------------------------------------------------------

export interface ProductionSecurityConfigInput {
  /** Resolved storage driver selector ('memory' | 'filesystem' | 'postgres' | …). */
  readonly storageDriverName?: string;
  readonly authorization?: {
    readonly durableSecurity?: { readonly enabled?: boolean; readonly materialProvider?: CredentialMaterialProvider };
    readonly durableAudit?: boolean;
  };
  readonly authentication?: {
    readonly durableSessions?: { readonly enabled?: boolean };
    readonly policy?: { readonly mode?: string; readonly allowTestMethod?: boolean };
    readonly authenticators?: readonly ServerAuthenticator[];
  };
  /** The non-durable-storage escape hatch (`--allow-non-durable-storage`). */
  readonly allowNonDurableStorage?: boolean;
}

/**
 * Validate the production security configuration BEFORE boot. Every check
 * maps to a P1 invariant and a deterministic code. Development posture is
 * unaffected. Throws `ProductionPostureViolation` (fail-closed).
 */
export function validateProductionSecurityConfig(input: ProductionSecurityConfigInput): void {
  // INV-16/INV-03: unsafe escape hatches are refused outright in production.
  if (input.allowNonDurableStorage === true) {
    throw new ProductionPostureViolation(
      'P1_CFG_UNSAFE_ESCAPE_HATCH',
      '--allow-non-durable-storage is a development escape hatch and can never be used under the production security posture (fail-closed).',
    );
  }

  // INV-02/INV-03: memory and filesystem are development-only drivers and are
  // never security-authoritative state.
  const driver = input.storageDriverName ?? 'memory';
  if (driver === 'memory' || driver === 'filesystem' || driver === 'fs') {
    throw new ProductionPostureViolation(
      'P1_CFG_STORAGE_DRIVER_NOT_DURABLE',
      `STORAGE_DRIVER="${driver}" is development-only and cannot hold security-authoritative state in production; ` +
        'use the transactional PostgreSQL driver (STORAGE_DRIVER=postgres with JATAQI_PG_CONNECTION_STRING) (fail-closed).',
    );
  }

  // INV-01: durable security is mandatory.
  if (input.authorization?.durableSecurity?.enabled !== true) {
    throw new ProductionPostureViolation(
      'P1_CFG_DURABLE_SECURITY_REQUIRED',
      'the production security posture requires the durable security substrate (authorization.durableSecurity.enabled=true); ' +
        'process-local (R1) security authority is not admissible in production (fail-closed).',
    );
  }

  // INV-05 (audit): the durable audit sink cannot be switched off.
  if (input.authorization?.durableAudit === false) {
    throw new ProductionPostureViolation(
      'P1_CFG_DURABLE_AUDIT_REQUIRED',
      'durableAudit:false is not permitted under the production security posture — an unauditable production ALLOW must not exist (fail-closed).',
    );
  }

  // INV-09: development credential material providers are refused.
  const provider = input.authorization?.durableSecurity?.materialProvider;
  if (provider !== undefined && isDevelopmentCredentialMaterialProvider(provider)) {
    throw new ProductionPostureViolation(
      'P1_CFG_DEV_CREDENTIAL_PROVIDER',
      `the credential material provider "${provider.id}" is a development implementation; production requires an external ` +
        '(KMS/HSM-class) provider satisfying the P1 provider contract (fail-closed).',
    );
  }

  // INV-07: durable session state is part of the production contract.
  if (input.authentication?.durableSessions?.enabled !== true) {
    throw new ProductionPostureViolation(
      'P1_CFG_DURABLE_SESSIONS_REQUIRED',
      'the production security posture requires durable sessions (authentication.durableSessions.enabled=true); ' +
        'process-local session/token authority is not admissible in production (fail-closed).',
    );
  }

  // INV-10: test authority is never admissible in production.
  if (input.authentication?.policy?.mode === 'test-only' || input.authentication?.policy?.allowTestMethod === true) {
    throw new ProductionPostureViolation(
      'P1_CFG_TEST_AUTH_REFUSED',
      'DETERMINISTIC_TEST authority is never admissible under the production security posture (fail-closed).',
    );
  }
  const authenticators = input.authentication?.authenticators ?? [];
  if (authenticators.some((a) => a instanceof DeterministicTestAuthenticator)) {
    throw new ProductionPostureViolation(
      'P1_CFG_TEST_AUTH_REFUSED',
      'a DeterministicTestAuthenticator is configured; test authority is never admissible under the production security posture (fail-closed).',
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — kernel security invariants (evaluated at end of init)
// ---------------------------------------------------------------------------

/** The canary tenant used by the boot decision probe (GC-cleaned; no real data). */
export const P1_BOOT_CANARY_TENANT = 'p1-canary';
/** The (nonexistent) capability the boot canary asks about. */
export const P1_BOOT_CANARY_CAPABILITY = 'p1.boot-canary';

function bootCanaryRequest(): A01AuthorizationRequest {
  return {
    principal: {
      id: 'p1-boot-canary',
      tenantId: P1_BOOT_CANARY_TENANT,
      roles: ['observer'],
      authenticationMethod: 'STATIC_TOKEN',
      authenticationEventId: 'p1-boot-canary',
    },
    tenantId: P1_BOOT_CANARY_TENANT,
    agent: { agentId: 'p1-boot-canary' },
    run: { runId: 'p1-boot-canary', correlationId: 'p1-boot-canary' },
    capability: { capabilityId: P1_BOOT_CANARY_CAPABILITY, capabilityVersion: '1' },
    tool: 'p1-boot-canary',
    operation: 'probe',
    target: { system: 'p1-boot-canary' },
    dataClassification: 'PUBLIC',
    impact: 'READ',
  };
}

/**
 * Declare the P1 production security invariants on a kernel. Evaluated at the
 * end of the init phase on EVERY boot (append-only, non-overridable); any
 * failure aborts boot before a module starts. Posture cannot be relaxed
 * afterwards: the invariants are registered, and re-declaration is an error.
 */
export function declareProductionSecurityInvariants(kernel: KernelApi): void {
  // INV-01/INV-05/INV-06/INV-08 + boot canary (INV-14): the durable security
  // substrate is attached, its decision path renders decisions, every ACTIVE
  // manifest satisfies the durable lifetime floor, and an expected-DENY
  // canary denies through the live durable path (rate write + session read +
  // audit write) without an availability failure.
  kernel.requireSecurityInvariant({
    id: 'p1.production.durable-security',
    description:
      'the durable security substrate is attached and its decision path is live (boot canary must render a DENY decision, never an availability failure)',
    async check(k: KernelApi): Promise<boolean | string> {
      const boundary = k.getModule<AuthorizationBoundaryModule>('authorization-boundary');
      let store: ReturnType<AuthorizationBoundaryModule['getSecurityStore']>;
      try {
        store = boundary.getSecurityStore();
      } catch {
        return 'durable security is NOT enabled: the authorization boundary is running on the process-local (R1) path, which is not admissible in production';
      }
      try {
        const active = await store.listActiveManifests();
        const violating = active.filter((m) => m.manifest.maxLifetimeMs <= MIN_DURABLE_MANIFEST_LIFETIME_MS);
        if (violating.length > 0) {
          return `ACTIVE durable manifests below the durable lifetime floor (${MIN_DURABLE_MANIFEST_LIFETIME_MS} ms): ${violating
            .map((m) => `${m.capabilityId}@${m.version}`)
            .join(', ')} — such manifests can never execute (fail-closed)`;
        }
      } catch (error) {
        return `the durable manifest authority could not be read: ${error instanceof Error ? error.message : String(error)} (fail-closed)`;
      }
      try {
        const envelope = await boundary.getService().decideAsync(bootCanaryRequest());
        if (envelope.decision.decision !== 'DENY') {
          return `the boot canary produced a ${envelope.decision.decision} decision for a nonexistent capability — the durable decision path is not behaving fail-closed`;
        }
        const codes = [...envelope.decision.reasonCodes];
        if (codes.includes('SECURITY_STATE_UNAVAILABLE') || codes.includes('AUDIT_UNAVAILABLE')) {
          return `the boot canary denied for availability reasons (${codes.join(',')}) — security-state health could not be established (fail-closed)`;
        }
      } catch (error) {
        return `the boot canary failed to render a decision through the durable path: ${
          error instanceof Error ? error.message : String(error)
        } (fail-closed)`;
      }
      return true;
    },
  });

  // INV-02/INV-03/INV-04: security-authoritative state lives in a
  // transactional, durable store — never MemoryDriver, never FsDriver.
  kernel.requireSecurityInvariant({
    id: 'p1.production.durable-storage',
    description: 'security-authoritative state is held by a transactional durable storage driver (never memory or filesystem)',
    check(k: KernelApi): boolean | string {
      const storage = k.getModule<StorageModule>('storage');
      const driver = storage.getDriver();
      if (!storage.supportsTransactions()) {
        return `the storage driver "${driver.id}" is not transactional; a non-transactional store is never authoritative security state (fail-closed)`;
      }
      if (driver.id === 'memory' || driver.id === 'filesystem' || driver.id === 'fs') {
        return `the storage driver "${driver.id}" is development-only and cannot hold security-authoritative state in production (fail-closed)`;
      }
      return true;
    },
  });

  // INV-07: durable session state is part of the production contract.
  kernel.requireSecurityInvariant({
    id: 'p1.production.durable-sessions',
    description: 'durable session and token-registry state is enabled (revocation visible cross-process)',
    check(k: KernelApi): boolean | string {
      const auth = k.getModule<AuthenticationModule>('authentication');
      try {
        auth.getSessionStore();
        auth.getTokenRegistry();
      } catch {
        return 'durable sessions/token registry are NOT enabled; process-local session authority is not admissible in production (fail-closed)';
      }
      return true;
    },
  });

  // INV-09: no development credential material provider in production.
  kernel.requireSecurityInvariant({
    id: 'p1.production.credential-material-provider',
    description: 'the credential material provider is an external (KMS/HSM-class) implementation, not a development provider',
    check(k: KernelApi): boolean | string {
      const boundary = k.getModule<AuthorizationBoundaryModule>('authorization-boundary');
      let provider: CredentialMaterialProvider;
      try {
        provider = boundary.getDurableBroker().materialProvider;
      } catch (error) {
        return `the durable credential broker is unavailable: ${error instanceof Error ? error.message : String(error)} (fail-closed)`;
      }
      if (isDevelopmentCredentialMaterialProvider(provider)) {
        return `the credential material provider "${provider.id}" is a development implementation; production requires an external provider (fail-closed)`;
      }
      return true;
    },
  });

  // INV-11/INV-12: the PostgreSQL RLS/role posture is explicitly verified at
  // boot (role neither superuser nor BYPASSRLS; RLS + FORCE on every security
  // table; canary cross-tenant refusal; no-context blindness).
  kernel.requireSecurityInvariant({
    id: 'p1.production.rls-posture',
    description:
      'the PostgreSQL RLS production contract is verified: non-superuser/non-BYPASSRLS role, RLS + FORCE ROW LEVEL SECURITY on every security collection table, and tenant-canary enforcement',
    async check(k: KernelApi): Promise<boolean | string> {
      const storage = k.getModule<StorageModule>('storage');
      const driver = storage.getDriver();
      if (typeof (driver as PostgresDriver).verifyRlsPosture !== 'function') {
        return `the storage driver "${driver.id}" provides no RLS posture verification; the production posture requires the PostgreSQL driver with the P1 RLS probe (fail-closed)`;
      }
      let probe: Awaited<ReturnType<PostgresDriver['verifyRlsPosture']>>;
      try {
        probe = await (driver as PostgresDriver).verifyRlsPosture();
      } catch (error) {
        return `RLS posture verification could not be executed: ${error instanceof Error ? error.message : String(error)} (fail-closed)`;
      }
      if (!probe.ok) {
        return `RLS posture verification FAILED: ${probe.failures
          .map((f) => `${f.code}(${f.detail})`)
          .join('; ')} (fail-closed)`;
      }
      return true;
    },
  });

  // INV-14: security-state health is observable and was established at boot.
  kernel.requireSecurityInvariant({
    id: 'p1.production.security-state-health',
    description: 'security-state storage health is established at boot (pool not degraded; observability available)',
    check(k: KernelApi): boolean | string {
      const storage = k.getModule<StorageModule>('storage');
      const driver = storage.getDriver();
      const health = typeof (driver as PostgresDriver).getPoolHealth === 'function'
        ? (driver as PostgresDriver).getPoolHealth()
        : undefined;
      if (health && health.degraded) {
        return `the security-state storage pool is degraded at boot (${health.poolErrors} error(s) recorded; last: ${
          health.lastPoolErrorMessage ?? '(unknown)'
        }); health must be established before serving protected traffic (fail-closed)`;
      }
      return true;
    },
  });
}
