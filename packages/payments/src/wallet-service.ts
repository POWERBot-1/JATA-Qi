import { createHash } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection, StorageWriteScope } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import {
  MoneyError,
  convertMoney,
  fromMinorUnits,
  minorUnitsOf,
  normalizeCurrency,
  quantizeAmount,
  scaleOf,
} from '@jataqi/commercial-control-plane';
import type {
  CommercialActor,
  CommercialControlPlaneService,
  CommercialProvenance,
  FxConversion,
  MonetaryValue,
} from '@jataqi/commercial-control-plane';
import {
  WalletEvents,
  type WalletAccount,
  type WalletBalance,
  type WalletConversionInput,
  type WalletConversionResult,
  type WalletDepositInput,
  type WalletEntryKind,
  type WalletFxRecord,
  type WalletLedgerEntry,
  type WalletMovementResult,
  type WalletStatus,
  type WalletWithdrawalInput,
} from './types.js';

/** T-09 per-currency wallet accounts: one row per (tenant, owner, currency). */
export const WALLETS_COLLECTION = 'payments.wallets';
/** T-09 append-only wallet movement records (idempotent by deterministic id). */
export const WALLET_ENTRIES_COLLECTION = 'payments.wallet-entries';

/**
 * Bounded create/update election attempts before failing closed (mirrors the
 * loop-host work-queue create election bound). A lost compare-and-set is
 * re-read and re-checked — funds are never moved on a stale read.
 */
const WALLET_CAS_ATTEMPTS = 8;

export class WalletError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'WalletError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface MovementRequest {
  ownerReference: string;
  currency: string;
  /** Signed exact minor units at the currency's own scale. */
  minorDelta: bigint;
  /** Absolute quantized movement amount (currency = `currency`). */
  amount: MonetaryValue;
  kind: WalletEntryKind;
  idempotencyKey: string;
  /** Entry/event leg discriminator: conversions write two legs under one key. */
  leg: 'debit' | 'credit';
  eventType: string;
  reason?: string;
  conversionId?: string;
  fx?: WalletFxRecord;
}

/**
 * T-09 per-currency wallet.
 *
 * Invariants (all fail-closed):
 *  - **One currency per account.** The account identity is
 *    (tenant, ownerReference, currency); balances are stored as exact minor
 *    units at THAT currency's scale (JPY/KRW/CLP 0dp, BHD/KWD/OMR 3dp,
 *    default 2dp). There is no aggregate "owner balance" that could mix
 *    currencies, and no code path adds minor units of two currencies.
 *  - **Currency-aware withdrawals.** A withdrawal debits only the account of
 *    the currency named by the amount; an owner holding KES can never satisfy
 *    a JPY withdrawal.
 *  - **Insufficient balance fails closed.** The debit is refused when the
 *    exact minor-unit balance is below the requested minor units; no partial
 *    debit, no negative balance, no implicit conversion.
 *  - **Currency mismatch fails closed.** An explicit `currency` that disagrees
 *    with the amount's currency is refused before any read or write.
 *  - **Idempotent.** One movement per (wallet, idempotencyKey, leg): a replay
 *    returns the recorded entry and never moves the balance twice.
 *  - **Concurrency-safe.** Every movement is a compare-and-set on the account
 *    row inside a tenant-bound composed write; a lost CAS is retried within a
 *    bounded election and otherwise refuses (never a blind overwrite).
 *  - **Tenant-isolated.** Ids are derived from the actor's tenant, every read
 *    re-checks the stored `tenantId`, and writes run under the tenant's
 *    storage scope (RLS on a transactional driver).
 *  - **FX is injected.** Conversions require a host-supplied rate source and
 *    round half-up ONCE at the target currency's scale. No PSP, no network,
 *    no bundled rate table.
 *
 * The wallet holds internal balances only. It is not a payment provider, it
 * cannot move money outside JATA Qi, and crediting it from verified provider
 * payments is a separately governed milestone (not T-09).
 */
