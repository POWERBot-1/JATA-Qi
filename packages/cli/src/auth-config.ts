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
//   oidc                 (P2-S1) — the provider-neutral OIDC authenticator
//                            (pinned-JWKS verification against the durable
//                            identity core). Requires an explicit issuer,
//                            audience allow-list, and a PINNED JWKS source
//                            (inline key set or exact URL). The authenticator
//                            is constructed by the authentication module's
//                            factory against the durable stores (it cannot
//                            exist without them — jti replay + identity
//                            mapping are durable by contract).
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
  type Jwk,
  type JwksSource,
  type JwtAlgorithm,
  type ServerAuthenticator,
  type StaticTokenRecord,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';

/** Authentication posture selected for this process. */
export type CliAuthMode = 'none' | 'static-token' | 'oidc' | 'test-only';

/**
 * P2-S1: the resolved OIDC configuration (a DESCRIPTION — the authenticator
 * itself is constructed by the authentication module's factory, against the
 * durable identity core + jti replay stores, which do not exist before boot).
 * The JWKS source here is a PIN: an inline operator-pinned key set or an
 * exact URL fetched once at authenticator construction (no runtime un-pinned
 * fetch; key rotation = new boot / config reload).
 */
export interface OidcAuthenticatorDescriptor {
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly jwks: JwksSource;
  readonly allowedAlgorithms: readonly JwtAlgorithm[];
}

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
  /**
   * P1: the parsed static-token records (present only in static-token mode).
   * Used by the production posture's durable import path (S-9 fingerprints);
   * never logged, never persisted as material.
   */
  readonly staticTokenRecords?: readonly StaticTokenRecord[];
  /**
   * P2-S1: the resolved OIDC configuration (present only in oidc mode).
   * The authenticator is built by the authentication module's factory against
   * the durable identity core + jti replay stores (absent before boot).
   */
  readonly oidc?: OidcAuthenticatorDescriptor;
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
  if (mode === 'oidc') return 'oidc';
  if (mode === 'test-only') return 'test-only';
  throw new CliAuthenticationConfigError(
    `JATAQI_AUTH_MODE="${raw}" is not recognized; expected "none", "static-token", "oidc", or "test-only" (fail-closed).`,
  );
}

/**
 * P2-S1: parse the pinned JWKS source from the environment. EXACTLY ONE of
 * `JATAQI_OIDC_JWKS` (an inline operator-pinned key set) or
 * `JATAQI_OIDC_JWKS_URL` (an exact pinned URL) must be provided. Neither, or
 * both, is a configuration ERROR (fail-closed) — the pin is explicit.
 */
function parseOidcJwksSource(env: NodeJS.ProcessEnv): JwksSource {
  const inline = env.JATAQI_OIDC_JWKS?.trim();
  const url = env.JATAQI_OIDC_JWKS_URL?.trim();
  if (inline && url) {
    throw new CliAuthenticationConfigError(
      'Set exactly ONE of JATAQI_OIDC_JWKS (inline pinned key set) or JATAQI_OIDC_JWKS_URL (exact pinned URL) — not both (fail-closed).',
    );
  }
  if (!inline && !url) {
    throw new CliAuthenticationConfigError(
      'JATAQI_AUTH_MODE="oidc" requires a PINNED JWKS source: set JATAQI_OIDC_JWKS (inline key set) or JATAQI_OIDC_JWKS_URL (exact URL) (fail-closed).',
    );
  }
  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      throw new CliAuthenticationConfigError(`JATAQI_OIDC_JWKS_URL="${url}" is not an http(s) URL (fail-closed).`);
    }
    return { kind: 'url', url };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline!);
  } catch (error) {
    throw new CliAuthenticationConfigError(
      `JATAQI_OIDC_JWKS is not valid JSON: ${(error as Error).message} (fail-closed).`,
    );
  }
  const keys = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new CliAuthenticationConfigError(
      'JATAQI_OIDC_JWKS must be a non-empty JWK array or a {keys:[...]} document (fail-closed).',
    );
  }
  return { kind: 'inline', keys: keys as readonly Jwk[] };
}

/** P2-S1: the admitted OIDC algorithm set (closed: RS256|ES256). */
function parseOidcAlgorithms(env: NodeJS.ProcessEnv): readonly JwtAlgorithm[] {
  const raw = env.JATAQI_OIDC_ALG?.trim();
  if (!raw) return ['RS256', 'ES256'];
  const algos = raw.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
  if (algos.length === 0) {
    throw new CliAuthenticationConfigError('JATAQI_OIDC_ALG must name at least one algorithm (fail-closed).');
  }
  for (const a of algos) {
    if (a !== 'RS256' && a !== 'ES256') {
      throw new CliAuthenticationConfigError(
        `JATAQI_OIDC_ALG="${a}" is not in the admitted set [RS256, ES256] (fail-closed).`,
      );
    }
  }
  return algos as readonly JwtAlgorithm[];
}

/** P2-S1: resolve the full OIDC descriptor from the environment. */
function buildOidcDescriptor(env: NodeJS.ProcessEnv): OidcAuthenticatorDescriptor {
  const issuer = env.JATAQI_OIDC_ISSUER?.trim();
  if (!issuer) {
    throw new CliAuthenticationConfigError(
      'JATAQI_AUTH_MODE="oidc" requires JATAQI_OIDC_ISSUER (the exact expected issuer) (fail-closed).',
    );
  }
  const audienceRaw = env.JATAQI_OIDC_AUDIENCE?.trim();
  if (!audienceRaw) {
    throw new CliAuthenticationConfigError(
      'JATAQI_AUTH_MODE="oidc" requires JATAQI_OIDC_AUDIENCE (a comma-separated audience allow-list) (fail-closed).',
    );
  }
  const audience = audienceRaw.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
  if (audience.length === 0) {
    throw new CliAuthenticationConfigError('JATAQI_OIDC_AUDIENCE must name at least one audience (fail-closed).');
  }
  return {
    issuer,
    audience,
    jwks: parseOidcJwksSource(env),
    allowedAlgorithms: parseOidcAlgorithms(env),
  };
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

  if (mode === 'oidc') {
    // P2-S1: the OIDC authenticator is provider-neutral and DURABLE — it is
    // constructed by the authentication module's factory against the identity
    // core + jti replay stores. Here we only resolve + validate the pinned
    // configuration (issuer / audience / JWKS pin / algorithms) so a
    // misconfigured process never boots. No authenticator is built yet
    // (the durable stores do not exist before module init).
    const descriptor = buildOidcDescriptor(env);
    return {
      mode,
      authenticators: [],
      oidc: descriptor,
      policy: { mode: 'production' },
      admitsNothing: false,
      description:
        `authentication mode=oidc: provider-neutral OIDC verification against a pinned JWKS ` +
        `(${descriptor.jwks.kind === 'url' ? descriptor.jwks.url : 'inline key set'}), issuer=${descriptor.issuer}, ` +
        `audiences=[${descriptor.audience.join(',')}], algs=[${descriptor.allowedAlgorithms.join(',')}] ` +
        '(durable identity core + jti replay required at boot).',
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
    staticTokenRecords: records,
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
