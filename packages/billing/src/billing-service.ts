import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { moneyEquals, moneyProductEquals, quantizeMonetaryValue, sumMoney } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvent, CommercialProvenance, MonetaryValue } from '@jataqi/commercial-control-plane';
import { PaymentsModule } from '@jataqi/payments';
import type { PaymentsService } from '@jataqi/payments';
import {
  BillingEvents,
  type BillingPlan,
  type CreateBillingPlanInput,
  type CreateInvoiceInput,
  type CreateInvoicePaymentInput,
  type CreateSubscriptionInput,
  type Invoice,
  type InvoiceLine,
  type Subscription,
} from './types.js';

const PLANS_COLLECTION = 'billing.plans';
const SUBSCRIPTIONS_COLLECTION = 'billing.subscriptions';
const INVOICES_COLLECTION = 'billing.invoices';
/** T-05 durable inbox handler id — stable across restarts/deploys (keys the inbox). */
export const BILLING_DURABLE_HANDLER_ID = 'billing.verified-payments';

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Billing state is activated from independently verified payment events only.
 * Creating an invoice or receiving a provider acceptance never marks an invoice
 * paid or a subscription active.
 */
export class BillingService {
  private api!: KernelApi;
  private storage!: StorageModule;
  private plans!: ICollection<BillingPlan>;
  private subscriptions!: ICollection<Subscription>;
  private invoices!: ICollection<Invoice>;
  private payments!: PaymentsService;
  private controlPlane!: CommercialControlPlaneService;
  private unregisterDurableHandler?: () => void;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.storage = storage;
    this.plans = await storage.collection<BillingPlan>(PLANS_COLLECTION);
    this.subscriptions = await storage.collection<Subscription>(SUBSCRIPTIONS_COLLECTION);
    this.invoices = await storage.collection<Invoice>(INVOICES_COLLECTION);
    this.payments = kernel.getModule<PaymentsModule>('payments').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    // T-05 durable cutover: verified payment/refund events reach billing
    // ONLY through the canonical unified-outbox delivery worker, behind a
    // durable per-event inbox record (at-least-once + idempotent effect).
    // No volatile bus subscription remains for durable-domain events.
    this.unregisterDurableHandler = this.controlPlane.registerDurableHandler({
      id: BILLING_DURABLE_HANDLER_ID,
      eventTypes: ['payment.verified', 'payment.refund.verified'],
      maxAttempts: 5,
      handle: async (event) => {
        if (event.eventType === 'payment.verified') await this.handleVerifiedPayment(event);
        else if (event.eventType === 'payment.refund.verified') await this.handleVerifiedRefund(event);
      },
    });
  }

  stop(): void {
    this.unregisterDurableHandler?.();
    this.unregisterDurableHandler = undefined;
  }

  async createPlan(actor: CommercialActor, input: CreateBillingPlanInput): Promise<BillingPlan> {
    assertAdministrator(actor);
    validatePlan(input);
    const now = Date.now();
    // T-07/T-09 money policy: prices are quantized at the boundary at the
    // PLAN CURRENCY's minor-unit scale (JPY/KRW/CLP 0dp, BHD/KWD/OMR 3dp,
    // default 2dp) — a JPY plan price is whole yen, a KWD plan price keeps fils.
    const plan: BillingPlan = { id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, name: input.name, price: quantizeMonetaryValue(input.price), cycle: input.cycle, active: true, createdAt: now, updatedAt: now };
    await this.plans.put(plan);
    await this.emit(actor, BillingEvents.PlanCreated, plan.id, { planId: plan.id, productId: plan.productId });
    return copy(plan);
  }

  async createSubscription(actor: CommercialActor, input: CreateSubscriptionInput): Promise<Subscription> {
    assertManager(actor);
    if (!input.customerReference.trim() || !input.productId.trim()) throw new BillingError('Subscription customer and product references are required.');
    const plan = await this.plans.get(input.planId);
    if (!plan || !canRead(actor, plan.tenantId) || !plan.active || plan.productId !== input.productId) throw new BillingError('Active billing plan not found for product.');
    const now = Date.now();
    const trialDays = input.trialDays ?? 0;
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new BillingError('Trial days must be an integer from 0 to 365.');
    const subscription: Subscription = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, planId: plan.id, customerReference: input.customerReference,
      status: trialDays > 0 ? 'TRIAL' : 'PENDING_PAYMENT', trialEndsAt: trialDays > 0 ? now + trialDays * 86_400_000 : undefined,
      createdAt: now, updatedAt: now,
    };
    await this.subscriptions.put(subscription);
    await this.emit(actor, BillingEvents.SubscriptionCreated, subscription.id, { subscriptionId: subscription.id, status: subscription.status, planId: subscription.planId });
    return copy(subscription);
  }

  async createInvoice(actor: CommercialActor, input: CreateInvoiceInput): Promise<Invoice> {
    assertManager(actor);
    validateInvoiceInput(input);
    if (input.subscriptionId) {
      const subscription = await this.subscriptions.get(input.subscriptionId);
      if (!subscription || !canRead(actor, subscription.tenantId) || subscription.customerReference !== input.customerReference || subscription.productId !== input.productId) {
        throw new BillingError('Subscription does not match invoice tenant/customer/product context.');
      }
    }
    const now = Date.now();
    // T-07/T-09 money policy: invoice lines are quantized at the boundary at
    // their own currency's minor-unit scale and the invoice total is the
    // deterministic exact sum of the quantized line totals in that ONE
    // currency (never a float accumulation: 0.1 + 0.2 === 0.3; never a
    // cross-currency or cross-scale sum).
    const lines = input.lines.map((line) => ({ ...line, unitPrice: quantizeMonetaryValue(line.unitPrice), total: quantizeMonetaryValue(line.total) }));
    const total = sumLines(lines);
    const invoice: Invoice = {
      id: randomUUID(), tenantId: actor.tenantId, subscriptionId: input.subscriptionId, productId: input.productId, customerReference: input.customerReference,
      lines: copy(lines), total, status: 'ISSUED', issuedAt: now, dueAt: input.dueAt, createdAt: now, updatedAt: now,
    };
    await this.invoices.put(invoice);
    await this.emit(actor, BillingEvents.InvoiceIssued, invoice.id, { invoiceId: invoice.id, subscriptionId: invoice.subscriptionId, total: invoice.total });
    return copy(invoice);
  }

  /** Creates a provider-neutral payment intent; it does not charge or activate the invoice. */
  async createInvoicePayment(actor: CommercialActor, invoiceId: string, input: CreateInvoicePaymentInput): Promise<Invoice> {
    assertManager(actor);
    const invoice = await this.requireInvoice(actor, invoiceId);
    if (!['ISSUED', 'PAYMENT_PENDING'].includes(invoice.status)) throw new BillingError(`Invoice ${invoice.id} cannot create payment from ${invoice.status}.`);
    const payment = await this.payments.createIntent(actor, {
      productId: invoice.productId, customerReference: invoice.customerReference, invoiceId: invoice.id,
      purpose: `Invoice ${invoice.id}`, amount: invoice.total, providerId: input.providerId,
      providerCustomerReference: input.providerCustomerReference, idempotencyKey: input.idempotencyKey,
    });
    const updated: Invoice = { ...invoice, paymentId: payment.id, status: 'PAYMENT_PENDING', updatedAt: Date.now() };
    await this.invoices.put(updated);
    return copy(updated);
  }

  async cancelSubscription(actor: CommercialActor, subscriptionId: string, reason: string): Promise<Subscription> {
    assertManager(actor);
    if (!reason.trim()) throw new BillingError('Cancellation reason is required.');
    const subscription = await this.requireSubscription(actor, subscriptionId);
    const updated: Subscription = { ...subscription, status: 'CANCELLED', cancelledAt: Date.now(), updatedAt: Date.now() };
    await this.subscriptions.put(updated);
    await this.emit(actor, BillingEvents.SubscriptionCancelled, updated.id, { subscriptionId: updated.id, reason });
    return copy(updated);
  }

  async getPlan(actor: CommercialActor, id: string): Promise<BillingPlan | undefined> {
    const plan = await this.plans.get(id);
    return plan && canRead(actor, plan.tenantId) ? copy(plan) : undefined;
  }

  async getSubscription(actor: CommercialActor, id: string): Promise<Subscription | undefined> {
    const subscription = await this.subscriptions.get(id);
    return subscription && canRead(actor, subscription.tenantId) ? copy(subscription) : undefined;
  }

  async listPlans(actor: CommercialActor): Promise<BillingPlan[]> {
    return (await this.plans.all()).filter((plan) => canRead(actor, plan.tenantId)).map(copy);
  }

  async listSubscriptions(actor: CommercialActor): Promise<Subscription[]> {
    return (await this.subscriptions.all()).filter((subscription) => canRead(actor, subscription.tenantId)).map(copy);
  }

  async getInvoice(actor: CommercialActor, id: string): Promise<Invoice | undefined> {
    const invoice = await this.invoices.get(id);
    return invoice && canRead(actor, invoice.tenantId) ? copy(invoice) : undefined;
  }

  async listInvoices(actor: CommercialActor): Promise<Invoice[]> {
    return (await this.invoices.all()).filter((invoice) => canRead(actor, invoice.tenantId)).map(copy);
  }

  /**
   * Durable handler effect (idempotent): invoice PAID + `billing.invoice.paid`
   * (+ subscription ACTIVE + `billing.subscription.activated`) commit as ONE
   * composed write (T-05). The tenant is the EVENT's tenant (copied from the
   * durable outbox record), never a consumer-supplied value; the invoice and
   * the verified payment must both belong to it.
   */
  private async handleVerifiedPayment(event: CommercialEvent): Promise<void> {
    const paymentId = event.payload.paymentId;
    const invoiceId = event.payload.invoiceId;
    if (typeof paymentId !== 'string' || typeof invoiceId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const payment = await this.payments.getPayment(actor, paymentId);
    if (!payment || payment.status !== 'VERIFIED' || payment.tenantId !== event.tenantId) return;
    // T-06: the composed write runs under the EVENT's tenant (the invoice and
    // payment both provably belong to it), so the database RLS context is set
    // inside this transaction.
    // T-07 I-1/I-6: the ISSUED/PAYMENT_PENDING -> PAID transition is a
    // compare-and-set on the invoice row itself (the constraint-backed
    // single-finalization anchor): even if two PaymentVerified events for the
    // same payment are delivered concurrently, exactly one handler can move
    // the invoice to PAID and emit `billing.invoice.paid`; the other sees PAID
    // and returns. Redelivery after PAID is a no-op (I-7).
    await this.storage.atomically(async (scope) => {
      const invoices = await scope.collection<Invoice>(INVOICES_COLLECTION);
      const invoice = await invoices.get(invoiceId);
      if (!invoice || invoice.tenantId !== event.tenantId || invoice.paymentId !== payment.id || !moneyEquals(invoice.total, payment.amount)) return;
      const now = Date.now();
      const casResult = await invoices.cas(
        invoice.id,
        (current) => current !== undefined && (current.status === 'ISSUED' || current.status === 'PAYMENT_PENDING') && current.paymentId === payment.id,
        (current) => ({ ...current, status: 'PAID' as const, providerReference: payment.providerReference, paidAt: now, updatedAt: now }),
      );
      if (!casResult.ok || !casResult.doc) return; // another handler already finalized this invoice
      const paid = copy(casResult.doc);
      await this.emit(actor, BillingEvents.InvoicePaid, paid.id, { invoiceId: paid.id, paymentId: payment.id, amount: paid.total }, { key: `${paid.id}:${payment.id}`, causationId: event.id, scope });
      if (paid.subscriptionId) {
        const subscriptions = await scope.collection<Subscription>(SUBSCRIPTIONS_COLLECTION);
        const subscription = await subscriptions.get(paid.subscriptionId);
        if (subscription && subscription.tenantId === paid.tenantId && subscription.status !== 'CANCELLED' && subscription.status !== 'ACTIVE') {
          const period = cyclePeriod((await this.plans.get(subscription.planId))?.cycle);
          const active: Subscription = { ...subscription, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: now + period, updatedAt: now };
          const activated = await subscriptions.cas(subscription.id, (current) => current !== undefined && current.status === subscription.status, () => active);
          if (activated.ok) {
            await this.emit(actor, BillingEvents.SubscriptionActivated, active.id, { subscriptionId: active.id, invoiceId: paid.id }, { key: `${active.id}:${paid.id}`, causationId: event.id, scope });
          }
        }
      }
    }, { tenantId: event.tenantId });
  }

  private async handleVerifiedRefund(event: CommercialEvent): Promise<void> {
    const paymentId = event.payload.paymentId;
    const invoiceId = event.payload.invoiceId;
    if (typeof paymentId !== 'string' || typeof invoiceId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const payment = await this.payments.getPayment(actor, paymentId);
    if (!payment || payment.status !== 'REFUNDED' || payment.tenantId !== event.tenantId) return;
    // T-07 I-6: PAID -> REFUNDED is a compare-and-set finalization; an
    // invoice that is not PAID cannot be refunded (fail closed), and two
    // concurrent refund events produce exactly one REFUNDED transition and
    // one `billing.invoice.refunded` emission.
    await this.storage.atomically(async (scope) => {
      const invoices = await scope.collection<Invoice>(INVOICES_COLLECTION);
      const invoice = await invoices.get(invoiceId);
      if (!invoice || invoice.tenantId !== event.tenantId || invoice.paymentId !== payment.id) return;
      const casResult = await invoices.cas(
        invoice.id,
        (current) => current !== undefined && current.status === 'PAID' && current.paymentId === payment.id,
        (current) => ({ ...current, status: 'REFUNDED' as const, providerReference: payment.providerReference, refundedAt: Date.now(), updatedAt: Date.now() }),
      );
      if (!casResult.ok || !casResult.doc) return; // already finalized (REFUNDED) or not payable in this state
      const refunded = copy(casResult.doc);
      await this.emit(actor, BillingEvents.InvoiceRefunded, refunded.id, { invoiceId: refunded.id, paymentId: payment.id, amount: payment.refundAmount ?? payment.amount }, { key: `${refunded.id}:${payment.id}`, causationId: event.id, scope });
    }, { tenantId: event.tenantId });
  }

  private async requireInvoice(actor: CommercialActor, invoiceId: string): Promise<Invoice> {
    const invoice = await this.getInvoice(actor, invoiceId);
    if (!invoice) throw new BillingError('Invoice not found.');
    return invoice;
  }

  private async requireSubscription(actor: CommercialActor, id: string): Promise<Subscription> {
    const subscription = await this.getSubscription(actor, id);
    if (!subscription) throw new BillingError('Subscription not found.');
    return subscription;
  }

  /**
   * Publish a billing event. Operator-driven events keep their time-based
   * idempotency key (each call is a distinct business act); durable-handler
   * effects pass a replay-stable `key` so a redelivered event can never
   * produce a second `billing.invoice.paid`, and a `scope` so the event
   * commits with the state it describes.
   */
  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>, options: { key?: string; causationId?: string; scope?: StorageWriteScope } = {}): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'billing', collectedAt: now, correlationId: entityId, causationId: options.causationId };
    await this.controlPlane.publishEvent(
      actor,
      { eventType, source: 'billing', entityId, correlationId: entityId, causationId: options.causationId, payload, provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `${eventType}:${options.key ?? `${entityId}:${now}`}` },
      options.scope ? { scope: options.scope } : {},
    );
  }
}

