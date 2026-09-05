import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { ActionExecutionAdapter } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
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

  async init(kernel: KernelApi, runtime: ActionRuntimeService): Promise<void> {
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
    const intent: PaymentIntent = {
      id: randomUUID(), tenantId: actor.tenantId, ventureId: input.ventureId, productId: input.productId, campaignId: input.campaignId,
      customerReference: input.customerReference, invoiceId: input.invoiceId, purpose: input.purpose, amount: copy(input.amount), providerId: input.providerId,
      providerCustomerReference: input.providerCustomerReference, idempotencyKey: input.idempotencyKey, status: 'DRAFT', verificationEvidence: [], createdAt: now, updatedAt: now,
    };
    await this.payments.put(intent);
    await this.emit(actor, PaymentEvents.IntentCreated, intent, { paymentId: intent.id, amount: intent.amount, invoiceId: intent.invoiceId });
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
    const action = payment.createActionId
      ? await this.runtime.getAction(actor, payment.createActionId)
      : await this.runtime.plan(actor, decision.id, {
          targetSystem: targetSystem(provider.id), idempotencyKey: input.idempotencyKey, dryRun: input.dryRun,
          rollbackStrategy: provider.rollback ? 'provider-managed payment rollback' : undefined,
          parameters: { paymentId: payment.id, operation: 'CREATE_PAYMENT' as PaymentOperation },
          resourceRequirements: [{ resourceType: 'MONEY', amount: payment.amount.amount, unit: payment.amount.currency, currency: payment.amount.currency }],
        });
    if (!action) throw new PaymentError('Payment action could not be planned.');
    const processing = await this.update(payment, { createActionId: action.id, status: 'PROCESSING' });
    const execution = await this.runtime.execute(actor, action.id, { maxAttempts: normalizedAttempts(provider.maxAttempts), timeoutMs: provider.defaultTimeoutMs });
    const result = this.providerResults.get(action.id);
    const status = execution.action.dryRun ? 'SIMULATED' : execution.action.executionStatus === 'VERIFYING' ? 'SUCCEEDED_UNVERIFIED' : execution.action.executionStatus === 'FAILED' ? 'FAILED' : 'BLOCKED';
    const updated = await this.update(processing, {
      status,
      providerReference: result?.providerReference ?? processing.providerReference,
      failureReason: execution.action.error,
    });
    await this.emit(actor, execution.action.executionStatus === 'VERIFYING' ? PaymentEvents.PaymentReported : PaymentEvents.PaymentFailed, updated, { paymentId: updated.id, status: updated.status, providerReference: updated.providerReference });
    return updated;
  }

  /** Independently verify provider state. Only this path can make payment revenue-eligible. */
  async verifyPayment(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status === 'SIMULATED') throw new PaymentError('A simulated payment cannot be verified as real revenue.');
    if (payment.status !== 'SUCCEEDED_UNVERIFIED' || !payment.createActionId) throw new PaymentError('Payment is not awaiting verification.');
    const { action, result } = await this.verifiedAction(actor, payment.createActionId);
    const verified = action.executionStatus === 'COMPLETED' && (result ? result.providerStatus === 'SUCCEEDED' : action.verificationStatus === 'VERIFIED');
    // T-05: the payment state and its `payment.verified` / `payment.failed`
    // event (+ unified-outbox record) commit as ONE composed write.
    return this.storage.atomically(async (scope) => {
      const updated = await this.update(payment, {
        status: verified ? 'VERIFIED' : 'FAILED',
        providerReference: result?.providerReference ?? payment.providerReference,
        verificationEvidence: copy(action.verificationEvidence),
        failureReason: verified ? undefined : action.error ?? 'Payment provider verification failed.',
        verifiedAt: verified ? Date.now() : undefined,
      }, scope);
      await this.emit(actor, verified ? PaymentEvents.PaymentVerified : PaymentEvents.PaymentFailed, updated, {
        paymentId: updated.id, invoiceId: updated.invoiceId, status: updated.status, amount: updated.amount, providerReference: updated.providerReference,
      }, scope);
      return updated;
    });
  }

  /** Refunds require a separate financial decision and independently verified provider state. */
  async requestRefund(actor: CommercialActor, paymentId: string, input: RequestRefundInput): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status !== 'VERIFIED') throw new PaymentError('Only a verified payment may be refunded.');
    const provider = this.requireProvider(actor, payment.providerId);
    if (!provider.supportsRefunds || !provider.refundPayment) throw new PaymentError('Payment provider does not support refunds.');
    const amount = input.amount ?? payment.amount;
    if (!moneyWithin(amount, payment.amount)) throw new PaymentError('Refund amount must match currency and may not exceed the verified payment amount.');
    const decision = await this.requireFinancialDecision(actor, input.decisionId, PaymentRefundActionType, amount);
    const action = await this.runtime.plan(actor, decision.id, {
      targetSystem: targetSystem(provider.id), idempotencyKey: input.idempotencyKey, dryRun: input.dryRun,
      rollbackStrategy: provider.rollback ? 'provider-managed refund rollback' : undefined,
      parameters: { paymentId: payment.id, operation: 'REFUND_PAYMENT' as PaymentOperation, reason: input.reason },
      resourceRequirements: [{ resourceType: 'MONEY', amount: amount.amount, unit: amount.currency, currency: amount.currency }],
    });
    const queued = await this.update(payment, { refundActionId: action.id, refundAmount: copy(amount), status: 'REFUND_PROCESSING' });
    const execution = await this.runtime.execute(actor, action.id, { maxAttempts: normalizedAttempts(provider.maxAttempts), timeoutMs: provider.defaultTimeoutMs });
    const result = this.providerResults.get(action.id);
    return this.update(queued, {
      status: execution.action.dryRun ? 'SIMULATED' : execution.action.executionStatus === 'VERIFYING' ? 'REFUND_UNVERIFIED' : 'FAILED',
      providerReference: result?.providerReference ?? queued.providerReference,
      failureReason: execution.action.error,
    });
  }

  async verifyRefund(actor: CommercialActor, paymentId: string): Promise<PaymentIntent> {
    assertManager(actor);
    const payment = await this.requirePayment(actor, paymentId);
    if (payment.status === 'SIMULATED') throw new PaymentError('A simulated refund cannot be verified as a real refund.');
    if (payment.status !== 'REFUND_UNVERIFIED' || !payment.refundActionId) throw new PaymentError('Refund is not awaiting verification.');
    const { action, result } = await this.verifiedAction(actor, payment.refundActionId);
    const verified = action.executionStatus === 'COMPLETED' && (result ? result.providerStatus === 'REFUNDED' : action.verificationStatus === 'VERIFIED');
    return this.storage.atomically(async (scope) => {
      const updated = await this.update(payment, {
        status: verified ? 'REFUNDED' : 'FAILED', providerReference: result?.providerReference ?? payment.providerReference,
        verificationEvidence: copy(action.verificationEvidence), failureReason: verified ? undefined : action.error ?? 'Refund verification failed.', refundedAt: verified ? Date.now() : undefined,
      }, scope);
      await this.emit(actor, verified ? PaymentEvents.RefundVerified : PaymentEvents.PaymentFailed, updated, { paymentId: updated.id, invoiceId: updated.invoiceId, status: updated.status, amount: updated.refundAmount ?? updated.amount, providerReference: updated.providerReference }, scope);
      return updated;
    });
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
    const action = alreadyJudged ? current : await this.runtime.verify(actor, actionId);
    return { action, result: this.verificationResults.get(actionId) };
  }

  private async update(payment: PaymentIntent, patch: Partial<PaymentIntent>, scope?: StorageWriteScope): Promise<PaymentIntent> {
    const updated: PaymentIntent = { ...payment, ...patch, updatedAt: Date.now() };
    const collection = scope ? await scope.collection<PaymentIntent>(PAYMENTS_COLLECTION) : this.payments;
    await collection.put(updated);
    return copy(updated);
  }

  private async emit(actor: CommercialActor, eventType: string, payment: PaymentIntent, payload: Record<string, unknown>, scope?: StorageWriteScope): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'payments', collectedAt: now, correlationId: payment.id };
    await this.controlPlane.publishEvent(actor, {
      eventType, source: 'payments', entityId: payment.id, correlationId: payment.id, payload,
      provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `${eventType}:${payment.id}:${payment.status}:${payment.updatedAt}`,
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

function moneyWithin(requested: MonetaryValue, ceiling: MonetaryValue): boolean {
  return requested.currency === ceiling.currency && requested.amount <= ceiling.amount;
}

function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean { return a.currency === b.currency && a.amount === b.amount; }

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
