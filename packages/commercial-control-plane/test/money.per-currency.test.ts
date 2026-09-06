import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONETARY_SCALE,
  MINOR_SCALE_BY_CURRENCY,
  MONEY_ROUNDING_RULE,
  MONTHS_PER_YEAR,
  MoneyError,
  annualToMonthly,
  assertMonetaryValue,
  convertMoney,
  createStaticFxProvider,
  decimalParts,
  divideMinorUnitsHalfUp,
  fromMinorUnits,
  fromMinorUnitsAtScale,
  isQuantizedAmount,
  minorUnitsAtScale,
  minorUnitsOf,
  minorUnitsOfValue,
  moneyAtLeast,
  moneyEquals,
  moneyLessThan,
  moneyProductEquals,
  moneyWithin,
  normalizeCurrency,
  quantizeAmount,
  quantizeAmountAtScale,
  quantizeMonetaryValue,
  roundHalfUpToScale,
  scaleOf,
  sumMonetaryAmounts,
  sumMoney,
} from '../src/index.js';

/**
 * T-09 AC-1/AC-2/AC-3/AC-5/AC-8 — per-currency minor-unit precision.
 *
 * Every assertion here is behavioural: it computes a value through the public
 * money/FX surface and compares it with the value the documented rule requires
 * (half-up at the CURRENCY's scale). If the implementation regresses to a
 * fixed 2-decimal assumption, or rounds half-even/half-down, or converts FX at
 * the source scale, these tests fail.
 */
