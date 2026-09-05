// T-03 authenticated work ingress.
//
// This is the production front door for creating durable work. It exists
// because T-01 (principal boundary) and T-02 (durable authority
// carry-through) were complete but unreachable: `enqueue` had no production
// caller and no shipped composition could produce an `AuthenticatedPrincipal`.
//
// WHAT THIS IS:
//   presented credential -> T-03 principal boundary -> AuthenticatedPrincipal
//   -> T-01 projectToActor (narrowing only) -> LoopHostService.enqueue
//   -> T-02 persisted principal snapshot -> durable work id
//
// WHAT THIS IS NOT:
//   - not a second authenticator (it calls the T-01/T-03 boundary);
//   - not a second authority system (it derives nothing itself — actor
//     narrowing is T-01's own `projectToActor`);
//   - not a second orchestrator (it never dispatches, leases, ticks, retries,
//     resumes, settles, or executes — loop-host and the unified 34-stage loop
//     remain the only execution path);
//   - not a storage client (it never touches the work-item collection; the
//     only write it performs is through `enqueue`).
//
// It deliberately does NOT duplicate principal-snapshot construction,
// authorization, or dispatch: `enqueue` already freezes the snapshot and
// re-verifies actor derivation, and dispatch already re-authorizes.
//
// It is a separate class from `LoopHostService` on purpose — the host's own
// surface must keep exposing no authority verbs (acceptance O16).

import type { IModule, KernelApi } from '@jataqi/core-kernel';
import {
  PrincipalValidationError,
  projectToActor,
  type AuthenticatedPrincipal,
  type AuthenticationModule,
  type PresentedCredential,
  type PrincipalBoundary,
} from '@jataqi/authentication';
import type { CommercialActor, CommercialActorRole } from '@jataqi/commercial-control-plane';
import type { LoopTask } from '@jataqi/unified-loop';
import { LoopHostError } from './types.js';
import type { EnqueueWorkInput, HostedWorkItem, HostedWorkStatus, HostLifecycle } from './types.js';
import type { LoopHostModule } from './module.js';

/**
 * The minimum the ingress needs from the host. `LoopHostService` satisfies it
 * structurally. Keeping this narrow is the guarantee that the ingress cannot
 * reach past `enqueue` into leases, checkpoints, or dispatch.
 */
export interface AuthenticatedEnqueueSink {
  enqueue(
    actor: CommercialActor,
    input: EnqueueWorkInput,
    principal: AuthenticatedPrincipal,
    now?: number,
  ): Promise<HostedWorkItem>;
  /** Optional: reported on the receipt so operators know if work will move. */
  getLifecycle?(): HostLifecycle;
}

/** One authenticated work-submission request. */
export interface WorkSubmission {
  /** What the loop is asked to reason toward. Required, non-blank. */
  readonly objective: string;
  readonly observations?: readonly string[];
  readonly knowledgeQuery?: string;
  /**
   * Caller-declared tenant. OPTIONAL and never authoritative: when present it
   * must equal the authenticated principal's tenant or the submission is
   * rejected. It exists so a caller cannot silently create work in a tenant
   * other than the one it proved — the mismatch is an error, not a fallback.
   */
  readonly tenantId?: string;
  /**
   * Roles the caller needs. May only NARROW the verified set; widening throws
   * inside T-01's `projectToActor`. Omit to use the full verified set.
   */
  readonly requestedRoles?: readonly CommercialActorRole[];
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly availableAt?: number;
  /**
   * A proposed external action, forwarded verbatim to the loop task. T-03
   * does not originate actions and adds no new way to produce one; this field
   * exists only so the ingress is not narrower than `EnqueueWorkInput`.
   */
  readonly proposedAction?: LoopTask['proposedAction'];
}

/** Secret-free receipt returned to an authenticated caller. */
export interface WorkIngressReceipt {
  readonly workId: string;
  /** Always the AUTHENTICATED tenant — never a caller-supplied value. */
  readonly tenantId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly status: HostedWorkStatus;
  readonly availableAt: number;
  /** Host lifecycle at submission time (informational; never a dispatch). */
  readonly hostLifecycle: HostLifecycle | 'UNKNOWN';
  /** Provenance only: no tokens, secrets, or credential material. */
  readonly authentication: {
    readonly principalId: string;
    readonly authenticationMethod: string;
    readonly authenticationEventId: string;
    readonly verifiedAt: number;
  };
}

export interface WorkIngressConfig {
  readonly boundary: PrincipalBoundary;
  readonly host: AuthenticatedEnqueueSink;
  /** Injectable clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class WorkIngressService {
  readonly #boundary: PrincipalBoundary;
  readonly #host: AuthenticatedEnqueueSink;
  readonly #now: () => number;

  constructor(config: WorkIngressConfig) {
    if (!config || typeof config !== 'object') {
      throw new LoopHostError('Work ingress requires a configuration object (fail-closed).');
    }
    if (!config.boundary || typeof config.boundary.authenticate !== 'function') {
      throw new LoopHostError('Work ingress requires a T-03 principal boundary (fail-closed).');
    }
    if (!config.host || typeof config.host.enqueue !== 'function') {
      throw new LoopHostError('Work ingress requires an authenticated enqueue sink (fail-closed).');
    }
    this.#boundary = config.boundary;
    this.#host = config.host;
    this.#now = config.now ?? ((): number => Date.now());
  }

  /** The resolved authentication policy this ingress admits (auditable). */
  getPolicy() {
    return this.#boundary.getPolicy();
  }

