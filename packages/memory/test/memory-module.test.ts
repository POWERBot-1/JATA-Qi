// DigitalMemoryModule tests — persistence, event bus, sweep, right-to-delete,
// and opt-in bus collection.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule, MemoryEvents } from '../src/index.js';

describe('DigitalMemoryModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: DigitalMemoryModule;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    mod = new DigitalMemoryModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('records, persists, and emits memory.recorded', async () => {
    let fired = false;
    kernel.bus.on(MemoryEvents.Recorded, () => { fired = true; });
    const r = await mod.record({ category: 'prompt', summary: 'hello memory', orgId: 'O', userId: 'u1' });
    assert.equal(r.recorded, true);
    await new Promise((res) => setImmediate(res));
    assert.equal(fired, true);
    assert.ok(mod.get(r.event!.id));
    assert.equal(mod.stats('O').total, 1);
  });

  it('queries and searches through the module', async () => {
    await mod.record({ category: 'search', summary: 'pay invoice now', orgId: 'O' });
    const results = mod.query({ orgId: 'O', text: 'invoice' });
    assert.ok(results.length >= 1);
  });

  it('sweeps expired events and emits memory.expired', async () => {
    let expired = 0;
    kernel.bus.on(MemoryEvents.Expired, () => { expired++; });
    await mod.record({ category: 'performance', summary: 'old', orgId: 'O', retentionDays: 1, ts: Date.now() - 10 * 86_400_000 });
    const removed = await mod.sweep();
    assert.ok(removed >= 1);
    await new Promise((res) => setImmediate(res));
    assert.ok(expired >= 1);
  });

  it('right-to-delete emits memory.purged', async () => {
    let purged = 0;
    kernel.bus.on(MemoryEvents.Purged, () => { purged++; });
    await mod.record({ category: 'prompt', summary: 'erase me', orgId: 'O', userId: 'victim' });
    const removed = await mod.deleteForSubject({ userId: 'victim', orgId: 'O' });
    assert.ok(removed >= 1);
    await new Promise((res) => setImmediate(res));
    assert.ok(purged >= 1);
  });

  it('collects platform bus events into memory (opt-in)', async () => {
    mod.collectFromBus([
      {
        eventType: 'security.user.login',
        category: 'auth',
        summarize: (p) => ({ summary: `login by ${(p as { username?: string }).username ?? 'unknown'}`, tags: ['auth'] }),
      },
    ]);
    kernel.bus.emit('security.user.login', { username: 'alice' });
    await new Promise((res) => setImmediate(res));
    const auth = mod.query({ orgId: undefined, category: 'auth' });
    // Collected events have no orgId (global); query with no orgId sees globals.
    assert.ok(auth.length >= 1 || mod.query({}).some((e) => e.category === 'auth'));
  });
});
