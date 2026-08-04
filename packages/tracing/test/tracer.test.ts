// Span lifecycle, samplers, and processors.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TracerProvider, Tracer, AlwaysOnSampler, AlwaysOffSampler, TraceIdRatioBasedSampler,
  ParentBasedSampler, SimpleSpanProcessor, BatchSpanProcessor, InMemorySpanExporter, Span,
} from '../src/index.js';

function providerWithMemory(): { provider: TracerProvider; mem: InMemorySpanExporter } {
  const mem = new InMemorySpanExporter();
  const provider = new TracerProvider({ serviceName: 'test' });
  provider.addSpanProcessor(new SimpleSpanProcessor(mem));
  return { provider, mem };
}

describe('Span lifecycle', () => {
  it('starts, records attributes/events/status, ends and exports a snapshot', async () => {
    const { provider, mem } = providerWithMemory();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('op', { kind: 'server', attributes: { 'http.method': 'GET' } });
    assert.equal(span.isRecording(), true);
    span.setAttribute('http.target', '/health');
    span.addEvent('dispatched', { queue: 'a' });
    span.setStatus('ok');
    span.end();
    assert.equal(span.isRecording(), false);
    await provider.forceFlush();
    assert.equal(mem.spans.length, 1);
    const s = mem.spans[0]!;
    assert.equal(s.name, 'op');
    assert.equal(s.kind, 'server');
    assert.equal(s.attributes['http.method'], 'GET');
    assert.equal(s.attributes['http.target'], '/health');
    assert.equal(s.status.code, 'ok');
    assert.equal(s.events[0]!.name, 'dispatched');
    assert.ok(BigInt(s.endUnixNano) >= BigInt(s.startUnixNano));
    await provider.shutdown();
  });

  it('child spans inherit the parent trace id and record the parent span id', async () => {
    const { provider, mem } = providerWithMemory();
    const tracer = provider.getTracer('test');
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child', { parent: parent.spanContext() });
    assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
    assert.notEqual(child.spanContext().spanId, parent.spanContext().spanId);
    assert.equal((child as unknown as { parentSpanId?: string }).parentSpanId, parent.spanContext().spanId);
    child.end(); parent.end();
    await provider.forceFlush();
    assert.equal(mem.spans.length, 2);
    await provider.shutdown();
  });

  it('recordException sets an exception event and error status', async () => {
    const { provider, mem } = providerWithMemory();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('op');
    span.recordException(Object.assign(new Error('boom'), { code: 'X' }));
    span.end();
    await provider.forceFlush();
    const s = mem.spans[0]!;
    assert.equal(s.events[0]!.name, 'exception');
    assert.equal(s.status.code, 'error');
    assert.equal((s.events[0]!.attributes! as { 'exception.message': string })['exception.message'], 'boom');
    await provider.shutdown();
  });
});

describe('Samplers', () => {
  it('AlwaysOn records; AlwaysOff does not', () => {
    const on = new TracerProvider({ sampler: new AlwaysOnSampler(), serviceName: 't' });
    const off = new TracerProvider({ sampler: new AlwaysOffSampler(), serviceName: 't' });
    assert.equal(on.getTracer('t').startSpan('a').isRecording(), true);
    assert.equal(off.getTracer('t').startSpan('a').isRecording(), false);
  });

  it('TraceIdRatioBased is deterministic on the trace id prefix', () => {
    const s = new TraceIdRatioBasedSampler(0.5);
    const low = '0'.repeat(32); // value ~ 0 -> sampled
    const high = 'f'.repeat(32); // value ~ 1 -> not sampled
    assert.equal(s.shouldSample(undefined, low, 'n', 'internal', {}, []).decision, 'record_and_sample');
    assert.equal(s.shouldSample(undefined, high, 'n', 'internal', {}, []).decision, 'not_record');
  });

  it('ParentBased inherits the parent sampled flag', () => {
    const sampler = new ParentBasedSampler(new AlwaysOffSampler());
    const sampledParent = { traceId: '0'.repeat(32), spanId: '1'.repeat(16), traceFlags: 0x01 };
    const unsampledParent = { traceId: '0'.repeat(32), spanId: '2'.repeat(16), traceFlags: 0x00 };
    assert.equal(sampler.shouldSample(sampledParent, sampledParent.traceId, 'n', 'internal', {}, []).decision, 'record_and_sample');
    assert.equal(sampler.shouldSample(unsampledParent, unsampledParent.traceId, 'n', 'internal', {}, []).decision, 'not_record');
    assert.equal(sampler.shouldSample(undefined, '0'.repeat(32), 'n', 'internal', {}, []).decision, 'not_record'); // root -> AlwaysOff
  });

  it('a non-sampled span is non-recording and never exported', async () => {
    const mem = new InMemorySpanExporter();
    const provider = new TracerProvider({ sampler: new AlwaysOffSampler(), serviceName: 't' });
    provider.addSpanProcessor(new SimpleSpanProcessor(mem));
    const span = provider.getTracer('t').startSpan('drop');
    span.setAttribute('x', 1); span.end();
    await provider.forceFlush();
    assert.equal(mem.spans.length, 0);
    await provider.shutdown();
  });
});

describe('Processors', () => {
  it('BatchSpanProcessor flushes queued spans', async () => {
    const mem = new InMemorySpanExporter();
    const provider = new TracerProvider({ serviceName: 't' });
    provider.addSpanProcessor(new BatchSpanProcessor(mem, 10, 5, 60_000));
    const tracer = provider.getTracer('t');
    for (let i = 0; i < 7; i++) { const s: Span = tracer.startSpan(`op${i}`); s.end(); }
    await provider.forceFlush();
    assert.equal(mem.spans.length, 7);
    await provider.shutdown();
  });

  it('generates valid W3C ids (32/16 hex, non-zero)', () => {
    const provider = new TracerProvider({ serviceName: 't' });
    const ctx = provider.getTracer('t').startSpan('x').spanContext();
    assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
    assert.match(ctx.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(ctx.traceId, '0'.repeat(32));
  });
});
