import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { establishKernelWorkerAuthority, type KernelWorkerAuthorization } from '@jataqi/authorization-boundary';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { moneyEquals, moneyWithin, quantizeMonetaryValue } from '@jataqi/commercial-control-plane';
import type { CommercialAction, CommercialActor, CommercialDecision, CommercialEvidence, CommercialProvenance, CommercialControlPlaneService, MonetaryValue } from '@jataqi/commercial-control-plane';
import {
  PaymentCreateActionType,
  PaymentEvents,
  PaymentRefundActionType,
  type CreatePaymentIntentInput,
  type ExecutePaymentInput,
  type PaymentIntent,
  type PaymentOperation,
  type PaymentProvider,
  type PaymentProviderResult,
  type PaymentVerificationResult,
  type RegisteredPaymentProvider,
  type RequestRefundInput,
} from './types.js';

const PAYMENTS_COLLECTION = 'payments.intents';
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Provider-neutral payment orchestration. Intent creation is internal only;
 * provider-facing create/refund and verification calls travel through the
 * action runtime and Commercial Control Plane. No provider is bundled.
 */
export class PaymentsService {
  private api!: KernelApi;
  private storage!: StorageModule;
  private payments!: ICollection<PaymentIntent>;
  private runtime!: ActionRuntimeService;
  private controlPlane!: CommercialControlPlaneService;
  private readonly providers = new Map<string, PaymentProvider>();
  private readonly providerResults = new Map<string, PaymentProviderResult>();
  private readonly verificationResults = new Map<string, PaymentVerificationResult>();
  private readonly recoveredReservationIds = new Set<string>();

