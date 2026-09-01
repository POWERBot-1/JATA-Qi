import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
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
  private plans!: ICollection<BillingPlan>;
  private subscriptions!: ICollection<Subscription>;
  private invoices!: ICollection<Invoice>;
  private payments!: PaymentsService;
  private controlPlane!: CommercialControlPlaneService;
  private unsubscribePayment?: () => void;
  private unsubscribeRefund?: () => void;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.plans = await storage.collection<BillingPlan>(PLANS_COLLECTION);
    this.subscriptions = await storage.collection<Subscription>(SUBSCRIPTIONS_COLLECTION);
    this.invoices = await storage.collection<Invoice>(INVOICES_COLLECTION);
    this.payments = kernel.getModule<PaymentsModule>('payments').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.unsubscribePayment = kernel.bus.on('payment.verified', async (event) => this.handleVerifiedPayment(event as CommercialEvent));
    this.unsubscribeRefund = kernel.bus.on('payment.refund.verified', async (event) => this.handleVerifiedRefund(event as CommercialEvent));
  }

  stop(): void {
    this.unsubscribePayment?.();
    this.unsubscribeRefund?.();
  }

  async createPlan(actor: CommercialActor, input: CreateBillingPlanInput): Promise<BillingPlan> {
    assertAdministrator(actor);
    validatePlan(input);
    const now = Date.now();
    const plan: BillingPlan = { id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, name: input.name, price: copy(input.price), cycle: input.cycle, active: true, createdAt: now, updatedAt: now };
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
    const total = sumLines(input.lines);
    const invoice: Invoice = {
      id: randomUUID(), tenantId: actor.tenantId, subscriptionId: input.subscriptionId, productId: input.productId, customerReference: input.customerReference,
      lines: copy(input.lines), total, status: 'ISSUED', issuedAt: now, dueAt: input.dueAt, createdAt: now, updatedAt: now,
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

  private async handleVerifiedPayment(event: CommercialEvent): Promise<void> {
    const paymentId = event.payload.paymentId;
    const invoiceId = event.payload.invoiceId;
    if (typeof paymentId !== 'string' || typeof invoiceId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const [payment, invoice] = await Promise.all([this.payments.getPayment(actor, paymentId), this.invoices.get(invoiceId)]);
    if (!payment || payment.status !== 'VERIFIED' || !invoice || invoice.tenantId !== event.tenantId || invoice.paymentId !== payment.id || !moneyEquals(invoice.total, payment.amount)) return;
    if (invoice.status === 'PAID') return;
    const now = Date.now();
    const paid: Invoice = { ...invoice, status: 'PAID', providerReference: payment.providerReference, paidAt: now, updatedAt: now };
    await this.invoices.put(paid);
    await this.emit(actor, BillingEvents.InvoicePaid, paid.id, { invoiceId: paid.id, paymentId: payment.id, amount: paid.total });
    if (paid.subscriptionId) {
      const subscription = await this.subscriptions.get(paid.subscriptionId);
      if (subscription && subscription.tenantId === paid.tenantId && subscription.status !== 'CANCELLED') {
        const period = cyclePeriod((await this.plans.get(subscription.planId))?.cycle);
        const active: Subscription = { ...subscription, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: now + period, updatedAt: now };
        await this.subscriptions.put(active);
        await this.emit(actor, BillingEvents.SubscriptionActivated, active.id, { subscriptionId: active.id, invoiceId: paid.id });
      }
    }
  }

  private async handleVerifiedRefund(event: CommercialEvent): Promise<void> {
    const paymentId = event.payload.paymentId;
    const invoiceId = event.payload.invoiceId;
    if (typeof paymentId !== 'string' || typeof invoiceId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const [payment, invoice] = await Promise.all([this.payments.getPayment(actor, paymentId), this.invoices.get(invoiceId)]);
    if (!payment || payment.status !== 'REFUNDED' || !invoice || invoice.tenantId !== event.tenantId || invoice.paymentId !== payment.id) return;
    const refunded: Invoice = { ...invoice, status: 'REFUNDED', providerReference: payment.providerReference, refundedAt: Date.now(), updatedAt: Date.now() };
    await this.invoices.put(refunded);
    await this.emit(actor, BillingEvents.InvoiceRefunded, refunded.id, { invoiceId: refunded.id, paymentId: payment.id, amount: payment.refundAmount ?? payment.amount });
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

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'billing', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'billing', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `${eventType}:${entityId}:${now}` });
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
    if (line.unitPrice.currency !== line.total.currency || line.total.amount !== line.unitPrice.amount * line.quantity) throw new BillingError('Invoice line total must equal unit price times quantity in the same currency.');
  }
}

function sumLines(lines: readonly InvoiceLine[]): MonetaryValue {
  const currency = lines[0]!.total.currency;
  if (lines.some((line) => line.total.currency !== currency)) throw new BillingError('Invoice lines must use one currency.');
  return { amount: lines.reduce((total, line) => total + line.total.amount, 0), currency };
}

function cyclePeriod(cycle: BillingPlan['cycle'] | undefined): number {
  return cycle === 'ANNUAL' ? 365 * 86_400_000 : cycle === 'ONE_TIME' ? 0 : 30 * 86_400_000;
}

function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean { return a.currency === b.currency && a.amount === b.amount; }
function assertMoney(value: MonetaryValue): void { if (!Number.isFinite(value.amount) || value.amount < 0 || !value.currency.trim()) throw new BillingError('Monetary value must be non-negative with a currency.'); }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new BillingError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new BillingError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function systemActor(tenantId: string): CommercialActor { return { id: 'billing-system', tenantId, roles: ['system'] }; }
function copy<T>(value: T): T { return structuredClone(value); }