describe('T-09 AC-1 — JPY and other zero-decimal currencies', () => {
  it('resolves a 0-decimal minor-unit scale and derives whole-yen minor units', () => {
    assert.equal(scaleOf('JPY'), 0);
    assert.equal(scaleOf('KRW'), 0);
    assert.equal(scaleOf('CLP'), 0);
    // The scale comes from the currency, never from the amount's decimals.
    assert.equal(minorUnitsOf(1000, 'JPY'), 1000n, 'JPY minor units ARE yen (no x100)');
    assert.equal(minorUnitsOf(1, 'JPY'), 1n);
    assert.equal(fromMinorUnits(1500n, 'JPY'), 1500);
    assert.equal(minorUnitsOfValue({ amount: 33, currency: 'JPY' }), 33n);
  });

  it('rounds half-up at 0 decimals, including exact ties', () => {
    assert.equal(quantizeAmount(100.5, 'JPY'), 101, 'tie 100.5 JPY rounds half-up to 101');
    assert.equal(quantizeAmount(99.5, 'JPY'), 100, 'tie 99.5 JPY rounds half-up to 100');
    assert.equal(quantizeAmount(100.4, 'JPY'), 100, 'below the tie rounds down');
    assert.equal(quantizeAmount(100.6, 'JPY'), 101, 'above the tie rounds up');
    assert.equal(quantizeAmount(0.5, 'JPY'), 1, 'smallest tie rounds to 1 yen');
    assert.equal(quantizeAmount(0.4, 'JPY'), 0, 'sub-yen value rounds to zero (documented)');
    assert.equal(quantizeAmount(100, 'JPY'), 100, 'an exact yen amount is bit-identical');
    assert.ok(Object.is(quantizeAmount(1234, 'JPY'), 1234), 'whole yen passes through bit-identical');
    assert.deepEqual(quantizeMonetaryValue({ amount: 100.5, currency: 'JPY' }), { amount: 101, currency: 'JPY' });
    assert.equal(isQuantizedAmount(100, 'JPY'), true);
    assert.equal(isQuantizedAmount(100.5, 'JPY'), false);
  });

  it('compares and sums JPY in whole yen (never at a 2-decimal assumption)', () => {
    // 100.4 JPY is 100 yen at the currency scale; a fixed-2dp implementation
    // would have compared 10000 vs 10040 minor units and reported a mismatch.
    assert.ok(moneyEquals({ amount: 100, currency: 'JPY' }, { amount: 100.4, currency: 'JPY' }));
    assert.ok(!moneyEquals({ amount: 100, currency: 'JPY' }, { amount: 100.5, currency: 'JPY' }), '100.5 JPY is 101 yen');
    assert.ok(moneyWithin({ amount: 100.4, currency: 'JPY' }, { amount: 100, currency: 'JPY' }));
    assert.ok(moneyAtLeast({ amount: 100, currency: 'JPY' }, { amount: 100.4, currency: 'JPY' }));
    assert.ok(moneyLessThan({ amount: 100, currency: 'JPY' }, { amount: 100.5, currency: 'JPY' }));
    assert.equal(sumMonetaryAmounts([100, 0.4], 'JPY'), 100, 'sub-yen fragments do not accumulate into phantom yen');
    assert.equal(sumMonetaryAmounts([33, 33, 33], 'JPY'), 99);
    assert.deepEqual(sumMoney([{ amount: 1000, currency: 'JPY' }, { amount: 500, currency: 'JPY' }]), { amount: 1500, currency: 'JPY' });
  });

  it('applies the exact product rule at 0 decimals with a half-up tie', () => {
    // 0.5 x 3 = 1.5 -> half-up at 0dp -> 2 yen. A 2dp implementation would
    // have demanded 1.50 and rejected the only correct yen total.
    assert.ok(moneyProductEquals({ amount: 0.5, currency: 'JPY' }, 3, { amount: 2, currency: 'JPY' }));
    assert.ok(!moneyProductEquals({ amount: 0.5, currency: 'JPY' }, 3, { amount: 1, currency: 'JPY' }));
    assert.ok(moneyProductEquals({ amount: 33, currency: 'JPY' }, 3, { amount: 99, currency: 'JPY' }));
    assert.ok(!moneyProductEquals({ amount: 33, currency: 'JPY' }, 3, { amount: 98, currency: 'JPY' }));
    assert.ok(!moneyProductEquals({ amount: 33, currency: 'JPY' }, 3, { amount: 99, currency: 'KES' }), 'currency mismatch fails closed');
  });

  it('allocates an annual JPY amount over 12 months in whole yen, half-up', () => {
    assert.deepEqual(annualToMonthly({ amount: 100, currency: 'JPY' }), { amount: 8, currency: 'JPY' }, '100/12 = 8.33 -> 8 yen');
    assert.deepEqual(annualToMonthly({ amount: 6, currency: 'JPY' }), { amount: 1, currency: 'JPY' }, 'tie 6/12 = 0.5 -> 1 yen half-up');
    assert.deepEqual(annualToMonthly({ amount: 5, currency: 'JPY' }), { amount: 0, currency: 'JPY' }, '5/12 = 0.416 -> 0 yen');
    assert.equal(divideMinorUnitsHalfUp(100n, BigInt(MONTHS_PER_YEAR)), 8n);
    assert.equal(divideMinorUnitsHalfUp(6n, BigInt(MONTHS_PER_YEAR)), 1n);
    assert.equal(divideMinorUnitsHalfUp(-6n, BigInt(MONTHS_PER_YEAR)), -1n, 'half-up is on magnitude: ties away from zero');
    assert.throws(() => divideMinorUnitsHalfUp(1n, 0n), MoneyError);
  });
});

