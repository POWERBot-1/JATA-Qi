// T-03 authentication policy — the explicit, fail-closed authority admission
// policy for a production composition root.
//
// T-01 installed the principal boundary and T-02 carried authenticated
// authority durably, but neither could be reached from a shipped process:
// nothing constructed an authenticator and nothing selected which
// authentication methods a running JATA Qi would admit. This module is the
// single place that decision is made.
//
// It is pure: no I/O, no state, no authority minted. It resolves an explicit
// input into a frozen, fully-specified policy whose `describe()` string is
// suitable for an audit log, so an operator can always answer "what would
// this process accept as authority?" without reading code.
//
// THE CENTRAL RULE: `DETERMINISTIC_TEST` is test infrastructure. It is never
// admitted by the default (production) policy, and asking for it under the
// production policy is a configuration ERROR (thrown), not a silent widening.
// A deployment can only admit test authority by explicitly selecting the
// `test-only` mode AND explicitly setting `allowTestMethod: true` — two
// deliberate acts, so it is impossible to enter by accident.

import { isAuthenticationMethod, type AuthenticationMethod } from './types.js';

/** Policy error: an unusable or unsafe authentication configuration. */
export class AuthenticationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationPolicyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The posture of a composition root.
 *
 * - `production` (DEFAULT): admits only real authentication methods. Test
 *   authority is refused at construction time, so it cannot leak in later.
 * - `test-only`: admits `DETERMINISTIC_TEST`. Requires an explicit, redundant
 *   opt-in. Intended for tests and local development only.
 *
 * `KERNEL_INTERNAL` is never an ingress posture: it denotes a kernel-internal
 * system actor and must never be obtainable from an external request.
 */
export type AuthenticationMode = 'production' | 'test-only';

/**
 * Authentication methods a production ingress may admit. `DETERMINISTIC_TEST`
 * is excluded by construction and `KERNEL_INTERNAL` is excluded because it is
 * not a user-facing request method.
 */
export const PRODUCTION_AUTHENTICATION_METHODS: readonly AuthenticationMethod[] = Object.freeze([
  'STATIC_TOKEN',
  'OIDC',
  'MTLS',
]);

/**
 * Machine-checkable statement of the test-authority rule, exported so a test
 * (or a future audit tool) can assert the invariant instead of re-deriving it.
 *
 * DETERMINISTIC_TEST authority requires TWO deliberate acts: selecting the
 * `test-only` mode AND setting `allowTestMethod: true`. Neither is a default.
 */
export const PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD = Object.freeze({
  /** Test authority is never the production default. */
  productionDefault: false,
  /** It cannot be reached without explicitly selecting the test-only mode. */
  requiresExplicitMode: true,
  /** Nor without the redundant allowTestMethod flag. */
  requiresExplicitAllowFlag: true,
  /** A production composition that asks for it fails closed at startup. */
  refusedUnderProductionPolicy: true,
} as const);

/** Caller-supplied policy input. Every field is optional; every default is safe. */
export interface AuthenticationPolicyInput {
  /** Posture. Defaults to `production`. */
  readonly mode?: AuthenticationMode;
  /**
   * Methods to admit. Defaults to `PRODUCTION_AUTHENTICATION_METHODS` under
   * the production posture and to `['DETERMINISTIC_TEST']` under `test-only`.
   * An explicit list is intersected with what the posture permits.
   */
  readonly allowedMethods?: readonly AuthenticationMethod[];
  /**
   * Explicit test-authority opt-in. Defaults to `false`. Must be `true` for
   * the `test-only` posture; MUST NOT be `true` under `production`.
   */
  readonly allowTestMethod?: boolean;
}

/** A fully-resolved, frozen policy. No optionals: nothing is left implicit. */
export interface ResolvedAuthenticationPolicy {
  readonly mode: AuthenticationMode;
  readonly allowedMethods: readonly AuthenticationMethod[];
  readonly allowTestMethod: boolean;
  /** True when the admitted set is empty (the boundary will refuse everything). */
  readonly admitsNothing: boolean;
  /** Human-readable, secret-free description for audit lines. */
  describe(): string;
}

