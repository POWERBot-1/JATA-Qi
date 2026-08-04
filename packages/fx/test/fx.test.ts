// KARIS FX (Phase 6) tests: rate engine, cross rates (incl. inverted legs),
// conversions with margin + rounding, history, trend/volatility analytics,
// and the kernel module's memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FxEngine } from '../src/index.js';
import { FxModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('FxEngine', () => {
  it('stores rates and validates inputs', () => {
    const fx = new FxEngine();
    const q = fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0, source: 'cbk' });
    assert.equal(q.pair, 'USD/KES');
    assert.equal(q.bid, 128.5);
    assert.equal(q.ask, 129.0);
    assert.throws(() => fx.setRate({ base: 'USD', quote: 'USD', bid: 1 }), /must differ/);
    assert.throws(() => fx.setRate({ base: 'USD', quote: 'KES', bid: 0 }), /positive/);
    assert.throws(() => fx.setRate({ base: 'USD', quote: 'KES', bid: 2, ask: 1 }), />= bid/);
    assert.equal(fx.stats().pairs, 1);
    assert.deepEqual(fx.stats().sources, ['cbk']);
  });

  it('converts amounts with margin and rounding', () => {
    const fx = new FxEngine();
    fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0 });
    // 100 USD → KES at mid 128.75.
    const r = fx.convert({ from: 'USD', to: 'KES', amount: 10000n });
    assert.equal(r.from, 'USD');
    assert.equal(r.to, 'KES');
    assert.equal(r.rate, 128.75);
    assert.equal(r.result, 1287500n); // 100.00 USD × 128.75 = 12,875.00 KES
    assert.equal(r.margin, 1);
    assert.equal(r.rounded, false);
    // With a 2% margin: rate = 128.75 / 1.02 = 126.2255 → 12,622.55 KES.
    const m = fx.convert({ from: 'USD', to: 'KES', amount: 10000n, margin: 1.02 });
    assert.ok(m.rate < 128.75);
    assert.ok(m.marginAmount > 0n);
    assert.ok(m.result < 1287500n);
    assert.throws(() => fx.convert({ from: 'USD', to: 'KES', amount: 10000n, margin: 0.9 }), /margin/);
  });

  it('derives cross rates through the anchor and inverted legs', () => {
    const fx = new FxEngine();
    fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0 });
    fx.setRate({ base: 'EUR', quote: 'USD', bid: 1.09, ask: 1.10 }); // stored inverted (EUR/USD)
    // EUR → KES = 1.09 × 128.5 = 140.065 (bid).
    const cross = fx.getRate('EUR', 'KES')!;
    assert.ok(cross.bid > 130 && cross.bid < 150, `cross bid ${cross.bid}`);
    assert.ok(Math.abs(cross.bid - 1.09 * 128.5) < 0.01);
    assert.equal(cross.source, 'cross:USD');
    // Inverted leg: KES → USD = 1 / 129.0 (ask side of stored pair).
    const inv = fx.getRate('KES', 'USD')!;
    assert.ok(Math.abs(inv.bid - 1 / 129.0) < 0.0001);
    // Identity pair.
    assert.equal(fx.getRate('KES', 'KES')!.bid, 1);
    // Unknown pair.
    assert.equal(fx.getRate('KES', 'JPY'), undefined);
  });

  it('keeps rate history and computes trend + volatility', () => {
    const fx = new FxEngine();
    const t0 = 1_000_000;
    fx.setRate({ base: 'USD', quote: 'KES', bid: 100, source: 'a', ts: t0 });
    fx.setRate({ base: 'USD', quote: 'KES', bid: 110, source: 'a', ts: t0 + 1000 });
    fx.setRate({ base: 'USD', quote: 'KES', bid: 120, source: 'a', ts: t0 + 2000 });
    fx.setRate({ base: 'USD', quote: 'KES', bid: 130, source: 'a', ts: t0 + 3000 });
    const history = fx.historyFor('USD/KES');
    assert.equal(history.length, 4);
    assert.equal(history[0]!.mid, 100);
    const analytics = fx.analyze('USD/KES', { fromTs: t0, toTs: t0 + 4000 })!;
    assert.equal(analytics.trend, 'up');
    assert.equal(analytics.points, 4);
    assert.equal(analytics.movingAverage, 115);
    assert.ok(analytics.volatility > 0);
    assert.equal(analytics.minMid, 100);
    assert.equal(analytics.maxMid, 130);
    // Windowed: only recent points.
    assert.equal(fx.analyze('USD/KES', { fromTs: t0 + 1500 })!.points, 2);
  });
});

describe('FxModule', () => {
  it('integrates with memory and the wallet currency universe', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new FxModule({ anchor: 'USD' }));
    await kernel.boot();
    try {
      const fx = kernel.getModule<FxModule>('fx');
      fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0, source: 'test' });
      const result = fx.convert({ from: 'USD', to: 'KES', amount: 1000n });
      assert.ok(result.result > 0n);

      // The conversion was recorded into the DME.
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const events = memory.query({ category: 'fx_conversion' });
      assert.equal(events.length, 1);
      assert.match(events[0]!.summary, /USD/);

      // Currency universe defaults when the wallet is absent.
      assert.ok(fx.currencies().includes('KES'));

      // Analytics surface.
      assert.ok(fx.analyze('USD/KES'));
      assert.equal(fx.stats().pairs, 1);
      assert.equal(fx.anchorCurrency, 'USD');
    } finally {
      await kernel.shutdown();
    }
  });
});