describe('T-09 AC-2 — KWD/BHD/OMR three-decimal currencies', () => {
  it('resolves a 3-decimal minor-unit scale and derives fils minor units', () => {
    assert.equal(scaleOf('KWD'), 3);
    assert.equal(scaleOf('BHD'), 3);
    assert.equal(scaleOf('OMR'), 3);
    assert.equal(minorUnitsOf(1, 'KWD'), 1000n);
    assert.equal(minorUnitsOf(19.999, 'KWD'), 19999n);
    assert.equal(fromMinorUnits(1235n, 'KWD'), 1.235);
    assert.equal(fromMinorUnits(1n, 'BHD'), 0.001);
  });

  it('rounds half-up at 3 decimals, including exact ties', () => {
    assert.equal(quantizeAmount(1.2345, 'KWD'), 1.235, 'tie at the 4th decimal rounds half-up');
    assert.equal(quantizeAmount(1.2344, 'KWD'), 1.234);
    assert.equal(quantizeAmount(1.2346, 'KWD'), 1.235);
    assert.equal(quantizeAmount(0.0005, 'OMR'), 0.001, 'smallest tie rounds to 1 fils');
    assert.equal(quantizeAmount(0.0004, 'OMR'), 0);
    assert.ok(Object.is(quantizeAmount(1.5, 'KWD'), 1.5), 'a 1-decimal KWD amount is already representable and stays bit-identical');
    assert.ok(isQuantizedAmount(19.999, 'KWD'));
    assert.equal(isQuantizedAmount(19.9999, 'KWD'), false);
  });

  it('keeps sub-cent precision that a 2-decimal assumption would destroy', () => {
    // A fixed-2dp implementation quantizes 1.2345 KWD to 1.23 and treats
    // 1.234 vs 1.235 as EQUAL (both 123 minor units). At 3dp they differ.
    assert.ok(!moneyEquals({ amount: 1.234, currency: 'KWD' }, { amount: 1.235, currency: 'KWD' }));
    assert.ok(moneyEquals({ amount: 1.2345, currency: 'KWD' }, { amount: 1.235, currency: 'KWD' }), '1.2345 KWD is 1235 fils');
    assert.ok(moneyLessThan({ amount: 1.234, currency: 'KWD' }, { amount: 1.235, currency: 'KWD' }));
    assert.equal(sumMonetaryAmounts([0.001, 0.002, 0.003], 'KWD'), 0.006);
    assert.equal(sumMonetaryAmounts([19.999, 0.001], 'KWD'), 20);
    assert.deepEqual(sumMoney([{ amount: 0.125, currency: 'BHD' }, { amount: 0.125, currency: 'BHD' }]), { amount: 0.25, currency: 'BHD' });
  });

  it('applies the exact product rule at 3 decimals', () => {
    assert.ok(moneyProductEquals({ amount: 19.999, currency: 'KWD' }, 3, { amount: 59.997, currency: 'KWD' }));
    assert.ok(!moneyProductEquals({ amount: 19.999, currency: 'KWD' }, 3, { amount: 59.996, currency: 'KWD' }));
    assert.ok(moneyProductEquals({ amount: 0.001, currency: 'OMR' }, 3, { amount: 0.003, currency: 'OMR' }));
    // 0.0005 x 3 = 0.0015 -> half-up at 3dp -> 0.002
    assert.ok(moneyProductEquals({ amount: 0.0005, currency: 'KWD' }, 3, { amount: 0.002, currency: 'KWD' }));
    assert.ok(!moneyProductEquals({ amount: 0.0005, currency: 'KWD' }, 3, { amount: 0.001, currency: 'KWD' }));
  });

  it('allocates an annual KWD amount over 12 months at 3 decimals, half-up', () => {
    assert.deepEqual(annualToMonthly({ amount: 1, currency: 'KWD' }), { amount: 0.083, currency: 'KWD' }, '1000 fils / 12 = 83.33 -> 83 fils');
    assert.deepEqual(annualToMonthly({ amount: 0.006, currency: 'KWD' }), { amount: 0.001, currency: 'KWD' }, 'tie 6 fils / 12 -> 1 fils half-up');
    assert.deepEqual(annualToMonthly({ amount: 12, currency: 'BHD' }), { amount: 1, currency: 'BHD' });
  });
});

