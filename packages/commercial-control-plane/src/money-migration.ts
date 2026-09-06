import {
  DEFAULT_MONETARY_SCALE,
  MoneyError,
  decimalParts,
  fromMinorUnitsAtScale,
  minorUnitsAtScale,
  minorUnitsOf,
  quantizeAmount,
  scaleOf,
} from './money.js';
import type { MonetaryValue } from './types.js';

/**
 * T-09 money-scale migration surface — EXPAND-ONLY AND NON-DESTRUCTIVE.
 *
 * What T-09 changes about persisted money:
 *  - Nothing. Persisted `MonetaryValue.amount` fields keep their shape (a JSON
 *    number) and their value. JATA Qi persists documents (jsonb bodies /
 *    JSONL), so there is no monetary column type to alter and therefore no
 *    destructive DDL to run.
 *  - New storage surfaces are additive: the per-currency wallet collections
 *    (`payments.wallets`, `payments.wallet-entries`) are created on first use
 *    by the storage driver, and wallet documents carry their own scale and
 *    exact minor-unit string alongside the canonical amount.
 *
 * What this module guarantees, and how it is checked:
 *  - {@link legacyMinorUnits} / {@link legacyQuantizeAmount} are the exact
 *    pre-T-09 fixed-2dp computations, retained ONLY as an equivalence oracle.
 *  - {@link isBitIdenticalUnderPerCurrencyScale} proves that for every
 *    2-decimal currency (the default scale) the T-09 currency-aware functions
 *    produce bit-identical results to the legacy fixed-scale functions, so no
 *    existing row, fixture, hash, or comparison changes meaning.
 *  - {@link auditMonetaryValues} INSPECTS rows. It never mutates them.
 *  - {@link planMonetaryScaleMigration} is structurally incapable of planning
 *    a rewrite: the returned plan's `rewrites` array is always empty and
 *    `destructive` is always false. Amounts that are not representable at
 *    their currency's scale (e.g. a legacy JPY row holding 100.5) are
 *    REPORTED for a separately governed decision, never silently rewritten.
 */

/** The migration mode T-09 is authorized to perform. */
export const T09_MONEY_MIGRATION_MODE = 'expand-only' as const;

/** The single fixed scale every currency used before T-09. */
export const LEGACY_FIXED_MONETARY_SCALE = DEFAULT_MONETARY_SCALE;

/** Pre-T-09 minor units: every currency at 2 decimals (equivalence oracle only). */
export function legacyMinorUnits(amount: number): bigint {
  return minorUnitsAtScale(amount, LEGACY_FIXED_MONETARY_SCALE);
}

/**
 * Pre-T-09 quantization: every currency at 2 decimals (equivalence oracle
 * only). This is a verbatim restatement of the T-07 `quantizeAmount`
 * fast-path-then-round algorithm so the equivalence proof compares against the
 * historical behaviour rather than against a reimplementation of the new one.
 */
export function legacyQuantizeAmount(amount: number): number {
  if (!Number.isFinite(amount)) throw new MoneyError('Monetary amount must be finite.');
  const legacyQuantized = amount >= 0 && decimalParts(amount).scale <= LEGACY_FIXED_MONETARY_SCALE;
  if (legacyQuantized) return amount;
  return fromMinorUnitsAtScale(legacyMinorUnits(amount), LEGACY_FIXED_MONETARY_SCALE);
}

/** One inspected monetary value: what it is, what T-09 derives from it, and whether that derivation is bit-identical to pre-T-09. */
export interface MonetaryScaleAuditRow {
  currency: string;
  amount: number;
  /** T-09 minor-unit scale of the currency. */
  scale: number;
  /** Exact minor units under the T-09 currency-aware rule (decimal string). */
  minorUnits: string;
  /** Exact minor units under the pre-T-09 fixed-2dp rule (decimal string). */
  legacyMinorUnits: string;
  /** True when T-09 quantization/minor units are bit-identical to the legacy fixed-scale result. */
  bitIdentical: boolean;
  /** True when the stored amount is not exactly representable at the currency's scale. */
  outOfScale: boolean;
  /** What quantization WOULD produce — reported, never applied. */
  quantizedAmount: number;
}

/** Read-only audit summary. `rewritesPerformed` is always 0. */
export interface MonetaryScaleAuditReport {
  mode: typeof T09_MONEY_MIGRATION_MODE;
  inspected: number;
  bitIdentical: number;
  /** Rows whose value differs between the legacy fixed-2dp rule and the currency-aware rule. */
  scaleChanged: MonetaryScaleAuditRow[];
  /** Rows that are not representable at their currency's minor-unit scale (reported, not rewritten). */
  outOfScale: MonetaryScaleAuditRow[];
  rewritesPerformed: number;
  destructive: false;
}

