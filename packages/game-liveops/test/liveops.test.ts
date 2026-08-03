// LiveOpsModule integration tests — telemetry pipeline, live events, offers,
// experiments, remote config, seasons, and the event bus.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { LiveOpsModule, LiveOpsEvents } from '../src/index.js';

const DAY = 86_400_000;

describe('LiveOpsModule', () => {
  let kernel: Kernel;
  let mod: LiveOpsModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new LiveOpsModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('ingests telemetry and emits telemetry.received', async () => {
    let received = 0;
    kernel.bus.on(LiveOpsEvents.TelemetryReceived, () => { received++; });
    mod.track({ playerId: 'p1', name: 'install', ts: Date.now() });
    mod.track({ playerId: 'p1', name: 'play', ts: Date.now() });
    await new Promise((r) => setImmediate(r));
    assert.ok(received >= 2);
    assert.equal(mod.analytics.eventCount(), 2);
  });

  it('emits retention.updated for returning players', async () => {
    let retentionEvents = 0;
    kernel.bus.on(LiveOpsEvents.RetentionUpdated, () => { retentionEvents++; });
    const past = Date.now() - 2 * DAY;
    mod.track({ playerId: 'ret-p', name: 'install', ts: past });
    mod.track({ playerId: 'ret-p', name: 'play', ts: Date.now() }); // returning
    await new Promise((r) => setImmediate(r));
    assert.ok(retentionEvents >= 1);
  });

  it('schedules an active live event and emits started', async () => {
    let started = 0;
    kernel.bus.on(LiveOpsEvents.EventStarted, () => { started++; });
    const now = Date.now();
    mod.scheduleEvent({ id: 'double-xp', name: 'Double XP', startAt: now - 1000, endAt: now + 3600_000, rewards: ['2x'], enabled: true });
    await new Promise((r) => setImmediate(r));
    assert.ok(started >= 1);
    assert.equal(mod.scheduler.active().some((e) => e.id === 'double-xp'), true);
  });

  it('targets offers to eligible players and tracks show/purchase', async () => {
    mod.track({ playerId: 'whale', name: 'install', ts: Date.now(), dims: { level: 60, country: 'KE', paying: 1 } });
    mod.addOffer({ id: 'vip-pack', name: 'VIP', segment: { minLevel: 50, paying: true }, price: { currency: 'usd', amount: 9.99 }, priority: 10, active: true });
    const eligible = mod.offersFor('whale');
    assert.ok(eligible.some((o) => o.id === 'vip-pack'));
    let shown = 0, purchased = 0;
    kernel.bus.on(LiveOpsEvents.OfferShown, () => { shown++; });
    kernel.bus.on(LiveOpsEvents.OfferPurchased, () => { purchased++; });
    mod.showOffer('vip-pack', 'whale');
    mod.purchaseOffer('vip-pack', 'whale');
    await new Promise((r) => setImmediate(r));
    assert.ok(shown >= 1 && purchased >= 1);
    const stats = mod.offerStats();
    assert.equal(stats.purchased, 1);
    assert.equal(stats.revenue, 9.99);
  });

  it('runs an experiment and emits assigned + completed', async () => {
    let assigned = 0, completed = 0;
    kernel.bus.on(LiveOpsEvents.ExperimentAssigned, () => { assigned++; });
    kernel.bus.on(LiveOpsEvents.ExperimentCompleted, () => { completed++; });
    mod.experiments.create({ id: 'btn-color', name: 'Button', metric: 'click', variants: [{ name: 'red', weight: 1 }, { name: 'green', weight: 1 }] });
    mod.experiments.start('btn-color');
    mod.assignVariant('p1', 'btn-color'); // first assignment emits
    mod.assignVariant('p1', 'btn-color'); // repeat does not emit
    mod.completeExperiment('btn-color');
    await new Promise((r) => setImmediate(r));
    assert.equal(assigned, 1);
    assert.ok(completed >= 1);
  });

  it('manages remote config with experiment overrides', () => {
    mod.setConfig('hero-color', 'blue', 'btn-color');
    mod.setConfig('hero-color.green', 'emerald');
    // player-1 was assigned 'green' above → override applies.
    const v = mod.getConfig('hero-color', 'p1');
    assert.equal(v, 'emerald');
    // reload hot-config.
    mod.reloadConfig({ 'hero-color': 'navy' });
    assert.equal(mod.configSnapshot()['hero-color'], 'navy');
  });

  it('rotates seasons', () => {
    const s1 = mod.startSeason('Season 1', 'spring');
    const s2 = mod.startSeason('Season 2', 'summer');
    assert.equal(mod.activeSeason?.id, s2.id);
    assert.equal(mod.seasonHistory().length, 2);
    assert.ok(s1.endAt !== undefined); // s1 ended when s2 started
  });
});