describe('T-09 AC-3 — KES/default two-decimal behaviour is unchanged', () => {
  it('keeps the documented 2-decimal default for unlisted currencies', () => {
    assert.equal(scaleOf('KES'), DEFAULT_MONETARY_SCALE);
    assert.equal(scaleOf('USD'), DEFAULT_MONETARY_SCALE);
    assert.equal(scaleOf('EUR'), DEFAULT_MONETARY_SCALE);
    assert.equal(scaleOf('ZZZ'), DEFAULT_MONETARY_SCALE, 'unknown currencies keep the documented default');
    assert.equal(DEFAULT_MONETARY_SCALE, 2);
  });

  it('preserves every T-07 float-trap result at 2 decimals', () => {
    assert.equal(minorUnitsOf(0.1, 'KES'), 10n);
    assert.equal(minorUnitsOf(19.99, 'KES'), 1999n);
    assert.equal(minorUnitsOf(1.005, 'KES'), 101n);
    assert.equal(quantizeAmount(1.005, 'KES'), 1.01);
    assert.equal(quantizeAmount(2.675, 'KES'), 2.68);
    assert.equal(quantizeAmount(0.1 + 0.2, 'KES'), 0.3);
    assert.equal(quantizeAmount(0.1 * 3, 'KES'), 0.3);
    assert.equal(sumMonetaryAmounts([0.1, 0.2], 'KES'), 0.3);
    assert.ok(moneyEquals({ amount: 0.3, currency: 'KES' }, { amount: 0.30000000000000004, currency: 'KES' }));
    assert.ok(moneyProductEquals({ amount: 19.99, currency: 'KES' }, 3, { amount: 59.97, currency: 'KES' }));
    assert.ok(moneyProductEquals({ amount: 1.15, currency: 'KES' }, 0.3, { amount: 0.35, currency: 'KES' }));
    assert.deepEqual(annualToMonthly({ amount: 12, currency: 'KES' }), { amount: 1, currency: 'KES' }, 'T-08.1 annual MRR result preserved');
    assert.deepEqual(annualToMonthly({ amount: 0.06, currency: 'KES' }), { amount: 0.01, currency: 'KES' }, 'T-08.1 half-up tie preserved');
    assert.deepEqual(annualToMonthly({ amount: 100, currency: 'KES' }), { amount: 8.33, currency: 'KES' }, 'T-08.1 mixed annual/monthly result preserved');
  });

  it('does not normalize currency case into equality (exact currency match preserved)', () => {
    // Scale LOOKUP is case-insensitive; money IDENTITY is not.
    assert.equal(scaleOf('jpy'), 0);
    assert.equal(normalizeCurrency(' kes '), 'KES');
    assert.ok(!moneyEquals({ amount: 100, currency: 'JPY' }, { amount: 100, currency: 'jpy' }));
    assert.ok(!moneyEquals({ amount: 0.3, currency: 'KES' }, { amount: 0.3, currency: 'USD' }));
    assert.ok(!moneyWithin({ amount: 0.3, currency: 'KES' }, { amount: 0.3, currency: 'USD' }));
    assert.throws(() => sumMoney([{ amount: 1, currency: 'KES' }, { amount: 1, currency: 'JPY' }]), MoneyError);
    assert.throws(() => sumMoney([]), MoneyError);
  });

  it('fails closed on missing currency, non-finite amounts, and bad scales', () => {
    assert.throws(() => scaleOf(''), MoneyError);
    assert.throws(() => scaleOf('   '), MoneyError);
    assert.throws(() => minorUnitsOf(Number.NaN, 'KES'), MoneyError);
    assert.throws(() => minorUnitsOf(Number.POSITIVE_INFINITY, 'JPY'), MoneyError);
    assert.throws(() => quantizeAmount(Number.NaN, 'KWD'), MoneyError);
    assert.throws(() => fromMinorUnitsAtScale(1n, -1), MoneyError);
    assert.throws(() => roundHalfUpToScale(1n, 0, -1), MoneyError);
    assert.throws(() => assertMonetaryValue({ amount: -1, currency: 'KES' }), MoneyError);
    assert.throws(() => assertMonetaryValue({ amount: 1, currency: '' }), MoneyError);
    assert.doesNotThrow(() => assertMonetaryValue({ amount: 1, currency: 'KES' }));
  });

  it('exposes the scale primitives without changing their documented semantics', () => {
    assert.equal(MONEY_ROUNDING_RULE, 'half-up');
    assert.deepEqual(decimalParts(1.2345), { int: 12345n, scale: 4, negative: false });
    assert.equal(minorUnitsAtScale(1.2345, 2), 123n, 'scale-based helper rounds half-up: 123.45 -> 123');
    assert.equal(minorUnitsAtScale(1.235, 2), 124n, 'tie 123.5 -> 124');
    assert.equal(quantizeAmountAtScale(1.2345, 4), 1.2345, 'already at the scale: bit-identical');
    assert.equal(quantizeAmountAtScale(1.2345, 3), 1.235, 'one place beyond the scale rounds half-up');
    // Negative amounts keep their sign and round ties away from zero. The T-07
    // implementation returned the magnitude, which made -1.00 and 1.00 compare
    // EQUAL under moneyEquals; T-09 fixes that (no boundary accepts negative
    // amounts, so no persisted value changes).
    assert.equal(minorUnitsOf(-1.005, 'KES'), -101n);
    assert.equal(minorUnitsOf(-1, 'KES'), -100n);
    assert.equal(quantizeAmount(-1.005, 'KES'), -1.01);
    assert.equal(quantizeAmount(-100.5, 'JPY'), -101);
    assert.equal(minorUnitsOf(-1.2345, 'KWD'), -1235n);
    assert.ok(!moneyEquals({ amount: -1, currency: 'KES' }, { amount: 1, currency: 'KES' }), 'a negative amount is never equal to its positive magnitude');
    assert.ok(moneyLessThan({ amount: -1, currency: 'KES' }, { amount: 0, currency: 'KES' }));
    assert.ok(moneyEquals({ amount: -1.005, currency: 'KES' }, { amount: -1.01, currency: 'KES' }));
    assert.equal(roundHalfUpToScale(15n, 1, 0), 2n);
    assert.equal(roundHalfUpToScale(14n, 1, 0), 1n);
    assert.equal(roundHalfUpToScale(1500n, 2, 4), 150000n);
    assert.ok(Object.isFrozen(MINOR_SCALE_BY_CURRENCY), 'the scale table is immutable at runtime');
    assert.equal(MINOR_SCALE_BY_CURRENCY['JPY'], 0);
    assert.equal(MINOR_SCALE_BY_CURRENCY['KWD'], 3);
  });
});

