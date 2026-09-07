import {
  MoneyError,
  decimalParts,
  fromMinorUnitsAtScale,
  minorUnitsOf,
  normalizeCurrency,
  quantizeMonetaryValue,
  roundHalfUpToScale,
  scaleOf,
  MONEY_ROUNDING_RULE,
} from './money.js';
import type { MonetaryValue } from './types.js';

/**
 * T-09 injected foreign-exchange conversion.
 *
 * Design rules (recorded in the T-09 design doc):
 *  - FX is ALWAYS injected. JATA Qi bundles no rate source, no PSP, no HTTP
 *    client, and no environment-variable rate table: a host that wants
 *    conversion supplies a provider, and a host that supplies none cannot
 *    convert at all (fail-closed).
 *  - Conversion is deterministic: the result is a pure function of
 *    (amount, source currency, target currency, rate). No clock, no random,
 *    no network, no cache mutation — the same inputs always produce the same
 *    minor units, which makes conversions replayable and testable.
 *  - The multiplication is performed on exact decimal parts (amount and rate
 *    decomposed independently) and the true product is rounded ONCE, half-up,
 *    at the TARGET currency's minor-unit scale. Rounding at the source scale
 *    and then converting is forbidden because it compounds two roundings.
 *  - A missing, non-finite, zero, or negative rate is an error, never a
 *    silent 1:1 fall-through and never a silent zero.
 */

/** Read-only rate source. Returns `undefined` when the pair is unknown (fail-closed). */
export interface FxRateProvider {
  /** Stable identifier for audit trails (e.g. `static:test-table`). */
  readonly id: string;
  /**
   * Rate for one unit of `from` expressed in `to`, or `undefined` when this
   * provider has no rate for the pair. Currencies arrive normalized
   * (trimmed, upper-cased).
   */
  getRate(from: string, to: string): number | undefined;
}

/** Minimal injectable form: a bare rate lookup function. */
export type FxRateResolver = (from: string, to: string) => number | undefined;

/** Anything a caller may inject as an FX source. */
export type FxSource = FxRateProvider | FxRateResolver;

/** Audit-complete record of one deterministic conversion. */
export interface FxConversion {
  /** The value that was converted (currency-normalized, quantized at its own scale). */
  source: MonetaryValue;
  /** The converted value, quantized half-up at the TARGET currency's scale. */
  converted: MonetaryValue;
  /** The exact rate that was applied. */
  rate: number;
  sourceCurrency: string;
  targetCurrency: string;
  sourceScale: number;
  targetScale: number;
  /** Exact minor units (decimal strings — JSON-safe) before/after conversion. */
  sourceMinorUnits: string;
  targetMinorUnits: string;
  /** Always `half-up`; recorded so an auditor can see which rule produced the target minor units. */
  rounding: typeof MONEY_ROUNDING_RULE;
  /** Provider id when a provider object was injected (`function` for a bare resolver). */
  providerId: string;
  /** True when source and target currencies are identical (rate 1, no rounding applied). */
  identity: boolean;
}

/** A static, deterministic rate table. Rates are validated once at construction. */
export interface StaticFxRateTable {
  readonly [pair: string]: number;
}

/**
 * Deterministic table-backed FX provider. Keys are `FROM/TO` (case-insensitive,
 * whitespace tolerated) and values are positive finite rates. No inversion is
 * performed: the reciprocal of a terminating decimal is generally NOT a
 * terminating decimal, so deriving `TO/FROM` from `FROM/TO` would introduce an
 * undocumented second rounding. A missing pair fails closed.
 */
export function createStaticFxProvider(rates: StaticFxRateTable | ReadonlyMap<string, number>, id = 'static:fx-table'): FxRateProvider {
  const table = new Map<string, number>();
  const entries: Array<[string, number]> = rates instanceof Map ? [...rates.entries()] : Object.entries(rates);
  for (const [pair, rate] of entries) {
    const normalizedPair = normalizePair(pair);
    if (table.has(normalizedPair)) throw new MoneyError(`Duplicate FX rate for pair "${normalizedPair}".`);
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new MoneyError(`FX rate for "${normalizedPair}" must be a positive finite number (got ${String(rate)}).`);
    }
    table.set(normalizedPair, rate);
  }
  return {
    id,
    getRate(from: string, to: string): number | undefined {
      return table.get(pairKey(normalizeCurrency(from), normalizeCurrency(to)));
    },
  };
}

