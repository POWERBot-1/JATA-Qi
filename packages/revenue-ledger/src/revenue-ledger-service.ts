import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { BillingModule, BillingEvents } from '@jataqi/billing';
import type { BillingService, Invoice } from '@jataqi/billing';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvent, CommercialEvidence, CommercialProvenance, MonetaryValue } from '@jataqi/commercial-control-plane';
import { PaymentsModule } from '@jataqi/payments';
import type { PaymentIntent, PaymentsService } from '@jataqi/payments';
import {
  RevenueLedgerEvents,
  type RecordCostInput,
  type RevenueLedgerEntry,
  type RevenueSummary,
} from './types.js';

const LEDGER_COLLECTION = 'revenue-ledger.entries';
/** T-05 durable inbox handler id — stable across restarts/deploys (keys the inbox). */
export const REVENUE_LEDGER_DURABLE_HANDLER_ID = 'revenue-ledger.invoice-settlement';

export class RevenueLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevenueLedgerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Append-oriented revenue ledger. It recognizes revenue only when both billing
 * and payment state are independently verified; provider acceptance alone is
 * deliberately insufficient.
 */
export class RevenueLedgerService {
  private storage!: StorageModule;
  private entries!: ICollection<RevenueLedgerEntry>;
  private billing!: BillingService;
  private payments!: PaymentsService;
  private controlPlane!: CommercialControlPlaneService;
  private unregisterDurableHandler?: () => void;

  async init(kernel: KernelApi): Promise<void> {
    this.storage = kernel.getModule<StorageModule>('storage');
    this.entries = await this.storage.collection<RevenueLedgerEntry>(LEDGER_COLLECTION);
    this.billing = kernel.getModule<BillingModule>('billing').getService();
    this.payments = kernel.getModule<PaymentsModule>('payments').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    // T-05 durable cutover: paid/refunded invoices reach the ledger ONLY via
    // the canonical unified-outbox delivery worker behind a durable inbox
    // record; the effect itself is deduplicated on `sourceEventId`.
    this.unregisterDurableHandler = this.controlPlane.registerDurableHandler({
      id: REVENUE_LEDGER_DURABLE_HANDLER_ID,
      eventTypes: [BillingEvents.InvoicePaid, BillingEvents.InvoiceRefunded],
      maxAttempts: 5,
      handle: async (event) => {
        if (event.eventType === BillingEvents.InvoicePaid) await this.handlePaidInvoice(event);
        else if (event.eventType === BillingEvents.InvoiceRefunded) await this.handleRefundedInvoice(event);
      },
    });
  }

  stop(): void {
    this.unregisterDurableHandler?.();
    this.unregisterDurableHandler = undefined;
  }

  /** Record an evidenced cost; estimates remain explicitly estimated. */
  async recordCost(actor: CommercialActor, input: RecordCostInput): Promise<RevenueLedgerEntry> {
    assertManager(actor);
    if (!input.evidence.length || !input.category || !input.notes?.trim() && input.notes !== undefined) throw new RevenueLedgerError('Cost category, evidence, and any supplied notes must be valid.');
    assertMoney(input.amount);
    const entry = await this.append({
      tenantId: actor.tenantId,
      entryType: 'COST',
      recognitionStatus: input.measured === false ? 'ESTIMATED' : 'RECOGNIZED',
      productId: input.productId,
      ventureId: input.ventureId,
      amount: copy(input.amount),
      costCategory: input.category,
      evidence: copy(input.evidence),
      notes: input.notes,
    });
    await this.emit(actor, RevenueLedgerEvents.CostRecorded, entry, { entryId: entry.id, category: entry.costCategory, amount: entry.amount, recognitionStatus: entry.recognitionStatus });
    return copy(entry);
  }

  async getEntry(actor: CommercialActor, id: string): Promise<RevenueLedgerEntry | undefined> {
    const entry = await this.entries.get(id);
    return entry && canRead(actor, entry.tenantId) ? copy(entry) : undefined;
  }

