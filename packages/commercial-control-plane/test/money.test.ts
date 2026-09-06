import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONETARY_SCALE,
  decimalParts,
  isQuantizedAmount,
  minorUnitsOf,
  moneyAtLeast,
  moneyEquals,
  moneyLessThan,
  moneyProductEquals,
  moneyWithin,
  quantizeAmount,
  quantizeMonetaryValue,
  sumMonetaryAmounts,
  sumMoney,
} from '../src/money.js';

/**
 * T-07 AC-5 float-trap fixtures: the quantized money policy must be exact on
 * decimal values that IEEE-754 cannot represent (0.1 + 0.2, 0.1 x 3,
 * 19.99 x 3, 1.005, 2.675) and must never false-mismatch a valid invoice.
 */
describe('T-07 money policy (commercial-control-plane money utilities)', () => {
  it('decomposes numbers from their exact shortest decimal representation', () => {
    assert.deepEqual(decimalParts(0.1), { int: 1n, scale: 1, negative: false });
    assert.deepEqual(decimalParts(19.99), { int: 1999n, scale: 2, negative: false });
    assert.deepEqual(decimalParts(0.30000000000000004), { int: 30000000000000004n, scale: 17, negative: false });
    assert.deepEqual(decimalParts(1e-7), { int: 1n, scale: 7, negative: false });
    assert.equal(DEFAULT_MONETARY_SCALE, 2);
  });

  it('derives exact minor units without float multiplication', () => {
    assert.equal(minorUnitsOf(0.1), 10n);
    assert.equal(minorUnitsOf(19.99), 1999n);
    assert.equal(minorUnitsOf(123456789.99), 12345678999n);
    // 1.005 is NOT 100.5 minor units in float math; the decimal parse must win.
    assert.equal(minorUnitsOf(1.005), 101n); // 100.5 -> half-up -> 101
  });

  it('quantizes at the boundary: <=2dp amounts pass through bit-identical', () => {
    assert.ok(isQuantizedAmount(0.1));
    assert.ok(isQuantizedAmount(19.99));
    assert.ok(!isQuantizedAmount(1.005));
    assert.ok(!isQuantizedAmount(0.1 * 3)); // float product 0.30000000000000004 carries >2 dp
    assert.ok(!isQuantizedAmount(Number('59.969999999999995'))); // parsed decimal carries >2 dp
    assert.equal(quantizeAmount(19.99), 19.99);
    assert.equal(quantizeAmount(0.3), 0.3);
  });

  it('rounds half-up on the exact decimal value (never on float arithmetic)', () => {
    assert.equal(quantizeAmount(1.005), 1.01); // float 1.005*100 < 100.5 would round down
    assert.equal(quantizeAmount(2.675), 2.68); // classic float trap
    assert.equal(quantizeAmount(1.004), 1.0);
    assert.equal(quantizeAmount(0.1 + 0.2), 0.3); // float sum 0.30000000000000004 rounds to exactly 0.3
    assert.equal(quantizeAmount(0.1 * 3), 0.3); // float product 0.30000000000000004 rounds to exactly 0.3
    assert.equal(quantizeAmount(Number('59.969999999999995')), 59.97); // 19.99 x 3-style artifact value rounds to exactly 59.97
    assert.equal(quantizeAmount(1e-7), 0); // below the minor unit -> zero (documented)
    assert.deepEqual(quantizeMonetaryValue({ amount: 1.005, currency: 'KES' }), { amount: 1.01, currency: 'KES' });
  });

  it('sums deterministically: 0.1 + 0.2 === 0.3 exactly', () => {
    assert.equal(sumMonetaryAmounts([0.1, 0.2]), 0.3);
    assert.equal(sumMonetaryAmounts([0.1, 0.2, 0.3]), 0.6);
    assert.equal(sumMonetaryAmounts([19.99, 19.99, 19.99, 0.01]), 59.98);
    assert.deepEqual(sumMoney([
      { amount: 0.1, currency: 'KES' },
      { amount: 0.2, currency: 'KES' },
    ]), { amount: 0.3, currency: 'KES' });
  });

  it('compares scale-exactly on amounts that are float-unequal', () => {
    assert.ok(moneyEquals({ amount: 0.3, currency: 'KES' }, { amount: 0.30000000000000004, currency: 'KES' }));
    assert.ok(!moneyEquals({ amount: 0.3, currency: 'KES' }, { amount: 0.31, currency: 'KES' }));
    assert.ok(!moneyEquals({ amount: 0.3, currency: 'KES' }, { amount: 0.3, currency: 'USD' }));
    assert.ok(moneyWithin({ amount: 0.3, currency: 'KES' }, { amount: 0.30000000000000004, currency: 'KES' }));
    assert.ok(!moneyWithin({ amount: 0.31, currency: 'KES' }, { amount: 0.3, currency: 'KES' }));
    assert.ok(!moneyWithin({ amount: 0.3, currency: 'KES' }, { amount: 0.3, currency: 'USD' }));
    assert.ok(moneyLessThan({ amount: 0.3, currency: 'KES' }, { amount: 0.30000000000000004, currency: 'KES' }) === false);
    assert.ok(moneyLessThan({ amount: 0.29, currency: 'KES' }, { amount: 0.3, currency: 'KES' }));
    assert.ok(moneyAtLeast({ amount: 0.30000000000000004, currency: 'KES' }, { amount: 0.3, currency: 'KES' }));
  });

  it('product rule is exact for float-trap quantities and never false-mismatches', () => {
    // 0.1 x 3 vs 0.3 (float product is 0.30000000000000004)
    assert.ok(moneyProductEquals({ amount: 0.1, currency: 'KES' }, 3, { amount: 0.3, currency: 'KES' }));
    assert.ok(!moneyProductEquals({ amount: 0.1, currency: 'KES' }, 3, { amount: 0.29, currency: 'KES' }));
    // 19.99 x 3 vs 59.97 (float product is 59.969999999999995)
    assert.ok(moneyProductEquals({ amount: 19.99, currency: 'KES' }, 3, { amount: 59.97, currency: 'KES' }));
    assert.ok(!moneyProductEquals({ amount: 19.99, currency: 'KES' }, 3, { amount: 59.96, currency: 'KES' }));
    // Decimal quantity 1.15 x 0.3 = 0.345 -> half-up 0.35 (float multiply gives 0.344999...)
    assert.ok(moneyProductEquals({ amount: 1.15, currency: 'KES' }, 0.3, { amount: 0.35, currency: 'KES' }));
    assert.ok(!moneyProductEquals({ amount: 1.15, currency: 'KES' }, 0.3, { amount: 0.34, currency: 'KES' }));
    // Currency mismatch fails closed.
    assert.ok(!moneyProductEquals({ amount: 0.1, currency: 'KES' }, 3, { amount: 0.3, currency: 'USD' }));
  });
});
