import type { MonetaryValue } from './types.js';

/**
 * T-07 quantized monetary arithmetic (approved milestone: "Commercial
 * state-transition and money-math integrity hardening", risk register R-02).
 *
 * Money policy (decision recorded in the T-07 design doc):
 *  - Monetary values carry a defined minor-unit scale: 2 decimal places by
 *    default for every currency (no per-currency table in this milestone).
 *  - The boundary treatment is quantization: an amount that is not exactly
 *    representable at the minor-unit scale is rounded to the scale with
 *    half-up rounding (ties away from zero). Amounts already at or under the
 *    scale pass through bit-identical, so no stored record changes value.
 *  - All equality/ordering/summation on amounts is performed on exact
 *    integer minor units derived from the decimal (shortest round-trip)
 *    representation of the number — never on raw IEEE-754 arithmetic.
 *  - Deterministic summation adds exact minor units and converts once at the
 *    end; the result of summing quantized amounts is itself quantized.
 *  - Product checks (invoice line unitPrice x quantity) multiply exact
 *    decimal parts and round the true product once to the minor-unit scale.
 *
 * Rationale: strict float equality and float accumulation can reject valid
 * invoices (0.1 + 0.2) or silently drift (19.99 x 3). Quantized math is
 * backward compatible with persisted records because every amount that is
 * already a <=2dp decimal compares and sums exactly as before.
 */

/** Default minor-unit scale: 2 decimal places for all currencies. */
export const DEFAULT_MONETARY_SCALE = 2;

/** Documented rounding rule: half-up on the exact decimal value (ties round away from zero). */
export const MONEY_ROUNDING_RULE = 'half-up';

export interface DecimalParts {
  /** Sign-adjusted integer formed by all significant digits. */
  int: bigint;
  /** Decimal exponent: value = int / 10^scale. */
  scale: number;
  /** True when the value is negative. */
  negative: boolean;
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
  if (!/^\d+$/.test(digits)) throw new Error(`Not a finite decimal: ${value}`);
  let int = BigInt(digits);
  if (negative) int = -int;
  if (scale < 0) int = int * 10n ** BigInt(-scale);
  return { int: int < 0n ? -int : int, scale: scale < 0 ? 0 : scale, negative: int < 0n };
}

/** True when the amount is already an exact minor-unit value at the default scale. */
export function isQuantizedAmount(amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;
  return decimalParts(amount).scale <= DEFAULT_MONETARY_SCALE;
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

/**
 * Exact minor units of an amount at the default scale (half-up rounding of
 * the exact decimal value when the amount carries more decimal places).
 * Negative amounts round ties toward zero (half-up on magnitude).
 */
export function minorUnitsOf(amount: number): bigint {
  if (!Number.isFinite(amount)) throw new Error('Monetary amount must be finite.');
  const parts = decimalParts(amount);
  if (parts.scale <= DEFAULT_MONETARY_SCALE) {
    return parts.int * powerOfTen(DEFAULT_MONETARY_SCALE - parts.scale);
  }
  const divisor = powerOfTen(parts.scale - DEFAULT_MONETARY_SCALE);
  // Half-up on the magnitude: (n + d/2) / d with integer division truncating.
  const rounded = (parts.int + divisor / 2n) / divisor;
  return rounded;
}

/** Quantized amount: unchanged when already at the scale, otherwise rounded half-up to the scale. */
export function quantizeAmount(amount: number): number {
  if (isQuantizedAmount(amount)) return amount;
  const minor = minorUnitsOf(amount);
  return Number(minor) / Math.pow(10, DEFAULT_MONETARY_SCALE);
}

/** Float amount whose exact value is minorUnits / 10^scale (storage/display boundary). */
export function fromMinorUnits(minor: bigint, scale: number = DEFAULT_MONETARY_SCALE): number {
  return Number(minor) / Math.pow(10, scale);
}

/** Quantized MonetaryValue: currency untouched, amount boundary-quantized. */
export function quantizeMonetaryValue(value: MonetaryValue): MonetaryValue {
  return { amount: quantizeAmount(value.amount), currency: value.currency };
}

/** Exact minor-unit addition of quantized amounts, converted once at the end. */
export function sumMonetaryAmounts(amounts: readonly number[]): number {
  let minor = 0n;
  for (const amount of amounts) minor += minorUnitsOf(amount);
  return Number(minor) / Math.pow(10, DEFAULT_MONETARY_SCALE);
}

/** Deterministic sum of monetary values that must share one currency. */
export function sumMoney(values: readonly MonetaryValue[]): MonetaryValue {
  if (values.length === 0) throw new Error('Cannot sum an empty set of monetary values.');
  const currency = values[0]!.currency;
  if (values.some((value) => value.currency !== currency)) throw new Error('Monetary values must use one currency.');
  return { amount: sumMonetaryAmounts(values.map((value) => value.amount)), currency };
}

/** Scale-exact equality: same currency and identical minor units. */
export function moneyEquals(a: MonetaryValue, b: MonetaryValue): boolean {
  return a.currency === b.currency && minorUnitsOf(a.amount) === minorUnitsOf(b.amount);
}

/** Scale-exact ceiling check: same currency and requested <= ceiling in minor units. */
export function moneyWithin(requested: MonetaryValue, ceiling: MonetaryValue): boolean {
  return requested.currency === ceiling.currency && minorUnitsOf(requested.amount) <= minorUnitsOf(ceiling.amount);
}

/** Scale-exact strict ordering: same currency and value < ceiling in minor units. */
export function moneyLessThan(value: MonetaryValue, ceiling: MonetaryValue): boolean {
  return value.currency === ceiling.currency && minorUnitsOf(value.amount) < minorUnitsOf(ceiling.amount);
}

/** Scale-exact floor check: same currency and value >= floor in minor units. */
export function moneyAtLeast(value: MonetaryValue, floor: MonetaryValue): boolean {
  return value.currency === floor.currency && minorUnitsOf(value.amount) >= minorUnitsOf(floor.amount);
}

/**
 * Exact product rule: does `total` equal `unitPrice x quantity` quantized to
 * the minor-unit scale? The multiplication is performed on exact decimal
 * parts (unitPrice and quantity decomposed independently) and the true
 * product is rounded once, so float artifacts (0.1 x 3, 19.99 x 3, 1.15 x 0.3)
 * can never cause a false mismatch.
 */
export function moneyProductEquals(unitPrice: MonetaryValue, quantity: number, total: MonetaryValue): boolean {
  if (unitPrice.currency !== total.currency) return false;
  if (!Number.isFinite(quantity) || quantity < 0) return false;
  const price = decimalParts(unitPrice.amount);
  const qty = decimalParts(quantity);
  const combinedScale = price.scale + qty.scale;
  const exactProduct = price.int * qty.int; // sign folded into qty.int? negative handled below
  const positive = price.negative === qty.negative;
  const magnitude = exactProduct < 0n ? -exactProduct : exactProduct;
  if (combinedScale <= DEFAULT_MONETARY_SCALE) {
    const minor = magnitude * powerOfTen(DEFAULT_MONETARY_SCALE - combinedScale);
    return minorUnitsOf(total.amount) === minor;
  }
  const divisor = powerOfTen(combinedScale - DEFAULT_MONETARY_SCALE);
  const rounded = (magnitude + divisor / 2n) / divisor;
  const totalMinor = minorUnitsOf(total.amount);
  return positive ? totalMinor === rounded : totalMinor === -rounded;
}
