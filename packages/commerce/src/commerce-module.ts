// CommerceModule — the JATA Qi Commercial & Product Packaging engine. All
// products, plans, prices, entitlements, cycles, currencies and commission rates
// are configurable data. Payments are abstracted behind a provider adapter; no
// real money movement is wired by default (an explicit adapter must be supplied).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { CommerceEvents, UNLIMITED } from './types.js';
import type {
  BillingCycle, CreditBatch, EntitlementOverride, Entitlements, Invoice, InvoiceLine,
  License, MarketplaceItem, MarketplaceOrder, Money, PaymentProvider, PaymentRecord,
  Plan, Product, Payout, Subscription, SubscriptionStatus, UsageEvent,
} from './types.js';
import { evaluate, quotaFor } from './entitlements.js';
import { add, money, monthlyEquivalent, multiply, pct } from './money.js';
import { DEFAULT_PLANS, DEFAULT_PRODUCTS } from './catalog.js';

const DAY = 86_400_000;
function cycleMs(cycle: BillingCycle): number {
  switch (cycle) {
    case 'HOURLY': return 3_600_000;
    case 'DAILY': return DAY;
    case 'WEEKLY': return 7 * DAY;
    case 'MONTHLY': return 30 * DAY;
    case 'QUARTERLY': return 90 * DAY;
    case 'SEMIANNUAL': return 182 * DAY;
    case 'ANNUAL': return 365 * DAY;
    case 'BIENNIAL': return 730 * DAY;
    default: return 30 * DAY;
  }
}

export interface SubscribeOptions {
  currency?: string;
  seats?: number;
  trial?: boolean;
  organizationId?: string;
}