  /**
   * R1/D2: verified, scoped kernel-internal authority for the payments
   * worker. Established per registered provider adapter; `undefined` when no
   * boundary is installed, in which case execution DENIES (fail-closed).
   */
  private readonly workerAuthority = new Map<string, KernelWorkerAuthorization>();
  private kernel!: KernelApi;

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
    this.kernel = kernel;
    this.api = kernel;
    this.storage = kernel.getModule<StorageModule>('storage');
    this.payments = await this.storage.collection<PaymentIntent>(PAYMENTS_COLLECTION);
    this.runtime = runtime;
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  registerProvider(actor: CommercialActor, provider: PaymentProvider): RegisteredPaymentProvider {
    assertAdministrator(actor);
    validateProvider(provider);
    if (provider.tenantId && provider.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new PaymentError('Cross-tenant payment provider registration is not authorized.');
    if (this.providers.has(provider.id)) throw new PaymentError(`Payment provider "${provider.id}" is already registered.`);
    const actionTypes = provider.supportsRefunds ? [PaymentCreateActionType, PaymentRefundActionType] : [PaymentCreateActionType];
    const adapter: ActionExecutionAdapter = {
      id: `payment:${provider.id}`,
      targetSystem: targetSystem(provider.id),
      actionTypes,
      environment: 'sandbox',
      maxAttempts: normalizedAttempts(provider.maxAttempts),
      defaultTimeoutMs: normalizedTimeout(provider.defaultTimeoutMs),
      execute: async (context) => {
        const { payment, operation } = await this.paymentForAction(context.action);
        // T-07 I-2/AC-2/AC-3 (execution-time precondition): a queued action may
        // execute long after it was planned. Re-check the CURRENT payment state
        // before any provider call and fail closed without an external side
        // effect when the state no longer authorizes the operation. A stale
        // refund (payment already REFUNDED/REFUND_UNVERIFIED/FAILED) or a
        // replayed create (already PROCESSING or beyond) never reaches the
        // provider.
        if (operation === 'REFUND_PAYMENT' && payment.status !== 'REFUND_PROCESSING') {
          const stale: PaymentProviderResult = { reportedSuccess: false, providerStatus: 'FAILED', summary: `Refund refused: payment state ${payment.status} no longer authorizes provider execution (fail-closed precondition).` };
          this.providerResults.set(context.action.id, copy(stale));
          return stale;
        }
        // Create is refused only once the payment has left its pre-execution
        // states (e.g. already SUCCEEDED_UNVERIFIED/VERIFIED/REFUNDED/…);
        // DRAFT/FAILED retries keep provider-decline retry semantics intact.
        if (operation === 'CREATE_PAYMENT' && !['PROCESSING', 'DRAFT', 'REQUIRES_ACTION', 'FAILED'].includes(payment.status)) {
          const stale: PaymentProviderResult = { reportedSuccess: false, providerStatus: 'FAILED', summary: `Payment create refused: payment state ${payment.status} no longer authorizes provider execution (fail-closed precondition).` };
          this.providerResults.set(context.action.id, copy(stale));
          return stale;
        }
        const result = operation === 'CREATE_PAYMENT'
          ? await provider.createPayment({ payment, operation, action: context.action, actor: context.actor, signal: context.signal })
          : provider.refundPayment
            ? await provider.refundPayment({ payment, operation, action: context.action, actor: context.actor, signal: context.signal })
            : { reportedSuccess: false, providerStatus: 'FAILED' as const, summary: 'Provider does not support refunds.' };
        this.providerResults.set(context.action.id, copy(result));
        return result;
      },
      verify: async (context) => {
        const { payment, operation } = await this.paymentForAction(context.action);
        const result = await provider.verifyPayment({ payment, operation, action: context.action, actor: context.actor, signal: context.signal });
        this.verificationResults.set(context.action.id, copy(result));
        const expectedAmount = operation === 'REFUND_PAYMENT' ? payment.refundAmount ?? payment.amount : payment.amount;
        const amountMatches = !result.observedAmount || moneyEquals(expectedAmount, result.observedAmount);
        const expectedStatus = operation === 'REFUND_PAYMENT' ? 'REFUNDED' : 'SUCCEEDED';
        return { ...result, verified: result.verified && result.providerStatus === expectedStatus && amountMatches };
      },
      rollback: provider.rollback ? (context) => provider.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(adapter);
    // R1/D2: bind NARROW kernel-internal authority to exactly this adapter,
    // exactly these action types, and exactly this provider's target system.
    const authority = establishKernelWorkerAuthority(this.kernel, {
      capabilityId: `kernel.worker.payments.${provider.id}`,
      description: `Payments worker authority for provider ${provider.id}`,
      tool: adapter.id,
      operations: actionTypes,
      targets: [{ system: targetSystem(provider.id) }],
    });
    if (authority) this.workerAuthority.set(provider.id, authority);
    this.providers.set(provider.id, provider);
    return providerMetadata(provider, actor.tenantId);
  }

  async createIntent(actor: CommercialActor, input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    assertManager(actor);
    validateCreateInput(input);
    const existing = (await this.payments.query({ where: (payment) => payment.tenantId === actor.tenantId && payment.idempotencyKey === input.idempotencyKey, limit: 1 }))[0];
    if (existing) return copy(existing);
    const provider = this.providers.get(input.providerId);
    if (!provider || (provider.tenantId && !canRead(actor, provider.tenantId))) throw new PaymentError('Payment provider is not registered for this tenant.');
    if (!provider.currencies.includes(input.amount.currency)) throw new PaymentError(`Provider does not support ${input.amount.currency}.`);
    const now = Date.now();
    // T-07/T-09 money policy: amounts are quantized at the boundary to the
    // minor-unit scale OF THE PAYMENT CURRENCY (JPY/KRW/CLP 0dp, BHD/KWD/OMR
    // 3dp, default 2dp), so every stored payment amount and every later
    // comparison/sum is scale-exact in that currency.
    const amount = quantizeMonetaryValue(input.amount);
    const intent: PaymentIntent = {
      id: randomUUID(), tenantId: actor.tenantId, ventureId: input.ventureId, productId: input.productId, campaignId: input.campaignId,
      customerReference: input.customerReference, invoiceId: input.invoiceId, purpose: input.purpose, amount, providerId: input.providerId,
      providerCustomerReference: input.providerCustomerReference, idempotencyKey: input.idempotencyKey, status: 'DRAFT', verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await this.payments.put(intent);
    await this.emit(actor, PaymentEvents.IntentCreated, intent, { paymentId: intent.id, amount: intent.amount, invoiceId: intent.invoiceId }, undefined, `intent-created:${intent.id}`);
    return copy(intent);
  }

  /** Execute a payment only after a matching control-plane decision authorizes its financial amount. */
  async executePayment(actor: CommercialActor, paymentId: string, input: ExecutePaymentInput): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (!['DRAFT', 'FAILED', 'REQUIRES_ACTION'].includes(payment.status)) throw new PaymentError(`Payment ${payment.id} cannot execute from ${payment.status}.`);
    const provider = this.requireProvider(actor, payment.providerId);
    if (provider.environment === 'production' && !provider.productionEnabled) return this.update(payment, { status: 'BLOCKED', failureReason: 'Production payment provider is not explicitly enabled.' });
    const decision = await this.requireFinancialDecision(actor, input.decisionId, PaymentCreateActionType, payment.amount);
    // T-07 I-3: reserve the execution state with a compare-and-set so two
    // concurrent executions of the same payment cannot both plan a provider
    // create. The loser fails closed with no write and no provider call.
    // A retried execution (createActionId already set) re-uses its single
    // action exactly as before — no second reservation is possible.
    let action;
    let reserved = payment;
    if (!payment.createActionId) {
      const processing = await this.casTransition(payment, ['DRAFT', 'FAILED', 'REQUIRES_ACTION'], { status: 'PROCESSING' });
      // T-07 B-1: `runtime.plan` REJECTS on a plan-time refusal — a control-plane
      // DENY (kill switch, policy, budget), a simulation-only policy under
      // `dryRun:false`, a missing adapter. It does not return a falsy action, so
      // a `!action` guard alone can never observe those paths. Without this
      // try/catch the throw escapes past the reservation above and strands the
      // payment in PROCESSING, which no entry point accepts as a start state:
      // the payment deadlocks permanently. Release the reservation on EVERY
      // planning failure and rethrow the original error unchanged, so the
      // caller still sees the authoritative fail-closed refusal.
      try {
        action = await this.runtime.plan(actor, decision.id, {
          targetSystem: targetSystem(provider.id), idempotencyKey: input.idempotencyKey, dryRun: input.dryRun,
          rollbackStrategy: provider.rollback ? 'provider-managed payment rollback' : undefined,
          parameters: { paymentId: payment.id, operation: 'CREATE_PAYMENT' as PaymentOperation },
          resourceRequirements: [{ resourceType: 'MONEY', amount: processing.amount.amount, unit: processing.amount.currency, currency: processing.amount.currency }],
        });
      } catch (error) {
        await this.releaseReservation(actor, processing, 'PROCESSING', { status: payment.status });
        throw error;
      }
      if (!action) {
        // Defensive: a falsy plan result leaves the payment exactly where it
        // was (DRAFT/FAILED/REQUIRES_ACTION) — same release path as a throw.
        await this.releaseReservation(actor, processing, 'PROCESSING', { status: payment.status });
        throw new PaymentError('Payment action could not be planned.');
      }
      reserved = await this.update(processing, { createActionId: action.id });
    } else {
      action = await this.runtime.getAction(actor, payment.createActionId);
      if (!action) throw new PaymentError('Payment execution action is missing.');
    }
    const execution = await this.runtime.execute(actor, action.id, {
      maxAttempts: normalizedAttempts(provider.maxAttempts),
      timeoutMs: provider.defaultTimeoutMs,
      ...(this.workerAuthority.has(provider.id) ? { authorization: this.workerAuthority.get(provider.id)! } : {}),
    });
    const result = this.providerResults.get(action.id);
    const status = execution.action.dryRun ? 'SIMULATED' : execution.action.executionStatus === 'VERIFYING' ? 'SUCCEEDED_UNVERIFIED' : execution.action.executionStatus === 'FAILED' ? 'FAILED' : 'BLOCKED';
    const updated = await this.update(reserved, {
      status,
      providerReference: result?.providerReference ?? reserved.providerReference,
      failureReason: execution.action.error,
    });
    const executionKey = execution.action.executionStatus === 'VERIFYING'
      ? `payment-reported:${updated.id}:${action.id}`
      : `payment-failed:${updated.id}:create:${updated.createActionId ?? action.id}`;
    await this.emit(actor, execution.action.executionStatus === 'VERIFYING' ? PaymentEvents.PaymentReported : PaymentEvents.PaymentFailed, updated, { paymentId: updated.id, status: updated.status, providerReference: updated.providerReference }, undefined, executionKey);
    return updated;
  }

  /** Independently verify provider state. Only this path can make payment revenue-eligible. */
  async verifyPayment(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status === 'VERIFIED') return copy(payment); // I-7/AC-1: repeat finalization observes the final state, no second event
    if (payment.status === 'SIMULATED') throw new PaymentError('A simulated payment cannot be verified as real revenue.');
    if (payment.status !== 'SUCCEEDED_UNVERIFIED' || !payment.createActionId) throw new PaymentError('Payment is not awaiting verification.');
    const { action, result } = await this.verifiedAction(actor, payment.createActionId);
    const verified = action.executionStatus === 'COMPLETED' && (result ? result.providerStatus === 'SUCCEEDED' : action.verificationStatus === 'VERIFIED');
    // T-05: the payment state and its `payment.verified` / `payment.failed`
    // event (+ unified-outbox record) commit as ONE composed write.
    // T-06: when the payment belongs to the actor's tenant the transaction
    // runs under that tenant's RLS context (cross-tenant global-admin flows
    // stay on the system scope — application authorization is unchanged).
    // T-07 I-1/I-3: the transition itself is a compare-and-set on the current
    // status inside the composed write: exactly one of N concurrent verifiers
    // can move SUCCEEDED_UNVERIFIED -> VERIFIED/FAILED and publish the single
    // `PaymentVerified` event (stable per-(payment, transition) anchor key,
    // no longer updatedAt-dependent). Losers read and return the winner's
    // final state without emitting anything.
    const tenantBinding = payment.tenantId === actor.tenantId ? { tenantId: actor.tenantId } : {};
    return this.storage.atomically(async (scope) => {
      const updated = await this.casTransitionWithinScope(scope, payment.id, ['SUCCEEDED_UNVERIFIED'], {
        status: verified ? 'VERIFIED' : 'FAILED',
        ...(result?.providerReference ? { providerReference: result.providerReference } : {}),
        verificationEvidence: copy(action.verificationEvidence),
        failureReason: verified ? undefined : action.error ?? 'Payment provider verification failed.',
        verifiedAt: verified ? Date.now() : undefined,
      });
      if (!updated) {
        const winner = await (await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION)).get(payment.id);
        if (!winner) throw new PaymentError('Payment intent disappeared during verification.');
        if (!['VERIFIED', 'FAILED'].includes(winner.status)) throw new PaymentError(`Payment ${payment.id} changed state concurrently (${winner.status}); verification aborted fail-closed.`);
        return copy(winner);
      }
      await this.emit(actor, verified ? PaymentEvents.PaymentVerified : PaymentEvents.PaymentFailed, updated, {
        paymentId: updated.id, invoiceId: updated.invoiceId, status: updated.status, amount: updated.amount, providerReference: updated.providerReference,
      }, scope, verified ? `payment-verified:${updated.id}` : `payment-failed:${updated.id}:create:${updated.createActionId}`);
      return copy(updated);
    }, tenantBinding);
  }