  async listEntries(actor: CommercialActor): Promise<RevenueLedgerEntry[]> {
    return (await this.entries.query({ where: (entry) => canRead(actor, entry.tenantId), orderBy: 'sequence', order: 'asc' })).map(copy);
  }

  async summarize(actor: CommercialActor): Promise<RevenueSummary[]> {
    const entries = await this.listEntries(actor);
    const byCurrency = new Map<string, RevenueSummary>();
    for (const entry of entries) {
      const summary = byCurrency.get(entry.amount.currency) ?? {
        currency: entry.amount.currency, recognizedRevenue: 0, reversedRevenue: 0, measuredCosts: 0, estimatedCosts: 0, contribution: 0,
      };
      if (entry.entryType === 'REVENUE' && entry.recognitionStatus === 'RECOGNIZED') summary.recognizedRevenue += entry.amount.amount;
      if (entry.entryType === 'REFUND_REVERSAL' && entry.recognitionStatus === 'REVERSED') summary.reversedRevenue += entry.amount.amount;
      if (entry.entryType === 'COST') {
        if (entry.recognitionStatus === 'ESTIMATED') summary.estimatedCosts += entry.amount.amount;
        else summary.measuredCosts += entry.amount.amount;
      }
      summary.contribution = summary.recognizedRevenue - summary.reversedRevenue - summary.measuredCosts;
      byCurrency.set(summary.currency, summary);
    }
    return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  async verifyIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<{ valid: boolean; entries: number; brokenAt?: number; reason?: string }> {
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new RevenueLedgerError('Cross-tenant ledger verification is not authorized.');
    const entries = await this.entries.query({ where: (entry) => entry.tenantId === tenantId, orderBy: 'sequence', order: 'asc' });
    let previousHash = 'GENESIS';
    let sequence = 0;
    for (const entry of entries) {
      if (entry.sequence !== sequence + 1) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Ledger sequence is discontinuous.' };
      if (entry.previousHash !== previousHash) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Previous hash does not match.' };
      if (entry.hash !== hashEntry({ ...entry, hash: '' })) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Entry hash does not match its canonical payload.' };
      previousHash = entry.hash;
      sequence = entry.sequence;
    }
    return { valid: true, entries: entries.length };
  }

  /**
   * Durable handler effect (idempotent on `sourceEventId`): the ledger entry
   * and its `revenue.recorded` event commit as ONE composed write (T-05).
   * Tenant = the event's tenant; invoice and payment must both belong to it.
   */
  private async handlePaidInvoice(event: CommercialEvent): Promise<void> {
    const invoiceId = event.payload.invoiceId;
    const paymentId = event.payload.paymentId;
    if (typeof invoiceId !== 'string' || typeof paymentId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const [invoice, payment] = await Promise.all([this.billing.getInvoice(actor, invoiceId), this.payments.getPayment(actor, paymentId)]);
    if (!invoice || !payment || !isVerifiedPaymentForInvoice(invoice, payment, event.tenantId) || payment.tenantId !== event.tenantId) return;
    await this.storage.atomically(async (scope) => {
      const entries = await scope.collection<RevenueLedgerEntry>(LEDGER_COLLECTION);
      if ((await entries.query({ where: (entry) => entry.sourceEventId === event.id, limit: 1 }))[0]) return; // idempotent redelivery
      const entry = await this.append({
        tenantId: event.tenantId,
        entryType: 'REVENUE',
        recognitionStatus: 'RECOGNIZED',
        invoiceId: invoice.id,
        paymentId: payment.id,
        providerReference: payment.providerReference,
        productId: invoice.productId,
        customerReference: invoice.customerReference,
        amount: copy(invoice.total),
        sourceEventId: event.id,
        evidence: copy(payment.verificationEvidence),
        notes: `Recognized from verified payment ${payment.id}.`,
      }, entries);
      await this.emit(actor, RevenueLedgerEvents.RevenueRecorded, entry, { entryId: entry.id, invoiceId: entry.invoiceId, paymentId: entry.paymentId, amount: entry.amount }, scope);
    });
  }

  private async handleRefundedInvoice(event: CommercialEvent): Promise<void> {
    const invoiceId = event.payload.invoiceId;
    const paymentId = event.payload.paymentId;
    if (typeof invoiceId !== 'string' || typeof paymentId !== 'string') return;
    const actor = systemActor(event.tenantId);
    const [invoice, payment] = await Promise.all([this.billing.getInvoice(actor, invoiceId), this.payments.getPayment(actor, paymentId)]);
    if (!invoice || !payment || invoice.status !== 'REFUNDED' || payment.status !== 'REFUNDED' || invoice.tenantId !== event.tenantId || payment.tenantId !== event.tenantId) return;
    const amount = payment.refundAmount ?? payment.amount;
    await this.storage.atomically(async (scope) => {
      const entries = await scope.collection<RevenueLedgerEntry>(LEDGER_COLLECTION);
      if ((await entries.query({ where: (entry) => entry.sourceEventId === event.id, limit: 1 }))[0]) return; // idempotent redelivery
      const entry = await this.append({
        tenantId: event.tenantId,
        entryType: 'REFUND_REVERSAL',
        recognitionStatus: 'REVERSED',
        invoiceId: invoice.id,
        paymentId: payment.id,
        providerReference: payment.providerReference,
        productId: invoice.productId,
        customerReference: invoice.customerReference,
        amount: copy(amount),
        sourceEventId: event.id,
        evidence: copy(payment.verificationEvidence),
        notes: `Revenue reversal from verified refund ${payment.id}.`,
      }, entries);
      await this.emit(actor, RevenueLedgerEvents.RevenueReversed, entry, { entryId: entry.id, invoiceId: entry.invoiceId, paymentId: entry.paymentId, amount: entry.amount }, scope);
    });
  }

  private async append(input: Omit<RevenueLedgerEntry, 'id' | 'sequence' | 'previousHash' | 'hash' | 'createdAt'>, entries: ICollection<RevenueLedgerEntry> = this.entries): Promise<RevenueLedgerEntry> {
    const previous = (await entries.query({ where: (entry) => entry.tenantId === input.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<RevenueLedgerEntry, 'hash'> = {
      ...input,
      id: randomUUID(),
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS',
      createdAt: Date.now(),
    };
    const entry: RevenueLedgerEntry = { ...draft, hash: hashEntry({ ...draft, hash: '' }) };
    await entries.put(entry);
    return entry;
  }

  private async emit(actor: CommercialActor, eventType: string, entry: RevenueLedgerEntry, payload: Record<string, unknown>, scope?: StorageWriteScope): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'revenue-ledger', collectedAt: now, correlationId: entry.id, causationId: entry.sourceEventId };
    await this.controlPlane.publishEvent(
      actor,
      { eventType, source: 'revenue-ledger', entityId: entry.id, correlationId: entry.id, causationId: entry.sourceEventId, payload, provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `${eventType}:${entry.id}` },
      scope ? { scope } : {},
    );
  }
}

function isVerifiedPaymentForInvoice(invoice: Invoice | undefined, payment: PaymentIntent | undefined, tenantId: string): invoice is Invoice & { paymentId: string } {
  return Boolean(invoice && payment && invoice.tenantId === tenantId && invoice.status === 'PAID' && invoice.paymentId === payment.id && payment.status === 'VERIFIED' && moneyEquals(invoice.total, payment.amount));
}

function hashEntry(entry: RevenueLedgerEntry): string { return createHash('sha256').update(stable(entry)).digest('hex'); }
function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
function assertMoney(amount: MonetaryValue): void { if (!Number.isFinite(amount.amount) || amount.amount < 0 || !amount.currency.trim()) throw new RevenueLedgerError('Ledger amount must be non-negative with a currency.'); }
function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean { return a.amount === b.amount && a.currency === b.currency; }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new RevenueLedgerError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function systemActor(tenantId: string): CommercialActor { return { id: 'revenue-ledger-system', tenantId, roles: ['system'] }; }
function copy<T>(value: T): T { return structuredClone(value); }
