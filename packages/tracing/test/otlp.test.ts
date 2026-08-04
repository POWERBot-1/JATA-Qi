// OTLP/HTTP JSON conversion shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toOTLP } from '../src/index.js';
import type { ReadableSpan } from '../src/index.js';

function span(over: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'GET /health',
    kind: 'server',
    context: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 0x01 },
    parentSpanId: 'a7ad6b7169203330',
    resource: { 'service.name': 'jataqi', count: 7, ok: true, ratio: 0.5 },
    instrumentationScope: 'jataqi',
    startUnixNano: '1000000000',
    endUnixNano: '1005000000',
    attributes: { 'http.method': 'GET', 'http.status_code': 200, 'cache.hit': false },
    events: [{ name: 'dispatch', timeUnixNano: '1001000000', attributes: { q: 'a' } }],
    links: [],
    status: { code: 'ok' },
    ...over,
  };
}

describe('toOTLP', () => {
  it('builds a well-formed ExportTraceServiceRequest', () => {
    const doc = toOTLP([span()]) as { resourceSpans: { resource: { attributes: { key: string; value: unknown }[] }; scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[] }[] };
    const rs = doc.resourceSpans[0]!;
    assert.ok(rs.resource.attributes.find((a) => a.key === 'service.name'));
    // anyValue shapes by type
    const resAttrs = rs.resource.attributes;
    assert.deepEqual(resAttrs.find((a) => a.key === 'count')!.value, { intValue: '7' });
    assert.deepEqual(resAttrs.find((a) => a.key === 'ok')!.value, { boolValue: true });
    assert.deepEqual(resAttrs.find((a) => a.key === 'ratio')!.value, { doubleValue: 0.5 });

    const sp = rs.scopeSpans[0]!.spans[0]!;
    assert.equal(sp.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(sp.spanId, 'b7ad6b7169203331');
    assert.equal(sp.parentSpanId, 'a7ad6b7169203330');
    assert.equal(sp.kind, 2); // server
    assert.equal(sp.startTimeUnixNano, '1000000000');
    assert.equal(sp.endTimeUnixNano, '1005000000');
    assert.equal(sp.flags, 1); // sampled
    assert.equal((sp.status as { code: number }).code, 1); // OK
    assert.equal((sp.events as { name: string }[])[0]!.name, 'dispatch');
  });

  it('omits parentSpanId / flags / links when absent', () => {
    const doc = toOTLP([span({ parentSpanId: undefined, links: [], context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0x00 } })]) as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    const sp = doc.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.equal(sp.parentSpanId, undefined);
    assert.equal(sp.flags, undefined);
  });

  it('groups spans by resource + scope', () => {
    const doc = toOTLP([span(), span({ resource: { 'service.name': 'other' } })]) as { resourceSpans: unknown[] };
    assert.equal(doc.resourceSpans.length, 2);
  });
});