function validatePlan(input: CreateBillingPlanInput): void {
  if (!input.productId.trim() || !input.name.trim()) throw new BillingError('Plan product id and name are required.');
  assertMoney(input.price);
}

function validateInvoiceInput(input: CreateInvoiceInput): void {
  if (!input.productId.trim() || !input.customerReference.trim() || !input.lines.length) throw new BillingError('Invoice product, customer reference, and lines are required.');
  for (const line of input.lines) {
    if (!line.description.trim() || !Number.isFinite(line.quantity) || line.quantity <= 0) throw new BillingError('Invoice line description and positive quantity are required.');
    assertMoney(line.unitPrice);
    assertMoney(line.total);
    // T-07 AC-5 / T-09 AC-7: the line-total check is the exact quantized
    // product rule (decimal-parts multiplication, rounded half-up ONCE at the
    // line currency's minor-unit scale), so float artifacts can never reject a
    // valid invoice (0.1 x 3, 19.99 x 3, 1.15 x 0.3) and a 0dp/3dp currency is
    // never silently assumed to have two decimal places.
    if (!moneyProductEquals(line.unitPrice, line.quantity, line.total)) throw new BillingError('Invoice line total must equal unit price times quantity in the same currency.');
  }
}

function sumLines(lines: readonly InvoiceLine[]): MonetaryValue {
  const currency = lines[0]!.total.currency;
  if (lines.some((line) => line.total.currency !== currency)) throw new BillingError('Invoice lines must use one currency.');
  // T-07/T-09: deterministic exact minor-unit summation at the shared line
  // currency's scale (never float accumulation, never mixed scales).
  return sumMoney(lines.map((line) => line.total));
}

function cyclePeriod(cycle: BillingPlan['cycle'] | undefined): number {
  return cycle === 'ANNUAL' ? 365 * 86_400_000 : cycle === 'ONE_TIME' ? 0 : 30 * 86_400_000;
}

function assertMoney(value: MonetaryValue): void { if (!Number.isFinite(value.amount) || value.amount < 0 || !value.currency.trim()) throw new BillingError('Monetary value must be non-negative with a currency.'); }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new BillingError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new BillingError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function systemActor(tenantId: string): CommercialActor { return { id: 'billing-system', tenantId, roles: ['system'] }; }
function copy<T>(value: T): T { return structuredClone(value); }
