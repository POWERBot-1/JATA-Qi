import type { MonetaryValue } from './types.js';

/**
 * T-07/T-09 quantized monetary arithmetic (approved milestones: "Commercial
 * state-transition and money-math integrity hardening" risk register R-02 and
 * "Per-currency money and wallet FX" risk register R-MONEY-03).
 *
 * Money policy (decisions recorded in the T-07 and T-09 design docs):
 *  - Every monetary value carries a currency, and every currency carries an
 *    explicit minor-unit scale (T-09): 0 decimals for JPY/KRW/CLP, 3 decimals
 *    for BHD/KWD/OMR, 2 decimals for every other currency (the T-07 default).
 *    The scale is never inferred from the amount itself.
 *  - The boundary treatment is quantization: an amount that is not exactly
 *    representable at its currency's minor-unit scale is rounded to that scale
 *    with half-up rounding (ties away from zero). Amounts already at or under
 *    the scale pass through bit-identical, so no stored record changes value.
 *  - All equality/ordering/summation on amounts is performed on exact
 *    integer minor units derived from the decimal (shortest round-trip)
 *    representation of the number — never on raw IEEE-754 arithmetic.
 *  - Deterministic summation adds exact minor units of ONE currency and
 *    converts once at the end; the result of summing quantized amounts is
 *    itself quantized at that currency's scale.
 *  - Product checks (invoice line unitPrice x quantity) multiply exact
 *    decimal parts and round the true product once to the currency scale.
 *  - Currency is a REQUIRED argument for every scale-dependent operation
 *    (T-09 AC-9). There is deliberately no default-currency overload: a
 *    call site that does not know the currency cannot silently quantize a
 *    0-decimal or 3-decimal amount at 2 decimals.
 *
 * Rationale: strict float equality and float accumulation can reject valid
 * invoices (0.1 + 0.2) or silently drift (19.99 x 3). Quantized math is
 * backward compatible with persisted records because every amount that is
 * already a <=2dp decimal in a 2-decimal currency compares and sums exactly
 * as before (proved by `money-migration.ts` and its test suite).
 */

/** Default minor-unit scale: 2 decimal places for every currency not listed in {@link MINOR_SCALE_BY_CURRENCY}. */
export const DEFAULT_MONETARY_SCALE = 2;

/** Documented rounding rule: half-up on the exact decimal value (ties round away from zero). */
export const MONEY_ROUNDING_RULE = 'half-up';

/**
 * T-09 per-currency minor-unit scale table.
 *
 * Only currencies whose ISO-4217 minor unit differs from the 2-decimal
 * default are listed; every other currency resolves to
 * {@link DEFAULT_MONETARY_SCALE}. Adding a currency here is an expand-only
 * change: it never rewrites persisted amounts (see `money-migration.ts`).
 */
export const MINOR_SCALE_BY_CURRENCY: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal currencies: the minor unit IS the major unit.
  JPY: 0,
  KRW: 0,
  CLP: 0,
  // Three-decimal currencies.
  BHD: 3,
  KWD: 3,
  OMR: 3,
});

/** Months per year — the divisor for annual→monthly recurring allocation (MRR). */
export const MONTHS_PER_YEAR = 12;

/** Raised for every fail-closed money rule violation (missing currency, non-finite amount, bad scale). */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DecimalParts {
  /** Sign-adjusted integer formed by all significant digits. */
  int: bigint;
  /** Decimal exponent: value = int / 10^scale. */
  scale: number;
  /** True when the value is negative. */
  negative: boolean;
}

/**
 * Canonical currency key: trimmed and upper-cased. Currency *scale lookup* is
 * case-insensitive; currency *equality* (see {@link moneyEquals}) remains an
 * exact string comparison so a case-only mismatch is never silently accepted
 * as the same money.
 */
export function normalizeCurrency(currency: string): string {
  if (typeof currency !== 'string') throw new MoneyError('Monetary currency must be a string.');
  const normalized = currency.trim().toUpperCase();
  if (normalized.length === 0) throw new MoneyError('Monetary currency is required for currency-aware money math (fail-closed).');
  return normalized;
}

