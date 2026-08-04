// Analytics engine tests — telemetry, active users, cohorts/retention, funnels,
// sessions, revenue (ARPDAU/ARPPU/LTV), economy, and queries.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Analytics, dayKey } from '../src/index.js';
import type { TelemetryEvent } from '../src/index.js';

const DAY = 86_400_000;
/** Timestamp for a given day index + optional second offset. */
const t = (day: number, sec = 0): number => day * DAY + sec * 1000;

describe('Analytics — ingestion & profiles', () => {
  it('builds profiles from telemetry and tracks level/country', () => {
    const a = new Analytics();
    a.track({ playerId: 'p1', name: 'install', ts: t(0), dims: { level: 1, country: 'KE' } });
    a.track({ playerId: 'p1', name: 'level_up', ts: t(0, 10), value: 5, dims: { level: 5 } });
    const p = a.profile('p1')!;
    assert.equal(p.country, 'KE');
    assert.equal(p.level, 5); // max level seen
    assert.equal(p.firstSeen, t(0));
  });
});

describe('Analytics — active users', () => {
  it('computes DAU/WAU/MAU', () => {
    const a = new Analytics();
    a.track({ playerId: 'a', name: 'play', ts: t(0) });
    a.track({ playerId: 'b', name: 'play', ts: t(0) });
    a.track({ playerId: 'a', name: 'play', ts: t(3) }); // a returns on day 3
    assert.equal(a.dau(dayKey(t(0))), 2);
    assert.equal(a.dau(dayKey(t(3))), 1);
    // WAU ending day 3 covers days -3..3 (7-day window) -> a + b.
    assert.equal(a.wau(dayKey(t(3))), 2);
    assert.equal(a.mau(dayKey(t(3))), 2);
  });

  it('splits new vs returning', () => {
    const a = new Analytics();
    a.track({ playerId: 'a', name: 'install', ts: t(0) }); // new on day 0
    a.track({ playerId: 'b', name: 'install', ts: t(0) }); // new on day 0
    a.track({ playerId: 'a', name: 'play', ts: t(1) }); // returning on day 1
    const d0 = a.newVsReturning(dayKey(t(0)));
    assert.equal(d0.new, 2);
    const d1 = a.newVsReturning(dayKey(t(1)));
    assert.equal(d1.returning, 1);
    assert.equal(d1.new, 0);
  });
});

describe('Analytics — cohorts & retention', () => {
  it('computes D1/D7 retention for an install cohort', () => {
    const a = new Analytics();
    // 10 players install on day 0.
    for (let i = 0; i < 10; i++) a.track({ playerId: `p${i}`, name: 'install', ts: t(0) });
    // 6 return on day 1, 3 on day 7.
    for (let i = 0; i < 6; i++) a.track({ playerId: `p${i}`, name: 'play', ts: t(1) });
    for (let i = 0; i < 3; i++) a.track({ playerId: `p${i}`, name: 'play', ts: t(7) });
    const cohort = dayKey(t(0));
    const d1 = a.retention(cohort, 1);
    const d7 = a.retention(cohort, 7);
    const d30 = a.retention(cohort, 30);
    assert.equal(d1.retained, 6);
    assert.equal(d1.rate, 0.6);
    assert.equal(d7.retained, 3);
    assert.equal(d30.retained, 0);
  });

  it('produces a cohort table', () => {
    const a = new Analytics();
    for (let i = 0; i < 4; i++) a.track({ playerId: `p${i}`, name: 'install', ts: t(0) });
    a.track({ playerId: 'p0', name: 'play', ts: t(1) });
    const table = a.cohortTable('day', 1);
    assert.equal(table.length, 1);
    assert.equal(table[0]!.retention[1], 1);
  });
});

