// Phase 6 — AutomationModule integration tests: the SOMA AI engine wired to
// the real platform modules (memory, notifications, knowledge, agent runtime,
// tool intelligence) on a live kernel, including bus-event triggers, schedule
// ticking, and chained automation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '@jataqi/agent-runtime';
import { DigitalMemoryModule } from '@jataqi/memory';
import { NotificationsModule } from '@jataqi/notifications';
import { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import { AutomationModule } from '../src/index.js';

async function bootFull() {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  kernel.register(new DigitalMemoryModule());
  kernel.register(new NotificationsModule());
  kernel.register(new ToolIntelligenceModule());
  kernel.register(new AutomationModule({ tickIntervalMs: 0 })); // no background ticker in tests
  await kernel.boot();
  return kernel;
}

describe('AutomationModule (Phase 6 — SOMA AI)', () => {
  it('records memory, sends notifications, ingests knowledge, and runs agents', async () => {
    const kernel = await bootFull();
    try {
      const automation = kernel.getModule<AutomationModule>('automation');
      const a = automation.create({
        name: 'full-action test', createdBy: 'admin', trigger: { type: 'manual' },
        actions: [
          { type: 'memory.record', params: { category: 'automation', summary: 'automation ran', userId: 'u1', orgId: 'org1', tags: ['soma'] } },
          { type: 'notification.send', params: { recipientId: 'u1', title: 'Automation ran', body: 'hello', type: 'automation' } },
          { type: 'knowledge.ingest', params: { text: 'SOMA AI automation ingested this document.', title: 'SOMA note' } },
          { type: 'agent.run', params: { message: 'say ok' } },
        ],
      });
      const exec = await automation.run({ automationId: a.id });
      assert.equal(exec.status, 'succeeded');
      assert.equal(exec.results.length, 4);
      assert.ok(exec.results.every((r) => r.status === 'ok'));

      // Memory event recorded.
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const events = memory.query({ category: 'automation', userId: 'u1', orgId: 'org1' });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.summary, 'automation ran');

      // Notification in the inbox.
      const notifications = kernel.getModule<NotificationsModule>('notifications');
      const inbox = await notifications.list('u1');
      assert.ok(inbox.some((n) => n.title === 'Automation ran'));

      // Knowledge doc ingested and retrievable.
      const knowledge = kernel.getModule<KnowledgeService>('knowledge');
      const hits = await knowledge.retrieve('SOMA AI automation');
      assert.ok(hits.length >= 1);

      assert.equal(automation.stats().succeeded, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('activates on bus events with filters and ticks schedules', async () => {
    const kernel = await bootFull();
    try {
      const automation = kernel.getModule<AutomationModule>('automation');
      const ev = automation.create({
        name: 'incident responder', createdBy: 'admin',
        trigger: { type: 'event', event: 'incident.raised', filter: { field: 'severity', value: 'critical' } },
        actions: [{ type: 'memory.record', params: { summary: 'critical incident observed', category: 'incident' } }],
      });
      const sched = automation.create({
        name: 'quarter-hour check', createdBy: 'admin',
        trigger: { type: 'schedule', intervalMs: 1000 },
        actions: [{ type: 'memory.record', params: { summary: 'scheduled check ran', category: 'operational' } }],
      });

      // Non-matching event does not activate.
      await kernel.bus.emit('incident.raised', { severity: 'low' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(automation.get(ev.id)!.runCount, 0);

      // Matching event activates.
      await kernel.bus.emit('incident.raised', { severity: 'critical' });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(automation.get(ev.id)!.runCount, 1);

      // Disabling unsubscribes: no further activations.
      automation.setEnabled(ev.id, false);
      await kernel.bus.emit('incident.raised', { severity: 'critical' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(automation.get(ev.id)!.runCount, 1);

      // Schedule tick (manual, deterministic).
      const runs = await automation.tick(Date.now() + 1001);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.automationId, sched.id);
      assert.equal(automation.get(sched.id)!.runCount, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('chains automation runs with a depth guard', async () => {
    const kernel = await bootFull();
    try {
      const automation = kernel.getModule<AutomationModule>('automation');
      const leaf = automation.create({
        name: 'leaf', createdBy: 'admin', trigger: { type: 'manual' },
        actions: [{ type: 'memory.record', params: { summary: 'leaf ran', category: 'command' } }],
      });
      const mid = automation.create({
        name: 'mid', createdBy: 'admin', trigger: { type: 'manual' },
        actions: [{ type: 'automation.run', params: { automationId: leaf.id } }],
      });
      const root = automation.create({
        name: 'root', createdBy: 'admin', trigger: { type: 'manual' },
        actions: [{ type: 'automation.run', params: { automationId: mid.id } }],
      });
      const exec = await automation.run({ automationId: root.id });
      assert.equal(exec.status, 'succeeded');
      assert.equal(exec.results.length, 1);
      assert.equal(exec.results[0]!.status, 'ok');
      assert.equal(automation.get(leaf.id)!.runCount, 1);
      assert.equal(automation.get(mid.id)!.runCount, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('fails gracefully when an action module is absent (partial kernel)', async () => {
    const kernel = createTestKernel();
    kernel.register(new AutomationModule({ tickIntervalMs: 0 }));
    await kernel.boot();
    try {
      const automation = kernel.getModule<AutomationModule>('automation');
      const a = automation.create({
        name: 'orphan', createdBy: 'admin', trigger: { type: 'manual' },
        actions: [{ type: 'notification.send', params: { recipientId: 'x', title: 'nope' } }],
      });
      const exec = await automation.run({ automationId: a.id });
      assert.equal(exec.status, 'failed');
      assert.match(exec.error ?? '', /notifications module not registered/);
    } finally {
      await kernel.shutdown();
    }
  });
});