  /** Refunds require a separate financial decision and independently verified provider state. */
  async requestRefund(actor: CommercialActor, paymentId: string, input: RequestRefundInput): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status !== 'VERIFIED') throw new PaymentError('Only a verified payment may be refunded.');
    const provider = this.requireProvider(actor, payment.providerId);
    if (!provider.supportsRefunds || !provider.refundPayment) throw new PaymentError('Payment provider does not support refunds.');
    const amount = quantizeMonetaryValue(input.amount ?? payment.amount);
    if (!moneyWithin(amount, payment.amount)) throw new PaymentError('Refund amount must match currency and may not exceed the verified payment amount.');
    const decision = await this.requireFinancialDecision(actor, input.decisionId, PaymentRefundActionType, amount);
    // T-07 I-3/AC-2: reserve VERIFIED -> REFUND_PROCESSING with a CAS before
    // planning. Two concurrent refund requests for one payment: exactly one
    // reservation wins; the loser fails closed here — before any action is
    // planned and before any provider call can happen.
    const queued = await this.casTransition(payment, ['VERIFIED'], { refundAmount: copy(amount), status: 'REFUND_PROCESSING' });
    // T-07 B-1: identical hazard on the refund path. A plan-time DENY here
    // strands the payment in REFUND_PROCESSING — `requestRefund` requires
    // VERIFIED and `verifyRefund` requires REFUND_UNVERIFIED, so neither can
    // ever pick it up again and the refund deadlocks. Release the reservation
    // back to VERIFIED (restoring the prior refundAmount) and rethrow.
    let action;
    try {
      action = await this.runtime.plan(actor, decision.id, {
        targetSystem: targetSystem(provider.id), idempotencyKey: input.idempotencyKey, dryRun: input.dryRun,
        rollbackStrategy: provider.rollback ? 'provider-managed refund rollback' : undefined,
        parameters: { paymentId: payment.id, operation: 'REFUND_PAYMENT' as PaymentOperation, reason: input.reason },
        resourceRequirements: [{ resourceType: 'MONEY', amount: amount.amount, unit: amount.currency, currency: amount.currency }],
      });
    } catch (error) {
      await this.releaseReservation(actor, queued, 'REFUND_PROCESSING', { status: 'VERIFIED', refundAmount: payment.refundAmount });
      throw error;
    }
    if (!action) {
      // Defensive: falsy plan result releases the reservation identically.
      await this.releaseReservation(actor, queued, 'REFUND_PROCESSING', { status: 'VERIFIED', refundAmount: payment.refundAmount });
      throw new PaymentError('Refund action could not be planned.');
    }
    const reserved = await this.update(queued, { refundActionId: action.id });
    const execution = await this.runtime.execute(actor, action.id, {
      maxAttempts: normalizedAttempts(provider.maxAttempts),
      timeoutMs: provider.defaultTimeoutMs,
      ...(this.workerAuthority.has(provider.id) ? { authorization: this.workerAuthority.get(provider.id)! } : {}),
    });
    const result = this.providerResults.get(action.id);
    return this.update(reserved, {
      status: execution.action.dryRun ? 'SIMULATED' : execution.action.executionStatus === 'VERIFYING' ? 'REFUND_UNVERIFIED' : 'FAILED',
      providerReference: result?.providerReference ?? reserved.providerReference,
      failureReason: execution.action.error,
    });
  }

  async verifyRefund(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status === 'REFUNDED') return copy(payment); // I-7/AC-1: repeat finalization observes the final state, no second event
    if (payment.status === 'SIMULATED') throw new PaymentError('A simulated refund cannot be verified as a real refund.');
    if (payment.status !== 'REFUND_UNVERIFIED' || !payment.refundActionId) throw new PaymentError('Refund is not awaiting verification.');
    const { action, result } = await this.verifiedAction(actor, payment.refundActionId);
    const verified = action.executionStatus === 'COMPLETED' && (result ? result.providerStatus === 'REFUNDED' : action.verificationStatus === 'VERIFIED');
    // T-07 I-1/I-3: CAS finalization (see verifyPayment) — at most one
    // REFUND_UNVERIFIED -> REFUNDED transition and one `RefundVerified`
    // event per payment, keyed on the stable (payment, transition) anchor.
    const tenantBinding = payment.tenantId === actor.tenantId ? { tenantId: actor.tenantId } : {};
    return this.storage.atomically(async (scope) => {
      const updated = await this.casTransitionWithinScope(scope, payment.id, ['REFUND_UNVERIFIED'], {
        status: verified ? 'REFUNDED' : 'FAILED',
        ...(result?.providerReference ? { providerReference: result.providerReference } : {}),
        verificationEvidence: copy(action.verificationEvidence),
        failureReason: verified ? undefined : action.error ?? 'Refund verification failed.',
        refundedAt: verified ? Date.now() : undefined,
      });
      if (!updated) {
        const winner = await (await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION)).get(payment.id);
        if (!winner) throw new PaymentError('Payment intent disappeared during refund verification.');
        if (!['REFUNDED', 'FAILED'].includes(winner.status)) throw new PaymentError(`Payment ${payment.id} changed state concurrently (${winner.status}); refund verification aborted fail-closed.`);
        return copy(winner);
      }
      await this.emit(actor, verified ? PaymentEvents.RefundVerified : PaymentEvents.PaymentFailed, updated, { paymentId: updated.id, invoiceId: updated.invoiceId, status: updated.status, amount: updated.refundAmount ?? updated.amount, providerReference: updated.providerReference }, scope, verified ? `refund-verified:${updated.id}` : `payment-failed:${updated.id}:refund:${updated.refundActionId}`);
      return copy(updated);
    }, tenantBinding);
  }

  async getPayment(actor: CommercialActor, paymentId: string): Promise<PaymentIntent | undefined> {
    const payment = await this.payments.get(paymentId);
    return payment && canRead(actor, payment.tenantId) ? copy(payment) : undefined;
  }

  async listPayments(actor: CommercialActor): Promise<PaymentIntent[]> {
    return (await this.payments.all()).filter((payment) => canRead(actor, payment.tenantId)).map(copy);
  }

  private requireProvider(actor: CommercialActor, providerId: string): PaymentProvider {
    const provider = this.providers.get(providerId);
    if (!provider || (provider.tenantId && !canRead(actor, provider.tenantId))) throw new PaymentError('Payment provider is not available for this tenant.');
    return provider;
  }

  private async requirePayment(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    const payment = await this.getPayment(actor, paymentId);
    if (!payment) throw new PaymentError('Payment intent not found.');
    return payment;
  }

  private async requireFinancialDecision(actor: CommercialActor, decisionId: string, actionType: string, amount: MonetaryValue): Promise<CommercialDecision> {
    const decision = await this.runtime.getDecision(actor, decisionId);
    if (!decision) throw new PaymentError('Commercial decision not found.');
    if (decision.actionType !== actionType) throw new PaymentError(`Financial decision must use action type ${actionType}.`);
    // Financial exposure must be explicit as an estimated cost/exposure so the
    // Commercial Control Plane can apply scoped money budgets before planning.
    const declared = decision.estimatedCost;
    if (!declared || !moneyWithin(amount, declared)) throw new PaymentError('Commercial decision does not authorize the requested financial amount/currency.');
    return decision;
  }

  private async paymentForAction(action: CommercialAction): Promise<{ payment: PaymentIntent; operation: PaymentOperation }> {
    const paymentId = action.parameters.paymentId;
    const operation = action.parameters.operation;
    if (typeof paymentId !== 'string' || (operation !== 'CREATE_PAYMENT' && operation !== 'REFUND_PAYMENT')) throw new PaymentError('Action does not identify a valid payment operation.');
    const payment = await this.payments.get(paymentId);
    if (!payment || payment.tenantId !== action.tenantId) throw new PaymentError('Payment intent does not belong to the action tenant.');
    return { payment, operation };
  }

  /**
   * T-05 (DB atomicity vs external atomicity): the provider verification is
   * an EXTERNAL effect whose verdict the control plane records durably on the
   * action (VERIFYING -> COMPLETED/FAILED) in its own write, BEFORE the
   * composed payment write. If a crash or rollback separates the two, the
   * action already carries the verdict: resume from that durable state
   * instead of calling the provider again (the action can never be verified
   * twice, and the payment must not dead-end on "not awaiting verification").
   * An action that never reached VERIFYING still fails closed in `verify`.
   */
  private async verifiedAction(actor: CommercialActor, actionId: string): Promise<{ action: CommercialAction; result?: PaymentVerificationResult }> {
    const current = await this.runtime.getAction(actor, actionId);
    const alreadyJudged = current !== undefined && current.executionStatus !== 'VERIFYING' && (current.verificationStatus === 'VERIFIED' || current.verificationStatus === 'FAILED');
    if (alreadyJudged) return { action: current, result: this.verificationResults.get(actionId) };
    try {
      const action = await this.runtime.verify(actor, actionId);
      return { action, result: this.verificationResults.get(actionId) };
    } catch (error) {
      // T-07 I-3/I-7: two OS processes may verify the SAME action
      // concurrently (AC-1). The winner's durable verdict (VERIFIED/FAILED)
      // is the authoritative result; a loser whose verify raced into a
      // settled state resumes from the winner's recorded judgment instead of
      // failing the whole finalization.
      const reread = await this.runtime.getAction(actor, actionId);
      if (reread && reread.executionStatus !== 'VERIFYING' && (reread.verificationStatus === 'VERIFIED' || reread.verificationStatus === 'FAILED')) {
        return { action: reread, result: this.verificationResults.get(actionId) };
      }
      throw error;
    }
  }

  private async update(payment: PaymentIntent, patch: Partial<PaymentIntent>, scope?: StorageWriteScope): Promise<PaymentIntent> {
    const updated: PaymentIntent = { ...payment, ...patch, updatedAt: Date.now() };
    const collection = scope ? await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION) : this.payments;
    await collection.put(updated);
    return copy(updated);
  }

  /**
   * T-07 I-3: compare-and-set a payment status transition inside one composed
   * write. The guard runs under the storage row lock, so concurrent
   * transitions of the same payment serialize to exactly one winner; the
   * loser receives `undefined` and must read/return the winner's final state.
   * Only the expected current status(es) may transition; anything else fails
   * closed with no write.
   */
  private async casTransitionWithinScope(scope: StorageWriteScope, paymentId: string, expected: readonly string[], patch: Partial<PaymentIntent>): Promise<PaymentIntent | undefined> {
    const collection = await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION);
    const result = await collection.cas(
      paymentId,
      (current) => current !== undefined && expected.includes(current.status),
      (current) => ({ ...current, ...patch, updatedAt: Date.now() }),
    );
    if (!result.ok) return undefined;
    return copy(result.doc);
  }

  /**
   * T-07 B-1: release a planning reservation taken before `runtime.plan`.
   *
   * Best-effort by design. The reservation is released only while the payment
   * is still in the reserved status, so a concurrent winner that has already
   * advanced the row is never overwritten — the CAS simply finds no match and
   * this returns without a write. Any failure is swallowed deliberately: the
   * caller is already unwinding an authoritative planning refusal and MUST
   * surface that original error rather than a secondary rollback error.
   *
   * T-08 F-1b: bounded retry (3 attempts, 50/100/200ms) with structured
   * observability. On final infra failure, a warning is logged, a
   * `payments.reservation.release.failed` event is emitted (with tenant,
   * payment, reservation state, reason, correlation, attempts), and a
   * `payment.reservation.release_failed` metaphoric metric is recorded via
   * the same event. The original DENY is still preserved — secondary errors
   * never mask it.
   */
  private async releaseReservation(actor: CommercialActor, reserved: PaymentIntent, reservedStatus: string, restore: Partial<PaymentIntent>): Promise<void> {
    const delays = [50, 100, 200];
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.casTransition(reserved, [reservedStatus], restore);
        return;
      } catch (error) {
        if (error instanceof PaymentError && String((error as Error).message).includes('cannot transition')) {
          return;
        }
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 50));
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.api.logger.warn('payment reservation release failed after retries', {
          paymentId: reserved.id,
          tenantId: reserved.tenantId,
          reservedStatus,
          attempts: attempt + 1,
          reason,
          category: 'reservation_release_failed',
          correlationId: reserved.id,
        });
        try {
          await this.emit(actor, PaymentEvents.ReservationReleaseFailed, reserved, {
            paymentId: reserved.id,
            tenantId: reserved.tenantId,
            reservedStatus,
            restoreStatus: (restore as { status?: string }).status,
            reason,
            category: 'reservation_release_failed',
            correlationId: reserved.id,
            attempts: attempt + 1,
          }, undefined, `reservation-release-failed:${reserved.id}:${reservedStatus}`);
        } catch (emitError) {
          this.api.logger.error('failed to emit reservation release failure event', emitError as Error);
        }
        return;
      }
    }
    void lastError;
  }

  /**
   * T-08 admin recovery for F-1b: recover a payment stuck in
   * PROCESSING/REFUND_PROCESSING after an infra-failed releaseReservation.
   * Idempotent, tenant-bound, admin-only, CAS-only.
   */
  async adminReleaseReservation(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    assertAdministrator(actor);
    const payment = await this.requirePayment(actor, paymentId);
    // T-08.1 P1: fast-path for same-process idempotency, but persistent CAS is authoritative.
    // A caller that already recovered this payment in this process and sees a recovered state may return immediately.
    if (this.recoveredReservationIds.has(paymentId) && (payment.status === 'DRAFT' || payment.status === 'VERIFIED')) {
      return copy(payment);
    }
    if (payment.status !== 'PROCESSING' && payment.status !== 'REFUND_PROCESSING') {
      throw new PaymentError(`Payment ${payment.id} is not in a recoverable reservation state (${payment.status}).`);
    }
    const previousStatus = payment.status;
    let recovered: PaymentIntent;
    if (payment.status === 'PROCESSING') {
      try {
        recovered = await this.casTransition(payment, ['PROCESSING'], { status: 'DRAFT' });
      } catch (error) {
        if (error instanceof PaymentError && String((error as Error).message).includes('cannot transition')) {
          const winner = await this.payments.get(paymentId);
          // T-08.1 P1: cross-process idempotency — if another worker already recovered PROCESSING→DRAFT, return winner
          if (winner && winner.status === 'DRAFT' && canRead(actor, winner.tenantId)) {
            this.recoveredReservationIds.add(paymentId);
            return copy(winner);
          }
          throw error;
        }
        throw error;
      }
    } else {
      try {
        recovered = await this.casTransition(payment, ['REFUND_PROCESSING'], { status: 'VERIFIED', refundAmount: undefined });
      } catch (error) {
        if (error instanceof PaymentError && String((error as Error).message).includes('cannot transition')) {
          const winner = await this.payments.get(paymentId);
          // T-08.1 P1: cross-process idempotency — REFUND_PROCESSING→VERIFIED winner
          if (winner && winner.status === 'VERIFIED' && canRead(actor, winner.tenantId)) {
            this.recoveredReservationIds.add(paymentId);
            return copy(winner);
          }
          throw error;
        }
        throw error;
      }
    }
    this.recoveredReservationIds.add(paymentId);
    await this.emit(actor, PaymentEvents.ReservationReleased, recovered, {
      paymentId: recovered.id,
      tenantId: recovered.tenantId,
      restoredStatus: recovered.status,
      previousStatus,
      reason: 'admin reservation recovery',
      correlationId: recovered.id,
    }, undefined, `reservation-released:${recovered.id}:${previousStatus}`);
    return copy(recovered);
  }

  /** Standalone (non-composed) CAS transition for reservation entry points. */
  private async casTransition(payment: PaymentIntent, expected: readonly string[], patch: Partial<PaymentIntent>): Promise<PaymentIntent> {
    const tenantBinding = { tenantId: payment.tenantId };
    return this.storage.atomically(async (scope) => {
      const updated = await this.casTransitionWithinScope(scope, payment.id, expected, patch);
      if (!updated) {
        const winner = await (await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION)).get(payment.id);
        const observed = winner?.status ?? '<missing>';
        throw new PaymentError(`Payment ${payment.id} cannot transition from ${observed} (expected ${expected.join(' or ')}); concurrent transition won — operation aborted fail-closed.`);
      }
      return updated;
    }, tenantBinding);
  }

  /**
   * Publish a payments event. T-07: idempotency keys are STABLE per
   * (payment, transition) — callers pass an explicit `key` for finalization
   * events; the default is `${eventType}:${payment.id}`. Keys never embed
   * `updatedAt`, so a redelivered or duplicated finalization can never
   * masquerade as a second, distinct event.
   */
  private async emit(actor: CommercialActor, eventType: string, payment: PaymentIntent, payload: Record<string, unknown>, scope?: StorageWriteScope, key?: string): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'payments', collectedAt: now, correlationId: payment.id };
    await this.controlPlane.publishEvent(actor, {
      eventType, source: 'payments', entityId: payment.id, correlationId: payment.id, payload,
      provenance, privacyClassification: 'RESTRICTED', idempotencyKey: key ?? `${eventType}:${payment.id}`,
    }, scope ? { scope } : {});
  }
}

