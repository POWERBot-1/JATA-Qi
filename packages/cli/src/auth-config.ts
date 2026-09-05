// T-03 CLI authentication configuration.
//
// Resolves the production authentication boundary for a CLI/composition-root
// process from explicit environment configuration. It constructs NO
// authenticator from defaults: a JATA Qi process that has not been told how
// to authenticate callers cannot authenticate anyone, and every ingress
// request fails closed.
//
// Modes:
//   none         (DEFAULT) — no authenticator is registered. Ingress refuses
//                            everything. This is the honest state of a process
//                            that has not been configured with an identity
//                            source, and it is reported as such.
//   static-token           — @jataqi/authentication's StaticTokenAuthenticator,
//                            built ONLY from an explicit operator-supplied
//                            principal file. Its own documentation scopes it to
//                            development/staging; T-03 does not claim otherwise.
//   test-only              — DeterministicTestAuthenticator. Requires the mode
//                            AND a second, redundant JATAQI_ALLOW_TEST_AUTH=true,
//                            so test authority cannot be enabled by accident.
//
// No secret is ever logged: only principal ids, tenants, roles, and counts are
// described. Token material stays inside the authenticator's own lookup table.

import { readFileSync } from 'node:fs';
import {
  AuthenticationPolicyError,
  DeterministicTestAuthenticator,
  StaticTokenAuthenticator,
  type AuthenticationPolicyInput,
  type ServerAuthenticator,
  type StaticTokenRecord,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';

/** Authentication posture selected for this process. */
export type CliAuthMode = 'none' | 'static-token' | 'test-only';

/** Error raised for an unusable authentication configuration (fail-closed). */
export class CliAuthenticationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliAuthenticationConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The closed actor-role vocabulary of the commercial control plane. */
const KNOWN_ROLES: readonly CommercialActorRole[] = [
  'observer',
  'agent',
  'operator',
  'approver',
  'admin',
  'global_admin',
  'system',
];

/**
 * Roles an externally-presented credential may never carry. `system` denotes a
 * kernel-internal actor; admitting it from the wire would be exactly the
 * "silently grant SYSTEM" failure the security requirements forbid.
 */
const FORBIDDEN_EXTERNAL_ROLES: readonly CommercialActorRole[] = ['system'];

export interface ResolvedCliAuthentication {
  readonly mode: CliAuthMode;
  readonly authenticators: readonly ServerAuthenticator[];
  readonly policy: AuthenticationPolicyInput;
  /** True when no credential can possibly verify in this process. */
  readonly admitsNothing: boolean;
  /** Operator-facing explanation of the current posture (secret-free). */
  readonly description: string;
  /** Set when a safe production method could not be configured. */
  readonly limitation?: string;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseMode(raw: string | undefined): CliAuthMode {
  const mode = (raw ?? 'none').trim().toLowerCase();
  if (mode === '' || mode === 'none') return 'none';
  if (mode === 'static-token') return 'static-token';
  if (mode === 'test-only') return 'test-only';
  throw new CliAuthenticationConfigError(
    `JATAQI_AUTH_MODE="${raw}" is not recognized; expected "none", "static-token", or "test-only" (fail-closed).`,
  );
}

function parseRoles(raw: unknown, context: string): CommercialActorRole[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CliAuthenticationConfigError(`${context}: "roles" must be a non-empty array (fail-closed).`);
  }
  const roles: CommercialActorRole[] = [];
  for (const role of raw) {
    if (!isNonBlank(role) || !(KNOWN_ROLES as readonly string[]).includes(role)) {
      throw new CliAuthenticationConfigError(
        `${context}: "${String(role)}" is not a recognized actor role (known: ${KNOWN_ROLES.join(', ')}) (fail-closed).`,
      );
    }
    if ((FORBIDDEN_EXTERNAL_ROLES as readonly string[]).includes(role)) {
      throw new CliAuthenticationConfigError(
        `${context}: role "${role}" can never be granted to an externally-presented credential; ` +
          'it denotes a kernel-internal actor (fail-closed).',
      );
    }
    const typed = role as CommercialActorRole;
    if (!roles.includes(typed)) roles.push(typed);
  }
  return roles;
}

function readPrincipalFile(filePath: string | undefined, mode: CliAuthMode): unknown[] {
  if (!isNonBlank(filePath)) {
    throw new CliAuthenticationConfigError(
      `JATAQI_AUTH_MODE="${mode}" requires JATAQI_AUTH_PRINCIPALS to name a JSON file of principal records ` +
        '(no default principal table exists; fail-closed).',
    );
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CliAuthenticationConfigError(
      `JATAQI_AUTH_PRINCIPALS="${filePath}" could not be read: ${(error as Error).message} (fail-closed).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliAuthenticationConfigError(
      `JATAQI_AUTH_PRINCIPALS="${filePath}" is not valid JSON: ${(error as Error).message} (fail-closed).`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliAuthenticationConfigError(
      `JATAQI_AUTH_PRINCIPALS="${filePath}" must contain a non-empty JSON array of principal records (fail-closed).`,
    );
  }
  return parsed;
}

function buildStaticTokenRecords(records: readonly unknown[]): StaticTokenRecord[] {
  return records.map((entry, index) => {
    const context = `static-token record [${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CliAuthenticationConfigError(`${context}: must be an object (fail-closed).`);
    }
    const record = entry as Record<string, unknown>;
    if (!isNonBlank(record.token)) {
      throw new CliAuthenticationConfigError(`${context}: "token" must be a non-empty string (fail-closed).`);
    }
    if (!isNonBlank(record.principalId)) {
      throw new CliAuthenticationConfigError(`${context}: "principalId" must be a non-empty string (fail-closed).`);
    }
    if (!isNonBlank(record.tenantId)) {
      throw new CliAuthenticationConfigError(`${context}: "tenantId" must be a non-empty string (fail-closed).`);
    }
    const expiresAt = record.expiresAt;
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
      throw new CliAuthenticationConfigError(`${context}: "expiresAt" must be a finite number when present (fail-closed).`);
    }
    return {
      token: record.token,
      principalId: record.principalId.trim(),
      tenantId: record.tenantId.trim(),
      roles: parseRoles(record.roles, context),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  });
}

function buildTestPrincipalRecords(records: readonly unknown[]): TestPrincipalRecord[] {
  return records.map((entry, index) => {
    const context = `test principal record [${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CliAuthenticationConfigError(`${context}: must be an object (fail-closed).`);
    }
    const record = entry as Record<string, unknown>;
    if (!isNonBlank(record.id)) {
      throw new CliAuthenticationConfigError(`${context}: "id" must be a non-empty string (fail-closed).`);
    }
    if (!isNonBlank(record.tenantId)) {
      throw new CliAuthenticationConfigError(`${context}: "tenantId" must be a non-empty string (fail-closed).`);
    }
    return {
      id: record.id.trim(),
      tenantId: record.tenantId.trim(),
      roles: parseRoles(record.roles, context),
    };
  });
}

/**
 * Resolve this process's authentication posture from the environment.
 * Throws `CliAuthenticationConfigError` or `AuthenticationPolicyError` for any
 * unusable configuration; never returns a permissive default.
 */
export function resolveCliAuthentication(env: NodeJS.ProcessEnv = process.env): ResolvedCliAuthentication {
  const mode = parseMode(env.JATAQI_AUTH_MODE);

  if (mode === 'none') {
    return {
      mode,
      authenticators: [],
      policy: { mode: 'production' },
      admitsNothing: true,
      description:
        'authentication mode=none: no authenticator is configured, so no credential can verify ' +
        'and every authenticated ingress request fails closed.',
      limitation:
        'No production authentication method is configured. T-03 ships no identity provider ' +
        '(OIDC/mTLS are explicitly out of scope), so a deployment must either configure ' +
        'JATAQI_AUTH_MODE=static-token with an explicit JATAQI_AUTH_PRINCIPALS file, or embed ' +
        'JATA Qi and register its own ServerAuthenticator. Until then, authenticated work ' +
        'ingress is unavailable by design rather than by accident.',
    };
  }

  if (mode === 'test-only') {
    if (env.JATAQI_ALLOW_TEST_AUTH?.trim().toLowerCase() !== 'true') {
      throw new CliAuthenticationConfigError(
        'JATAQI_AUTH_MODE="test-only" additionally requires JATAQI_ALLOW_TEST_AUTH=true. ' +
          'DETERMINISTIC_TEST authority is never enabled implicitly (fail-closed).',
      );
    }
    const records = buildTestPrincipalRecords(readPrincipalFile(env.JATAQI_AUTH_PRINCIPALS, mode));
    return {
      mode,
      authenticators: [new DeterministicTestAuthenticator(records)],
      policy: { mode: 'test-only', allowTestMethod: true },
      admitsNothing: false,
      description:
        `authentication mode=test-only: ${records.length} DETERMINISTIC_TEST principal record(s) configured ` +
        '(TEST AUTHORITY — not for production traffic).',
    };
  }

  const records = buildStaticTokenRecords(readPrincipalFile(env.JATAQI_AUTH_PRINCIPALS, mode));
  return {
    mode,
    authenticators: [new StaticTokenAuthenticator(records)],
    policy: { mode: 'production' },
    admitsNothing: false,
    description:
      `authentication mode=static-token: ${records.length} STATIC_TOKEN principal record(s) configured ` +
      '(development/staging scope per the authenticator contract).',
  };
}

/**
 * True when the host must refuse DETERMINISTIC_TEST authority. Derived from the
 * resolved posture so the T-02 `allowTestMethod` knob can never be left at its
 * permissive library default in a production composition.
 */
export function hostAllowsTestMethod(resolved: ResolvedCliAuthentication): boolean {
  return resolved.mode === 'test-only';
}

export { AuthenticationPolicyError };
