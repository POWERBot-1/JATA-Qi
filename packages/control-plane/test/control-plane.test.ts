// Unit tests for Unified Capability Control Plane

import test from 'node:test';
import assert from 'node:assert';
import { ControlPlane } from '../src/index.js';

test('ControlPlane tracks registered modules, telemetry events, and system state', () => {
  const cp = new ControlPlane();
  cp.registerModule('model-fabric');
  cp.registerModule('identity');
  cp.registerModule('commerce');
  cp.registerModule('experience');
  cp.registerModule('execution');
  cp.registerModule('benchmark');

  cp.setHealthy();

  const ev1 = cp.emitTelemetry('model-fabric', 'MODEL_ROUTED', { modelId: 'gpt-4o' });
  const ev2 = cp.emitTelemetry('commerce', 'PAYMENT_SUCCEEDED', { amount: 2500, currency: 'KES' });

  const state = cp.getState();
  assert.strictEqual(state.status, 'HEALTHY');
  assert.strictEqual(state.activeModules.length, 6);
  assert.strictEqual(state.totalTelemetryEvents, 2);

  const recent = cp.getRecentTelemetry(10);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0]?.eventId, ev1.eventId);
  assert.strictEqual(recent[1]?.eventId, ev2.eventId);
});