function assertRecognized(method: unknown, context: string): asserts method is AuthenticationMethod {
  if (!isAuthenticationMethod(method)) {
    throw new AuthenticationPolicyError(
      `${context}: "${String(method)}" is not a recognized authentication method (fail-closed).`,
    );
  }
}

/**
 * Resolve policy input into an explicit policy, or throw. Throws on:
 * an unrecognized mode, an unrecognized method, `allowTestMethod: true` under
 * the production posture, a missing `allowTestMethod: true` for `test-only`,
 * and a request for `DETERMINISTIC_TEST` under `production`.
 */
export function resolveAuthenticationPolicy(
  input: AuthenticationPolicyInput = {},
): ResolvedAuthenticationPolicy {
  const mode = input.mode ?? 'production';
  if (mode !== 'production' && mode !== 'test-only') {
    throw new AuthenticationPolicyError(
      `Unknown authentication mode "${String(mode)}"; expected "production" or "test-only" (fail-closed).`,
    );
  }
  const allowTestMethod = input.allowTestMethod ?? false;

  if (mode === 'production' && allowTestMethod) {
    throw new AuthenticationPolicyError(
      'allowTestMethod:true is not permitted under the production authentication policy. ' +
        'Select mode "test-only" explicitly to admit DETERMINISTIC_TEST authority (fail-closed).',
    );
  }
  if (mode === 'test-only' && allowTestMethod !== true) {
    throw new AuthenticationPolicyError(
      'The "test-only" authentication mode requires an explicit allowTestMethod:true; ' +
        'test authority is never enabled implicitly (fail-closed).',
    );
  }

  const permitted: readonly AuthenticationMethod[] =
    mode === 'production' ? PRODUCTION_AUTHENTICATION_METHODS : ['DETERMINISTIC_TEST'];

  let methods: readonly AuthenticationMethod[];
  if (input.allowedMethods === undefined) {
    methods = [...permitted];
  } else {
    if (!Array.isArray(input.allowedMethods)) {
      throw new AuthenticationPolicyError('allowedMethods must be an array of authentication methods (fail-closed).');
    }
    const requested: AuthenticationMethod[] = [];
    for (const method of input.allowedMethods) {
      assertRecognized(method, 'allowedMethods');
      if (method === 'DETERMINISTIC_TEST' && mode === 'production') {
        throw new AuthenticationPolicyError(
          'DETERMINISTIC_TEST cannot be admitted under the production authentication policy; ' +
            'test authority requires the explicit "test-only" mode (fail-closed).',
        );
      }
      if (method === 'KERNEL_INTERNAL') {
        throw new AuthenticationPolicyError(
          'KERNEL_INTERNAL is a kernel-internal system actor method and can never be admitted at an ingress boundary (fail-closed).',
        );
      }
      if (!permitted.includes(method)) {
        throw new AuthenticationPolicyError(
          `Authentication method "${method}" is not permitted under the "${mode}" policy (fail-closed).`,
        );
      }
      if (!requested.includes(method)) requested.push(method);
    }
    methods = requested;
  }

  const frozenMethods = Object.freeze([...methods]);
  const allowTest = mode === 'test-only';
  return Object.freeze({
    mode,
    allowedMethods: frozenMethods,
    allowTestMethod: allowTest,
    admitsNothing: frozenMethods.length === 0,
    describe(): string {
      return (
        `authentication policy: mode=${mode}` +
        ` allowedMethods=[${frozenMethods.join(',') || '<none>'}]` +
        ` allowTestMethod=${String(allowTest)}` +
        (frozenMethods.length === 0 ? ' (admits nothing; every request fails closed)' : '')
      );
    },
  });
}

/**
 * Assert that `method` may be presented at this boundary. Throws
 * `AuthenticationPolicyError` otherwise. Called BEFORE any authenticator is
 * consulted, so a registered authenticator can never widen the policy.
 */
export function assertMethodAdmitted(
  policy: ResolvedAuthenticationPolicy,
  method: unknown,
): asserts method is AuthenticationMethod {
  assertRecognized(method, 'presented credential method');
  if (!policy.allowedMethods.includes(method)) {
    throw new AuthenticationPolicyError(
      `Authentication method "${method}" is not admitted by this composition root's policy ` +
        `(admitted: ${policy.allowedMethods.join(',') || '<none>'}) (fail-closed).`,
    );
  }
}