export class WalletService {
  private api!: KernelApi;
  private storage!: StorageModule;
  private wallets!: ICollection<WalletAccount>;
  private walletEntries!: ICollection<WalletLedgerEntry>;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.storage = kernel.getModule<StorageModule>('storage');
    this.wallets = await this.storage.collection<WalletAccount>(WALLETS_COLLECTION);
    this.walletEntries = await this.storage.collection<WalletLedgerEntry>(WALLET_ENTRIES_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  /** Deterministic account id: the currency is part of the identity, so two currencies can never share a row. */
  walletIdFor(tenantId: string, ownerReference: string, currency: string): string {
    const normalized = walletCurrency(currency);
    const owner = assertOwnerReference(ownerReference);
    assertTenantId(tenantId);
    return `wallet:${hash(`tenant:${tenantId}\0owner:${owner}\0currency:${normalized}`)}`;
  }

  /**
   * Credit an (owner, currency) wallet. The amount is quantized at the
   * currency's minor-unit scale before it is credited, so a JPY deposit is
   * whole yen and a KWD deposit keeps its fils.
   */
  async deposit(actor: CommercialActor, input: WalletDepositInput): Promise<WalletMovementResult> {
    assertManager(actor);
    const movement = this.prepareMovement(actor, input, 'CREDIT');
    return this.runMovement(actor, { ...movement, leg: 'credit', eventType: WalletEvents.Credited });
  }

  /**
   * Debit an (owner, currency) wallet. Fails closed on: missing account,
   * insufficient exact minor-unit balance, currency mismatch, frozen account,
   * non-positive/non-finite amount, and lost concurrent CAS.
   */
  async withdraw(actor: CommercialActor, input: WalletWithdrawalInput): Promise<WalletMovementResult> {
    assertManager(actor);
    const movement = this.prepareMovement(actor, input, 'DEBIT');
    try {
      return await this.runMovement(actor, { ...movement, leg: 'debit', eventType: WalletEvents.Debited });
    } catch (error) {
      // Fail-closed refusals are auditable: the rejection event is published
      // best-effort and can never mask or replace the thrown refusal.
      await this.recordRejection(actor, movement, error);
      throw error;
    }
  }

  /**
   * Convert an owner's balance from one currency into another using the
   * INJECTED FX source. Both legs (debit source, credit target) commit as one
   * composed write; the converted amount is rounded half-up ONCE at the
   * TARGET currency's minor-unit scale.
   */
  async convert(actor: CommercialActor, input: WalletConversionInput): Promise<WalletConversionResult> {
    assertManager(actor);
    const ownerReference = assertOwnerReference(input.ownerReference);
    const sourceCurrency = walletCurrency(input.source?.currency);
    const targetCurrency = walletCurrency(input.targetCurrency);
    if (sourceCurrency === targetCurrency) {
      throw new WalletError(`Wallet conversion requires a different target currency (source and target are both ${sourceCurrency}).`);
    }
    const source = assertMovementAmount(input.source, sourceCurrency, input.currency, 'conversion source');
    if (!input.fx) throw new WalletError('Wallet conversion requires an injected FX source (no bundled rate provider, no PSP, no network).');

    let conversion: FxConversion;
    try {
      conversion = convertMoney(source, targetCurrency, input.fx);
    } catch (error) {
      throw new WalletError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const conversionId = walletConversionId(actor.tenantId, ownerReference, sourceCurrency, targetCurrency, idempotencyKey);
    const fxRecord: WalletFxRecord = {
      from: conversion.sourceCurrency,
      to: conversion.targetCurrency,
      rate: conversion.rate,
      sourceScale: conversion.sourceScale,
      targetScale: conversion.targetScale,
      sourceMinorUnits: conversion.sourceMinorUnits,
      targetMinorUnits: conversion.targetMinorUnits,
      rounding: conversion.rounding,
      providerId: conversion.providerId,
    };
    const debitMinor = -minorUnitsOf(source.amount, sourceCurrency);
    const creditMinor = minorUnitsOf(conversion.converted.amount, targetCurrency);
    if (creditMinor <= 0n) {
      throw new WalletError(
        `Conversion of ${source.amount} ${sourceCurrency} at rate ${conversion.rate} yields ${conversion.converted.amount} ${targetCurrency}, which is zero at ${conversion.targetScale} decimal place(s); conversion refused rather than destroying value silently.`,
      );
    }

    return this.storage.atomically(async (scope) => {
      // Replay: both legs already recorded -> return the recorded pair, move nothing.
      const replay = await this.readConversionReplay(scope, actor.tenantId, ownerReference, sourceCurrency, targetCurrency, idempotencyKey, conversionId);
      if (replay) return replay;

      const debit = await this.moveWithinScope(scope, actor, {
        ownerReference, currency: sourceCurrency, minorDelta: debitMinor, amount: source, kind: 'CONVERSION_DEBIT',
        idempotencyKey, leg: 'debit', eventType: WalletEvents.ConversionCompleted, reason: input.reason, conversionId, fx: fxRecord,
      });

      try {
        const credit = await this.moveWithinScope(scope, actor, {
          ownerReference, currency: targetCurrency, minorDelta: creditMinor, amount: conversion.converted, kind: 'CONVERSION_CREDIT',
          idempotencyKey, leg: 'credit', eventType: WalletEvents.ConversionCompleted, reason: input.reason, conversionId, fx: fxRecord,
        });
        return {
          conversionId,
          rate: conversion.rate,
          source: conversion.source,
          converted: conversion.converted,
          debit: debit.entry,
          credit: credit.entry,
          sourceWallet: debit.wallet,
          targetWallet: credit.wallet,
          fx: conversion,
        };
      } catch (error) {
        // Transactional drivers roll the whole scope back. Development drivers
        // (memory/filesystem) have no rollback, so compensate the debit
        // explicitly and then rethrow the ORIGINAL error unchanged.
        if (!scope.atomic) await this.compensateDebit(actor, debit, sourceCurrency, idempotencyKey);
        throw error;
      }
    }, { tenantId: actor.tenantId });
  }

  /** Balance view of one (owner, currency) account. `exists: false` is a genuine zero, not an error. */
  async getBalance(actor: CommercialActor, ownerReference: string, currency: string): Promise<WalletBalance | undefined> {
    assertActor(actor);
    const normalized = walletCurrency(currency);
    const owner = assertOwnerReference(ownerReference);
    const wallet = await this.wallets.get(this.walletIdFor(actor.tenantId, owner, normalized));
    if (wallet && wallet.tenantId !== actor.tenantId) return undefined; // T-06: never expose another tenant's balance
    return wallet ? balanceView(wallet) : zeroBalance(actor.tenantId, owner, normalized);
  }

  /** Every stored balance of one tenant (optionally one owner). One entry per currency; never summed across currencies. */
  async listBalances(actor: CommercialActor, ownerReference?: string): Promise<WalletBalance[]> {
    assertActor(actor);
    const owner = ownerReference === undefined ? undefined : assertOwnerReference(ownerReference);
    const wallets = await this.wallets.query({ where: (wallet) => wallet.tenantId === actor.tenantId && (owner === undefined || wallet.ownerReference === owner) });
    return wallets.map(balanceView).sort((a, b) => a.ownerReference.localeCompare(b.ownerReference) || a.currency.localeCompare(b.currency));
  }

  /** Stored movement records of one tenant (optionally filtered by owner/currency). */
  async listEntries(actor: CommercialActor, filter: { ownerReference?: string; currency?: string; limit?: number } = {}): Promise<WalletLedgerEntry[]> {
    assertActor(actor);
    const owner = filter.ownerReference === undefined ? undefined : assertOwnerReference(filter.ownerReference);
    const currency = filter.currency === undefined ? undefined : walletCurrency(filter.currency);
    const entries = await this.walletEntries.query({
      where: (entry) => entry.tenantId === actor.tenantId
        && (owner === undefined || entry.ownerReference === owner)
        && (currency === undefined || entry.currency === currency),
      orderBy: 'createdAt',
      order: 'asc',
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
    });
    return entries.map(copy);
  }

  /** Freeze/unfreeze one (owner, currency) account. A frozen account refuses every movement. */
  async setStatus(actor: CommercialActor, ownerReference: string, currency: string, status: WalletStatus, reason: string): Promise<WalletAccount> {
    assertAdministrator(actor);
    const normalized = walletCurrency(currency);
    const owner = assertOwnerReference(ownerReference);
    if (!reason.trim()) throw new WalletError('A wallet status change requires a reason.');
    if (status !== 'ACTIVE' && status !== 'FROZEN') throw new WalletError('Wallet status must be ACTIVE or FROZEN.');
    const walletId = this.walletIdFor(actor.tenantId, owner, normalized);
    return this.storage.atomically(async (scope) => {
      const wallets = await scope.collection<WalletAccount>(WALLETS_COLLECTION);
      const current = await wallets.get(walletId);
      if (!current) throw new WalletError(`Wallet for ${owner} in ${normalized} does not exist.`);
      if (current.tenantId !== actor.tenantId) throw new WalletError('Cross-tenant wallet access is not authorized.');
      if (current.status === status) return copy(current);
      const now = Date.now();
      const result = await wallets.cas(
        walletId,
        (candidate) => candidate !== undefined && candidate.tenantId === actor.tenantId && candidate.version === current.version,
        (candidate) => ({ ...candidate, status, updatedAt: now, version: candidate.version + 1 }),
      );
      if (!result.ok || !result.doc) throw new WalletError(`Wallet ${walletId} changed concurrently; status change aborted fail-closed.`);
      const updated = copy(result.doc);
      await this.emit(actor, WalletEvents.StatusChanged, updated.id, {
        walletId: updated.id, tenantId: updated.tenantId, ownerReference: updated.ownerReference, currency: updated.currency,
        status: updated.status, previousStatus: current.status, reason, balance: updated.balance, minorUnits: updated.minorUnits,
      }, scope, `wallet-status:${updated.id}:${status}:${updated.version}`);
      return updated;
    }, { tenantId: actor.tenantId });
  }

  /* --------------------------------------------------------------------- *
   * Internals
   * --------------------------------------------------------------------- */

  private prepareMovement(
    actor: CommercialActor,
    input: WalletDepositInput | WalletWithdrawalInput,
    kind: 'CREDIT' | 'DEBIT',
  ): MovementRequest {
    const ownerReference = assertOwnerReference(input.ownerReference);
    const currency = walletCurrency(input.amount?.currency);
    const amount = assertMovementAmount(input.amount, currency, input.currency, kind === 'CREDIT' ? 'deposit' : 'withdrawal');
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const minor = minorUnitsOf(amount.amount, currency);
    if (minor <= 0n) {
      throw new WalletError(`Wallet ${kind === 'CREDIT' ? 'deposit' : 'withdrawal'} amount must be greater than zero at the ${currency} minor-unit scale (${scaleOf(currency)} decimal place(s)).`);
    }
    return {
      ownerReference,
      currency,
      minorDelta: kind === 'CREDIT' ? minor : -minor,
      amount,
      kind,
      idempotencyKey,
      leg: kind === 'CREDIT' ? 'credit' : 'debit',
      eventType: kind === 'CREDIT' ? WalletEvents.Credited : WalletEvents.Debited,
      reason: input.reason,
    };
  }

  private async runMovement(actor: CommercialActor, movement: MovementRequest): Promise<WalletMovementResult> {
    return this.storage.atomically(async (scope) => {
      const applied = await this.moveWithinScope(scope, actor, movement);
      return { wallet: copy(applied.wallet), entry: copy(applied.entry), balance: balanceView(applied.wallet) };
    }, { tenantId: actor.tenantId });
  }

  /**
   * The single balance-mutation primitive: idempotent, CAS-guarded,
   * tenant-checked, and fail-closed on insufficient funds.
   */
  private async moveWithinScope(
    scope: StorageWriteScope,
    actor: CommercialActor,
    movement: MovementRequest,
  ): Promise<{ wallet: WalletAccount; entry: WalletLedgerEntry }> {
    const wallets = await scope.collection<WalletAccount>(WALLETS_COLLECTION);
    const entries = await scope.collection<WalletLedgerEntry>(WALLET_ENTRIES_COLLECTION);
    const walletId = this.walletIdFor(actor.tenantId, movement.ownerReference, movement.currency);
    const entryId = walletEntryId(walletId, movement.idempotencyKey, movement.leg);
    const scale = scaleOf(movement.currency);

    // Idempotency first: a replayed key returns the recorded movement and
    // never touches the balance a second time.
    const recorded = await entries.get(entryId);
    if (recorded) {
      const wallet = await wallets.get(walletId);
      if (!wallet || wallet.tenantId !== actor.tenantId) {
        throw new WalletError(`Wallet movement ${entryId} exists without a readable wallet for tenant ${actor.tenantId}; refusing to continue (fail-closed).`);
      }
      return { wallet, entry: { ...recorded, replayed: true } };
    }

    let wallet: WalletAccount | undefined;
    for (let attempt = 0; attempt < WALLET_CAS_ATTEMPTS; attempt += 1) {
      const current = await wallets.get(walletId);
      if (current && current.tenantId !== actor.tenantId) throw new WalletError('Cross-tenant wallet access is not authorized.');
      if (current && current.currency !== movement.currency) {
        throw new WalletError(`Wallet ${walletId} holds ${current.currency} and can never accept a ${movement.currency} movement (per-currency balances are isolated).`);
      }
      if (current && current.status !== 'ACTIVE') throw new WalletError(`Wallet for ${movement.ownerReference} in ${movement.currency} is ${current.status}; movements are refused (fail-closed).`);
      const currentMinor = current ? BigInt(current.minorUnits) : 0n;
      const nextMinor = currentMinor + movement.minorDelta;
      if (nextMinor < 0n) {
        throw new WalletError(
          `Insufficient ${movement.currency} balance for ${movement.ownerReference}: available ${fromMinorUnits(currentMinor, movement.currency)} ${movement.currency} (${currentMinor} minor units at ${scale}dp), requested ${fromMinorUnits(-movement.minorDelta, movement.currency)} ${movement.currency} (${-movement.minorDelta} minor units); withdrawal refused (fail-closed, no partial debit, no implicit conversion).`,
        );
      }
      const now = Date.now();
      if (current) {
        const result = await wallets.cas(
          walletId,
          (candidate) => candidate !== undefined
            && candidate.tenantId === actor.tenantId
            && candidate.currency === movement.currency
            && candidate.status === 'ACTIVE'
            && candidate.minorUnits === current.minorUnits
            && candidate.version === current.version,
          (candidate) => ({
            ...candidate,
            balance: { amount: fromMinorUnits(nextMinor, candidate.currency), currency: candidate.currency },
            minorUnits: nextMinor.toString(),
            updatedAt: now,
            version: candidate.version + 1,
          }),
        );
        if (result.ok && result.doc) {
          wallet = result.doc;
          break;
        }
        continue; // lost the CAS election: re-read the winner and re-check funds
      }
      const created: WalletAccount = {
        id: walletId,
        tenantId: actor.tenantId,
        ownerReference: movement.ownerReference,
        currency: movement.currency,
        scale,
        balance: { amount: fromMinorUnits(nextMinor, movement.currency), currency: movement.currency },
        minorUnits: nextMinor.toString(),
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      const result = await wallets.cas(walletId, (candidate) => candidate === undefined, () => created);
      if (result.ok && result.doc) {
        wallet = result.doc;
        break;
      }
      // Another writer created the account first; the next loop iteration
      // applies the guarded update to the winner's row.
    }
    if (!wallet) throw new WalletError(`Wallet ${walletId} could not be updated after ${WALLET_CAS_ATTEMPTS} compare-and-set attempts; movement aborted fail-closed.`);

    const entry: WalletLedgerEntry = {
      id: entryId,
      tenantId: actor.tenantId,
      walletId,
      ownerReference: movement.ownerReference,
      currency: movement.currency,
      scale,
      kind: movement.kind,
      amount: copy(movement.amount),
      minorUnits: movement.minorDelta.toString(),
      balanceAfter: copy(wallet.balance),
      balanceMinorAfter: wallet.minorUnits,
      idempotencyKey: movement.idempotencyKey,
      ...(movement.reason ? { reason: movement.reason } : {}),
      ...(movement.conversionId ? { conversionId: movement.conversionId } : {}),
      ...(movement.fx ? { fx: copy(movement.fx) } : {}),
      createdAt: wallet.updatedAt,
    };
    await entries.put(entry);
    // One event per leg, keyed by the deterministic entry id; a conversion's
    // two legs share `conversionId` so an auditor can pair them.
    await this.emit(actor, movement.eventType, walletId, {
      walletId, tenantId: actor.tenantId, ownerReference: movement.ownerReference, currency: movement.currency, scale,
      kind: movement.kind, amount: entry.amount, minorUnits: entry.minorUnits,
      balanceAfter: entry.balanceAfter, balanceMinorAfter: entry.balanceMinorAfter,
      ...(movement.conversionId ? { conversionId: movement.conversionId } : {}),
      ...(movement.fx ? { fx: movement.fx } : {}),
      ...(movement.reason ? { reason: movement.reason } : {}),
    }, scope, `wallet-movement:${entryId}`);
    return { wallet, entry };
  }

  private async readConversionReplay(
    scope: StorageWriteScope,
    tenantId: string,
    ownerReference: string,
    sourceCurrency: string,
    targetCurrency: string,
    idempotencyKey: string,
    conversionId: string,
  ): Promise<WalletConversionResult | undefined> {
    const wallets = await scope.collection<WalletAccount>(WALLETS_COLLECTION);
    const entries = await scope.collection<WalletLedgerEntry>(WALLET_ENTRIES_COLLECTION);
    const sourceWalletId = this.walletIdFor(tenantId, ownerReference, sourceCurrency);
    const targetWalletId = this.walletIdFor(tenantId, ownerReference, targetCurrency);
    const debitEntry = await entries.get(walletEntryId(sourceWalletId, idempotencyKey, 'debit'));
    const creditEntry = await entries.get(walletEntryId(targetWalletId, idempotencyKey, 'credit'));
    if (!debitEntry && !creditEntry) return undefined;
    if (!debitEntry || !creditEntry) {
      throw new WalletError(
        `Wallet conversion ${conversionId} is partially recorded (debit=${Boolean(debitEntry)}, credit=${Boolean(creditEntry)}); refusing to continue fail-closed. Requires explicit operator repair.`,
      );
    }
    const sourceWallet = await wallets.get(sourceWalletId);
    const targetWallet = await wallets.get(targetWalletId);
    if (!sourceWallet || !targetWallet || sourceWallet.tenantId !== tenantId || targetWallet.tenantId !== tenantId) {
      throw new WalletError(`Wallet conversion ${conversionId} replay cannot read both wallets for tenant ${tenantId}; refusing fail-closed.`);
    }
    const fx = debitEntry.fx;
    if (!fx) throw new WalletError(`Wallet conversion ${conversionId} replay is missing its FX audit record; refusing fail-closed.`);
    return {
      conversionId,
      rate: fx.rate,
      source: copy(debitEntry.amount),
      converted: copy(creditEntry.amount),
      debit: { ...copy(debitEntry), replayed: true },
      credit: { ...copy(creditEntry), replayed: true },
      sourceWallet: copy(sourceWallet),
      targetWallet: copy(targetWallet),
      fx: {
        source: copy(debitEntry.amount),
        converted: copy(creditEntry.amount),
        rate: fx.rate,
        sourceCurrency: fx.from,
        targetCurrency: fx.to,
        sourceScale: fx.sourceScale,
        targetScale: fx.targetScale,
        sourceMinorUnits: fx.sourceMinorUnits,
        targetMinorUnits: fx.targetMinorUnits,
        rounding: fx.rounding,
        providerId: fx.providerId,
        identity: false,
      },
    };
  }

  /** Development-driver compensation: restore the debited source balance after a failed credit leg. */
  private async compensateDebit(actor: CommercialActor, debit: { wallet: WalletAccount; entry: WalletLedgerEntry }, currency: string, idempotencyKey: string): Promise<void> {
    try {
      const wallets = await this.storage.collection<WalletAccount>(WALLETS_COLLECTION);
      const entries = await this.storage.collection<WalletLedgerEntry>(WALLET_ENTRIES_COLLECTION);
      const before = BigInt(debit.entry.balanceMinorAfter) - BigInt(debit.entry.minorUnits);
      await wallets.cas(
        debit.wallet.id,
        (candidate) => candidate !== undefined && candidate.tenantId === actor.tenantId && candidate.minorUnits === debit.wallet.minorUnits,
        (candidate) => ({
          ...candidate,
          balance: { amount: fromMinorUnits(before, candidate.currency), currency: candidate.currency },
          minorUnits: before.toString(),
          updatedAt: Date.now(),
          version: candidate.version + 1,
        }),
      );
      await entries.delete(debit.entry.id);
      this.api.logger.warn('wallet conversion credit leg failed; debit compensated on a non-transactional driver', {
        walletId: debit.wallet.id, tenantId: actor.tenantId, currency, idempotencyKey, restoredMinorUnits: before.toString(),
      });
    } catch (error) {
      this.api.logger.error('wallet conversion compensation failed; manual repair required', {
        walletId: debit.wallet.id, tenantId: actor.tenantId, currency, idempotencyKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Best-effort audit event for a refused withdrawal; never masks the refusal. */
  private async recordRejection(actor: CommercialActor, movement: MovementRequest, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await this.emit(actor, WalletEvents.WithdrawalRejected, this.walletIdFor(actor.tenantId, movement.ownerReference, movement.currency), {
        walletId: this.walletIdFor(actor.tenantId, movement.ownerReference, movement.currency),
        tenantId: actor.tenantId, ownerReference: movement.ownerReference, currency: movement.currency,
        requestedAmount: movement.amount, requestedMinorUnits: (-movement.minorDelta).toString(),
        scale: scaleOf(movement.currency), idempotencyKey: movement.idempotencyKey,
        reason, category: 'wallet_withdrawal_rejected',
      }, undefined, `wallet-withdrawal-rejected:${movement.idempotencyKey}:${hash(reason)}`);
    } catch (emitError) {
      this.api.logger.error('failed to record wallet withdrawal rejection event', emitError as Error);
    }
  }

  private async emit(
    actor: CommercialActor,
    eventType: string,
    entityId: string,
    payload: Record<string, unknown>,
    scope?: StorageWriteScope,
    key?: string,
  ): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'payments', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, {
      eventType, source: 'payments', entityId, correlationId: entityId, payload,
      provenance, privacyClassification: 'RESTRICTED', idempotencyKey: key ?? `${eventType}:${entityId}`,
    }, scope ? { scope } : {});
  }
}

/* ----------------------------------------------------------------------- *
 * Validation and helpers (all fail-closed)
 * ----------------------------------------------------------------------- */

/**
 * Wallet currencies are normalized ISO-4217 alpha-3 codes. Normalization
 * prevents `kes` and `KES` from becoming two separate balances for one owner;
 * the shape check keeps garbage labels out of money math.
 */
function walletCurrency(currency: string | undefined): string {
  let normalized: string;
  try {
    normalized = normalizeCurrency(currency ?? '');
  } catch (error) {
    throw new WalletError('Wallet currency is required.', { cause: error });
  }
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new WalletError(`Wallet currency must be a 3-letter ISO-4217 code (got "${currency ?? ''}").`);
  }
  return normalized;
}

function assertOwnerReference(ownerReference: string | undefined): string {
  const owner = typeof ownerReference === 'string' ? ownerReference.trim() : '';
  if (!owner) throw new WalletError('Wallet owner reference is required.');
  if (owner.length > 200) throw new WalletError('Wallet owner reference must be 200 characters or fewer.');
  return owner;
}

function assertTenantId(tenantId: string | undefined): string {
  if (!tenantId || !tenantId.trim()) throw new WalletError('Wallet operations require a tenant identity (fail-closed).');
  StorageModule.validateTenantId(tenantId);
  return tenantId;
}

function assertIdempotencyKey(key: string | undefined): string {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) throw new WalletError('Wallet movements require a replay-stable idempotency key.');
  if (value.length > 200) throw new WalletError('Wallet idempotency key must be 200 characters or fewer.');
  return value;
}

/**
 * Validate and quantize a movement amount at the currency's own scale.
 * An explicit `currency` that disagrees with the amount's currency is a
 * mismatch and fails closed BEFORE any read or write.
 */
function assertMovementAmount(amount: MonetaryValue | undefined, currency: string, explicitCurrency: string | undefined, label: string): MonetaryValue {
  if (!amount || typeof amount !== 'object') throw new WalletError(`Wallet ${label} requires a monetary amount.`);
  if (typeof amount.amount !== 'number' || !Number.isFinite(amount.amount)) throw new WalletError(`Wallet ${label} amount must be a finite number.`);
  if (amount.amount < 0) throw new WalletError(`Wallet ${label} amount must be non-negative.`);
  if (explicitCurrency !== undefined && normalizeCurrency(explicitCurrency) !== currency) {
    throw new WalletError(`Wallet ${label} currency mismatch: the account currency is ${currency} but ${normalizeCurrency(explicitCurrency)} was requested; refusing fail-closed (no implicit conversion).`);
  }
  let quantized: number;
  try {
    quantized = quantizeAmount(amount.amount, currency);
  } catch (error) {
    if (error instanceof MoneyError) throw new WalletError(`Wallet ${label} amount is not usable at the ${currency} minor-unit scale: ${error.message}`, { cause: error });
    throw error;
  }
  return { amount: quantized, currency };
}

function walletEntryId(walletId: string, idempotencyKey: string, leg: 'debit' | 'credit'): string {
  return `wallet-entry:${hash(`${walletId}\0key:${idempotencyKey}\0leg:${leg}`)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function balanceView(wallet: WalletAccount): WalletBalance {
  return {
    tenantId: wallet.tenantId,
    ownerReference: wallet.ownerReference,
    currency: wallet.currency,
    scale: wallet.scale,
    balance: copy(wallet.balance),
    minorUnits: wallet.minorUnits,
    exists: true,
    status: wallet.status,
    walletId: wallet.id,
    version: wallet.version,
    updatedAt: wallet.updatedAt,
  };
}

function zeroBalance(tenantId: string, ownerReference: string, currency: string): WalletBalance {
  const scale = scaleOf(currency);
  return {
    tenantId,
    ownerReference,
    currency,
    scale,
    balance: { amount: fromMinorUnits(0n, currency), currency },
    minorUnits: '0',
    exists: false,
  };
}

function assertActor(actor: CommercialActor): void {
  if (!actor || typeof actor !== 'object' || !actor.id || !actor.tenantId || !Array.isArray(actor.roles)) {
    throw new WalletError('A commercial actor identity is required for wallet operations.');
  }
  assertTenantId(actor.tenantId);
}

function assertManager(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) {
    throw new WalletError('Commercial operator role is required for wallet movements.');
  }
}

function assertAdministrator(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) {
    throw new WalletError('Commercial administrator role is required for wallet status changes.');
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Exported for tests/hosts that need a fresh conversion id without a wallet. */
export function walletConversionId(tenantId: string, ownerReference: string, from: string, to: string, idempotencyKey: string): string {
  return `wallet-conversion:${hash(`tenant:${tenantId}\0owner:${ownerReference}\0from:${from}\0to:${to}\0key:${idempotencyKey}`)}`;
}
