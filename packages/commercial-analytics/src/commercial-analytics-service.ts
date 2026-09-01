import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { BillingModule } from '@jataqi/billing';
import type { BillingPlan, BillingService, Subscription } from '@jataqi/billing';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvidence, CommercialProvenance, EvidenceStatus } from '@jataqi/commercial-control-plane';
import { PaymentsModule } from '@jataqi/payments';
import type { PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import type { CostCategory, RevenueLedgerEntry, RevenueLedgerService } from '@jataqi/revenue-ledger';
import {
  CommercialAnalyticsEvents,
  type AnalyticsPeriod,
  type ChannelEconomics,
  type CommercialAnalyticsSnapshot,
  type CommercialFunnelEvent,
  type CurrencyEconomics,
  type EconomicMetricName,
  type EconomicObservation,
  type RecordFunnelEventInput,
} from './types.js';

const EVENTS_COLLECTION = 'commercial-analytics.funnel-events';
const COST_CATEGORIES: readonly CostCategory[] = ['PAYMENT', 'AI', 'MARKETING', 'INFRASTRUCTURE', 'SUPPORT', 'THIRD_PARTY', 'OTHER'];

export class CommercialAnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialAnalyticsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Computes commercial metrics from named source records. Missing denominators
 * remain undefined rather than being coerced to zero or false certainty.
 */
export class CommercialAnalyticsService {
  private events!: ICollection<CommercialFunnelEvent>;
  private billing!: BillingService;
  private payments!: PaymentsService;
  private revenueLedger!: RevenueLedgerService;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    this.events = await kernel.getModule<StorageModule>('storage').collection<CommercialFunnelEvent>(EVENTS_COLLECTION);
    this.billing = kernel.getModule<BillingModule>('billing').getService();
    this.payments = kernel.getModule<PaymentsModule>('payments').getService();
    this.revenueLedger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async recordFunnelEvent(actor: CommercialActor, input: RecordFunnelEventInput): Promise<CommercialFunnelEvent> {
    assertManager(actor);
    if (!input.evidence.length) throw new CommercialAnalyticsError('Commercial funnel events require evidence.');
    if (!Number.isFinite(input.count ?? 1) || (input.count ?? 1) <= 0) throw new CommercialAnalyticsError('Funnel event count must be a positive finite number.');
    if (!input.provenance.source.trim() || !Number.isFinite(input.provenance.collectedAt)) throw new CommercialAnalyticsError('Funnel event provenance is required.');
    const event: CommercialFunnelEvent = {
      id: randomUUID(), tenantId: actor.tenantId, type: input.type, count: input.count ?? 1, customerReference: input.customerReference,
      productId: input.productId, campaignId: input.campaignId, channel: input.channel, market: input.market,
      timestamp: input.timestamp ?? Date.now(), evidence: copy(input.evidence), provenance: copy(input.provenance),
    };
    await this.events.put(event);
    await this.emit(actor, CommercialAnalyticsEvents.FunnelEventRecorded, event.id, { eventId: event.id, type: event.type, count: event.count, channel: event.channel });
    return copy(event);
  }

  async snapshot(actor: CommercialActor, requestedPeriod: AnalyticsPeriod = {}): Promise<CommercialAnalyticsSnapshot> {
    assertManager(actor);
    const now = Date.now();
    const period = { start: requestedPeriod.start ?? 0, end: requestedPeriod.end ?? now };
    if (!Number.isFinite(period.start) || !Number.isFinite(period.end) || period.start > period.end) throw new CommercialAnalyticsError('Analytics period is invalid.');
    const [funnel, subscriptions, plans, payments, entries] = await Promise.all([
      this.events.query({ where: (event) => event.tenantId === actor.tenantId && event.timestamp >= period.start && event.timestamp <= period.end }),
      this.billing.listSubscriptions(actor),
      this.billing.listPlans(actor),
      this.payments.listPayments(actor),
      this.revenueLedger.listEntries(actor),
    ]);

    const funnelCounts = countFunnel(funnel);
    const verifiedCustomers = new Set(payments.filter((payment) => payment.status === 'VERIFIED' || payment.status === 'REFUNDED').map((payment) => payment.customerReference));
    const paidCustomers = Math.max(funnelCounts.PAID_CUSTOMER ?? 0, verifiedCustomers.size);
    const activeSubscriptions = subscriptions.filter((subscription) => subscription.status === 'ACTIVE');
    const churnedSubscriptions = subscriptions.filter((subscription) => subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED').length;
    const retentionDenominator = activeSubscriptions.length + churnedSubscriptions;
    const churnRate = retentionDenominator > 0 ? round(churnedSubscriptions / retentionDenominator) : undefined;
    const retentionRate = retentionDenominator > 0 ? round(activeSubscriptions.length / retentionDenominator) : undefined;
    const currencyEconomics = calculateCurrencies(activeSubscriptions, plans, entries.filter((entry) => entry.createdAt >= period.start && entry.createdAt <= period.end), paidCustomers, churnRate);
    const channels = calculateChannels(funnel);
    const observations = buildObservations(actor.tenantId, period, funnelCounts, paidCustomers, churnRate, retentionRate, currencyEconomics);
    const snapshot: CommercialAnalyticsSnapshot = {
      tenantId: actor.tenantId, period, visitors: funnelCounts.VISITOR ?? 0, signups: funnelCounts.SIGNUP ?? 0, activations: funnelCounts.ACTIVATION ?? 0,
      trials: funnelCounts.TRIAL_STARTED ?? 0, paidCustomers, refunds: Math.max(funnelCounts.REFUND ?? 0, payments.filter((payment) => payment.status === 'REFUNDED').length),
      failedPayments: payments.filter((payment) => payment.status === 'FAILED').length, churnedSubscriptions, activeSubscriptions: activeSubscriptions.length,
      churnRate, retentionRate, currencies: currencyEconomics, channels, observations, calculatedAt: now,
    };
    await this.emit(actor, CommercialAnalyticsEvents.SnapshotCalculated, `snapshot:${now}`, { tenantId: actor.tenantId, period, currencies: currencyEconomics.length, paidCustomers });
    return snapshot;
  }

  async listFunnelEvents(actor: CommercialActor): Promise<CommercialFunnelEvent[]> {
    return (await this.events.query({ where: (event) => event.tenantId === actor.tenantId, orderBy: 'timestamp', order: 'asc' })).map(copy);
  }

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'commercial-analytics', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'commercial-analytics', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${entityId}` });
  }
}

function countFunnel(events: readonly CommercialFunnelEvent[]): Record<string, number> {
  const counts: Record<string, number> = { VISITOR: 0, SIGNUP: 0, ACTIVATION: 0, TRIAL_STARTED: 0, PAID_CUSTOMER: 0, CANCELLATION: 0, REFUND: 0, REFERRAL: 0, ADVOCACY: 0 };
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + event.count;
  return counts;
}

function calculateChannels(events: readonly CommercialFunnelEvent[]): ChannelEconomics[] {
  const channels = new Map<string, ChannelEconomics>();
  for (const event of events) {
    if (!event.channel) continue;
    const channel = channels.get(event.channel) ?? { channel: event.channel, visitors: 0, signups: 0, activations: 0, paidCustomers: 0, referrals: 0 };
    if (event.type === 'VISITOR') channel.visitors += event.count;
    if (event.type === 'SIGNUP') channel.signups += event.count;
    if (event.type === 'ACTIVATION') channel.activations += event.count;
    if (event.type === 'PAID_CUSTOMER') channel.paidCustomers += event.count;
    if (event.type === 'REFERRAL') channel.referrals += event.count;
    channels.set(channel.channel, channel);
  }
  return [...channels.values()].sort((a, b) => a.channel.localeCompare(b.channel));
}

function calculateCurrencies(activeSubscriptions: readonly Subscription[], plans: readonly BillingPlan[], entries: readonly RevenueLedgerEntry[], paidCustomers: number, churnRate: number | undefined): CurrencyEconomics[] {
  const currencySet = new Set<string>();
  for (const entry of entries) currencySet.add(entry.amount.currency);
  for (const subscription of activeSubscriptions) {
    const plan = plans.find((candidate) => candidate.id === subscription.planId);
    if (plan) currencySet.add(plan.price.currency);
  }
  return [...currencySet].sort().map((currency) => {
    const categoryCosts = emptyCostMap();
    const estimatedCosts = emptyCostMap();
    let recognizedRevenue = 0;
    let reversedRevenue = 0;
    for (const entry of entries.filter((candidate) => candidate.amount.currency === currency)) {
      if (entry.entryType === 'REVENUE' && entry.recognitionStatus === 'RECOGNIZED') recognizedRevenue += entry.amount.amount;
      else if (entry.entryType === 'REFUND_REVERSAL' && entry.recognitionStatus === 'REVERSED') reversedRevenue += entry.amount.amount;
      else if (entry.entryType === 'COST' && entry.costCategory) {
        if (entry.recognitionStatus === 'ESTIMATED') estimatedCosts[entry.costCategory] += entry.amount.amount;
        else categoryCosts[entry.costCategory] += entry.amount.amount;
      }
    }
    let mrr = 0;
    let arr = 0;
    for (const subscription of activeSubscriptions) {
      const plan = plans.find((candidate) => candidate.id === subscription.planId && candidate.price.currency === currency);
      if (!plan) continue;
      const monthly = plan.cycle === 'MONTHLY' ? plan.price.amount : plan.cycle === 'ANNUAL' ? plan.price.amount / 12 : 0;
      mrr += monthly;
      arr += plan.cycle === 'ANNUAL' ? plan.price.amount : plan.cycle === 'MONTHLY' ? plan.price.amount * 12 : 0;
    }
    const netRevenue = recognizedRevenue - reversedRevenue;
    const directCosts = categoryCosts.PAYMENT + categoryCosts.AI + categoryCosts.INFRASTRUCTURE + categoryCosts.THIRD_PARTY;
    const allCosts = Object.values(categoryCosts).reduce((total, cost) => total + cost, 0);
    const grossProfit = netRevenue - directCosts;
    const contributionMargin = netRevenue - allCosts;
    const arpu = paidCustomers > 0 ? round(netRevenue / paidCustomers) : undefined;
    const marketingCost = categoryCosts.MARKETING;
    const cac = paidCustomers > 0 && marketingCost > 0 ? round(marketingCost / paidCustomers) : undefined;
    const roas = marketingCost > 0 ? round(netRevenue / marketingCost) : undefined;
    const ltv = arpu !== undefined && churnRate !== undefined && churnRate > 0 ? round(arpu / churnRate) : undefined;
    return { currency, recognizedRevenue: round(recognizedRevenue), reversedRevenue: round(reversedRevenue), measuredCosts: categoryCosts, estimatedCosts, grossProfit: round(grossProfit), contributionMargin: round(contributionMargin), mrr: round(mrr), arr: round(arr), arpu, cac, roas, ltv };
  });
}

function buildObservations(tenantId: string, period: { start: number; end: number }, funnel: Record<string, number>, paidCustomers: number, churnRate: number | undefined, retentionRate: number | undefined, currencies: readonly CurrencyEconomics[]): EconomicObservation[] {
  const now = Date.now();
  const provenance = (metric: string): CommercialProvenance => ({ source: 'commercial-analytics', collectedAt: now, correlationId: `analytics:${metric}:${now}` });
  const result: EconomicObservation[] = [
    observation(tenantId, 'VISITORS', funnel.VISITOR ?? 0, undefined, 'count', statusForCount(funnel.VISITOR ?? 0), period, 'sum of evidenced VISITOR events', provenance('visitors')),
    observation(tenantId, 'SIGNUPS', funnel.SIGNUP ?? 0, undefined, 'count', statusForCount(funnel.SIGNUP ?? 0), period, 'sum of evidenced SIGNUP events', provenance('signups')),
    observation(tenantId, 'ACTIVATIONS', funnel.ACTIVATION ?? 0, undefined, 'count', statusForCount(funnel.ACTIVATION ?? 0), period, 'sum of evidenced ACTIVATION events', provenance('activations')),
    observation(tenantId, 'PAID_CUSTOMERS', paidCustomers, undefined, 'count', statusForCount(paidCustomers), period, 'max of evidenced paid-customer events and verified payment identities', provenance('paid-customers')),
    observation(tenantId, 'CHURN_RATE', churnRate, undefined, 'ratio', churnRate === undefined ? 'UNAVAILABLE' : 'MEASURED', period, 'churned subscriptions / (active + churned subscriptions)', provenance('churn')),
    observation(tenantId, 'RETENTION_RATE', retentionRate, undefined, 'ratio', retentionRate === undefined ? 'UNAVAILABLE' : 'MEASURED', period, 'active subscriptions / (active + churned subscriptions)', provenance('retention')),
  ];
  for (const currency of currencies) {
    result.push(
      observation(tenantId, 'RECOGNIZED_REVENUE', currency.recognizedRevenue, currency.currency, 'currency', 'VERIFIED', period, 'sum of verified revenue-ledger entries minus no reversals', provenance(`revenue:${currency.currency}`)),
      observation(tenantId, 'MRR', currency.mrr, currency.currency, 'currency/month', currency.mrr > 0 ? 'MEASURED' : 'PARTIAL', period, 'active billing subscriptions normalized to monthly value', provenance(`mrr:${currency.currency}`)),
      observation(tenantId, 'ARR', currency.arr, currency.currency, 'currency/year', currency.arr > 0 ? 'MEASURED' : 'PARTIAL', period, 'active billing subscriptions normalized to annual value', provenance(`arr:${currency.currency}`)),
      observation(tenantId, 'CONTRIBUTION_MARGIN', currency.contributionMargin, currency.currency, 'currency', 'MEASURED', period, 'recognized revenue minus reversals and measured costs', provenance(`margin:${currency.currency}`)),
      observation(tenantId, 'CAC', currency.cac, currency.currency, 'currency/customer', currency.cac === undefined ? 'UNAVAILABLE' : 'MEASURED', period, 'measured marketing cost / paid customers', provenance(`cac:${currency.currency}`)),
      observation(tenantId, 'ROAS', currency.roas, undefined, 'ratio', currency.roas === undefined ? 'UNAVAILABLE' : 'MEASURED', period, 'net recognized revenue / measured marketing cost', provenance(`roas:${currency.currency}`)),
    );
  }
  return result;
}

function observation(tenantId: string, metric: EconomicMetricName | string, value: number | undefined, currency: string | undefined, unit: string, evidenceStatus: EvidenceStatus, period: { start: number; end: number }, calculationMethod: string, provenance: CommercialProvenance): EconomicObservation {
  return { id: randomUUID(), tenantId, metric, value, currency, unit, evidenceStatus, source: 'commercial-analytics', confidence: value === undefined ? 0 : evidenceStatus === 'VERIFIED' ? 95 : evidenceStatus === 'MEASURED' ? 85 : 50, period, timestamp: Date.now(), calculationMethod, sourceReferences: [], provenance };
}

function statusForCount(value: number): EvidenceStatus { return value > 0 ? 'MEASURED' : 'PARTIAL'; }
function emptyCostMap(): Record<CostCategory, number> { return { PAYMENT: 0, AI: 0, MARKETING: 0, INFRASTRUCTURE: 0, SUPPORT: 0, THIRD_PARTY: 0, OTHER: 0 }; }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['observer', 'agent', 'operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialAnalyticsError('A commercial actor role is required.'); }
function copy<T>(value: T): T { return structuredClone(value); }