describe('T-09 AC-5 — injected FX conversion (deterministic, target-scale, half-up)', () => {
  const fx = createStaticFxProvider({
    'USD/JPY': 155.25,
    'USD/KES': 1.005,
    'KWD/USD': 3.25,
    'JPY/KWD': 0.0021,
    'KES/JPY': 1.1,
  });

  it('converts with exact decimal multiplication and rounds ONCE at the target scale', () => {
    // 10 USD x 155.25 = 1552.5 JPY -> half-up at 0dp -> 1553 yen
    const conversion = convertMoney({ amount: 10, currency: 'USD' }, 'JPY', fx);
    assert.deepEqual(conversion.converted, { amount: 1553, currency: 'JPY' });
    assert.equal(conversion.rate, 155.25);
    assert.equal(conversion.sourceScale, 2);
    assert.equal(conversion.targetScale, 0);
    assert.equal(conversion.sourceMinorUnits, '1000');
    assert.equal(conversion.targetMinorUnits, '1553');
    assert.equal(conversion.rounding, 'half-up');
    assert.equal(conversion.identity, false);
    assert.equal(conversion.providerId, 'static:fx-table');

    // 1.5 KWD x 3.25 = 4.875 USD -> half-up at 2dp -> 4.88
    assert.deepEqual(convertMoney({ amount: 1.5, currency: 'KWD' }, 'USD', fx).converted, { amount: 4.88, currency: 'USD' });
    // 1000 JPY x 0.0021 = 2.1 KWD -> exact at 3dp -> 2.100
    assert.deepEqual(convertMoney({ amount: 1000, currency: 'JPY' }, 'KWD', fx).converted, { amount: 2.1, currency: 'KWD' });
    // 100 KES x 1.1 = 110 JPY -> exact at 0dp
    assert.deepEqual(convertMoney({ amount: 100, currency: 'KES' }, 'JPY', fx).converted, { amount: 110, currency: 'JPY' });
  });

  it('beats the naive float conversion on the classic 1.005 trap', () => {
    // Naive float: Math.round(1 * 1.005 * 100) / 100 === 1.00 (1.005*100 is 100.49999...).
    assert.equal(Math.round(1 * 1.005 * 100) / 100, 1, 'the naive float path loses the tie');
    // Exact decimal multiplication keeps the tie and rounds half-up to 1.01.
    const conversion = convertMoney({ amount: 1, currency: 'USD' }, 'KES', fx);
    assert.deepEqual(conversion.converted, { amount: 1.01, currency: 'KES' });
    assert.equal(conversion.targetMinorUnits, '101');
  });

  it('rounds ties half-up at the target scale, not the source scale', () => {
    const tieFx = createStaticFxProvider({ 'USD/JPY': 155.5 });
    // 1 USD x 155.5 = 155.5 JPY -> half-up at 0dp -> 156 yen
    assert.deepEqual(convertMoney({ amount: 1, currency: 'USD' }, 'JPY', tieFx).converted, { amount: 156, currency: 'JPY' });
    // Rounding at the SOURCE scale first (155.50 -> 155.50) then converting
    // would give 155.5 -> 155 with half-even/truncation; we require 156.
    const zeroFx = createStaticFxProvider({ 'JPY/KWD': 0.0005 });
    // 1 JPY x 0.0005 = 0.0005 KWD -> tie at 3dp -> 0.001
    assert.deepEqual(convertMoney({ amount: 1, currency: 'JPY' }, 'KWD', zeroFx).converted, { amount: 0.001, currency: 'KWD' });
  });

  it('is deterministic: identical inputs produce identical minor units every time', () => {
    const first = convertMoney({ amount: 19.99, currency: 'USD' }, 'JPY', fx);
    const second = convertMoney({ amount: 19.99, currency: 'USD' }, 'JPY', fx);
    assert.deepEqual(first, second);
    assert.equal(first.targetMinorUnits, second.targetMinorUnits);
    // 19.99 x 155.25 = 3103.4475 JPY -> half-up at 0dp -> 3103 yen
    assert.equal(first.converted.amount, 3103);
    assert.equal(first.targetMinorUnits, '3103');
    // One hundredth of a rate away the true product crosses the tie:
    // 19.99 x 155.26 = 3103.6474 -> 3104 yen. A float implementation that
    // rounds at the source scale, or truncates, cannot produce both results.
    const upFx = createStaticFxProvider({ 'USD/JPY': 155.26 });
    const up = convertMoney({ amount: 19.99, currency: 'USD' }, 'JPY', upFx);
    assert.equal(up.converted.amount, 3104);
    assert.equal(up.targetMinorUnits, '3104');
  });

  it('accepts a bare resolver function and treats same-currency conversion as an exact identity', () => {
    const resolver = (from: string, to: string): number | undefined => (from === 'KES' && to === 'JPY' ? 1.1 : undefined);
    const converted = convertMoney({ amount: 250, currency: 'KES' }, 'JPY', resolver);
    assert.deepEqual(converted.converted, { amount: 275, currency: 'JPY' });
    assert.equal(converted.providerId, 'function');

    const identity = convertMoney({ amount: 100.5, currency: 'JPY' }, 'JPY', fx);
    assert.equal(identity.identity, true);
    assert.equal(identity.rate, 1);
    assert.deepEqual(identity.converted, { amount: 101, currency: 'JPY' }, 'identity still quantizes at the currency scale');
    assert.equal(identity.providerId, 'identity');
  });

  it('fails closed on a missing, zero, negative, or non-finite rate — never a silent 1:1', () => {
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'KRW', fx), MoneyError);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'KRW', fx), /No injected FX rate/);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'JPY', () => undefined), MoneyError);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'JPY', () => 0), /positive finite/);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'JPY', () => -1), /positive finite/);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'JPY', () => Number.NaN), /positive finite/);
    assert.throws(() => convertMoney({ amount: 10, currency: 'USD' }, 'JPY', {} as never), /injected rate provider/);
    assert.throws(() => convertMoney({ amount: Number.NaN, currency: 'USD' }, 'JPY', fx), /finite amount/);
    assert.throws(() => convertMoney({ amount: 10, currency: '' }, 'JPY', fx), MoneyError);
  });

  it('rejects an invalid static rate table at construction (no hidden defaults)', () => {
    assert.throws(() => createStaticFxProvider({ 'USD/JPY': 0 }), MoneyError);
    assert.throws(() => createStaticFxProvider({ 'USD/JPY': -5 }), MoneyError);
    assert.throws(() => createStaticFxProvider({ 'USD/JPY': Number.NaN }), MoneyError);
    assert.throws(() => createStaticFxProvider({ 'USDJPY': 150 }), /FROM\/TO/);
    assert.throws(() => createStaticFxProvider(new Map([['USD/JPY', 150], ['usd/jpy', 151]])), /Duplicate FX rate/);
    const mapProvider = createStaticFxProvider(new Map([['usd/jpy', 150]]), 'static:map');
    assert.equal(mapProvider.getRate('USD', 'JPY'), 150);
    assert.equal(mapProvider.getRate('JPY', 'USD'), undefined, 'no implicit inversion (a reciprocal is not an exact decimal)');
    assert.equal(mapProvider.id, 'static:map');
  });
});
