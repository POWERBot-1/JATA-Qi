// W3C trace-context propagation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceparent, formatTraceparent, extract, inject } from '../src/index.js';
import type { SpanContext } from '../src/index.js';

describe('traceparent parse/format', () => {
  it('formats and parses round-trip', () => {
    const ctx: SpanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 0x01 };
    const tp = formatTraceparent(ctx);
    assert.equal(tp, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    assert.deepEqual(parseTraceparent(tp), ctx);
  });

  it('rejects malformed / forbidden values', () => {
    assert.equal(parseTraceparent('garbage'), undefined);
    assert.equal(parseTraceparent('00-abc-b7ad6b7169203331-01'), undefined); // bad trace id length
    assert.equal(parseTraceparent('ff-' + '0'.repeat(32) + '-b7ad6b7169203331-01'), undefined); // forbidden version
    assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-b7ad6b7169203331-01'), undefined); // zero trace id
    assert.equal(parseTraceparent('00-' + 'a'.repeat(32) + '-' + '0'.repeat(16) + '-01'), undefined); // zero span id
  });

  it('extracts only the sampled flag bit', () => {
    const ctx = parseTraceparent('00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-03');
    assert.equal(ctx?.traceFlags, 0x01); // 0x03 -> bit0 set
  });
});

describe('extract / inject on a carrier', () => {
  it('extracts traceparent + tracestate (case-insensitive headers)', () => {
    const carrier = { 'TraceParent': '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01', tracestate: 'congo=t61rcWkgMzE' };
    const ctx = extract(carrier);
    assert.ok(ctx);
    assert.equal(ctx!.traceState, 'congo=t61rcWkgMzE');
  });

  it('returns undefined when no valid traceparent is present', () => {
    assert.equal(extract({}), undefined);
    assert.equal(extract({ traceparent: 'nope' }), undefined);
  });

  it('inject sets traceparent (and tracestate when present)', () => {
    const carrier: Record<string, string> = {};
    inject({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0x01 }, carrier);
    assert.match(carrier.traceparent, /^00-(a){32}-(b){16}-01$/);
    const withState = inject({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0x00, traceState: 'v=1' }, {});
    assert.equal(withState.tracestate, 'v=1');
  });

  it('round-trips extract -> inject across two carriers', () => {
    const incoming = { traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01' };
    const ctx = extract(incoming)!;
    const outgoing: Record<string, string> = {};
    inject(ctx, outgoing);
    assert.deepEqual(extract(outgoing), ctx);
  });
});