/**
 * T-09 minor-unit scale of a currency: 0 for JPY/KRW/CLP, 3 for BHD/KWD/OMR,
 * 2 (the documented default) for every other currency. An empty/absent
 * currency fails closed rather than defaulting.
 */
export function scaleOf(currency: string): number {
  const normalized = normalizeCurrency(currency);
  const scale = Object.prototype.hasOwnProperty.call(MINOR_SCALE_BY_CURRENCY, normalized)
    ? MINOR_SCALE_BY_CURRENCY[normalized]
    : undefined;
  return scale === undefined ? DEFAULT_MONETARY_SCALE : scale;
}

/**
 * Exact decimal decomposition of a finite number using its shortest
 * round-trip representation (Number.prototype.toString). Scientific notation
 * is expanded, so 1e-7 decomposes exactly rather than via float math.
 * Assumes a finite input; callers validate finiteness before invoking.
 */
export function decimalParts(value: number): DecimalParts {
  const raw = value.toString();
  let negative = false;
  let body = raw;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }
  const exponentMatch = /^([0-9.]+)[eE](-?\d+)$/.exec(body);
  const mantissa = exponentMatch ? exponentMatch[1]! : body;
  const exponent = exponentMatch ? Number(exponentMatch[2]!) : 0;
  const point = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const fractionLength = point === -1 ? 0 : mantissa.length - point - 1;
  const scale = fractionLength - exponent;
  if (!/^\d+$/.test(digits)) throw new MoneyError(`Not a finite decimal: ${value}`);
  let int = BigInt(digits);
  if (negative) int = -int;
  if (scale < 0) int = int * 10n ** BigInt(-scale);
  return { int: int < 0n ? -int : int, scale: scale < 0 ? 0 : scale, negative: int < 0n };
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

/**
 * Half-up rounding of an exact non-negative decimal magnitude
 * (`magnitude / 10^fromScale`) onto `toScale` decimal places. Ties round away
 * from zero. This is the single rounding primitive used by quantization,
 * minor-unit derivation, products, and FX conversion, so every monetary
 * rounding in JATA Qi shares one documented rule.
 */
export function roundHalfUpToScale(magnitude: bigint, fromScale: number, toScale: number): bigint {
  if (!Number.isInteger(fromScale) || fromScale < 0) throw new MoneyError(`Invalid source scale: ${fromScale}`);
  if (!Number.isInteger(toScale) || toScale < 0) throw new MoneyError(`Invalid target scale: ${toScale}`);
  const absolute = magnitude < 0n ? -magnitude : magnitude;
  if (fromScale <= toScale) return absolute * powerOfTen(toScale - fromScale);
  const divisor = powerOfTen(fromScale - toScale);
  return (absolute + divisor / 2n) / divisor;
}

/**
 * Exact minor units of an amount at an explicit scale (half-up rounding of the
 * exact decimal value when the amount carries more decimal places).
 *
 * `decimalParts` returns a sign-free magnitude plus a `negative` flag, so the
 * sign is re-applied here: a negative amount yields NEGATIVE minor units and a
 * tie rounds away from zero on the magnitude, exactly as
 * {@link MONEY_ROUNDING_RULE} documents.
 *
 * T-09 fix (found by the per-currency suite): the T-07 implementation returned
 * the magnitude for negative amounts, which made `-1.00` and `1.00` compare
 * equal under `moneyEquals`. Every JATA Qi boundary rejects negative monetary
 * amounts, so no persisted record or existing assertion changes; the corrected
 * sign makes the canonical comparison sound for refunds/adjustments and for
 * signed wallet deltas.
 */
export function minorUnitsAtScale(amount: number, scale: number): bigint {
  if (!Number.isFinite(amount)) throw new MoneyError('Monetary amount must be finite.');
  const parts = decimalParts(amount);
  if (parts.scale <= scale) {
    const exact = parts.int * powerOfTen(scale - parts.scale);
    return parts.negative ? -exact : exact;
  }
  const divisor = powerOfTen(parts.scale - scale);
  // Half-up on the magnitude: (n + d/2) / d with integer division truncating.
  const rounded = (parts.int + divisor / 2n) / divisor;
  return parts.negative ? -rounded : rounded;
}