  /**
   * Authenticate a caller and create durable work.
   *
   * Fails closed — with NO work created and NO receipt returned — on: a
   * missing credential, an unverified credential, an inadmissible
   * authentication method, a malformed principal, a blank objective, a
   * caller tenant that disagrees with the authenticated tenant, a role
   * widening attempt, and any persistence error from `enqueue`.
   *
   * Nothing in this method generates a fallback principal, a SYSTEM actor, or
   * an anonymous tenant.
   */
  async submit(
    credential: PresentedCredential | undefined | null,
    submission: WorkSubmission,
  ): Promise<WorkIngressReceipt> {
    if (!submission || typeof submission !== 'object') {
      throw new LoopHostError('A work submission is required (fail-closed).');
    }
    if (!isNonBlank(submission.objective)) {
      throw new LoopHostError('A non-blank objective is required to create work (fail-closed).');
    }

    // 1. AUTHENTICATE. Everything downstream depends on this returning a
    //    server-verified principal; there is no path that continues without one.
    const principal = await this.#boundary.authenticate(credential);

    // 2. TENANT CONTINUITY. The authenticated tenant is authoritative. A
    //    caller-declared tenant is only a consistency check.
    const requestedTenant = submission.tenantId?.trim();
    if (requestedTenant !== undefined && requestedTenant !== principal.tenantId) {
      throw new PrincipalValidationError(
        `Caller-declared tenant "${requestedTenant}" does not match the authenticated tenant ` +
          `"${principal.tenantId}"; the authenticated tenant is authoritative (fail-closed).`,
      );
    }

    // 3. ACTOR DERIVATION through T-01's own projection — narrowing only, and
    //    with no second implementation of the widening rule.
    const actor = projectToActor(principal, submission.requestedRoles);

    // 4. BUILD THE TASK. No cognition, no action generation, no defaults that
    //    could imply authority.
    const task: LoopTask = {
      objective: submission.objective.trim(),
      ...(submission.observations && submission.observations.length > 0
        ? { observations: [...submission.observations] }
        : {}),
      ...(isNonBlank(submission.knowledgeQuery) ? { knowledgeQuery: submission.knowledgeQuery.trim() } : {}),
      ...(submission.proposedAction ? { proposedAction: submission.proposedAction } : {}),
    };

    const input: EnqueueWorkInput = {
      task,
      ...(isNonBlank(submission.correlationId) ? { correlationId: submission.correlationId.trim() } : {}),
      ...(isNonBlank(submission.idempotencyKey) ? { idempotencyKey: submission.idempotencyKey.trim() } : {}),
      ...(submission.maxAttempts !== undefined ? { maxAttempts: submission.maxAttempts } : {}),
      ...(submission.baseDelayMs !== undefined ? { baseDelayMs: submission.baseDelayMs } : {}),
      ...(submission.maxDelayMs !== undefined ? { maxDelayMs: submission.maxDelayMs } : {}),
      ...(submission.availableAt !== undefined ? { availableAt: submission.availableAt } : {}),
    };

    // 5. ENQUEUE through the existing authenticated path. `enqueue` freezes the
    //    T-02 snapshot and re-verifies actor derivation; a throw here means no
    //    record was created, so no false success is possible.
    const item = await this.#host.enqueue(actor, input, principal, this.#now());

    // 6. RECEIPT. Built only from the persisted record — never from the request.
    return {
      workId: item.id,
      tenantId: item.tenantId,
      correlationId: item.correlationId,
      idempotencyKey: item.idempotencyKey,
      status: item.status,
      availableAt: item.availableAt,
      hostLifecycle: this.#host.getLifecycle ? this.#host.getLifecycle() : 'UNKNOWN',
      authentication: {
        principalId: principal.id,
        authenticationMethod: principal.authenticationMethod,
        authenticationEventId: principal.authenticationEventId,
        verifiedAt: principal.verifiedAt,
      },
    };
  }
}

/**
 * T-03 composition unit for the authenticated ingress.
 *
 * Registered only alongside the loop host (it needs a durable queue to submit
 * to) and only after the `authentication` module, which supplies the boundary.
 * It starts nothing, authenticates nothing at boot, and creates no work: an
 * ingress is inert until a caller presents a credential.
 */
export class WorkIngressModule implements IModule {
  readonly id = 'work-ingress';
  readonly tags = ['ingress', 'authentication', 'operation', 'authority'] as const;
  readonly dependsOn = ['authentication', 'loop-host'] as const;

  readonly #now?: () => number;
  #service: WorkIngressService | undefined;

  constructor(config: { now?: () => number } = {}) {
    this.#now = config.now;
  }

  async init(kernel: KernelApi): Promise<void> {
    const boundary: PrincipalBoundary = kernel.getModule<AuthenticationModule>('authentication').getService();
    const host = kernel.getModule<LoopHostModule>('loop-host').getService();
    this.#service = new WorkIngressService({ boundary, host, now: this.#now });
    kernel.container.registerValue('work-ingress.service', this.#service);
    kernel.container.registerValue('work-ingress', this.#service);
    kernel.logger.info(
      `authenticated work ingress initialized (T-03): ${boundary.getPolicy().describe()}; ` +
        'no work is created at boot',
    );
  }

  getService(): WorkIngressService {
    if (!this.#service) throw new Error('Work ingress module is not initialized.');
    return this.#service;
  }
}
