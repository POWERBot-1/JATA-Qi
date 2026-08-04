// Experimentation tests — deterministic assignment, traffic allocation,
// conversion + significance, lifecycle, and feature flags/canary.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentManager, FeatureFlagManager, segmentMatches } from '../src/index.js';

describe('ExperimentManager — assignment', () => {
  it('assigns deterministically and stably per player', () => {
    const m = new ExperimentManager();
    m.create({ id: 'exp1', name: 'Color', metric: 'click', variants: [{ name: 'red', weight: 1 }, { name: 'blue', weight: 1 }] });
    m.start('exp1');
    const a1 = m.assign('player-42', 'exp1');
    const a2 = m.assign('player-42', 'exp1');
    assert.equal(a1, a2); // stable
    assert.ok(a1 === 'red' || a1 === 'blue');
  });

  it('distributes roughly evenly across variants', () => {
    const m = new ExperimentManager();
    m.create({ id: 'ab', name: 'AB', metric: 'conv', variants: [{ name: 'A', weight: 1 }, { name: 'B', weight: 1 }] });
    m.start('ab');
    const counts = { A: 0, B: 0 } as Record<string, number>;
    for (let i = 0; i < 4000; i++) counts[m.assign(`p${i}`, 'ab')]++;
    // Roughly 50/50 with tolerance.
    assert.ok(counts.A > 1600 && counts.B > 1600, `A=${counts.A} B=${counts.B}`);
  });

  it('respects traffic allocation (un-enrolled players get the baseline)', () => {
    const m = new ExperimentManager();
    m.create({ id: 'roll', name: 'Roll', metric: 'conv', variants: [{ name: 'control', weight: 1 }, { name: 'treatment', weight: 1 }], trafficPct: 50, baseline: 'control' });
    m.start('roll');
    let enrolled = 0;
    for (let i = 0; i < 2000; i++) {
      const v = m.assign(`p${i}`, 'roll');
      if (v === 'treatment') enrolled++;
    }
    // ~25% land in treatment (50% traffic * 50% of the enrolled split).
    assert.ok(enrolled > 350 && enrolled < 700, `treatment=${enrolled}`);
  });

  it('multivariate assignment across multiple experiments', () => {
    const m = new ExperimentManager();
    m.create({ id: 'color', name: 'C', metric: 'x', variants: [{ name: 'red', weight: 1 }, { name: 'blue', weight: 1 }] });
    m.create({ id: 'layout', name: 'L', metric: 'x', variants: [{ name: 'grid', weight: 1 }, { name: 'list', weight: 1 }] });
    m.start('color'); m.start('layout');
    const combo = m.assignAll('player-99', ['color', 'layout']);
    assert.ok(combo.color && combo.layout);
    // Stable across calls.
    assert.deepEqual(combo, m.assignAll('player-99', ['color', 'layout']));
  });
});

describe('ExperimentManager — conversion + statistics', () => {
  it('tracks conversions and reports lift + significance', () => {
    const m = new ExperimentManager();
    m.create({ id: 'win', name: 'Win', metric: 'buy', variants: [{ name: 'control', weight: 1 }, { name: 'better', weight: 1 }] });
    m.start('win');
    // Assign many players, then convert "better" far more often to force significance.
    for (let i = 0; i < 2000; i++) {
      const v = m.assign(`p${i}`, 'win');
      if (v === 'better' && i % 2 === 0) m.convert(`p${i}`, 'win');
      if (v === 'control' && i % 20 === 0) m.convert(`p${i}`, 'win');
    }
    const report = m.report('win');
    const better = report.variants.find((v) => v.name === 'better')!;
    assert.ok(better.conversionRate > 0);
    assert.ok(better.significant, 'better should be significantly better');
    assert.equal(report.winner, 'better');
  });

  it('lifecycle: draft -> running -> paused -> completed', () => {
    const m = new ExperimentManager();
    m.create({ id: 'life', name: 'L', metric: 'x', variants: [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }] });
    assert.equal(m.get('life')!.status, 'draft');
    m.start('life'); assert.equal(m.get('life')!.status, 'running');
    m.pause('life'); assert.equal(m.get('life')!.status, 'paused');
    assert.throws(() => m.assign('p', 'life')); // paused -> no assignment
    m.resume('life'); assert.equal(m.get('life')!.status, 'running');
    m.complete('life'); assert.equal(m.get('life')!.status, 'completed');
    assert.ok(m.get('life')!.endedAt! > 0);
  });
});

describe('FeatureFlagManager — flags + canary', () => {
  it('gates a flag by rollout percentage deterministically', () => {
    const f = new FeatureFlagManager();
    f.set({ key: 'new-ui', enabled: true, rolloutPct: 50 });
    let on = 0;
    for (let i = 0; i < 2000; i++) if (f.isEnabled('new-ui', `p${i}`)) on++;
    assert.ok(on > 700 && on < 1300, `on=${on}`);
    // Same player is stable.
    const first = f.isEnabled('new-ui', 'stable-player');
    assert.equal(first, f.isEnabled('new-ui', 'stable-player'));
  });

  it('disables a flag entirely when enabled=false', () => {
    const f = new FeatureFlagManager();
    f.set({ key: 'x', enabled: false, rolloutPct: 100 });
    assert.equal(f.isEnabled('x', 'p1'), false);
  });

  it('targets a segment', () => {
    const f = new FeatureFlagManager();
    f.set({ key: 'vip', enabled: true, rolloutPct: 100, segment: { minLevel: 50, paying: true } });
    assert.equal(f.isEnabled('vip', 'whale', { level: 80, paying: true }), true);
    assert.equal(f.isEnabled('vip', 'newbie', { level: 5, paying: false }), false);
  });

  it('canary rollout helper', () => {
    const f = new FeatureFlagManager();
    const flag = f.enableCanary('feature-x', 5);
    assert.equal(flag.rolloutPct, 5);
    assert.equal(f.get('feature-x')!.rolloutPct, 5);
  });
});

describe('segmentMatches', () => {
  it('evaluates all predicates', () => {
    assert.equal(segmentMatches({ minLevel: 10 }, { level: 15 }), true);
    assert.equal(segmentMatches({ minLevel: 10 }, { level: 5 }), false);
    assert.equal(segmentMatches({ country: 'KE' }, { country: 'KE' }), true);
    assert.equal(segmentMatches({ paying: true }, { paying: false }), false);
  });
});