/** A migration plan. T-09 plans are always empty and non-destructive. */
export interface MonetaryScaleMigrationPlan {
  mode: typeof T09_MONEY_MIGRATION_MODE;
  /** Always empty: T-09 performs no rewrite of historical monetary data. */
  rewrites: readonly MonetaryValue[];
  /** Rows an operator may want to review in a separately governed milestone. */
  advisories: readonly MonetaryScaleAuditRow[];
  destructive: false;
}

/**
 * True when a persisted monetary value derives EXACTLY as it did before T-09:
 * same quantized amount (bit-identical, `Object.is`) and same exact minor
 * units. Every 2-decimal-currency value that is representable at 2dp satisfies
 * this, which is the backward-compatibility claim of the milestone.
 *
 * For a 0-decimal or 3-decimal currency the derived minor units necessarily
 * differ from the pre-T-09 fixed-2dp derivation (that is the point of T-09),
 * so this returns false and {@link auditMonetaryValues} lists the row under
 * `scaleChanged` — while the stored amount itself is never rewritten.
 */
export function isBitIdenticalUnderPerCurrencyScale(value: MonetaryValue): boolean {
  const scale = scaleOf(value.currency);
  const t09Minor = minorUnitsOf(value.amount, value.currency);
  const legacyMinor = legacyMinorUnits(value.amount);
  if (scale === LEGACY_FIXED_MONETARY_SCALE) {
    return t09Minor === legacyMinor && Object.is(quantizeAmount(value.amount, value.currency), legacyQuantizeAmount(value.amount));
  }
  // Non-default scales are new semantics by definition; they are bit-identical
  // only when the amount is already exactly representable at BOTH scales
  // (e.g. whole JPY amounts, which the legacy rule also treated as exact).
  return t09Minor === legacyMinor && Object.is(quantizeAmount(value.amount, value.currency), value.amount);
}

/** Inspect one monetary value. Pure: never mutates its input. */
export function auditMonetaryValue(value: MonetaryValue): MonetaryScaleAuditRow {
  if (!value || typeof value !== 'object') throw new MoneyError('Monetary value audit requires an object with amount and currency.');
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) throw new MoneyError(`Monetary value audit requires a finite amount (got ${String(value.amount)}).`);
  const scale = scaleOf(value.currency);
  const quantized = quantizeAmount(value.amount, value.currency);
  return {
    currency: value.currency,
    amount: value.amount,
    scale,
    minorUnits: minorUnitsOf(value.amount, value.currency).toString(),
    legacyMinorUnits: legacyMinorUnits(value.amount).toString(),
    bitIdentical: isBitIdenticalUnderPerCurrencyScale(value),
    outOfScale: !Object.is(quantized, value.amount),
    quantizedAmount: quantized,
  };
}

/**
 * Inspect many monetary values. Read-only: the input array and every value in
 * it are untouched (the report proves `rewritesPerformed === 0`).
 */
export function auditMonetaryValues(values: readonly MonetaryValue[]): MonetaryScaleAuditReport {
  const rows = values.map(auditMonetaryValue);
  return {
    mode: T09_MONEY_MIGRATION_MODE,
    inspected: rows.length,
    bitIdentical: rows.filter((row) => row.bitIdentical).length,
    scaleChanged: rows.filter((row) => row.minorUnits !== row.legacyMinorUnits),
    outOfScale: rows.filter((row) => row.outOfScale),
    rewritesPerformed: 0,
    destructive: false,
  };
}

/**
 * Plan the T-09 scale migration for a corpus of persisted values.
 *
 * The plan is ALWAYS expand-only: `rewrites` is empty and `destructive` is
 * false. Values that are not representable at their currency's scale are
 * surfaced as advisories for a separately governed decision; T-09 does not
 * rewrite historical monetary data.
 */
export function planMonetaryScaleMigration(values: readonly MonetaryValue[]): MonetaryScaleMigrationPlan {
  const audit = auditMonetaryValues(values);
  return {
    mode: T09_MONEY_MIGRATION_MODE,
    rewrites: Object.freeze([]) as readonly MonetaryValue[],
    advisories: Object.freeze([...audit.outOfScale, ...audit.scaleChanged.filter((row) => !row.outOfScale)]),
    destructive: false,
  };
}
