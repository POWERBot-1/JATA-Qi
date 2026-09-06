import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_FIXED_MONETARY_SCALE,
  MoneyError,
  T09_MONEY_MIGRATION_MODE,
  auditMonetaryValue,
  auditMonetaryValues,
  isBitIdenticalUnderPerCurrencyScale,
  legacyMinorUnits,
  legacyQuantizeAmount,
  minorUnitsOf,
  planMonetaryScaleMigration,
  quantizeAmount,
  scaleOf,
} from '../src/index.js';
import type { MonetaryValue } from '../src/index.js';

/**
 * T-09 migration requirement — expand-only and non-destructive.
 *
 * These tests prove three properties of the per-currency scale change:
 *  1. every persisted 2-decimal-currency value derives EXACTLY as it did under
 *     the pre-T-09 fixed-2dp rule (bit-identical amounts and minor units);
 *  2. the audit/plan surface is read-only — it never rewrites a value, and the
 *     migration plan is structurally incapable of proposing one;
 *  3. values that are not representable at their currency's scale (a legacy
 *     JPY row holding 100.5) are REPORTED for a separately governed decision
 *     instead of being silently quantized in place.
 */

/** A deterministic corpus shaped like persisted rows: amounts plus float traps. */
const TWO_DECIMAL_CORPUS: readonly MonetaryValue[] = Object.freeze([
  { amount: 0, currency: 'KES' },
  { amount: 0.01, currency: 'KES' },
  { amount: 0.1, currency: 'KES' },
  { amount: 0.3, currency: 'KES' },
  { amount: 0.30000000000000004, currency: 'KES' }, // 0.1 + 0.2 float artifact
  { amount: 1.005, currency: 'KES' },
  { amount: 2.675, currency: 'KES' },
  { amount: 19.99, currency: 'KES' },
  { amount: 59.97, currency: 'KES' },
  { amount: Number('59.969999999999995'), currency: 'KES' }, // 19.99 x 3 float artifact
  { amount: 100, currency: 'KES' },
  { amount: 123456789.99, currency: 'KES' },
  { amount: 250.5, currency: 'USD' },
  { amount: 1234.56, currency: 'EUR' },
]);

const NON_DEFAULT_SCALE_CORPUS: readonly MonetaryValue[] = Object.freeze([
  { amount: 100, currency: 'JPY' }, // already whole yen: no rewrite needed
  { amount: 100.5, currency: 'JPY' }, // legacy row that is NOT representable at 0dp
  { amount: 0.4, currency: 'KRW' }, // sub-unit legacy row
  { amount: 1.234, currency: 'KWD' }, // exactly representable at 3dp
  { amount: 1.2345, currency: 'KWD' }, // one place beyond 3dp
  { amount: 250, currency: 'BHD' },
]);