export class CommerceModule implements IModule {
  readonly id = 'commerce';
  readonly tags = ['core', 'commerce'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private plans!: ICollection<Plan>;
  private products!: ICollection<Product>;
  private subs!: ICollection<Subscription>;
  private usage!: ICollection<UsageEvent>;
  private credits!: ICollection<CreditBatch>;
  private licenses!: ICollection<License>;
  private invoices!: ICollection<Invoice>;
  private payments!: ICollection<PaymentRecord>;
  private orders!: ICollection<MarketplaceOrder>;
  private payouts!: ICollection<Payout>;
  private overrides!: ICollection<EntitlementOverride>;
  private provider: PaymentProvider | undefined;
  private trialStarts = 0;
  private trialConversions = 0;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.plans = await C<Plan>('commerce.plans');
    this.products = await C<Product>('commerce.products');
    this.subs = await C<Subscription>('commerce.subscriptions');
    this.usage = await C<UsageEvent>('commerce.usage');
    this.credits = await C<CreditBatch>('commerce.credits');
    this.licenses = await C<License>('commerce.licenses');
    this.invoices = await C<Invoice>('commerce.invoices');
    this.payments = await C<PaymentRecord>('commerce.payments');
    this.orders = await C<MarketplaceOrder>('commerce.orders');
    this.payouts = await C<Payout>('commerce.payouts');
    this.overrides = await C<EntitlementOverride>('commerce.overrides');

    // Seed default catalog once.
    if ((await this.plans.count()) === 0) for (const p of DEFAULT_PLANS) await this.plans.put(p);
    if ((await this.products.count()) === 0) for (const p of DEFAULT_PRODUCTS) await this.products.put(p);

    kernel.container.registerValue('commerce', this);
    kernel.logger.info(`commerce initialized (${await this.plans.count()} plans, payment provider: ${this.provider ? this.provider.id : 'none'})`);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- catalog -------------------------------------------------------------

  async createPlan(input: Omit<Plan, 'id' | 'createdAt'>): Promise<Plan> {
    const plan: Plan = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.plans.put(plan);
    return plan;
  }
  async getPlan(idOrSlug: string): Promise<Plan | undefined> {
    const all = await this.plans.all();
    return all.find((p) => p.id === idOrSlug || p.slug === idOrSlug);
  }
  async listPlans(family?: string): Promise<Plan[]> {
    const all = await this.plans.all();
    return family ? all.filter((p) => p.productFamily === family) : all;
  }
  async createProduct(input: Omit<Product, 'id' | 'createdAt'>): Promise<Product> {
    const product: Product = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.products.put(product);
    return product;
  }
  async listProducts(): Promise<Product[]> {
    return this.products.all();
  }

  // --- subscriptions -------------------------------------------------------

  async subscribe(customerId: string, planSlug: string, opts: SubscribeOptions = {}): Promise<Subscription> {
    const plan = await this.getPlan(planSlug);
    if (!plan) throw new Error(`commerce: plan "${planSlug}" not found`);
    const currency = opts.currency ?? 'USD';
    const price = plan.prices[currency] ?? plan.prices[Object.keys(plan.prices)[0]!] ?? money(0, currency);
    const now = Date.now();
    const dur = cycleMs(plan.billingCycle);
    // Trials are explicit only — the platform never auto-charges or auto-trials.
    const wantTrial = opts.trial === true;
    const status: SubscriptionStatus = wantTrial ? 'TRIAL' : plan.pricingModel === 'FREE' ? 'ACTIVE' : 'ACTIVE';
    const sub: Subscription = {
      id: randomUUID(),
      customerId,
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      planId: plan.id,
      status,
      billingCycle: plan.billingCycle,
      currency: price.currency,
      price,
      ...(opts.seats ? { seats: opts.seats } : {}),
      currentPeriodStart: now,
      currentPeriodEnd: now + dur,
      autoRenew: true,
      ...(wantTrial && plan.trial ? { trialEnd: now + plan.trial.days * DAY } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.subs.put(sub);
    if (wantTrial) this.trialStarts++;
    await this.audit(customerId, 'subscription_created', { plan: plan.slug, status });
    await this.api.bus.emit(CommerceEvents.SubscriptionCreated, { subscriptionId: sub.id, plan: plan.slug });
    return sub;
  }

  async getSubscription(id: string): Promise<Subscription | undefined> {
    return this.subs.get(id);
  }
  async listSubscriptions(customerId?: string): Promise<Subscription[]> {
    const all = await this.subs.all();
    return customerId ? all.filter((s) => s.customerId === customerId) : all;
  }
  /** Most recent non-cancelled subscription for a customer (their active plan). */
  async activeSubscription(customerId: string): Promise<Subscription | undefined> {
    const mine = (await this.subs.all()).filter((s) => s.customerId === customerId);
    const eligible = mine.filter((s) => s.status !== 'CANCELLED' && s.status !== 'EXPIRED');
    return eligible.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  private planFor(sub: Subscription): Promise<Plan | undefined> {
    return this.plans.get(sub.planId);
  }

  async upgrade(id: string, newPlanSlug: string, opts: SubscribeOptions = {}): Promise<Subscription> {
    return this.changePlan(id, newPlanSlug, opts, 'upgrade');
  }
  async downgrade(id: string, newPlanSlug: string, opts: { scheduleAtPeriodEnd?: boolean } & SubscribeOptions = {}): Promise<Subscription> {
    if (opts.scheduleAtPeriodEnd) {
      const sub = await this.requireSub(id);
      const updated: Subscription = { ...sub, updatedAt: Date.now() };
      (updated as Subscription & { pendingPlanId?: string }).pendingPlanId = (await this.getPlan(newPlanSlug))?.id;
      await this.subs.put(updated);
      await this.audit(sub.customerId, 'downgrade_scheduled', { to: newPlanSlug });
      return updated;
    }
    return this.changePlan(id, newPlanSlug, opts, 'downgrade');
  }
  private async changePlan(id: string, newPlanSlug: string, opts: SubscribeOptions, kind: 'upgrade' | 'downgrade'): Promise<Subscription> {
    const sub = await this.requireSub(id);
    const plan = await this.getPlan(newPlanSlug);
    if (!plan) throw new Error(`commerce: plan "${newPlanSlug}" not found`);
    const currency = opts.currency ?? sub.currency;
    const price = plan.prices[currency] ?? plan.prices[Object.keys(plan.prices)[0]!] ?? money(0, currency);
    const wasTrial = sub.status === 'TRIAL';
    const updated: Subscription = {
      ...sub,
      planId: plan.id,
      billingCycle: plan.billingCycle,
      currency: price.currency,
      price,
      status: 'ACTIVE',
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + cycleMs(plan.billingCycle),
      ...(opts.seats ? { seats: opts.seats } : {}),
      trialEnd: undefined,
      updatedAt: Date.now(),
    };
    await this.subs.put(updated);
    if (wasTrial) this.trialConversions++;
    await this.audit(sub.customerId, kind, { from: sub.planId, to: plan.id });
    await this.api.bus.emit(kind === 'upgrade' ? CommerceEvents.SubscriptionUpgraded : CommerceEvents.SubscriptionCancelled, { subscriptionId: id });
    return updated;
  }

  async cancel(id: string, opts: { immediate?: boolean } = {}): Promise<Subscription> {
    const sub = await this.requireSub(id);
    const updated: Subscription = opts.immediate
      ? { ...sub, status: 'CANCELLED', autoRenew: false, updatedAt: Date.now() }
      : { ...sub, cancelAtPeriodEnd: true, autoRenew: false, updatedAt: Date.now() };
    await this.subs.put(updated);
    await this.audit(sub.customerId, 'subscription_cancelled', { immediate: !!opts.immediate });
    await this.api.bus.emit(CommerceEvents.SubscriptionCancelled, { subscriptionId: id });
    return updated;
  }
  async pause(id: string): Promise<Subscription> { return this.setStatus(id, 'PAUSED'); }
  async resume(id: string): Promise<Subscription> { return this.setStatus(id, 'ACTIVE'); }

  /** Suspend a subscription (non-payment, abuse, offboarding) — audited. */
  async suspend(id: string, reason?: string): Promise<Subscription> {
    const sub = await this.setStatus(id, 'SUSPENDED');
    await this.audit(sub.customerId, 'subscription_suspended', { id, ...(reason ? { reason } : {}) });
    return sub;
  }

  /** Reactivate a suspended subscription — audited. */
  async reactivate(id: string): Promise<Subscription> {
    const sub = await this.setStatus(id, 'REACTIVATED');
    await this.audit(sub.customerId, 'subscription_reactivated', { id });
    return sub;
  }

  /**
   * Composed billing state for a customer: subscription, invoices, and
   * in-period usage — the single source for billing UIs, dunning, and the
   * commercial lifecycle validation.
   */
  async customerBillingState(customerId: string): Promise<{
    customerId: string;
    subscription?: {
      id: string; planId: string; status: SubscriptionStatus; billingCycle: string;
      currency: string; price: Money; autoRenew: boolean; currentPeriodStart: number;
      currentPeriodEnd: number; trialEnd?: number; cancelAtPeriodEnd?: boolean;
    };
    invoices: { total: number; paid: number; outstanding: number; totalAmountMinor: number; outstandingAmountMinor: number };
    usage: Record<string, number>;
  }> {
    const sub = await this.activeSubscription(customerId);
    const invoices = await this.listInvoices(customerId);
    const paid = invoices.filter((i) => i.status === 'PAID');
    const outstanding = invoices.filter((i) => i.status !== 'PAID');
    const usage: Record<string, number> = {};
    for (const u of await this.usage.all()) {
      if (u.customerId !== customerId) continue;
      usage[u.metric] = (usage[u.metric] ?? 0) + u.qty;
    }
    return {
      customerId,
      ...(sub ? {
        subscription: {
          id: sub.id, planId: sub.planId, status: sub.status, billingCycle: sub.billingCycle,
          currency: sub.currency, price: sub.price, autoRenew: sub.autoRenew,
          currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd,
          ...(sub.trialEnd ? { trialEnd: sub.trialEnd } : {}),
          ...(sub.cancelAtPeriodEnd ? { cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : {}),
        },
      } : {}),
      invoices: {
        total: invoices.length,
        paid: paid.length,
        outstanding: outstanding.length,
        totalAmountMinor: invoices.reduce((s, i) => s + i.total.amount, 0),
        outstandingAmountMinor: outstanding.reduce((s, i) => s + i.total.amount, 0),
      },
      usage,
    };
  }
  private async setStatus(id: string, status: SubscriptionStatus): Promise<Subscription> {
    const sub = await this.requireSub(id);
    const updated: Subscription = { ...sub, status, updatedAt: Date.now() };
    await this.subs.put(updated);
    return updated;
  }
  private async requireSub(id: string): Promise<Subscription> {
    const sub = await this.subs.get(id);
    if (!sub) throw new Error(`commerce: subscription "${id}" not found`);
    return sub;
  }

  // --- entitlements + usage ------------------------------------------------

  /** Evaluate whether a customer may use a metered feature. */
  async check(customerId: string, feature: string, requestedQty = 1) {
    const sub = await this.activeSubscription(customerId);
    const plan = sub ? await this.planFor(sub) : undefined;
    const baseEntitlements: Entitlements | undefined = plan?.entitlements;
    const used = await this.usageInPeriod(customerId, feature, sub);
    let decision = evaluate(baseEntitlements, feature, used, requestedQty);
    // Active admin overrides can grant/raise a feature.
    const ov = await this.activeOverride(customerId, feature);
    if (ov && (!decision.allowed || decision.quota < ov.quota)) {
      const effectiveQuota = decision.quota > 0 && decision.quota !== UNLIMITED ? Math.max(decision.quota, ov.quota) : ov.quota;
      const remaining = effectiveQuota === UNLIMITED ? UNLIMITED : Math.max(0, effectiveQuota - used);
      decision = {
        allowed: remaining === UNLIMITED ? true : remaining >= requestedQty,
        feature, quota: effectiveQuota, used, remaining,
        reason: remaining >= requestedQty || remaining === UNLIMITED ? 'override granted' : 'override exhausted',
      };
    }
    return decision;
  }

  /** Record usage of a metered feature and return the post-increment decision. */
  async meterUsage(customerId: string, metric: string, qty = 1): Promise<{ event: UsageEvent; decision: Awaited<ReturnType<CommerceModule['check']>> }> {
    const period = new Date().toISOString().slice(0, 7);
    const event: UsageEvent = { id: randomUUID(), customerId, metric, qty, period, ts: Date.now() };
    await this.usage.put(event);
    const decision = await this.check(customerId, metric);
    if (decision.quota !== UNLIMITED && decision.quota > 0 && decision.remaining <= Math.max(1, Math.floor(decision.quota * 0.1))) {
      await this.api.bus.emit(CommerceEvents.UsageThresholdReached, { customerId, metric, remaining: decision.remaining });
    }
    return { event, decision };
  }

  async usageInPeriod(customerId: string, metric: string, sub?: Subscription): Promise<number> {
    const active = sub ?? (await this.activeSubscription(customerId));
    const start = active?.currentPeriodStart ?? 0;
    const end = active?.currentPeriodEnd ?? Number.POSITIVE_INFINITY;
    const events = (await this.usage.all()).filter((e) => e.customerId === customerId && e.metric === metric && e.ts >= start && e.ts <= end);
    return events.reduce((n, e) => n + e.qty, 0);
  }
  async getUsage(customerId: string, metric?: string, period?: string): Promise<Record<string, number>> {
    let events = (await this.usage.all()).filter((e) => e.customerId === customerId);
    if (metric) events = events.filter((e) => e.metric === metric);
    if (period) events = events.filter((e) => e.period === period);
    const out: Record<string, number> = {};
    for (const e of events) out[e.metric] = (out[e.metric] ?? 0) + e.qty;
    return out;
  }

  // --- credits -------------------------------------------------------------

  async grantCredits(customerId: string, amount: number, source: string, expiresAt?: number): Promise<CreditBatch> {
    if (amount <= 0) throw new Error('commerce: credit amount must be positive');
    const batch: CreditBatch = { id: randomUUID(), customerId, source, amount, remaining: amount, ...(expiresAt ? { expiresAt } : {}), createdAt: Date.now() };
    await this.credits.put(batch);
    await this.audit(customerId, 'credit_granted', { amount, source });
    return batch;
  }
  async creditBalance(customerId: string): Promise<number> {
    const now = Date.now();
    const batches = (await this.credits.all()).filter((b) => b.customerId === customerId && b.remaining > 0 && (!b.expiresAt || b.expiresAt > now));
    return batches.reduce((n, b) => n + b.remaining, 0);
  }
  /** Consume credits FIFO across non-expired batches. Throws if insufficient. */
  async consumeCredits(customerId: string, amount: number): Promise<{ consumed: number; remaining: number }> {
    if (amount <= 0) throw new Error('commerce: consume amount must be positive');
    const now = Date.now();
    const batches = (await this.credits.all())
      .filter((b) => b.customerId === customerId && b.remaining > 0 && (!b.expiresAt || b.expiresAt > now))
      .sort((a, b) => a.createdAt - b.createdAt);
    let need = amount;
    for (const b of batches) {
      if (need <= 0) break;
      const take = Math.min(b.remaining, need);
      b.remaining -= take;
      need -= take;
      await this.credits.put(b);
    }
    if (need > 0) throw new Error('commerce: insufficient credits');
    const remaining = await this.creditBalance(customerId);
    await this.audit(customerId, 'credit_consumed', { amount });
    if (remaining <= 10) await this.api.bus.emit(CommerceEvents.CreditLow, { customerId, remaining });
    return { consumed: amount, remaining };
  }

  // --- licensing -----------------------------------------------------------

  async issueLicense(input: Omit<License, 'id' | 'createdAt' | 'status' | 'validFrom'> & { validFrom?: number }): Promise<License> {
    const license: License = { ...input, id: randomUUID(), validFrom: input.validFrom ?? Date.now(), status: 'ACTIVE', createdAt: Date.now() };
    await this.licenses.put(license);
    await this.audit(input.customerId, 'license_created', { productId: input.productId });
    return license;
  }
  async verifyLicense(id: string): Promise<{ valid: boolean; reason: string; license?: License }> {
    const lic = await this.licenses.get(id);
    if (!lic) return { valid: false, reason: 'license not found' };
    if (lic.status !== 'ACTIVE') return { valid: false, reason: `license ${lic.status}`, license: lic };
    if (lic.validUntil && lic.validUntil < Date.now()) return { valid: false, reason: 'license expired', license: lic };
    return { valid: true, reason: 'license active', license: lic };
  }
  async revokeLicense(id: string): Promise<License> {
    const lic = await this.licenses.get(id);
    if (!lic) throw new Error(`commerce: license "${id}" not found`);
    const updated: License = { ...lic, status: 'REVOKED' };
    await this.licenses.put(updated);
    await this.audit(lic.customerId, 'license_revoked', { licenseId: id });
    return updated;
  }

  // --- payments (abstracted) ----------------------------------------------

  setPaymentProvider(provider: PaymentProvider): void {
    this.provider = provider;
  }
  async charge(customerId: string, amount: Money, reference: string, opts: { invoiceId?: string } = {}): Promise<PaymentRecord> {
    if (!this.provider) throw new Error('commerce: no payment provider configured (payments are abstracted)');
    const result = await this.provider.charge(amount, reference);
    const rec: PaymentRecord = {
      id: randomUUID(), customerId, reference, amount,
      status: result.ok ? 'SUCCEEDED' : 'FAILED', provider: this.provider.id,
      ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}), ts: Date.now(),
    };
    await this.payments.put(rec);
    await this.audit(customerId, result.ok ? 'payment_received' : 'payment_failed', { reference, amount });
    await this.api.bus.emit(CommerceEvents.PaymentRecorded, { ok: result.ok, reference });
    if (!result.ok) throw new Error(`commerce: payment failed — ${result.error ?? 'declined'}`);
    return rec;
  }
  async refund(reference: string, amount?: Money): Promise<PaymentRecord> {
    const recs = (await this.payments.all()).filter((p) => p.reference === reference && p.status === 'SUCCEEDED');
    const rec = recs[0];
    if (!rec) throw new Error(`commerce: no successful payment for reference "${reference}"`);
    if (this.provider) await this.provider.refund(reference, amount);
    const updated: PaymentRecord = { ...rec, status: 'REFUNDED' };
    await this.payments.put(updated);
    await this.audit(rec.customerId, 'refund_issued', { reference, amount: amount ?? rec.amount });
    await this.api.bus.emit(CommerceEvents.RefundIssued, { reference });
    return updated;
  }

  // --- invoices / tax / discounts -----------------------------------------

  async createInvoice(customerId: string, lines: InvoiceLine[], opts: { discountPct?: number; taxPct?: number; currency?: string; dueDate?: number; periodStart?: number; periodEnd?: number } = {}): Promise<Invoice> {
    const currency = opts.currency ?? lines[0]?.unitPrice.currency ?? 'USD';
    let subtotal = 0;
    const norm: InvoiceLine[] = lines.map((l) => {
      const lineTotal = multiply(l.unitPrice, l.quantity);
      subtotal += lineTotal.amount;
      return { ...l, unitPrice: { ...l.unitPrice, currency }, total: lineTotal };
    });
    const discountAmt = opts.discountPct ? pct(subtotal, opts.discountPct) : 0;
    const taxable = subtotal - discountAmt;
    const taxAmt = opts.taxPct ? pct(taxable, opts.taxPct) : 0;
    const total = taxable + taxAmt;
    const invoice: Invoice = {
      id: randomUUID(), customerId, lines: norm,
      subtotal: money(subtotal, currency), discount: money(discountAmt, currency), tax: money(taxAmt, currency), total: money(total, currency),
      status: 'ISSUED', issueDate: Date.now(),
      ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
      ...(opts.periodStart ? { periodStart: opts.periodStart } : {}),
      ...(opts.periodEnd ? { periodEnd: opts.periodEnd } : {}),
    };
    await this.invoices.put(invoice);
    await this.audit(customerId, 'invoice_created', { invoiceId: invoice.id, total });
    return invoice;
  }
  async getInvoice(id: string): Promise<Invoice | undefined> { return this.invoices.get(id); }
  async listInvoices(customerId?: string): Promise<Invoice[]> {
    const all = await this.invoices.all();
    return customerId ? all.filter((i) => i.customerId === customerId) : all;
  }
  async markInvoicePaid(id: string, paymentRef?: string): Promise<Invoice> {
    const inv = await this.invoices.get(id);
    if (!inv) throw new Error(`commerce: invoice "${id}" not found`);
    const updated: Invoice = { ...inv, status: 'PAID' };
    await this.invoices.put(updated);
    if (paymentRef) await this.audit(inv.customerId, 'invoice_paid', { invoiceId: id, paymentRef });
    return updated;
  }

  // --- marketplace / commissions / payouts --------------------------------

  async listItem(input: Omit<MarketplaceItem, 'id' | 'status'> & { status?: MarketplaceItem['status'] }): Promise<MarketplaceItem> {
    const item: MarketplaceItem = { ...input, id: randomUUID(), status: input.status ?? 'LISTED' };
    return item;
  }
  async purchase(buyerId: string, item: MarketplaceItem, opts: { currency?: string } = {}): Promise<{ order: MarketplaceOrder; payout: Payout }> {
    const currency = opts.currency ?? item.price.currency;
    const price: Money = { amount: item.price.amount, currency };
    const platformShare = money(pct(price.amount, item.platformCommissionPct), currency);
    const sellerShare = money(price.amount - platformShare.amount, currency);
    const order: MarketplaceOrder = { id: randomUUID(), itemId: item.id, buyerId, sellerId: item.sellerId, price, platformShare, sellerShare, status: 'COMPLETED', createdAt: Date.now() };
    await this.orders.put(order);
    const payout: Payout = { id: randomUUID(), payeeId: item.sellerId, amount: sellerShare, reason: `marketplace sale ${item.id}`, orderId: order.id, status: 'SCHEDULED', createdAt: Date.now() };
    await this.payouts.put(payout);
    await this.audit(buyerId, 'marketplace_purchase', { item: item.id, seller: item.sellerId });
    await this.api.bus.emit(CommerceEvents.MarketplacePurchase, { orderId: order.id, seller: item.sellerId });
    return { order, payout };
  }
  async listOrders(): Promise<MarketplaceOrder[]> { return this.orders.all(); }
  async payoutsFor(payeeId: string): Promise<Payout[]> { return (await this.payouts.all()).filter((p) => p.payeeId === payeeId); }

  // --- admin overrides -----------------------------------------------------

  async grantOverride(input: Omit<EntitlementOverride, 'id' | 'createdAt'>): Promise<EntitlementOverride> {
    const ov: EntitlementOverride = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.overrides.put(ov);
    await this.audit(input.customerId, 'entitlement_override', { feature: input.feature, admin: input.adminId });
    await this.api.bus.emit(CommerceEvents.EntitlementOverridden, { customerId: input.customerId, feature: input.feature });
    return ov;
  }
  private async activeOverride(customerId: string, feature: string): Promise<EntitlementOverride | undefined> {
    const now = Date.now();
    const all = (await this.overrides.all()).filter((o) => o.customerId === customerId && o.feature === feature && (!o.expiresAt || o.expiresAt > now));
    return all.sort((a, b) => b.quota - a.quota)[0];
  }

  // --- analytics -----------------------------------------------------------

  async mrr(): Promise<Record<string, number>> {
    const active = (await this.subs.all()).filter((s) => s.status === 'ACTIVE' || s.status === 'REACTIVATED');
    const out: Record<string, number> = {};
    for (const s of active) {
      const monthly = monthlyEquivalent(s.price, s.billingCycle);
      out[monthly.currency] = Math.round(((out[monthly.currency] ?? 0) + monthly.amount) * 100) / 100;
    }
    return out;
  }
  async analytics(): Promise<{
    totalSubscriptions: number; byStatus: Record<string, number>; byPlan: Record<string, number>;
    mrr: Record<string, number>; trialStarts: number; trialConversions: number;
    marketplaceOrders: number; invoices: number;
    // Phase 5 commercial KPIs.
    activePayingTenants: number; payingTenants: number; arr: Record<string, number>;
    revenuePerTenantMinor: number; churnCount: number; conversionRate: number;
  }> {
    const subs = await this.subs.all();
    const byStatus: Record<string, number> = {};
    const byPlan: Record<string, number> = {};
    for (const s of subs) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      byPlan[s.planId] = (byPlan[s.planId] ?? 0) + 1;
    }
    // REACTIVATED and GRACE_PERIOD count as active for KPIs (billing truth).
    const activeStatuses = ['ACTIVE', 'TRIAL', 'GRACE_PERIOD', 'REACTIVATED'];
    const active = subs.filter((s) => activeStatuses.includes(s.status));
    const paying = subs.filter((s) => (s.status === 'ACTIVE' || s.status === 'REACTIVATED') && !s.trialEnd);
    const churnCount = subs.filter((s) => s.status === 'CANCELLED' || s.status === 'EXPIRED').length;
    const conversionRate = this.trialStarts > 0 ? Math.round((this.trialConversions / this.trialStarts) * 1000) / 1000 : 0;
    const totalActiveAmount = active.reduce((s, sub) => s + sub.price.amount, 0);
    const arr: Record<string, number> = {};
    for (const sub of active) {
      const annual = sub.billingCycle === 'ANNUAL' ? sub.price.amount : sub.price.amount * 12;
      arr[sub.currency] = (arr[sub.currency] ?? 0) + annual;
    }
    return {
      totalSubscriptions: subs.length, byStatus, byPlan,
      mrr: await this.mrr(), trialStarts: this.trialStarts, trialConversions: this.trialConversions,
      marketplaceOrders: await this.orders.count(), invoices: await this.invoices.count(),
      activePayingTenants: active.length,
      payingTenants: paying.length,
      arr,
      revenuePerTenantMinor: active.length > 0 ? Math.round(totalActiveAmount / active.length) : 0,
      churnCount,
      conversionRate,
    };
  }

  // --- audit ---------------------------------------------------------------

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') {
        await sec.audit({ actor, action: `commerce.${action}`, result: 'success', detail });
      }
    } catch { /* security optional */ }
  }
}

// Re-export for callers.
export { add, money, multiply, pct, quotaFor };
