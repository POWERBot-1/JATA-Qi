// TracingModule kernel integration.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { TracingModule, isSampled } from '../src/index.js';

describe('TracingModule (kernel)', () => {
  let kernel: Kernel;

  it('configures an in-memory exporter and records spans', async () => {
    kernel = createTestKernel();
    kernel.register(new TracingModule({ serviceName: 'svc-a', exporter: 'memory', sampler: 'always_on' }));
    await kernel.boot();
    const mod = kernel.getModule<TracingModule>('tracing');
    const tracer = mod.getTracer('test');
    const span = tracer.startSpan('op', { kind: 'server', attributes: { 'http.method': 'POST' } });
    span.setStatus('ok'); span.end();
    // batch processor flush
    await mod.provider.forceFlush();
    const finished = mod.getFinishedSpans();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]!.resource['service.name'], 'svc-a');
    assert.equal(isSampled(finished[0]!.context), true);
    await kernel.shutdown();
  });

  it('respects sampling: always_off exports nothing', async () => {
    kernel = createTestKernel();
    kernel.register(new TracingModule({ exporter: 'memory', sampler: 'always_off' }));
    await kernel.boot();
    const mod = kernel.getModule<TracingModule>('tracing');
    mod.getTracer('t').startSpan('skip').end();
    await mod.provider.forceFlush();
    assert.equal(mod.getFinishedSpans().length, 0);
    await kernel.shutdown();
  });

  it('shuts down cleanly', async () => {
    kernel = createTestKernel();
    kernel.register(new TracingModule({ exporter: 'memory' }));
    await kernel.boot();
    await kernel.shutdown(); // should not hang
    assert.ok(true);
  });

  after(async () => { /* kernels shut down per-test */ });
});