/**
 * T-09 exact minor units of an amount in a currency: the scale comes from the
 * currency (JPY/KRW/CLP → 0, BHD/KWD/OMR → 3, default 2), never from a
 * fixed assumption about the amount.
 */
export function minorUnitsOf(amount: number, currency: string): bigint {
  return minorUnitsAtScale(amount, scaleOf(currency));
}

/** Convenience: exact minor units of a MonetaryValue at its own currency's scale. */
export function minorUnitsOfValue(value: MonetaryValue): bigint {
  return minorUnitsOf(value.amount, value.currency);
}

/** True when the amount is already an exact minor-unit value at the currency's scale. */
export function isQuantizedAmount(amount: number, currency: string): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;
  return decimalParts(amount).scale <= scaleOf(currency);
}

/** Quantized amount at an explicit scale: unchanged when already at the scale, otherwise rounded half-up. */
export function quantizeAmountAtScale(amount: number, scale: number): number {
  if (!Number.isFinite(amount)) throw new MoneyError('Monetary amount must be finite.');
  if (decimalParts(amount).scale <= scale) return amount;
  return fromMinorUnitsAtScale(minorUnitsAtScale(amount, scale), scale);
}

/** T-09 quantized amount at the currency's minor-unit scale (bit-identical when already representable). */
export function quantizeAmount(amount: number, currency: string): number {
  return quantizeAmountAtScale(amount, scaleOf(currency));
}

/**
 * Float amount whose exact value is minorUnits / 10^scale (storage/display
 * boundary). Scale-based variant used where the scale — not a currency — is
 * the operative value (FX legs, migration equivalence proofs).
 */
export function fromMinorUnitsAtScale(minor: bigint, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0) throw new MoneyError(`Invalid monetary scale: ${scale}`);
  if (scale === 0) return Number(minor);
  return Number(minor) / Math.pow(10, scale);
}

/** T-09 float amount whose exact value is minorUnits / 10^scaleOf(currency). */
export function fromMinorUnits(minor: bigint, currency: string): number {
  return fromMinorUnitsAtScale(minor, scaleOf(currency));
}

/**
 * T-09 quantized MonetaryValue: the amount is boundary-quantized at the
 * scale of ITS OWN currency, so a JPY price quantizes to whole yen and a KWD
 * price keeps its fils. Currency metadata is preserved unchanged.
 */
export function quantizeMonetaryValue(value: MonetaryValue): MonetaryValue {
  return { amount: quantizeAmount(value.amount, value.currency), currency: value.currency };
}

/** Exact minor-unit addition of quantized amounts of ONE currency, converted once at the end. */
export function sumMonetaryAmounts(amounts: readonly number[], currency: string): number {
  const scale = scaleOf(currency);
  let minor = 0n;
  for (const amount of amounts) minor += minorUnitsAtScale(amount, scale);
  return fromMinorUnitsAtScale(minor, scale);
}

/** Deterministic sum of monetary values that must share one currency (exact string match). */
export function sumMoney(values: readonly MonetaryValue[]): MonetaryValue {
  if (values.length === 0) throw new MoneyError('Cannot sum an empty set of monetary values.');
  const currency = values[0]!.currency;
  if (values.some((value) => value.currency !== currency)) throw new MoneyError('Monetary values must use one currency.');
  return { amount: sumMonetaryAmounts(values.map((value) => value.amount), currency), currency };
}

/** T-09 scale-exact equality: same currency (exact match) and identical minor units at that currency's scale. */
export function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean {
  return a.currency === b.currency && minorUnitsOf(a.amount, a.currency) === minorUnitsOf(b.amount, b.currency);
}

/** T-09 scale-exact ceiling check: same currency and requested <= ceiling in minor units. */
export function moneyWithin(requested: MonetaryValue, ceiling: MonetaryValue): boolean {
  return requested.currency === ceiling.currency && minorUnitsOfValue(requested) <= minorUnitsOfValue(ceiling);
}