describe('Analytics — funnels', () => {
  it('counts sequential conversion through stages', () => {
    const a = new Analytics();
    // Player A completes all 3 stages; B stops at stage 2; C only stage 1.
    const stages = ['open', 'signup', 'purchase'];
    const seq: Array<[string, string[]]> = [
      ['A', ['open', 'signup', 'purchase']],
      ['B', ['open', 'signup']],
      ['C', ['open']],
    ];
    for (const [player, events] of seq) {
      for (let i = 0; i < events.length; i++) a.track({ playerId: player, name: events[i]!, ts: t(0, i) });
    }
    const f = a.funnel(stages);
    assert.deepEqual(f.stages.map((s) => s.count), [3, 2, 1]);
    assert.ok(Math.abs(f.conversion[2]! - 0.5) < 1e-9); // 1/2
  });
});

describe('Analytics — sessions & economy & matches', () => {
  it('tracks session durations', () => {
    const a = new Analytics();
    a.sessionStart('s1', 'p1', t(0));
    a.sessionEnd('s1', t(0, 120)); // 120s
    a.sessionStart('s2', 'p1', t(0, 200));
    a.sessionEnd('s2', t(0, 260)); // 60s
    assert.equal(a.avgSessionDuration(), 90); // (120+60)/2
    assert.equal(a.profile('p1')!.sessions, 2);
  });

  it('aggregates economy earn/spend', () => {
    const a = new Analytics();
    a.track({ playerId: 'p1', name: 'earn', ts: t(0), value: 100 });
    a.track({ playerId: 'p1', name: 'spend', ts: t(0), value: 30 });
    assert.deepEqual(a.economyAnalytics(), { earn: 100, spend: 30, net: 70 });
  });

  it('counts match wins/losses/draws', () => {
    const a = new Analytics();
    a.track({ playerId: 'p1', name: 'match_end', ts: t(0), dims: { result: 'win' } });
    a.track({ playerId: 'p1', name: 'match_end', ts: t(0), dims: { result: 'loss' } });
    a.track({ playerId: 'p2', name: 'match_end', ts: t(0), dims: { result: 'draw' } });
    assert.deepEqual(a.matchAnalytics(), { wins: 1, losses: 1, draws: 1, total: 3 });
  });
});

describe('Analytics — revenue (ARPDAU / ARPPU / LTV)', () => {
  it('computes revenue metrics', () => {
    const a = new Analytics();
    a.track({ playerId: 'p1', name: 'install', ts: t(0) });
    a.track({ playerId: 'p2', name: 'install', ts: t(0) });
    a.track({ playerId: 'p1', name: 'purchase', ts: t(0), value: 10 });
    a.track({ playerId: 'p2', name: 'purchase', ts: t(0), value: 5 });
    const day = dayKey(t(0));
    assert.equal(a.revenueOn(day), 15);
    assert.equal(a.totalRevenue(), 15);
    // ARPDAU = 15 / 2 DAU = 7.5
    assert.equal(a.arpDau(day), 7.5);
    // ARPPU = 15 / 2 payers = 7.5
    assert.equal(a.arppu(), 7.5);
    // LTV for the day-0 cohort = 15 / 2 = 7.5
    assert.equal(a.ltv(day), 7.5);
  });
});

describe('Analytics — queries & aggregation', () => {
  it('filters by name/dims/time and aggregates', () => {
    const a = new Analytics();
    a.track({ playerId: 'p1', name: 'spend', ts: t(0), value: 10, dims: { item: 'skin' } });
    a.track({ playerId: 'p2', name: 'spend', ts: t(1), value: 20, dims: { item: 'skin' } });
    a.track({ playerId: 'p1', name: 'spend', ts: t(2), value: 5, dims: { item: 'boost' } });
    const skins = a.query({ name: 'spend', dims: { item: 'skin' } });
    assert.equal(skins.length, 2);
    const agg = a.aggregate({ name: 'spend' });
    assert.equal(agg.count, 3);
    assert.equal(agg.sum, 35);
    assert.equal(agg.uniquePlayers, 2);
    assert.equal(agg.max, 20);
    const day0 = a.aggregate({ name: 'spend', fromTs: t(0), toTs: t(0, 86399) });
    assert.equal(day0.count, 1);
  });
});