describe('T-09 migration — expand-only, non-destructive, bit-identical for 2dp rows', () => {
  it('derives every legacy 2-decimal value bit-identically to the pre-T-09 fixed-scale rule', () => {
    for (const value of TWO_DECIMAL_CORPUS) {
      assert.equal(scaleOf(value.currency), LEGACY_FIXED_MONETARY_SCALE, `${value.currency} keeps the 2-decimal default scale`);
      assert.equal(
        minorUnitsOf(value.amount, value.currency),
        legacyMinorUnits(value.amount),
        `minor units of ${value.amount} ${value.currency} must equal the legacy fixed-2dp derivation`,
      );
      assert.ok(
        Object.is(quantizeAmount(value.amount, value.currency), legacyQuantizeAmount(value.amount)),
        `quantization of ${value.amount} ${value.currency} must be bit-identical to the legacy result`,
      );
      assert.ok(isBitIdenticalUnderPerCurrencyScale(value), `${value.amount} ${value.currency} must be bit-identical under T-09`);
    }
  });

  it('is bit-identical across an exhaustive deterministic 2dp corpus (every cent up to 500.00)', () => {
    // Deterministic enumeration instead of Math.random: every amount is an
    // exact number of cents, i.e. the shape of every persisted 2dp row.
    for (let cents = 0; cents <= 50_000; cents += 7) {
      const amount = cents / 100;
      const value: MonetaryValue = { amount, currency: 'KES' };
      assert.equal(minorUnitsOf(amount, 'KES'), legacyMinorUnits(amount), `minor units diverged at ${amount}`);
      assert.ok(Object.is(quantizeAmount(amount, 'KES'), legacyQuantizeAmount(amount)), `quantization diverged at ${amount}`);
      assert.ok(isBitIdenticalUnderPerCurrencyScale(value), `bit-identity diverged at ${amount}`);
      assert.ok(Object.is(quantizeAmount(amount, 'KES'), amount), `a persisted 2dp row must never change value (diverged at ${amount})`);
    }
  });

  it('audits rows read-only: zero rewrites, no mutation of the inspected corpus', () => {
    const before = structuredClone(TWO_DECIMAL_CORPUS);
    const report = auditMonetaryValues(TWO_DECIMAL_CORPUS);
    assert.equal(report.mode, T09_MONEY_MIGRATION_MODE);
    assert.equal(T09_MONEY_MIGRATION_MODE, 'expand-only');
    assert.equal(report.inspected, TWO_DECIMAL_CORPUS.length);
    assert.equal(report.bitIdentical, TWO_DECIMAL_CORPUS.length, 'every 2dp row is bit-identical');
    assert.equal(report.rewritesPerformed, 0);
    assert.equal(report.destructive, false);
    assert.equal(report.scaleChanged.length, 0, 'no 2dp row changes its derived minor units');
    // The only rows the audit flags in a 2dp corpus are the IEEE-754 artifact
    // rows (0.1+0.2, 1.005, 2.675, 19.99x3): they are not exactly
    // representable at 2dp, so they are REPORTED (and would quantize at the
    // boundary) — but they are still derived bit-identically to the legacy
    // rule, and nothing is rewritten.
    assert.deepEqual(
      report.outOfScale.map((row) => row.amount).sort((a, b) => a - b),
      [1.005, 2.675, 0.30000000000000004, Number('59.969999999999995')].sort((a, b) => a - b),
    );
    assert.ok(report.outOfScale.every((row) => row.bitIdentical), 'float-artifact rows still derive exactly as the legacy rule did');
    assert.deepEqual(TWO_DECIMAL_CORPUS, before, 'the audit must not mutate the rows it inspected');
  });

  it('reports out-of-scale rows for other currencies instead of rewriting them', () => {
    const before = structuredClone(NON_DEFAULT_SCALE_CORPUS);
    const report = auditMonetaryValues(NON_DEFAULT_SCALE_CORPUS);

    assert.equal(report.rewritesPerformed, 0);
    assert.equal(report.destructive, false);
    assert.deepEqual(NON_DEFAULT_SCALE_CORPUS, before, 'no row was rewritten');

    const jpyWhole = auditMonetaryValue({ amount: 100, currency: 'JPY' });
    assert.equal(jpyWhole.scale, 0);
    assert.equal(jpyWhole.outOfScale, false, '100 JPY is exactly representable at 0dp');
    assert.equal(jpyWhole.quantizedAmount, 100, 'the stored amount is untouched');
    assert.equal(jpyWhole.minorUnits, '100');
    assert.equal(jpyWhole.legacyMinorUnits, '10000', 'the legacy fixed-2dp derivation differed');
    assert.equal(jpyWhole.bitIdentical, false, 'a 0dp currency is new semantics by design');

    const jpyFraction = auditMonetaryValue({ amount: 100.5, currency: 'JPY' });
    assert.equal(jpyFraction.outOfScale, true, '100.5 JPY is not representable at 0dp');
    assert.equal(jpyFraction.amount, 100.5, 'the audit reports the stored value unchanged');
    assert.equal(jpyFraction.quantizedAmount, 101, 'what quantization WOULD produce is reported, not applied');
    assert.equal(jpyFraction.minorUnits, '101');

    const kwdExact = auditMonetaryValue({ amount: 1.234, currency: 'KWD' });
    assert.equal(kwdExact.outOfScale, false);
    assert.equal(kwdExact.minorUnits, '1234');

    const kwdBeyond = auditMonetaryValue({ amount: 1.2345, currency: 'KWD' });
    assert.equal(kwdBeyond.outOfScale, true);
    assert.equal(kwdBeyond.quantizedAmount, 1.235);
    assert.equal(kwdBeyond.amount, 1.2345);

    assert.equal(report.outOfScale.length, 3, 'JPY 100.5, KRW 0.4, KWD 1.2345 are reported');
    assert.deepEqual(report.outOfScale.map((row) => `${row.amount}${row.currency}`).sort(), ['0.4KRW', '1.2345KWD', '100.5JPY']);
  });

  it('plans a migration that can never contain a rewrite', () => {
    const corpus = [...TWO_DECIMAL_CORPUS, ...NON_DEFAULT_SCALE_CORPUS];
    const frozen = corpus.map((value) => Object.freeze({ ...value }));
    const plan = planMonetaryScaleMigration(frozen);
    assert.equal(plan.mode, 'expand-only');
    assert.equal(plan.destructive, false);
    assert.equal(plan.rewrites.length, 0, 'T-09 performs no rewrite of historical monetary data');
    assert.ok(Object.isFrozen(plan.rewrites));
    assert.ok(plan.advisories.length >= 3, 'out-of-scale rows are surfaced for a separately governed decision');
    assert.ok(plan.advisories.every((row) => row.outOfScale || !row.bitIdentical),
      'every advisory is either not representable at its currency scale or derives differently than before T-09');
    const advisoryKeys = plan.advisories.map((row) => `${row.amount}${row.currency}`);
    assert.ok(advisoryKeys.includes('100.5JPY'), 'the unrepresentable legacy JPY row is surfaced');
    assert.ok(advisoryKeys.includes('1.2345KWD'), 'the 4-decimal legacy KWD row is surfaced');
    assert.ok(advisoryKeys.includes('100JPY'), 'a whole-yen row is surfaced because its derived minor units changed');
    assert.ok(!advisoryKeys.includes('19.99KES'), 'an exactly representable 2dp row needs no review');
    // A 3dp row that IS exactly representable needs no rewrite, but its
    // derived minor units changed under T-09 (123 -> 1234), so it is listed as
    // an informational advisory with outOfScale false.
    const kwdExactAdvisory = plan.advisories.find((row) => row.amount === 1.234 && row.currency === 'KWD');
    assert.ok(kwdExactAdvisory, 'an exactly representable 3dp row is listed informationally');
    assert.equal(kwdExactAdvisory!.outOfScale, false);
    assert.equal(kwdExactAdvisory!.quantizedAmount, 1.234, 'its stored value is untouched');
    assert.equal(kwdExactAdvisory!.minorUnits, '1234');
    assert.equal(kwdExactAdvisory!.legacyMinorUnits, '123');
    // Frozen inputs would throw on any mutation attempt: planning is read-only.
    assert.doesNotThrow(() => planMonetaryScaleMigration(frozen));
  });

  it('fails closed when an audited amount is not a finite number', () => {
    assert.throws(() => auditMonetaryValue({ amount: Number.NaN, currency: 'KES' }), MoneyError);
    assert.throws(() => auditMonetaryValue({ amount: Number.POSITIVE_INFINITY, currency: 'JPY' }), MoneyError);
    assert.throws(() => auditMonetaryValue(undefined as unknown as MonetaryValue), MoneyError);
    assert.throws(() => legacyQuantizeAmount(Number.NaN), MoneyError);
  });
});