function pairKey(from: string, to: string): string {
  return `${from}/${to}`;
}

function normalizePair(pair: string): string {
  if (typeof pair !== 'string') throw new MoneyError('FX rate pair must be a string "FROM/TO".');
  const parts = pair.split('/');
  if (parts.length !== 2) throw new MoneyError(`FX rate pair must be formatted "FROM/TO" (got "${pair}").`);
  return pairKey(normalizeCurrency(parts[0]!), normalizeCurrency(parts[1]!));
}

function resolveRate(fx: FxSource, from: string, to: string): { rate: number | undefined; providerId: string } {
  if (typeof fx === 'function') return { rate: fx(from, to), providerId: 'function' };
  if (!fx || typeof fx.getRate !== 'function') throw new MoneyError('FX conversion requires an injected rate provider or resolver (fail-closed: no bundled rate source).');
  return { rate: fx.getRate(from, to), providerId: fx.id || 'provider' };
}

/**
 * Convert a monetary value into `targetCurrency` using the injected FX source.
 *
 * - Same currency: identity conversion — the value is quantized at its own
 *   scale and returned with rate 1 (no rounding is applied beyond the
 *   documented boundary quantization).
 * - Different currency: exact decimal multiplication of amount x rate, rounded
 *   ONCE half-up at the target currency's minor-unit scale.
 * - Any missing/invalid rate throws {@link MoneyError}; nothing is converted
 *   at an assumed rate and no external system is contacted.
 */
export function convertMoney(value: MonetaryValue, targetCurrency: string, fx: FxSource): FxConversion {
  if (!value || typeof value !== 'object') throw new MoneyError('FX conversion requires a monetary value.');
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) throw new MoneyError('FX conversion requires a finite amount.');
  const sourceCurrency = normalizeCurrency(value.currency);
  const target = normalizeCurrency(targetCurrency);
  const sourceScale = scaleOf(sourceCurrency);
  const targetScale = scaleOf(target);
  const sourceMinorUnits = minorUnitsOf(value.amount, sourceCurrency);

  if (sourceCurrency === target) {
    const quantized = quantizeMonetaryValue({ amount: value.amount, currency: sourceCurrency });
    return {
      source: quantized,
      converted: quantized,
      rate: 1,
      sourceCurrency,
      targetCurrency: target,
      sourceScale,
      targetScale,
      sourceMinorUnits: sourceMinorUnits.toString(),
      targetMinorUnits: minorUnitsOf(quantized.amount, target).toString(),
      rounding: MONEY_ROUNDING_RULE,
      providerId: 'identity',
      identity: true,
    };
  }

  const { rate, providerId } = resolveRate(fx, sourceCurrency, target);
  if (rate === undefined) {
    throw new MoneyError(`No injected FX rate for ${sourceCurrency}->${target}; conversion refused (fail-closed, no bundled rate source).`);
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new MoneyError(`FX rate for ${sourceCurrency}->${target} must be a positive finite number (got ${String(rate)}).`);
  }

  const amount = decimalParts(value.amount);
  const rateParts = decimalParts(rate);
  const amountMagnitude = amount.int < 0n ? -amount.int : amount.int;
  const rateMagnitude = rateParts.int < 0n ? -rateParts.int : rateParts.int;
  // ONE rounding, half-up, at the target scale (never at the source scale).
  const targetMinorMagnitude = roundHalfUpToScale(amountMagnitude * rateMagnitude, amount.scale + rateParts.scale, targetScale);
  const targetMinor = amount.negative ? -targetMinorMagnitude : targetMinorMagnitude;

  return {
    source: { amount: fromMinorUnitsAtScale(sourceMinorUnits, sourceScale), currency: sourceCurrency },
    converted: { amount: fromMinorUnitsAtScale(targetMinor, targetScale), currency: target },
    rate,
    sourceCurrency,
    targetCurrency: target,
    sourceScale,
    targetScale,
    sourceMinorUnits: sourceMinorUnits.toString(),
    targetMinorUnits: targetMinor.toString(),
    rounding: MONEY_ROUNDING_RULE,
    providerId,
    identity: false,
  };
}