/** T-09 scale-exact strict ordering: same currency and value < ceiling in minor units. */
export function moneyLessThan(value: MonetaryValue, ceiling: MonetaryValue): boolean {
  return value.currency === ceiling.currency && minorUnitsOfValue(value) < minorUnitsOfValue(ceiling);
}

/** T-09 scale-exact floor check: same currency and value >= floor in minor units. */
export function moneyAtLeast(value: MonetaryValue, floor: MonetaryValue): boolean {
  return value.currency === floor.currency && minorUnitsOfValue(value) >= minorUnitsOfValue(floor);
}

/**
 * Exact product rule: does `total` equal `unitPrice x quantity` quantized to
 * the currency's minor-unit scale? The multiplication is performed on exact
 * decimal parts (unitPrice and quantity decomposed independently) and the true
 * product is rounded once, so float artifacts (0.1 x 3, 19.99 x 3, 1.15 x 0.3)
 * can never cause a false mismatch — in any currency scale.
 */
export function moneyProductEquals(unitPrice: MonetaryValue, quantity: number, total: MonetaryValue): boolean {
  if (unitPrice.currency !== total.currency) return false;
  if (!Number.isFinite(quantity) || quantity < 0) return false;
  if (!Number.isFinite(unitPrice.amount) || !Number.isFinite(total.amount)) return false;
  const scale = scaleOf(total.currency);
  const price = decimalParts(unitPrice.amount);
  const qty = decimalParts(quantity);
  const priceMagnitude = price.int < 0n ? -price.int : price.int;
  const qtyMagnitude = qty.int < 0n ? -qty.int : qty.int;
  const magnitude = roundHalfUpToScale(priceMagnitude * qtyMagnitude, price.scale + qty.scale, scale);
  const negative = price.negative !== qty.negative;
  const expected = negative ? -magnitude : magnitude;
  return minorUnitsAtScale(total.amount, scale) === expected;
}

/**
 * T-09 exact integer division of minor units with half-up rounding on the
 * magnitude (ties away from zero). Used for recurring allocation
 * (annual → monthly = divide by {@link MONTHS_PER_YEAR}) so a 0-decimal or
 * 3-decimal currency allocates with the same documented rule as a 2-decimal
 * one, and so no binary floating-point division is ever involved.
 */
export function divideMinorUnitsHalfUp(minor: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new MoneyError('Monetary allocation divisor must be non-zero.');
  const divisorMagnitude = divisor < 0n ? -divisor : divisor;
  const magnitude = minor < 0n ? -minor : minor;
  // Half-up on the magnitude: (n + d/2) / d with integer division truncating.
  const rounded = (magnitude + divisorMagnitude / 2n) / divisorMagnitude;
  const negative = (minor < 0n) !== (divisor < 0n);
  return negative ? -rounded : rounded;
}

/**
 * T-09 generalized annual→monthly recurring allocation: exact minor units of
 * the annual amount divided by 12 with half-up rounding at the currency's own
 * scale (JPY 100 → 8; KES 12.00 → 1.00; KWD 1.000 → 0.083).
 */
export function annualToMonthly(value: MonetaryValue): MonetaryValue {
  const minor = minorUnitsOfValue(value);
  return { amount: fromMinorUnits(divideMinorUnitsHalfUp(minor, BigInt(MONTHS_PER_YEAR)), value.currency), currency: value.currency };
}

/**
 * Fail-closed monetary value guard: finite, non-negative, and a non-empty
 * currency. Scale violations are NOT rejected here — the documented boundary
 * treatment is quantization ({@link quantizeMonetaryValue}).
 */
export function assertMonetaryValue(value: MonetaryValue, label = 'Monetary value'): void {
  if (!value || typeof value !== 'object') throw new MoneyError(`${label} must be an object with amount and currency.`);
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) throw new MoneyError(`${label} amount must be a finite number.`);
  if (value.amount < 0) throw new MoneyError(`${label} amount must be non-negative.`);
  normalizeCurrency(value.currency);
}