function targetSystem(providerId: string): string { return `payment:${providerId}`; }

function providerMetadata(provider: PaymentProvider, fallbackTenantId: string): RegisteredPaymentProvider {
  return {
    id: provider.id,
    tenantId: provider.tenantId ?? fallbackTenantId,
    currencies: [...provider.currencies],
    supportsRefunds: provider.supportsRefunds,
    environment: provider.environment,
    productionEnabled: provider.productionEnabled ?? false,
    maxAttempts: normalizedAttempts(provider.maxAttempts),
    defaultTimeoutMs: normalizedTimeout(provider.defaultTimeoutMs),
    credentialReference: provider.credentialReference,
  };
}

function validateCreateInput(input: CreatePaymentIntentInput): void {
  if (!input.customerReference.trim() || !input.purpose.trim() || !input.providerId.trim() || !input.idempotencyKey.trim()) throw new PaymentError('Payment customer reference, purpose, provider, and idempotency key are required.');
  assertMoney(input.amount);
}

function validateProvider(provider: PaymentProvider): void {
  if (!provider.id.trim() || !provider.currencies.length || provider.currencies.some((currency) => !currency.trim())) throw new PaymentError('Payment provider id and supported currencies are required.');
  if (provider.environment !== 'sandbox' && provider.environment !== 'production') throw new PaymentError('Payment provider environment must be sandbox or production.');
  if (provider.supportsRefunds && !provider.refundPayment) throw new PaymentError('Refund-capable provider must implement refundPayment.');
  normalizedAttempts(provider.maxAttempts);
  normalizedTimeout(provider.defaultTimeoutMs);
}

function assertMoney(value: MonetaryValue): void {
  if (!Number.isFinite(value.amount) || value.amount < 0 || !value.currency.trim()) throw new PaymentError('Payment amount must be non-negative and include a currency.');
}

function normalizedAttempts(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new PaymentError(`Payment retry limit must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return attempts;
}

function normalizedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300_000) throw new PaymentError('Payment timeout must be between 1ms and 300000ms.');
  return timeout;
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new PaymentError('Commercial administrator role is required.');
}

function assertManager(actor: CommercialActor): void {
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new PaymentError('Commercial operator role is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
