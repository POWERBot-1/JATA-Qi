import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvidence, CommercialProvenance, MonetaryValue } from '@jataqi/commercial-control-plane';
import { PaymentsModule } from '@jataqi/payments';
import type { PaymentIntent, PaymentsService } from '@jataqi/payments';
import { RevenueLedgerModule } from '@jataqi/revenue-ledger';
import type { RevenueLedgerEntry, RevenueLedgerService } from '@jataqi/revenue-ledger';
import {
  ReconciliationEvents,
  type PaymentReconciliationSource,
  type ProviderPaymentObservation,
  type ReconciliationDiscrepancy,
  type ReconciliationRun,
  type RunReconciliationInput,
} from './types.js';

const RUNS_COLLECTION = 'reconciliation.runs';

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Reconciles verified internal payment/revenue records first, then optionally
 * compares them with an injected read-only provider observation source. It
 * cannot repair or mutate an external provider.
 */
export class ReconciliationService {
  private runs!: ICollection<ReconciliationRun>;
  private payments!: PaymentsService;
  private ledger!: RevenueLedgerService;
  private controlPlane!: CommercialControlPlaneService;
  private readonly sources = new Map<string, PaymentReconciliationSource>();

  async init(kernel: KernelApi): Promise<void> {
    this.runs = await kernel.getModule<StorageModule>('storage').collection<ReconciliationRun>(RUNS_COLLECTION);
    this.payments = kernel.getModule<PaymentsModule>('payments').getService();
    this.ledger = kernel.getModule<RevenueLedgerModule>('revenue-ledger').getService();
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  registerSource(actor: CommercialActor, source: PaymentReconciliationSource): void {
    assertAdministrator(actor);
    if (!source.id.trim() || !source.providerId.trim()) throw new ReconciliationError('Reconciliation source id and provider id are required.');
    if (source.tenantId && source.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new ReconciliationError('Cross-tenant reconciliation source registration is not authorized.');
    if (this.sources.has(source.id)) throw new ReconciliationError(`Reconciliation source "${source.id}" is already registered.`);
    this.sources.set(source.id, source);
  }

  async reconcile(actor: CommercialActor, input: RunReconciliationInput = {}): Promise<ReconciliationRun> {
    assertManager(actor);
    const payments = (await this.payments.listPayments(actor)).filter((payment) => input.providerId === undefined || payment.providerId === input.providerId);
    const ledgerEntries = await this.ledger.listEntries(actor);
    const relevantEntries = ledgerEntries.filter((entry) => entry.entryType === 'REVENUE' || entry.entryType === 'REFUND_REVERSAL');
    const internal = internalDiscrepancies(payments, relevantEntries);
    const discrepancies = [...internal];
    let observations: ProviderPaymentObservation[] = [];
    let externalObserved = false;
    let evidence: CommercialEvidence[] = [systemEvidence('Internal payment/billing/revenue consistency scan completed.')];
    let source: PaymentReconciliationSource | undefined;

    if (input.sourceId) {
      source = this.sources.get(input.sourceId);
      if (!source || (source.tenantId && !canRead(actor, source.tenantId))) throw new ReconciliationError('Reconciliation source not found.');
      if (input.providerId && source.providerId !== input.providerId) throw new ReconciliationError('Reconciliation source does not match requested provider.');
      try {
        observations = await source.observe({ tenantId: actor.tenantId, since: input.since, until: input.until, signal: new AbortController().signal });
        externalObserved = true;
        for (const observation of observations) evidence.push(...copy(observation.evidence));
        discrepancies.push(...providerDiscrepancies(payments, observations));
      } catch (error) {
        const failed: ReconciliationRun = {
          id: randomUUID(), tenantId: actor.tenantId, providerId: input.providerId ?? source.providerId, sourceId: source.id,
          status: 'FAILED', internalReconciled: internal.length === 0, externalObserved: false,
          paymentCount: payments.length, revenueEntryCount: relevantEntries.length, providerObservationCount: 0,
          discrepancies, evidence: [...evidence, systemEvidence(`Provider observation failed: ${errorMessage(error)}`)], createdAt: Date.now(),
        };
        await this.runs.put(failed);
        await this.emit(actor, failed);
        return copy(failed);
      }
    }

    const internalReconciled = internal.length === 0;
    const status = !externalObserved
      ? internalReconciled ? 'PENDING_EXTERNAL' : 'UNRECONCILED'
      : discrepancies.length === 0 ? 'RECONCILED'
        : discrepancies.some((item) => ['MISSING_PROVIDER', 'PROVIDER_STATUS_MISMATCH', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH'].includes(item.kind)) ? 'DISPUTED'
          : 'UNRECONCILED';
    const run: ReconciliationRun = {
      id: randomUUID(), tenantId: actor.tenantId, providerId: input.providerId ?? source?.providerId, sourceId: source?.id,
      status, internalReconciled, externalObserved, paymentCount: payments.length, revenueEntryCount: relevantEntries.length,
      providerObservationCount: observations.length, discrepancies, evidence, createdAt: Date.now(),
    };
    await this.runs.put(run);
    await this.emit(actor, run);
    return copy(run);
  }

  async getRun(actor: CommercialActor, runId: string): Promise<ReconciliationRun | undefined> {
    const run = await this.runs.get(runId);
    return run && canRead(actor, run.tenantId) ? copy(run) : undefined;
  }

  async listRuns(actor: CommercialActor): Promise<ReconciliationRun[]> {
    return (await this.runs.all()).filter((run) => canRead(actor, run.tenantId)).map(copy);
  }

  private async emit(actor: CommercialActor, run: ReconciliationRun): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'reconciliation', collectedAt: now, correlationId: run.id };
    await this.controlPlane.publishEvent(actor, {
      eventType: ReconciliationEvents.Completed, source: 'reconciliation', entityId: run.id, correlationId: run.id,
      payload: { runId: run.id, status: run.status, discrepancies: run.discrepancies.length, externalObserved: run.externalObserved },
      provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `reconciliation:${run.id}`,
    });
  }
}

function internalDiscrepancies(payments: readonly PaymentIntent[], entries: readonly RevenueLedgerEntry[]): ReconciliationDiscrepancy[] {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  for (const payment of payments) {
    const relevantType = payment.status === 'VERIFIED' ? 'REVENUE' : payment.status === 'REFUNDED' ? 'REFUND_REVERSAL' : undefined;
    if (!relevantType) continue;
    const matches = entries.filter((entry) => entry.paymentId === payment.id && entry.entryType === relevantType);
    if (matches.length === 0) {
      discrepancies.push(discrepancy('MISSING_LEDGER', { paymentId: payment.id, providerReference: payment.providerReference, detail: `Verified payment status ${payment.status} has no matching ${relevantType} ledger entry.`, expected: payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount }));
    } else if (matches.length > 1) {
      discrepancies.push(discrepancy('DUPLICATE_LEDGER', { paymentId: payment.id, providerReference: payment.providerReference, detail: `Payment has ${matches.length} matching ${relevantType} ledger entries.`, ledgerEntryId: matches[0]!.id }));
    } else if (!moneyEquals(matches[0]!.amount, payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount)) {
      discrepancies.push(discrepancy('AMOUNT_MISMATCH', { paymentId: payment.id, ledgerEntryId: matches[0]!.id, providerReference: payment.providerReference, detail: 'Internal payment and revenue ledger amounts do not match.', expected: payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount, observed: matches[0]!.amount }));
    }
  }
  for (const entry of entries) {
    if (!entry.paymentId) continue;
    const payment = payments.find((candidate) => candidate.id === entry.paymentId);
    if (!payment) discrepancies.push(discrepancy('ORPHAN_LEDGER', { ledgerEntryId: entry.id, paymentId: entry.paymentId, providerReference: entry.providerReference, detail: 'Revenue ledger entry references no payment in scope.', observed: entry.amount }));
  }
  return discrepancies;
}

function providerDiscrepancies(payments: readonly PaymentIntent[], observations: readonly ProviderPaymentObservation[]): ReconciliationDiscrepancy[] {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  for (const payment of payments.filter((candidate) => candidate.status === 'VERIFIED' || candidate.status === 'REFUNDED')) {
    if (!payment.providerReference) {
      discrepancies.push(discrepancy('MISSING_PROVIDER', { paymentId: payment.id, detail: 'Verified internal payment has no provider reference.' }));
      continue;
    }
    const observation = observations.find((candidate) => candidate.providerReference === payment.providerReference);
    if (!observation) {
      discrepancies.push(discrepancy('MISSING_PROVIDER', { paymentId: payment.id, providerReference: payment.providerReference, detail: 'Provider observation is missing for verified internal payment.', expected: payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount }));
      continue;
    }
    const expectedStatus = payment.status === 'REFUNDED' ? 'REFUNDED' : 'SUCCEEDED';
    if (observation.status !== expectedStatus) discrepancies.push(discrepancy('PROVIDER_STATUS_MISMATCH', { paymentId: payment.id, providerReference: payment.providerReference, detail: `Provider status ${observation.status} does not match internal status ${expectedStatus}.` }));
    if (observation.amount.currency !== payment.amount.currency) discrepancies.push(discrepancy('CURRENCY_MISMATCH', { paymentId: payment.id, providerReference: payment.providerReference, detail: 'Provider currency does not match internal currency.', expected: payment.amount, observed: observation.amount }));
    else if (observation.amount.amount !== (payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount).amount) discrepancies.push(discrepancy('AMOUNT_MISMATCH', { paymentId: payment.id, providerReference: payment.providerReference, detail: 'Provider amount does not match internal amount.', expected: payment.status === 'REFUNDED' ? payment.refundAmount ?? payment.amount : payment.amount, observed: observation.amount }));
  }
  return discrepancies;
}

function discrepancy(kind: ReconciliationDiscrepancy['kind'], input: Omit<ReconciliationDiscrepancy, 'id' | 'kind'>): ReconciliationDiscrepancy { return { id: randomUUID(), kind, ...input }; }
function systemEvidence(summary: string): CommercialEvidence { const now = Date.now(); return { id: `reconciliation:${randomUUID()}`, status: 'OBSERVED', source: 'reconciliation', observedAt: now, confidence: 100, summary, provenance: { source: 'reconciliation', collectedAt: now }, privacyClassification: 'INTERNAL' }; }
function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean { return a.currency === b.currency && a.amount === b.amount; }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new ReconciliationError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new ReconciliationError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
